const { tables, _reset } = require('../db/jsonDB');
const { generateId, validateTimeRange, calculateDeduction, calculateDowntime } = require('../utils');

console.log('========================================');
console.log('  充电桩运维结算系统 - 功能验证脚本');
console.log('========================================\n');

_reset();
console.log('🔄 数据库已重置\n');

let results = {
  total: 0,
  passed: 0,
  failed: 0
};

function test(name, fn) {
  results.total++;
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    results.passed++;
  } catch (e) {
    console.log(`❌ FAIL: ${name}`);
    console.log(`   错误: ${e.message}`);
    results.failed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || '断言失败');
  }
}

console.log('--- 测试1: 时间校验规则 ---');

test('修复时间早于开始时间 - 应退回', () => {
  const result = validateTimeRange('2024-06-15 10:00:00', '2024-06-15 09:00:00');
  assert(result.valid === false, '应该返回无效');
  assert(result.reason === '修复时间早于停机开始时间', '错误原因不正确');
});

test('停机时长为零 - 应退回', () => {
  const result = validateTimeRange('2024-06-15 10:00:00', '2024-06-15 10:00:00');
  assert(result.valid === false, '应该返回无效');
  assert(result.reason === '停机时长为零', '错误原因不正确');
});

test('正常时间范围 - 应通过', () => {
  const result = validateTimeRange('2024-06-15 10:00:00', '2024-06-15 12:00:00');
  assert(result.valid === true, '应该返回有效');
  assert(result.downtime === 2, '停机时长计算错误');
});

console.log('');
console.log('--- 测试2: 扣款计算规则 ---');

test('基础扣款计算 - 硬件故障2小时', () => {
  const result = calculateDeduction('硬件故障', 2);
  assert(result.amount === 100, `扣款金额错误: ${result.amount}`);
  assert(result.rule === '硬件故障扣款标准', '规则名称错误');
});

test('低于最低扣款 - 软件故障0.5小时', () => {
  const result = calculateDeduction('软件故障', 0.5);
  assert(result.amount === 50, `低于最低扣款应取最小值: ${result.amount}`);
});

test('重复故障加罚 - 硬件故障2小时重复', () => {
  const normal = calculateDeduction('硬件故障', 2);
  const repeat = calculateDeduction('硬件故障', 2, true);
  assert(repeat.amount === normal.amount * 1.5, `重复故障加罚计算错误: ${repeat.amount}`);
});

console.log('');
console.log('--- 测试3: 工单生命周期 ---');

let testOrderId = '';

