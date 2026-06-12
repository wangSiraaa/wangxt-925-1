const http = require('http');
const path = require('path');

const dbPath = path.join(__dirname, '../data/db.json');
const fs = require('fs');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const { startServer } = require('../server');

let PORT;
let server;

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
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

async function runEndToEndTests() {
  console.log('========================================');
  console.log('  充电桩运维结算系统 - 端到端验证');
  console.log('========================================\n');

  server = await new Promise((resolve, reject) => {
    const s = startServer(0, '127.0.0.1', () => {
      PORT = s.address().port;
      console.log(`测试服务器端口: ${PORT}\n`);
      resolve(s);
    });
  });

  let createdOrderIds = [];
  let createdSettleIds = [];

  // ============================================================
  console.log('【场景一】未修复故障不能进入结算\n');
  // ============================================================

  await test('1.1 创建一条待修复工单（不修复）', async () => {
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

  await test('1.2 创建一条已修复工单（可结算）', async () => {
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

  await test('1.3 生成结算单 - 未修复工单被过滤，有效工单正常生成', async () => {
    const res = await api('POST', '/settlements/generate', { settlement_period: '2024-06' });
    assert(res.status === 200, 'HTTP状态码应为200');
    assert(res.body.code === 0 || res.body.code === 2, `生成结算应成功(code=0或=2)，实际code=${res.body.code}：${res.body.message}`);

    let settlements;
    if (res.body.code === 0) {
      settlements = res.body.data;
    } else {
      settlements = res.body.data.settlements;
    }

    const scene001Settle = settlements.find(s => s.pile_no === 'SCENE-001');
    assert(scene001Settle, 'SCENE-001 应该生成了结算单');
    assert(scene001Settle.item_count === 1, `SCENE-001 应该只有1条明细（未修复的被过滤），实际 ${scene001Settle.item_count} 条`);
    createdSettleIds.push(scene001Settle.id);

    const detailRes = await api('GET', '/settlements/' + scene001Settle.id);
    const items = detailRes.body.data.items || [];
    assert(items.length === 1, '详情也应只有1条明细');
    assert(items[0].fault_type === '软件故障', '应该是软件故障那条已修复的');
  });

  // ============================================================
  console.log('\n【场景二】时间异常工单单独退回，有效工单继续生成\n');
  // ============================================================

  let timeErrorOrderA, timeErrorOrderB;

  await test('2.1 创建时间异常工单A - 修复时间早于开始时间', async () => {
    const res = await api('POST', '/work-orders', {
      pile_no: 'SCENE-002',
      fault_type: '网络故障',
      fault_desc: '场景二：修复时间早于开始时间',
      downtime_start: '2024-06-05 14:00:00',
      reporter: '验证员'
    });
    timeErrorOrderA = res.body.data.id;
    createdOrderIds.push(timeErrorOrderA);

    const confirmRes = await api('POST', `/work-orders/${timeErrorOrderA}/confirm-repair`, {
      repair_time: '2024-06-05 10:00:00',
      duty_owner: '运维方',
      duty_type: '主要责任',
      confirmor: '站长'
    });
    assert(confirmRes.body.code !== 0, '确认修复时就应该被拒绝（时间先后问题）');
    assert(confirmRes.body.message && (confirmRes.body.message.includes('早于') || confirmRes.body.message.includes('早')),
      '错误信息应提示时间先后问题: ' + confirmRes.body.message);
  });

  await test('2.2 创建时间异常工单B - 停机时长为零', async () => {
    const res = await api('POST', '/work-orders', {
      pile_no: 'SCENE-002',
      fault_type: '其他故障',
      fault_desc: '场景二：时长为零',
      downtime_start: '2024-06-06 12:00:00',
      reporter: '验证员'
    });
    timeErrorOrderB = res.body.data.id;
    createdOrderIds.push(timeErrorOrderB);

    const confirmRes = await api('POST', `/work-orders/${timeErrorOrderB}/confirm-repair`, {
      repair_time: '2024-06-06 12:00:00',
      duty_owner: '运维方',
      duty_type: '主要责任',
      confirmor: '站长'
    });
    assert(confirmRes.body.code !== 0, '时长为零确认修复时应该被拒绝');
  });

  await test('2.3 SCENE-002 同时创建一条有效工单', async () => {
    const res = await api('POST', '/work-orders', {
      pile_no: 'SCENE-002',
      fault_type: '硬件故障',
      fault_desc: '场景二：有效可结算工单',
      downtime_start: '2024-06-07 09:00:00',
      reporter: '验证员'
    });
    const orderId = res.body.data.id;
    createdOrderIds.push(orderId);

    const confirmRes = await api('POST', `/work-orders/${orderId}/confirm-repair`, {
      repair_time: '2024-06-07 12:00:00',
      duty_owner: '设备厂商',
      duty_type: '主要责任',
      confirmor: '站长'
    });
    assert(confirmRes.body.code === 0, '有效工单确认修复应成功: ' + JSON.stringify(confirmRes.body));
  });

  console.log('     ℹ️ 注意：上面2.1/2.2的时间异常在确认修复阶段已拦截，工单仍处于pending状态');
  console.log('     ℹ️ 再创建一条绕过前端拦截、后端校验时才发现的时间异常工单，验证结算阶段退回\n');

  // 直接写数据库绕过前端时间校验，验证结算生成阶段的时间校验兜底
  await test('2.4 绕过确认修复校验，模拟数据库中 repair_time 异常的工单', async () => {
    const { tables, now } = require('../db/jsonDB');
    const { generateId } = require('../utils');

    const woId = generateId('wo_e2e_');
    tables.work_order.insert({
      id: woId,
      pile_no: 'SCENE-002C',
      fault_type: '软件故障',
      fault_desc: '模拟：绕过前端校验直接入库的时间异常工单',
      downtime_start: '2024-06-08 15:00:00',
      photo_url: '',
      reporter: '模拟系统',
      status: 'repaired',
      remark: '',
      created_at: now(),
      updated_at: now()
    });

    tables.repair_record.insert({
      id: generateId('rr_e2e_'),
      work_order_id: woId,
      repair_time: '2024-06-08 10:00:00',
      duty_owner: '运维方',
      duty_type: '主要责任',
      duty_remark: '',
      confirmor: '模拟站长',
      created_at: now()
    });

    createdOrderIds.push(woId);
    timeErrorOrderA = woId;

    const woId2 = generateId('wo_e2e2_');
    tables.work_order.insert({
      id: woId2,
      pile_no: 'SCENE-002C',
      fault_type: '网络故障',
      fault_desc: '模拟：正常可结算工单（和异常工单同周期同桩）',
      downtime_start: '2024-06-09 08:00:00',
      photo_url: '',
      reporter: '模拟系统',
      status: 'repaired',
      remark: '',
      created_at: now(),
      updated_at: now()
    });

    tables.repair_record.insert({
      id: generateId('rr_e2e2_'),
      work_order_id: woId2,
      repair_time: '2024-06-09 12:00:00',
      duty_owner: '设备厂商',
      duty_type: '次要责任',
      duty_remark: '',
      confirmor: '模拟站长',
      created_at: now()
    });

    createdOrderIds.push(woId2);
  });

  await test('2.5 生成SCENE-002C结算 - 异常工单退回但正常工单仍生成结算单', async () => {
    const res = await api('POST', '/settlements/generate', { settlement_period: '2024-06', pile_no: 'SCENE-002C', operator: '测试员' });
    assert(res.status === 200, 'HTTP状态应为200');
    assert(res.body.code === 2, '部分工单异常时应返回code=2: ' + JSON.stringify(res.body));

    const timeErrors = res.body.data.time_errors || [];
    const settlements = res.body.data.settlements || [];

    assert(timeErrors.length === 1, `应发现1条时间异常工单，实际 ${timeErrors.length} 条`);
    assert(timeErrors[0].fault_type === '软件故障', '异常工单应是软件故障那条');
    assert(timeErrors[0].reason && timeErrors[0].reason.includes('早于'), '异常原因应提示时间先后问题: ' + timeErrors[0].reason);
    console.log(`     ℹ️ 异常工单已退回: ${timeErrors[0].pile_no} / ${timeErrors[0].fault_type} -> ${timeErrors[0].reason}`);

    assert(settlements.length === 1, `仍应生成1份结算单（同桩的正常工单），实际 ${settlements.length} 份`);
    assert(settlements[0].pile_no === 'SCENE-002C', '结算单桩号应是SCENE-002C');
    assert(settlements[0].item_count === 1, '结算单应只有1条明细（网络故障那条正常的）');
    createdSettleIds.push(settlements[0].id);
    console.log(`     ℹ️ 有效工单仍生成结算: ${settlements[0].pile_no} 共 ${settlements[0].item_count} 条明细，扣款 ¥${settlements[0].total_deduction}`);
  });

  await test('2.6 时间异常退回已写入操作日志', async () => {
    const { tables } = require('../db/jsonDB');
    const logs = tables.operation_log.filter(l => 
      l.biz_type === 'work_order' && 
      l.action === '时间异常退回' && 
      l.biz_id === timeErrorOrderA
    );
    assert(logs.length > 0, '时间异常工单应有退回操作日志，实际操作日志条数: ' + tables.operation_log.all().length);
    assert(logs[0].detail && logs[0].detail.includes('结算生成时退回'),
      '日志内容应包含结算生成时退回，实际: ' + (logs[0].detail || logs[0].content || '无字段'));
  });

  await test('2.7 列表页可查询到已生成的结算单（前端刷新验证点）', async () => {
    const listRes = await api('GET', '/settlements?settlement_period=2024-06');
    assert(listRes.body.code === 0, '查询结算列表失败');
    const list = listRes.body.data.list;
    assert(list.length >= 2, `结算列表至少应有2条（场景一+2.5），实际 ${list.length} 条`);

    const pile002C = list.find(s => s.pile_no === 'SCENE-002C');
    assert(pile002C, '列表中应能查到SCENE-002C的结算单');
    assert(pile002C.item_count === 1, 'SCENE-002C明细数应为1（部分退回）');
    console.log(`     ℹ️ 前端列表刷新验证通过: 周期2024-06共 ${list.length} 条结算单`);
  });

  // ============================================================
  console.log('\n【场景三】同桩同周期重复故障合并展示，责任明细保留\n');
  // ============================================================

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

  await test('3.2 生成SCENE-003结算 - 重复故障合并展示但责任明细保留', async () => {
    const res = await api('POST', '/settlements/generate', { settlement_period: '2024-06', pile_no: 'SCENE-003', operator: '测试员' });
    assert(res.status === 200 && res.body.code === 0, '生成结算失败: ' + JSON.stringify(res.body));

    const settlements = res.body.data;
    const settle003 = settlements.find(s => s.pile_no === 'SCENE-003');
    assert(settle003, 'SCENE-003 应生成结算单');
    assert(settle003.item_count === 2, `SCENE-003 应有2条明细，实际 ${settle003.item_count} 条`);
    createdSettleIds.push(settle003.id);

    const detailRes = await api('GET', '/settlements/' + settle003.id);
    const items = detailRes.body.data.items || [];
    assert(items.length === 2, '详情也应有2条明细');

    const repeatCount = items.filter(i => i.is_repeat === 1 || i.is_repeat === true).length;
    assert(repeatCount === 2, `两条都应标记为重复（is_repeat=1），实际 ${repeatCount} 条`);

    const duties = [...new Set(items.map(i => i.duty_owner))];
    assert(duties.length === 2, '责任明细分别保留：应该有两个不同的责任方，实际: ' + duties.join(','));
    assert(duties.includes('设备厂商'), '应该包含设备厂商责任');
    assert(duties.includes('运维方'), '应该包含运维方责任');

    const dutyTypes = [...new Set(items.map(i => i.duty_type))];
    assert(dutyTypes.includes('主要责任') && dutyTypes.includes('次要责任'), '责任类型也应分别保留');

    console.log(`     ℹ️ 同桩同故障2条（设备厂商+运维方），均标记为重复，责任明细分别保留`);
    console.log(`        - 明细1: ${items[0].duty_owner} / ${items[0].duty_type} / ¥${items[0].deduction_amount.toFixed(2)}`);
    console.log(`        - 明细2: ${items[1].duty_owner} / ${items[1].duty_type} / ¥${items[1].deduction_amount.toFixed(2)}`);
  });

  await test('3.3 重复故障扣款加罚1.5倍验证', async () => {
    const settle003 = createdSettleIds[createdSettleIds.length - 1];
    const detailRes = await api('GET', '/settlements/' + settle003);
    const items = detailRes.body.data.items;

    const expected = 50 * 3 * 1.5;
    items.forEach((item, idx) => {
      assert(item.deduction_amount === expected,
        `第${idx + 1}条扣款应为 ¥${expected.toFixed(2)}（硬件故障50元/h × 3h × 1.5倍重复加罚），实际 ¥${item.deduction_amount.toFixed(2)}`);
    });
    const totalSettle = detailRes.body.data.total_deduction;
    assert(totalSettle === expected * 2, `总扣款应为 ¥${(expected * 2).toFixed(2)}，实际 ¥${totalSettle.toFixed(2)}`);
    console.log(`     ℹ️ 重复加罚验证通过: 单条 ¥${expected.toFixed(2)} × 2 = 合计 ¥${totalSettle.toFixed(2)}`);
  });

  // ============================================================
  console.log('\n【场景四】结算确认后锁定 - 只能追加说明\n');
  // ============================================================

  let confirmedOrderId;

  await test('4.1 确认SCENE-003结算单', async () => {
    const settleId = createdSettleIds[createdSettleIds.length - 1];

    const confirmRes = await api('POST', `/settlements/${settleId}/confirm`, {
      confirmor: '财务主管'
    });
    assert(confirmRes.body.code === 0, '确认结算失败: ' + JSON.stringify(confirmRes.body));

    const afterConfirm = await api('GET', '/settlements/' + settleId);
    assert(afterConfirm.body.data.status === 'confirmed', '确认后状态应为confirmed');
    assert(afterConfirm.body.data.confirmor === '财务主管', '确认人应为财务主管');

    confirmedOrderId = afterConfirm.body.data.items[0].work_order_id;
  });

  await test('4.2 已结算工单不能修改非说明字段', async () => {
    const updateRes = await api('PUT', `/work-orders/${confirmedOrderId}`, {
      fault_desc: '尝试修改描述'
    });
    assert(updateRes.body.code !== 0, '已结算工单修改其他内容应该被拒绝');
    assert(updateRes.body.message && updateRes.body.message.includes('只能追加说明'),
      '错误信息应提示只能追加说明: ' + updateRes.body.message);
  });

  await test('4.3 已结算工单可以追加说明', async () => {
    const remarkRes = await api('PUT', `/work-orders/${confirmedOrderId}`, {
      remark: '追加的说明信息'
    });
    assert(remarkRes.body.code === 0, '追加说明应该成功');

    const getRes = await api('GET', '/work-orders/' + confirmedOrderId);
    assert(getRes.body.data.remark && getRes.body.data.remark.includes('追加的说明信息'),
      '追加说明应该被保存');
  });

  // ============================================================
  console.log('\n【场景五】质保复发追责与扣款重算\n');
  // ============================================================

  let recurrenceWO_A, recurrenceWO_B, recurrenceChainId, adjustmentId;

  await test('5.1 创建原工单（已修复、已结算）- 设备厂商/主要责任', async () => {
    const res = await api('POST', '/work-orders', {
      pile_no: 'SCENE-005',
      fault_type: '硬件故障',
      fault_desc: '质保复发原工单',
      downtime_start: '2024-07-01 08:00:00',
      reporter: '验证员'
    });
    assert(res.body.code === 0, '创建工单失败');
    recurrenceWO_A = res.body.data.id;

    const confirmRes = await api('POST', `/work-orders/${recurrenceWO_A}/confirm-repair`, {
      repair_time: '2024-07-01 11:00:00',
      duty_owner: '设备厂商',
      duty_type: '主要责任',
      confirmor: '站长'
    });
    assert(confirmRes.body.code === 0, '确认修复失败');
  });

  await test('5.2 生成并确认SCENE-005结算单', async () => {
    const genRes = await api('POST', '/settlements/generate', {
      settlement_period: '2024-07',
      pile_no: 'SCENE-005',
      operator: '测试员'
    });
    assert(genRes.body.code === 0, '生成结算失败: ' + JSON.stringify(genRes.body));

    const settleId = genRes.body.data[0]?.id || genRes.body.data?.id;
    assert(settleId, '应返回结算单ID');

    const confirmRes = await api('POST', `/settlements/${settleId}/confirm`, {
      confirmor: '财务主管'
    });
    assert(confirmRes.body.code === 0, '确认结算失败');
  });

  await test('5.3 在质保期内创建复发工单 - 运维方/次要责任', async () => {
    const res = await api('POST', '/work-orders', {
      pile_no: 'SCENE-005',
      fault_type: '硬件故障',
      fault_desc: '质保期内复发故障',
      downtime_start: '2024-09-15 10:00:00',
      reporter: '验证员'
    });
    assert(res.body.code === 0, '创建复发工单失败');
    recurrenceWO_B = res.body.data.id;

    const confirmRes = await api('POST', `/work-orders/${recurrenceWO_B}/confirm-repair`, {
      repair_time: '2024-09-15 14:00:00',
      duty_owner: '运维方',
      duty_type: '次要责任',
      confirmor: '站长'
    });
    assert(confirmRes.body.code === 0, '确认修复失败');
  });

  await test('5.4 检测复发 - 应检测到质保期内复发', async () => {
    const res = await api('POST', '/recurrences/detect', {
      work_order_id: recurrenceWO_B
    });
    assert(res.body.code === 0, '检测复发失败: ' + JSON.stringify(res.body));
    assert(res.body.data.recurrence_count >= 1, `应检测到至少1个复发，实际 ${res.body.data.recurrence_count}`);

    const rc = res.body.data.recurrences[0];
    assert(rc.is_warranty === 1, '应在质保期内: ' + JSON.stringify(rc));
    assert(rc.same_duty === 0, '责任方不同，same_duty应为0');
    assert(rc.pile_no === 'SCENE-005', '桩号应为SCENE-005');
    assert(rc.fault_type === '硬件故障', '故障类型应为硬件故障');
    console.log(`     ℹ️ 检测到复发: 质保期内=${rc.is_warranty}, 同责任方=${rc.same_duty}, 质保期${rc.warranty_months}月`);
  });

  await test('5.5 使用confirm-repair-and-detect接口 - 自动保存复发链路', async () => {
    const res = await api('POST', '/recurrences/confirm-repair-and-detect', {
      work_order_id: recurrenceWO_B,
      repair_time: '2024-09-15 14:00:00',
      duty_owner: '运维方',
      duty_type: '次要责任',
      confirmor: '站长'
    });
    assert(res.body.code === 0, '确认修复并检测失败: ' + JSON.stringify(res.body));
    assert(res.body.data.recurrence_detected === true, '应检测到复发');

    if (res.body.data.recurrence_chains && res.body.data.recurrence_chains.length > 0) {
      recurrenceChainId = res.body.data.recurrence_chains[0].id;
      assert(recurrenceChainId, '应返回复发链路ID');
      console.log(`     ℹ️ 复发链路ID: ${recurrenceChainId}`);
    } else {
      const chains = require('../db/jsonDB').tables.recurrence_chain.filter(
        rc => rc.recurrence_work_order_id === recurrenceWO_B
      );
      assert(chains.length > 0, '数据库中应存在复发链路记录');
      recurrenceChainId = chains[0].id;
    }
  });

  await test('5.6 质保期复发生成调整单', async () => {
    const res = await api('POST', '/recurrences/generate-adjustment', {
      recurrence_chain_id: recurrenceChainId,
      operator: '财务_王会计'
    });
    assert(res.body.code === 0, '生成调整单失败: ' + JSON.stringify(res.body));

    adjustmentId = res.body.data.adjustment_id;
    assert(adjustmentId, '应返回调整单ID');

    const adjAmount = res.body.data.adjustment_amount;
    assert(adjAmount !== 0, '调整金额不应为零');

    console.log(`     ℹ️ 调整单ID: ${adjustmentId}`);
    console.log(`     ℹ️ 原金额: ¥${res.body.data.original_amount}, 调整额: ¥${adjAmount}, 新金额: ¥${res.body.data.new_amount}`);
    console.log(`     ℹ️ 同责任方: ${res.body.data.same_duty ? '是' : '否（不同责任方保留明细）'}`);
  });

  await test('5.7 调整单明细保留不同责任方', async () => {
    const res = await api('GET', `/recurrences/adjustments/${adjustmentId}`);
    assert(res.body.code === 0, '查询调整单失败');

    const items = res.body.data.items;
    assert(items.length >= 1, '调整单应有至少1条明细');

    const item = items[0];
    assert(item.same_duty === 0, '应标记为不同责任方');
    assert(item.duty_owner === '运维方', '责任方应为运维方（复发工单的责任方）');
    assert(item.duty_type === '次要责任', '责任类型应为次要责任');
    assert(item.remark && item.remark.includes('不同责任方'), '备注应说明不同责任方保留明细');

    console.log(`     ℹ️ 调整明细: ${item.duty_owner}/${item.duty_type}, 原扣款¥${item.original_deduction_amount}, 新扣款¥${item.new_deduction_amount}`);
  });

  await test('5.8 已确认结算单金额不可直接覆盖', async () => {
    const adjDetail = await api('GET', `/recurrences/adjustments/${adjustmentId}`);
    assert(adjDetail.body.code === 0, '查询调整单失败');

    const originalSettlementId = adjDetail.body.data.original_settlement_id;
    const originalSettlement = await api('GET', `/settlements/${originalSettlementId}`);
    assert(originalSettlement.body.code === 0, '查询原结算单失败');

    assert(originalSettlement.body.data.status === 'confirmed', '原结算单应仍为confirmed状态');
    assert(originalSettlement.body.data.total_deduction === adjDetail.body.data.original_total_deduction,
      '原结算单金额不应被修改');

    console.log(`     ℹ️ 原结算单金额未变: ¥${originalSettlement.body.data.total_deduction}, 状态=${originalSettlement.body.data.status}`);
  });

  await test('5.9 确认调整单', async () => {
    const res = await api('POST', `/recurrences/adjustments/${adjustmentId}/confirm`, {
      confirmor: '财务主管'
    });
    assert(res.body.code === 0, '确认调整单失败: ' + JSON.stringify(res.body));

    const afterConfirm = await api('GET', `/recurrences/adjustments/${adjustmentId}`);
    assert(afterConfirm.body.data.status === 'confirmed', '确认后状态应为confirmed');

    const originalSettlementId = afterConfirm.body.data.original_settlement_id;
    const originalSettlement = await api('GET', `/settlements/${originalSettlementId}`);
    assert(originalSettlement.body.data.total_deduction === afterConfirm.body.data.original_total_deduction,
      '确认调整单后原结算金额仍不可变');
  });

  await test('5.10 复发链路可查询', async () => {
    const res = await api('GET', `/recurrences/chain/${recurrenceWO_A}`);
    assert(res.body.code === 0, '查询链路失败');
    assert(res.body.data.chain.length >= 2, `链路应至少包含2个节点，实际 ${res.body.data.chain.length}`);

    console.log(`     ℹ️ 链路节点数: ${res.body.data.chain.length}`);
    res.body.data.chain.forEach((node, idx) => {
      console.log(`        - 节点${idx + 1}: ${node.duty_owner}/${node.duty_type}, 停机${node.downtime}h, ¥${node.deduction_amount}`);
    });
  });

  await test('5.11 未修复工单不能参与复发判定', async () => {
    const res = await api('POST', '/work-orders', {
      pile_no: 'SCENE-005',
      fault_type: '硬件故障',
      fault_desc: '未修复工单-不参与复发',
      downtime_start: '2024-10-01 08:00:00',
      reporter: '验证员'
    });
    const pendingWO = res.body.data.id;

    const detectRes = await api('POST', '/recurrences/detect', {
      work_order_id: pendingWO
    });
    assert(detectRes.body.code !== 0 || detectRes.body.data.recurrence_count === 0,
      '未修复工单不应检测到复发');

    console.log(`     ℹ️ 未修复工单(pending)正确被排除在复发判定之外`);
  });

  await test('5.12 已确认结算不能直接修改金额（尝试修改被拒绝）', async () => {
    const { tables } = require('../db/jsonDB');
    const settlements = tables.settlement.filter(s => s.pile_no === 'SCENE-005' && s.status === 'confirmed');
    assert(settlements.length > 0, '应存在SCENE-005已确认结算单');

    const confirmedSettlement = settlements[0];
    const originalAmount = confirmedSettlement.total_deduction;

    const updateRes = await api('DELETE', `/settlements/${confirmedSettlement.id}?operator=${encodeURIComponent('测试员')}`);
    assert(updateRes.body.code !== 0, '已确认结算单不应能被删除');
    assert(updateRes.body.message && updateRes.body.message.includes('已确认'), '应提示已确认不能删除');

    const afterAttempt = await api('GET', `/settlements/${confirmedSettlement.id}`);
    assert(afterAttempt.body.data.total_deduction === originalAmount, '结算金额不应被改变');
  });

  // ============================================================
  console.log('\n========================================');
  console.log('  验证结果');
  console.log('========================================');
  console.log(`总测试数: ${results.total}`);
  console.log(`通过: ${results.passed}`);
  console.log(`失败: ${results.failed}`);

  if (failures.length > 0) {
    console.log('\n失败详情:');
    failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
    if (server) server.close();
    process.exit(1);
  } else {
    console.log('\n🎉 全部验证通过！五大核心场景均符合需求：');
    console.log('   1. ✅ 未修复故障不能进入结算 - 生成结算时自动过滤');
    console.log('   2. ✅ 时间异常工单单独退回并展示原因，有效工单继续生成');
    console.log('   3. ✅ 同桩同周期重复故障合并展示、责任明细保留、加罚1.5倍');
    console.log('   4. ✅ 结算确认后锁定、只能追加说明');
    console.log('   5. ✅ 质保复发追责与扣款重算：');
    console.log('      - 质保期内复发生成调整单');
    console.log('      - 不同责任方复发明细独立保留');
    console.log('      - 已确认结算不可直接修改金额');
    console.log('\n📋 页面回归验证要点（人工对照）:');
    console.log('   [质保复发页] - 检测复发、查看链路、生成/确认调整单');
    console.log('   [工单页] - 未修复工单不参与复发判定');
    console.log('   [结算页] - 已确认结算金额不变、调整单独立存在');
    console.log('   [规则页] - 质保期月数和减免比例展示');
  }

  if (server) server.close();
}

runEndToEndTests().catch(e => {
  console.error('验证执行失败:', e.message);
  console.error(e.stack);
  if (server) server.close();
  process.exit(1);
});
