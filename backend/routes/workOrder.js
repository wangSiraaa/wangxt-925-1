const express = require('express');
const router = express.Router();
const { tables, transaction, now } = require('../db/jsonDB');
const { generateId, addOperationLog, validateTimeRange, calculateDowntime, getSettlementPeriod } = require('../utils');

const STATUS = {
  PENDING: 'pending',
  REPAIRED: 'repaired',
  SETTLED: 'settled',
  REJECTED: 'rejected'
};

router.get('/', (req, res) => {
  const { status, pile_no, page = 1, page_size = 20 } = req.query;
  const offset = (page - 1) * page_size;

  let list = tables.work_order.all();

  if (status) {
    list = list.filter(item => item.status === status);
  }
  if (pile_no) {
    list = list.filter(item => item.pile_no && item.pile_no.includes(pile_no));
  }

  list = list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const total = list.length;
  const pageList = list.slice(offset, offset + parseInt(page_size));

  const result = pageList.map(wo => {
    const repair = tables.repair_record.find(r => r.work_order_id === wo.id);
    const settleItem = tables.settlement_item.find(s => s.work_order_id === wo.id);
    return {
      ...wo,
      repair_id: repair?.id,
      repair_time: repair?.repair_time,
      duty_owner: repair?.duty_owner,
      duty_type: repair?.duty_type,
      confirmor: repair?.confirmor,
      confirm_remark: repair?.confirm_remark,
      downtime_hours: settleItem?.downtime || 0,
      deduction_amount: settleItem?.deduction_amount || 0
    };
  });

  res.json({
    code: 0,
    data: {
      list: result,
      total,
      page: parseInt(page),
      page_size: parseInt(page_size)
    }
  });
});

router.get('/:id', (req, res) => {
  const { id } = req.params;
  
  const order = tables.work_order.get(id);
  if (!order) {
    return res.json({ code: 1, message: '工单不存在' });
  }

  const repair = tables.repair_record.find(r => r.work_order_id === id);
  const settleItem = tables.settlement_item.find(s => s.work_order_id === id);

  const logs = tables.operation_log.filter(l => l.biz_type === 'work_order' && l.biz_id === id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({
    code: 0,
    data: {
      ...order,
      repair_id: repair?.id,
      repair_time: repair?.repair_time,
      duty_owner: repair?.duty_owner,
      duty_type: repair?.duty_type,
      confirmor: repair?.confirmor,
      confirm_remark: repair?.confirm_remark,
      downtime_hours: settleItem?.downtime || 0,
      deduction_amount: settleItem?.deduction_amount || 0,
      logs
    }
  });
});

router.post('/', (req, res) => {
  const { pile_no, fault_type, fault_desc, downtime_start, photo_url, reporter, remark } = req.body;

  if (!pile_no || !fault_type || !downtime_start || !reporter) {
    return res.json({ code: 1, message: '缺少必填字段' });
  }

  const id = generateId('wo_');
  const createdAt = now();
  
  const order = {
    id,
    pile_no,
    fault_type,
    fault_desc: fault_desc || '',
    downtime_start,
    photo_url: photo_url || '',
    reporter,
    status: STATUS.PENDING,
    remark: remark || '',
    created_at: createdAt,
    updated_at: createdAt
  };

  tables.work_order.insert(order);
  addOperationLog('work_order', id, '创建工单', reporter, `创建故障工单：${pile_no} - ${fault_type}`);

  res.json({ code: 0, data: order });
});

router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { fault_desc, photo_url, remark, operator } = req.body;

  const order = tables.work_order.get(id);
  if (!order) {
    return res.json({ code: 1, message: '工单不存在' });
  }

  if (order.status === STATUS.SETTLED) {
    if (fault_desc !== undefined || photo_url !== undefined) {
      return res.json({ code: 1, message: '已结算工单只能追加说明，不能修改其他内容' });
    }
    if (remark === undefined) {
      return res.json({ code: 0, message: '无需修改' });
    }
    const newRemark = order.remark ? order.remark + '\n' + remark : remark;
    tables.work_order.update(id, { remark: newRemark, updated_at: now() });
    addOperationLog('work_order', id, '追加说明', operator || '系统', `追加说明：${remark}`);
    return res.json({ code: 0, data: { id } });
  }

  const updates = { updated_at: now() };
  if (fault_desc !== undefined) updates.fault_desc = fault_desc;
  if (photo_url !== undefined) updates.photo_url = photo_url;
  if (remark !== undefined) updates.remark = remark;

  tables.work_order.update(id, updates);
  addOperationLog('work_order', id, '修改工单', operator || '系统', '修改工单信息');

  res.json({ code: 0, data: { id } });
});

router.post('/:id/confirm-repair', (req, res) => {
  const { id } = req.params;
  const { repair_time, duty_owner, duty_type, confirmor, confirm_remark } = req.body;

  if (!repair_time || !duty_owner || !duty_type || !confirmor) {
    return res.json({ code: 1, message: '缺少必填字段' });
  }

  const order = tables.work_order.get(id);
  if (!order) {
    return res.json({ code: 1, message: '工单不存在' });
  }

  if (order.status === STATUS.SETTLED) {
    return res.json({ code: 1, message: '已结算工单不能修改修复信息' });
  }

  const timeCheck = validateTimeRange(order.downtime_start, repair_time);
  if (!timeCheck.valid) {
    return res.json({ code: 1, message: `时间校验失败：${timeCheck.reason}` });
  }

  const existing = tables.repair_record.find(r => r.work_order_id === id);
  
  if (existing) {
    tables.repair_record.update(existing.id, {
      repair_time,
      duty_owner,
      duty_type,
      confirmor,
      confirm_remark: confirm_remark || ''
    });
  } else {
    const repairId = generateId('rr_');
    tables.repair_record.insert({
      id: repairId,
      work_order_id: id,
      repair_time,
      duty_owner,
      duty_type,
      confirmor,
      confirm_remark: confirm_remark || '',
      created_at: now()
    });
  }

  tables.work_order.update(id, { status: STATUS.REPAIRED, updated_at: now() });

  addOperationLog('work_order', id, '确认修复', confirmor, 
    `确认修复：责任方=${duty_owner}，责任类型=${duty_type}，停机时长=${timeCheck.downtime.toFixed(2)}小时`);

  res.json({ 
    code: 0, 
    data: { 
      id,
      downtime_hours: timeCheck.downtime
    } 
  });
});

router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const { operator } = req.query;

  const order = tables.work_order.get(id);
  if (!order) {
    return res.json({ code: 1, message: '工单不存在' });
  }

  if (order.status === STATUS.SETTLED) {
    return res.json({ code: 1, message: '已结算工单不能删除' });
  }

  const hasSettlement = tables.settlement_item.find(s => s.work_order_id === id);
  if (hasSettlement) {
    return res.json({ code: 1, message: '工单已关联结算单，不能删除' });
  }

  const repairs = tables.repair_record.filter(r => r.work_order_id === id);
  for (const r of repairs) {
    tables.repair_record.delete(r.id);
  }

  tables.work_order.delete(id);
  addOperationLog('work_order', id, '删除工单', operator || '系统', '删除故障工单');

  res.json({ code: 0, data: { id } });
});

module.exports = router;