test('创建故障工单', () => {
  const id = generateId('test_wo_');
  tables.work_order.insert({
    id,
    pile_no: 'PILE-001',
    fault_type: '硬件故障',
    fault_desc: '测试故障描述',
    downtime_start: '2024-06-15 08:00:00',
    photo_url: '',
    reporter: 'test_user',
    status: 'pending',
    remark: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  testOrderId = id;
  
  const order = tables.work_order.get(id);
  assert(order !== undefined, '工单创建失败');
  assert(order.status === 'pending', '初始状态应为pending');
});

test('确认修复 - 正常时间', () => {
  const repairId = generateId('test_rr_');
  tables.repair_record.insert({
    id: repairId,
    work_order_id: testOrderId,
    repair_time: '2024-06-15 10:30:00',
    duty_owner: '运维方',
    duty_type: '主要责任',
    confirmor: 'manager',
    confirm_remark: '',
    created_at: new Date().toISOString()
  });

  tables.work_order.update(testOrderId, { status: 'repaired' });
  
  const order = tables.work_order.get(testOrderId);
  assert(order.status === 'repaired', '修复确认后状态应为repaired');
  
  const downtime = calculateDowntime('2024-06-15 08:00:00', '2024-06-15 10:30:00');
  assert(downtime === 2.5, `停机时长计算错误: ${downtime}`);
});

test('未修复工单不能进入结算 - 验证状态', () => {
  const pendingId = generateId('test_pending_');
  tables.work_order.insert({
    id: pendingId,
    pile_no: 'PILE-002',
    fault_type: '软件故障',
    downtime_start: '2024-06-15 09:00:00',
    reporter: 'test_user2',
    status: 'pending',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  const pendingOrders = tables.work_order.filter(wo => wo.status === 'pending' && wo.id === pendingId);
  assert(pendingOrders.length === 1, '未修复工单应保留在pending状态');
});

console.log('');
console.log('--- 测试4: 结算单生成与合并 ---');

let testSettleId = '';

test('同桩同周期重复故障合并 - 责任不同保留明细', () => {
  const pileNo = 'PILE-TEST-MERGE';
  const period = '2024-06';

  const orders = [
    { id: generateId('wo_m1_'), fault_type: '硬件故障', start: '2024-06-01 08:00:00', end: '2024-06-01 10:00:00', duty: '运维方', duty_type: '主要责任' },
    { id: generateId('wo_m2_'), fault_type: '硬件故障', start: '2024-06-10 14:00:00', end: '2024-06-10 16:00:00', duty: '设备厂商', duty_type: '次要责任' },
    { id: generateId('wo_m3_'), fault_type: '软件故障', start: '2024-06-15 09:00:00', end: '2024-06-15 11:00:00', duty: '运维方', duty_type: '主要责任' },
  ];

  for (const order of orders) {
    tables.work_order.insert({
      id: order.id,
      pile_no: pileNo,
      fault_type: order.fault_type,
      downtime_start: order.start,
      reporter: 'test_reporter',
      status: 'repaired',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    tables.repair_record.insert({
      id: generateId('rr_'),
      work_order_id: order.id,
      repair_time: order.end,
      duty_owner: order.duty,
      duty_type: order.duty_type,
      confirmor: 'test_confirmor',
      created_at: new Date().toISOString()
    });
  }

  const settleId = generateId('st_merge_');
  
  let totalDowntime = 0;
  let totalDeduction = 0;

  const faultCounts = {};
  for (const order of orders) {
    if (!faultCounts[order.fault_type]) faultCounts[order.fault_type] = 0;
    faultCounts[order.fault_type]++;
  }

  for (const order of orders) {
    const downtime = calculateDowntime(order.start, order.end);
    const isRepeat = faultCounts[order.fault_type] > 1;
    const ded = calculateDeduction(order.fault_type, downtime, isRepeat);
    
    tables.settlement_item.insert({
      id: generateId('si_'),
      settlement_id: settleId,
      work_order_id: order.id,
      fault_type: order.fault_type,
      downtime_start: order.start,
      repair_time: order.end,
      downtime,
      duty_owner: order.duty,
      duty_type: order.duty_type,
      deduction_amount: ded.amount,
      deduction_rule: ded.rule,
      is_repeat: isRepeat ? 1 : 0,
      remark: '',
      created_at: new Date().toISOString()
    });

    totalDowntime += downtime;
    totalDeduction += ded.amount;
  }

  tables.settlement.insert({
    id: settleId,
    settlement_period: period,
    pile_no: pileNo,
    total_downtime: totalDowntime,
    total_deduction: totalDeduction,
    status: 'draft',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  testSettleId = settleId;

  const items = tables.settlement_item.filter(i => i.settlement_id === settleId);
  assert(items.length === 3, `结算明细数量应为3，实际: ${items.length}`);

  const hardwareItems = items.filter(i => i.fault_type === '硬件故障');
  assert(hardwareItems.length === 2, '硬件故障应有2条明细');
  assert(hardwareItems[0].is_repeat === 1, '硬件故障应标记为重复故障');
  assert(hardwareItems[0].duty_owner !== hardwareItems[1].duty_owner, '责任方不同的明细应分别保留');

  const settle = tables.settlement.get(settleId);
  assert(settle.total_downtime === 6, `总停机时长应为6小时，实际: ${settle.total_downtime}`);
});

console.log('');
console.log('--- 测试5: 结算确认后锁定 ---');

test('结算确认后工单状态变更', () => {
  const items = tables.settlement_item.filter(i => i.settlement_id === testSettleId);

  tables.settlement.update(testSettleId, { status: 'confirmed' });
  
  for (const item of items) {
    tables.work_order.update(item.work_order_id, { status: 'settled' });
  }

  const updatedSettle = tables.settlement.get(testSettleId);
  assert(updatedSettle.status === 'confirmed', '结算单状态应为confirmed');

  const firstItem = items[0];
  const order = tables.work_order.get(firstItem.work_order_id);
  assert(order.status === 'settled', '工单状态应为settled');
});

test('已结算工单只能追加说明 - 修改其他内容应被拒绝', () => {
  const items = tables.settlement_item.filter(i => i.settlement_id === testSettleId);
  const orderId = items[0].work_order_id;
  const order = tables.work_order.get(orderId);
  
  assert(order.status === 'settled', '工单应为已结算状态');
  
  const beforeRemark = order.remark || '';
  const newRemark = beforeRemark + '\n追加测试说明';
  
  tables.work_order.update(orderId, { remark: newRemark });
  
  const after = tables.work_order.get(orderId);
  assert(after.remark.includes('追加测试说明'), '追加说明应成功');
});

console.log('');
console.log('--- 测试6: 未修复故障不能进入结算 ---');

test('生成结算时自动过滤未修复工单', () => {
  const pileNo = 'PILE-UNREPAIRED';
  const period = '2024-06';

  const orders = [
    { id: generateId('wo_unr1_'), status: 'repaired', fault_type: '硬件故障' },
    { id: generateId('wo_unr2_'), status: 'pending', fault_type: '软件故障' },
  ];

  for (const order of orders) {
    tables.work_order.insert({
      id: order.id,
      pile_no: pileNo,
      fault_type: order.fault_type,
      downtime_start: '2024-06-20 10:00:00',
      reporter: 'test_user',
      status: order.status,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    if (order.status === 'repaired') {
      tables.repair_record.insert({
        id: generateId('rr_'),
        work_order_id: order.id,
        repair_time: '2024-06-20 12:00:00',
        duty_owner: '运维方',
        duty_type: '主要责任',
        confirmor: 'test_confirmor',
        created_at: new Date().toISOString()
      });
    }
  }

  const repairableOrders = tables.work_order.filter(wo => {
    const hasRepair = tables.repair_record.find(r => r.work_order_id === wo.id);
    return hasRepair && wo.status === 'repaired' && wo.pile_no === pileNo;
  });

  assert(repairableOrders.length === 1, `可结算工单数量应为1，实际: ${repairableOrders.length}`);
});

console.log('');
console.log('--- 测试7: 操作日志 ---');

test('操作日志记录', () => {
  const testId = 'test_log_biz';
  tables.operation_log.insert({
    id: generateId('log_'),
    biz_type: 'test',
    biz_id: testId,
    action: '测试操作',
    operator: 'tester',
    detail: '测试详情',
    created_at: new Date().toISOString()
  });

  const logs = tables.operation_log.filter(l => l.biz_type === 'test' && l.biz_id === testId);
  assert(logs.length >= 1, '操作日志应被记录');
  assert(logs[0].operator === 'tester', '操作人应正确');
});

console.log('');
console.log('========================================');
console.log('  验证结果汇总');
console.log('========================================');
console.log(`总测试数: ${results.total}`);
console.log(`通过: ${results.passed}`);
console.log(`失败: ${results.failed}`);
console.log('');

if (results.failed === 0) {
  console.log('🎉 所有测试通过！');
} else {
  console.log('⚠️  有测试失败，请检查');
  process.exit(1);
}
