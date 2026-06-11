const { tables } = require('../db/jsonDB');
const { generateId, calculateDowntime, calculateDeduction } = require('../utils');

const now = new Date();
const formatDate = (d) => {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

console.log('========================================');
console.log('  初始化演示数据');
console.log('========================================\n');

function initDemoData() {
  const period = '2024-06';
  const createdAt = formatDate(now);

  const orders = [
    {
      id: generateId('wo_demo1_'),
      pile_no: 'PILE-A01',
      fault_type: '硬件故障',
      fault_desc: '充电模块损坏，无法正常输出电流',
      downtime_start: '2024-06-05 08:30:00',
      repair_time: '2024-06-05 11:45:00',
      reporter: '运维员_张工',
      duty_owner: '设备厂商',
      duty_type: '主要责任',
      confirmor: '站长_李经理',
      status: 'repaired'
    },
    {
      id: generateId('wo_demo2_'),
      pile_no: 'PILE-A01',
      fault_type: '硬件故障',
      fault_desc: '同一模块再次故障，疑似质量问题',
      downtime_start: '2024-06-12 14:00:00',
      repair_time: '2024-06-12 16:30:00',
      reporter: '运维员_张工',
      duty_owner: '运维方',
      duty_type: '次要责任',
      confirmor: '站长_李经理',
      status: 'repaired'
    },
    {
      id: generateId('wo_demo3_'),
      pile_no: 'PILE-A01',
      fault_type: '软件故障',
      fault_desc: '系统升级后死机',
      downtime_start: '2024-06-08 10:00:00',
      repair_time: '2024-06-08 10:45:00',
      reporter: '运维员_张工',
      duty_owner: '运维方',
      duty_type: '主要责任',
      confirmor: '站长_李经理',
      status: 'repaired'
    },
    {
      id: generateId('wo_demo4_'),
      pile_no: 'PILE-B02',
      fault_type: '网络故障',
      fault_desc: '网络连接不稳定，频繁断连',
      downtime_start: '2024-06-10 09:00:00',
      repair_time: '2024-06-10 12:00:00',
      reporter: '运维员_王工',
      duty_owner: '第三方',
      duty_type: '主要责任',
      confirmor: '站长_李经理',
      status: 'repaired'
    },
    {
      id: generateId('wo_demo5_'),
      pile_no: 'PILE-C03',
      fault_type: '硬件故障',
      fault_desc: '显示屏幕碎裂',
      downtime_start: '2024-06-15 08:00:00',
      repair_time: null,
      reporter: '运维员_张工',
      status: 'pending'
    },
    {
      id: generateId('wo_demo6_'),
      pile_no: 'PILE-D04',
      fault_type: '其他',
      fault_desc: '时间异常测试 - 修复时间早于开始时间',
      downtime_start: '2024-06-20 14:00:00',
      repair_time: '2024-06-20 10:00:00',
      reporter: '运维员_王工',
      duty_owner: '运维方',
      duty_type: '主要责任',
      confirmor: '站长_李经理',
      status: 'repaired'
    },
    {
      id: generateId('wo_demo7_'),
      pile_no: 'PILE-A01',
      fault_type: '网络故障',
      fault_desc: '网线松动',
      downtime_start: '2024-06-18 16:20:00',
      repair_time: '2024-06-18 16:20:00',
      reporter: '运维员_王工',
      duty_owner: '运维方',
      duty_type: '次要责任',
      confirmor: '站长_李经理',
      status: 'repaired'
    },
  ];

  for (const order of orders) {
    tables.work_order.insert({
      id: order.id,
      pile_no: order.pile_no,
      fault_type: order.fault_type,
      fault_desc: order.fault_desc,
      downtime_start: order.downtime_start,
      photo_url: '',
      reporter: order.reporter,
      status: order.status,
      remark: '',
      created_at: createdAt,
      updated_at: createdAt
    });

    if (order.repair_time) {
      tables.repair_record.insert({
        id: generateId('rr_'),
        work_order_id: order.id,
        repair_time: order.repair_time,
        duty_owner: order.duty_owner,
        duty_type: order.duty_type,
        confirmor: order.confirmor,
        confirm_remark: '',
        created_at: createdAt
      });
    }
  }

  console.log('✅ 已创建演示工单数据');
  console.log(`   - 共 ${orders.length} 条工单`);
  console.log(`   - PILE-A01: 3条已修复(2条硬件故障重复+1条软件故障) + 用于验证重复故障合并`);
  console.log(`   - PILE-B02: 1条已修复(网络故障)`);
  console.log(`   - PILE-C03: 1条待修复 - 用于验证未修复不能结算`);
  console.log(`   - PILE-D04: 1条时间异常(修复早于开始) - 用于验证时间异常退回`);
  console.log(`   - PILE-A01 还有1条时长为零的 - 用于验证零时长退回`);
  console.log('');

  console.log('📋 验证场景说明：');
  console.log('   1. 未修复故障不能进入结算');
  console.log('      → PILE-C03 的 pending 工单不会出现在结算中');
  console.log('');
  console.log('   2. 时间异常工单要退回');
  console.log('      → PILE-D04 修复时间早于开始时间，生成结算时会报错');
  console.log('      → PILE-A01 16:20那条时长为零，生成结算时会报错');
  console.log('');
  console.log('   3. 同桩同周期重复故障合并展示');
  console.log('      → PILE-A01 的2条硬件故障标记为"重复"并加罚');
  console.log('      → 但责任不同的明细仍然分别保留');
  console.log('');
  console.log('   4. 结算确认后只能追加说明');
  console.log('      → 确认后工单状态变为 settled');
  console.log('      → 不能修改金额，只能追加说明');
  console.log('');

  console.log('🎉 演示数据初始化完成！');
  console.log('');
}

try {
  initDemoData();
} catch (e) {
  console.error('初始化失败:', e.message);
  process.exit(1);
}
