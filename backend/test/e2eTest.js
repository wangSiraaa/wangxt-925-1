const http = require('http');

const BASE_URL = 'localhost';
const PORT = 3002;

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: BASE_URL,
      port: PORT,
      path: '/api' + path,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

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

function assert(condition, msg) {
  if (!condition) throw new Error(msg || '断言失败');
}

async function waitForServer() {
  console.log('⏳ 等待服务器就绪...');
  for (let i = 0; i < 20; i++) {
    try {
      const res = await api('GET', '/health');
      if (res.status === 200 && res.body.code === 0) {
        console.log('✅ 服务器已就绪\n');
        return;
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('服务器启动超时');
}

async function runEndToEndTests() {
  console.log('========================================');
  console.log('  充电桩运维结算系统 - 端到端验证');
  console.log('========================================\n');

  await waitForServer();

  let createdOrderIds = [];

  console.log('【场景一】未修复故障不能进入结算\n');

  await test('1.1 创建一条待修复工单', async () => {
    const res = await api('POST', '/work-orders', {
      pile_no: 'SCENE-001',
      fault_type: '硬件故障',
      fault_desc: '场景一测试：未修复不能结算',
      downtime_start: '2024-06-01 10:00:00',
      reporter: '验证员'
    });
    assert(res.status === 200 && res.body.code === 0, '创建工单失败: ' + JSON.stringify(res.body));
    createdOrderIds.push(res.body.data.id);
    assert(res.body.data.status === 'pending', '新工单状态应为pending');
  });

  await test('1.2 创建一条已修复工单', async () => {
    const res = await api('POST', '/work-orders', {
      pile_no: 'SCENE-001',
      fault_type: '软件故障',
      fault_desc: '场景一测试：已修复可结算',
      downtime_start: '2024-06-02 08:00:00',
      reporter: '验证员'
    });
    assert(res.status === 200 && res.body.code === 0, '创建工单失败');
    const orderId = res.body.data.id;
    createdOrderIds.push(orderId);

    const confirmRes = await api('POST', `/work-orders/${orderId}/confirm-repair`, {
      repair_time: '2024-06-02 10:30:00',
      duty_owner: '运维方',
      duty_type: '主要责任',
      confirmor: '站长'
    });
    assert(confirmRes.status === 200 && confirmRes.body.code === 0, '确认修复失败: ' + JSON.stringify(confirmRes.body));
  });

  await test('1.3 生成结算单 - 应过滤掉未修复工单', async () => {
    const res = await api('POST', '/settlements/generate', { period: '2024-06' });
    assert(res.status === 200 && res.body.code === 0, '生成结算失败: ' + JSON.stringify(res.body));
    const items = res.body.data.items || [];
    const scene001Items = items.filter(i => i.pile_no === 'SCENE-001');
    assert(scene001Items.length === 1, `SCENE-001 应该只有1条可结算记录，实际有 ${scene001Items.length} 条`);
    assert(scene001Items[0].fault_type === '软件故障', '应该是软件故障那条已修复的');
  });

  console.log('\n【场景二】时间异常工单要退回\n');

  await test('2.1 修复时间早于开始时间 - 应退回', async () => {
    const res = await api('POST', '/work-orders', {
      pile_no: 'SCENE-002',
      fault_type: '网络故障',
      fault_desc: '场景二：修复时间早于开始时间',
      downtime_start: '2024-06-05 14:00:00',
      reporter: '验证员'
    });
    const orderId = res.body.data.id;

    const confirmRes = await api('POST', `/work-orders/${orderId}/confirm-repair`, {
      repair_time: '2024-06-05 10:00:00',
      duty_owner: '运维方',
      duty_type: '主要责任',
      confirmor: '站长'
    });
    assert(confirmRes.body.code !== 0, '修复时间早于开始时间应该被拒绝');
    assert(confirmRes.body.message && confirmRes.body.message.includes('早于'), '错误信息应提示时间先后问题: ' + confirmRes.body.message);
  });

  await test('2.2 停机时长为零 - 应退回', async () => {
    const res = await api('POST', '/work-orders', {
      pile_no: 'SCENE-002B',
      fault_type: '其他',
      fault_desc: '场景二：时长为零',
      downtime_start: '2024-06-06 12:00:00',
      reporter: '验证员'
    });
    const orderId = res.body.data.id;

    const confirmRes = await api('POST', `/work-orders/${orderId}/confirm-repair`, {
      repair_time: '2024-06-06 12:00:00',
      duty_owner: '运维方',
      duty_type: '主要责任',
      confirmor: '站长'
    });
    assert(confirmRes.body.code !== 0, '时长为零应该被拒绝');
  });

  console.log('\n【场景三】同桩同周期重复故障合并展示\n');

  await test('3.1 创建同一桩同类型故障2条（责任不同）', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await api('POST', '/work-orders', {
        pile_no: 'SCENE-003',
        fault_type: '硬件故障',
        fault_desc: `重复故障测试-${i + 1}`,
        downtime_start: `2024-06-1${i} 08:00:00`,
        reporter: '验证员'
      });
      const orderId = res.body.data.id;
      createdOrderIds.push(orderId);

      const confirmRes = await api('POST', `/work-orders/${orderId}/confirm-repair`, {
        repair_time: `2024-06-1${i} 11:00:00`,
        duty_owner: i === 0 ? '设备厂商' : '运维方',
        duty_type: i === 0 ? '主要责任' : '次要责任',
        confirmor: '站长'
      });
      assert(confirmRes.body.code === 0, `第${i + 1}条确认修复失败: ` + JSON.stringify(confirmRes.body));
    }
  });

  let scene003Items = [];

  await test('3.2 生成结算 - 重复故障合并展示但责任明细保留', async () => {
    const res = await api('POST', '/settlements/generate', { period: '2024-06' });
    assert(res.status === 200 && res.body.code === 0, '生成结算失败');

    scene003Items = res.body.data.items.filter(i => i.pile_no === 'SCENE-003');
    assert(scene003Items.length === 2, `SCENE-003 应该有2条明细（责任不同保留明细），实际 ${scene003Items.length} 条`);

    const hasRepeat = scene003Items.some(i => i.is_repeat === true);
    assert(hasRepeat, '应该有重复故障标记');

    const duties = [...new Set(scene003Items.map(i => i.duty_owner))];
    assert(duties.length === 2, '应该有两个不同的责任方');
    assert(duties.includes('设备厂商'), '应该包含设备厂商');
    assert(duties.includes('运维方'), '应该包含运维方');

    console.log('     ℹ️ 同桩同故障2条（设备厂商+运维方），均标记为重复，明细分别保留');
  });

  console.log('\n【场景四】结算确认后锁定 - 只能追加说明\n');

  let settlementId = null;

  await test('4.1 生成并确认结算单', async () => {
    const genRes = await api('POST', '/settlements/generate', { period: '2024-06' });
    settlementId = genRes.body.data.id;
    assert(genRes.body.code === 0, '生成结算失败');

    const confirmRes = await api('POST', `/settlements/${settlementId}/confirm`);
    assert(confirmRes.body.code === 0, '确认结算失败: ' + JSON.stringify(confirmRes.body));
    assert(confirmRes.body.data.status === 'confirmed', '状态应为confirmed');
  });

  await test('4.2 确认后工单不能修改非说明', async () => {
    const orderId = createdOrderIds[1];
    const updateRes = await api('PUT', `/work-orders/${orderId}`, {
      fault_desc: '尝试修改描述'
    });
    assert(updateRes.body.code !== 0, '已结算工单修改其他内容应该被拒绝');
    assert(updateRes.body.message && updateRes.body.message.includes('只能追加说明'), '错误信息应提示只能追加说明: ' + updateRes.body.message);
  });

  await test('4.3 确认后可以追加说明', async () => {
    const orderId = createdOrderIds[1];
    const remarkRes = await api('PUT', `/work-orders/${orderId}`, {
      remark: '追加的说明信息'
    });
    assert(remarkRes.body.code === 0, '追加说明应该成功');
  });

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
}

runEndToEndTests().catch(e => {
  console.error('验证执行失败:', e.message);
  console.error(e.stack);
  process.exit(1);
});
