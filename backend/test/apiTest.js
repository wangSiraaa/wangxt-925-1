const { app } = require('../server');
const http = require('http');

let results = { total: 0, passed: 0, failed: 0 };
const failures = [];

async function test(name, fn) {
  results.total++;
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    results.passed++;
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     错误: ${e.message}`);
    failures.push({ name, error: e.message });
    results.failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

console.log('========================================');
console.log('  充电桩运维结算系统 - API集成验证');
console.log('========================================\n');

const server = app.listen(0, '127.0.0.1', async () => {
  const PORT = server.address().port;
  console.log(`测试服务器端口: ${PORT}\n`);

  function api(method, path, body) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: '127.0.0.1',
        port: PORT,
        path: '/api' + path,
        method,
        headers: { 'Content-Type': 'application/json' }
      };
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch (e) {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  try {
    let orderIds = [];

    // ============== 场景一：未修复故障不能进入结算 ==============
    console.log('【场景一】未修复故障不能进入结算\n');

    await test('1.1 创建待修复工单', async () => {
      const r = await api('POST', '/work-orders', {
        pile_no: 'S1-PILE',
        fault_type: '硬件故障',
        fault_desc: '未修复测试',
        downtime_start: '2024-06-01 10:00:00',
        reporter: '测试员'
      });
      assert(r.body.code === 0, '创建失败');
      assert(r.body.data.status === 'pending', '状态应为pending');
      orderIds.push(r.body.data.id);
    });

    await test('1.2 创建并确认修复工单', async () => {
      const createRes = await api('POST', '/work-orders', {
        pile_no: 'S1-PILE',
        fault_type: '软件故障',
        fault_desc: '已修复测试',
        downtime_start: '2024-06-02 08:00:00',
        reporter: '测试员'
      });
      assert(createRes.body.code === 0, '创建失败');
      const orderId = createRes.body.data.id;
      orderIds.push(orderId);

      const confirmRes = await api('POST', `/work-orders/${orderId}/confirm-repair`, {
        repair_time: '2024-06-02 10:30:00',
        duty_owner: '运维方',
        duty_type: '主要责任',
        confirmor: '站长'
      });
      assert(confirmRes.body.code === 0, '确认修复失败: ' + confirmRes.body.message);
    });

    await test('1.3 生成结算 - 未修复工单被过滤', async () => {
      const genRes = await api('POST', '/settlements/generate', { settlement_period: '2024-06' });
      assert(genRes.body.code === 0, '生成失败: ' + genRes.body.message);
      assert(Array.isArray(genRes.body.data), 'data应该是数组');

      const s1Settle = genRes.body.data.find(s => s.pile_no === 'S1-PILE');
      assert(s1Settle, '应该有S1-PILE的结算单');
      assert(s1Settle.item_count === 1, `应该只有1条明细（未修的被过滤），实际${s1Settle.item_count}条`);

      const detailRes = await api('GET', '/settlements/' + s1Settle.id);
      assert(detailRes.body.code === 0, '获取详情失败');
      const items = detailRes.body.data.items;
      assert(items.length === 1, `详情里应该只有1条，实际${items.length}条`);
      assert(items[0].fault_type === '软件故障', '应该是软件故障那条已修复的');
    });

    // ============== 场景二：时间异常工单退回 ==============
    console.log('\n【场景二】时间异常工单退回\n');

    await test('2.1 修复时间早于开始时间 - 确认修复时退回', async () => {
      const createRes = await api('POST', '/work-orders', {
        pile_no: 'S2-PILE',
        fault_type: '网络故障',
        fault_desc: '测试修复早于开始',
        downtime_start: '2024-06-05 14:00:00',
        reporter: '测试员'
      });
      const orderId = createRes.body.data.id;

      const confirmRes = await api('POST', `/work-orders/${orderId}/confirm-repair`, {
        repair_time: '2024-06-05 10:00:00',
        duty_owner: '运维方',
        duty_type: '主要责任',
        confirmor: '站长'
      });
      assert(confirmRes.body.code !== 0, '应该被拒绝');
      assert(confirmRes.body.message && confirmRes.body.message.includes('早于'),
        '错误信息应提示时间先后问题');
    });

    await test('2.2 停机时长为零 - 确认修复时退回', async () => {
      const createRes = await api('POST', '/work-orders', {
        pile_no: 'S2B-PILE',
        fault_type: '其他',
        fault_desc: '测试零时长',
        downtime_start: '2024-06-06 12:00:00',
        reporter: '测试员'
      });
      const orderId = createRes.body.data.id;

      const confirmRes = await api('POST', `/work-orders/${orderId}/confirm-repair`, {
        repair_time: '2024-06-06 12:00:00',
        duty_owner: '运维方',
        duty_type: '主要责任',
        confirmor: '站长'
      });
      assert(confirmRes.body.code !== 0, '应该被拒绝');
    });

    // ============== 场景三：同桩同周期重复故障合并 ==============
    console.log('\n【场景三】同桩同周期重复故障合并展示\n');

    await test('3.1 创建同一桩同类型故障2条（责任不同）', async () => {
      for (let i = 0; i < 2; i++) {
        const createRes = await api('POST', '/work-orders', {
          pile_no: 'S3-PILE',
          fault_type: '硬件故障',
          fault_desc: `重复测试${i + 1}`,
          downtime_start: `2024-06-1${i} 08:00:00`,
          reporter: '测试员'
        });
        assert(createRes.body.code === 0, `创建第${i + 1}条失败`);
        const orderId = createRes.body.data.id;
        orderIds.push(orderId);

        const confirmRes = await api('POST', `/work-orders/${orderId}/confirm-repair`, {
          repair_time: `2024-06-1${i} 11:00:00`,
          duty_owner: i === 0 ? '设备厂商' : '运维方',
          duty_type: i === 0 ? '主要责任' : '次要责任',
          confirmor: '站长'
        });
        assert(confirmRes.body.code === 0, `确认第${i + 1}条失败: ` + confirmRes.body.message);
      }
    });

    await test('3.2 重复故障合并展示、责任明细保留', async () => {
      const genRes = await api('POST', '/settlements/generate', { settlement_period: '2024-06', pile_no: 'S3-PILE', operator: '测试员' });
      assert(genRes.body.code === 0, '生成失败: ' + (genRes.body.message || JSON.stringify(genRes.body)));

      const s3Settle = genRes.body.data.find(s => s.pile_no === 'S3-PILE');
      assert(s3Settle, '应该有S3-PILE的结算单');
      assert(s3Settle.item_count === 2, `应该有2条明细，实际${s3Settle.item_count}条`);

      const detailRes = await api('GET', '/settlements/' + s3Settle.id);
      const items = detailRes.body.data.items;

      assert(items.length === 2, `详情应该有2条明细（责任不同分别保留），实际${items.length}条`);

      const hasRepeat = items.some(i => i.is_repeat === 1 || i.is_repeat === true);
      assert(hasRepeat, '应该有重复故障标记');

      const duties = [...new Set(items.map(i => i.duty_owner))];
      assert(duties.length === 2, '应该有两个不同的责任方');
      assert(duties.includes('设备厂商'), '应包含设备厂商');
      assert(duties.includes('运维方'), '应包含运维方');

      console.log('     ℹ️ 同桩同故障2条（设备厂商+运维方），均标记为重复，责任明细分别保留');
    });

    // ============== 场景四：结算确认后锁定 ==============
    console.log('\n【场景四】结算确认后锁定 - 只能追加说明\n');

    let testSettleId = null;
    let settledOrderId = null;

    await test('4.1 确认结算单', async () => {
      const listRes = await api('GET', '/settlements?status=draft');
      assert(listRes.body.code === 0 && listRes.body.data.list.length > 0, '应该有草稿结算单');

      testSettleId = listRes.body.data.list.find(s => s.pile_no === 'S1-PILE')?.id;
      assert(testSettleId, '应该找到S1-PILE的草稿结算单');

      const detailRes = await api('GET', '/settlements/' + testSettleId);
      assert(detailRes.body.code === 0, '获取详情失败');
      settledOrderId = detailRes.body.data.items[0]?.work_order_id;
      assert(settledOrderId, '应该有结算明细工单');

      const confirmRes = await api('POST', `/settlements/${testSettleId}/confirm`, {
        confirmor: '财务主管'
      });
      assert(confirmRes.body.code === 0, '确认失败: ' + confirmRes.body.message);

      const afterConfirm = await api('GET', '/settlements/' + testSettleId);
      assert(afterConfirm.body.data.status === 'confirmed', '确认后状态应为confirmed');
    });

    await test('4.2 已结算工单不能修改非说明字段', async () => {
      const updateRes = await api('PUT', `/work-orders/${settledOrderId}`, {
        fault_desc: '尝试修改描述'
      });
      assert(updateRes.body.code !== 0, '修改应该被拒绝');
      assert(updateRes.body.message && updateRes.body.message.includes('只能追加说明'),
        '错误信息应提示只能追加说明');
    });

    await test('4.3 已结算工单可以追加说明', async () => {
      const remarkRes = await api('PUT', `/work-orders/${settledOrderId}`, {
        remark: '追加说明测试'
      });
      assert(remarkRes.body.code === 0, '追加说明应该成功');
    });

    // ============== 汇总 ==============
    console.log('\n========================================');
    console.log('  验证结果');
    console.log('========================================');
    console.log(`总测试数: ${results.total}`);
    console.log(`通过: ${results.passed}`);
    console.log(`失败: ${results.failed}`);

    if (failures.length > 0) {
      console.log('\n失败详情:');
      failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
      process.exit(1);
    } else {
      console.log('\n🎉 全部验证通过！四大核心场景均符合需求：');
      console.log('   1. ✅ 未修复故障不能进入结算');
      console.log('   2. ✅ 时间异常工单被退回');
      console.log('   3. ✅ 同桩同周期重复故障合并展示、责任明细保留');
      console.log('   4. ✅ 结算确认后锁定、只能追加说明');
    }

    server.close();
  } catch (e) {
    console.error('\n测试异常:', e.message);
    console.error(e.stack);
    server.close();
    process.exit(1);
  }
});
