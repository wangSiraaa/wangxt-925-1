const express = require('express');
const router = express.Router();
const { tables, transaction, now } = require('../db/jsonDB');
const {
  generateId,
  addOperationLog,
  detectRecurrence,
  calculateAdjustmentAmounts,
  getRecurrenceChain,
  calculateDowntime
} = require('../utils');

router.get('/chain/:workOrderId', (req, res) => {
  const { workOrderId } = req.params;

  const wo = tables.work_order.get(workOrderId);
  if (!wo) {
    return res.json({ code: 1, message: '工单不存在' });
  }

  const chain = getRecurrenceChain(workOrderId);
  const chainRecords = tables.recurrence_chain.filter(
    rc => rc.original_work_order_id === workOrderId || rc.recurrence_work_order_id === workOrderId
  );

  res.json({
    code: 0,
    data: {
      work_order_id: workOrderId,
      pile_no: wo.pile_no,
      fault_type: wo.fault_type,
      chain,
      chain_records: chainRecords
    }
  });
});

router.post('/detect', (req, res) => {
  const { work_order_id } = req.body;

  if (!work_order_id) {
    return res.json({ code: 1, message: '请指定工单ID' });
  }

  const wo = tables.work_order.get(work_order_id);
  if (!wo) {
    return res.json({ code: 1, message: '工单不存在' });
  }

  if (wo.status !== 'repaired' && wo.status !== 'settled') {
    return res.json({ code: 1, message: '未修复工单不能参与复发判定' });
  }

  const repair = tables.repair_record.find(r => r.work_order_id === work_order_id);
  if (!repair) {
    return res.json({ code: 1, message: '工单无修复记录' });
  }

  const recurrences = detectRecurrence(work_order_id);

  res.json({
    code: 0,
    data: {
      work_order_id,
      pile_no: wo.pile_no,
      fault_type: wo.fault_type,
      recurrence_count: recurrences.length,
      recurrences
    }
  });
});

router.post('/generate-adjustment', (req, res) => {
  const { recurrence_chain_id, operator } = req.body;

  if (!recurrence_chain_id) {
    return res.json({ code: 1, message: '请指定复发链路ID' });
  }

  const chainRecord = tables.recurrence_chain.get(recurrence_chain_id);
  if (!chainRecord) {
    return res.json({ code: 1, message: '复发链路不存在' });
  }

  if (chainRecord.status === 'adjusted') {
    return res.json({ code: 1, message: '该复发链路已生成调整单，不能重复生成' });
  }

  const originalItem = tables.settlement_item.find(
    si => si.work_order_id === chainRecord.original_work_order_id
  );
  if (!originalItem) {
    return res.json({ code: 1, message: '原工单未在结算明细中，无法生成调整单' });
  }

  const originalSettlement = tables.settlement.get(originalItem.settlement_id);
  if (!originalSettlement) {
    return res.json({ code: 1, message: '原结算单不存在' });
  }

  if (originalSettlement.status !== 'confirmed') {
    return res.json({ code: 1, message: '原结算单未确认，只能修改原结算单而非生成调整单' });
  }

  const existingAdj = tables.settlement_adjustment.find(
    sa => sa.recurrence_chain_id === recurrence_chain_id
  );
  if (existingAdj) {
    return res.json({ code: 1, message: '该复发链路已存在调整单，不能重复生成' });
  }

  const adjCalc = calculateAdjustmentAmounts(chainRecord);

  const recurrenceRepair = tables.repair_record.find(
    r => r.work_order_id === chainRecord.recurrence_work_order_id
  );

  const adjId = generateId('adj_');

  const originalItemId = originalItem.id;

  tables.adjustment_item.insert({
    id: generateId('ai_'),
    adjustment_id: adjId,
    original_item_id: originalItemId,
    work_order_id: chainRecord.recurrence_work_order_id,
    fault_type: chainRecord.fault_type,
    original_downtime: chainRecord.original_downtime,
    recurrence_downtime: chainRecord.recurrence_downtime,
    total_downtime: chainRecord.total_downtime,
    duty_owner: recurrenceRepair ? recurrenceRepair.duty_owner : '',
    duty_type: recurrenceRepair ? recurrenceRepair.duty_type : '',
    original_deduction_amount: adjCalc.originalAmount,
    new_deduction_amount: adjCalc.newAmount,
    adjustment_amount: adjCalc.adjustmentAmount,
    same_duty: chainRecord.same_duty,
    warranty_discount: adjCalc.warrantyDiscount || 0,
    remark: chainRecord.same_duty
      ? '同责任方：停机叠加+质保减免重算'
      : '不同责任方：明细独立保留+质保减免',
    created_at: now()
  });

  tables.settlement_adjustment.insert({
    id: adjId,
    original_settlement_id: originalItem.settlement_id,
    recurrence_chain_id,
    adjustment_type: 'warranty_recurrence',
    original_total_deduction: originalSettlement.total_deduction,
    adjustment_amount: adjCalc.adjustmentAmount,
    new_total_deduction: Math.round((originalSettlement.total_deduction + adjCalc.adjustmentAmount) * 100) / 100,
    status: 'draft',
    operator: operator || '系统',
    created_at: now(),
    confirmed_at: null
  });

  tables.recurrence_chain.update(recurrence_chain_id, { status: 'adjusted' });

  addOperationLog('settlement_adjustment', adjId, '生成调整单', operator || '系统',
    `质保复发调整：原结算${originalItem.settlement_id}，调整金额¥${adjCalc.adjustmentAmount.toFixed(2)}，${chainRecord.same_duty ? '同责任方' : '不同责任方保留明细'}`);

  addOperationLog('recurrence_chain', recurrence_chain_id, '生成调整单', operator || '系统',
    `复发链路已生成调整单${adjId}`);

  res.json({
    code: 0,
    message: '调整单生成成功',
    data: {
      adjustment_id: adjId,
      original_settlement_id: originalItem.settlement_id,
      original_amount: adjCalc.originalAmount,
      adjustment_amount: adjCalc.adjustmentAmount,
      new_amount: adjCalc.newAmount,
      same_duty: chainRecord.same_duty
    }
  });
});

router.get('/adjustments', (req, res) => {
  const { status, page = 1, page_size = 20 } = req.query;
  const offset = (page - 1) * page_size;

  let list = tables.settlement_adjustment.all();

  if (status) {
    list = list.filter(a => a.status === status);
  }

  list = list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const total = list.length;
  const pageList = list.slice(offset, offset + parseInt(page_size));

  const result = pageList.map(adj => ({
    ...adj,
    item_count: tables.adjustment_item.filter(i => i.adjustment_id === adj.id).length
  }));

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

router.get('/adjustments/:id', (req, res) => {
  const { id } = req.params;

  const adjustment = tables.settlement_adjustment.get(id);
  if (!adjustment) {
    return res.json({ code: 1, message: '调整单不存在' });
  }

  const items = tables.adjustment_item.filter(i => i.adjustment_id === id);

  const logs = tables.operation_log.filter(l => l.biz_type === 'settlement_adjustment' && l.biz_id === id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const chainRecord = tables.recurrence_chain.get(adjustment.recurrence_chain_id);
  const chain = chainRecord ? getRecurrenceChain(chainRecord.original_work_order_id) : [];

  res.json({
    code: 0,
    data: {
      ...adjustment,
      items,
      chain,
      chain_record: chainRecord,
      logs
    }
  });
});

router.post('/adjustments/:id/confirm', (req, res) => {
  const { id } = req.params;
  const { confirmor } = req.body;

  if (!confirmor) {
    return res.json({ code: 1, message: '请指定确认人' });
  }

  const adjustment = tables.settlement_adjustment.get(id);
  if (!adjustment) {
    return res.json({ code: 1, message: '调整单不存在' });
  }

  if (adjustment.status === 'confirmed') {
    return res.json({ code: 1, message: '调整单已确认，不能重复确认' });
  }

  const items = tables.adjustment_item.filter(i => i.adjustment_id === id);
  if (items.length === 0) {
    return res.json({ code: 1, message: '调整单没有明细' });
  }

  tables.settlement_adjustment.update(id, {
    status: 'confirmed',
    confirmed_at: now()
  });

  const originalSettlement = tables.settlement.get(adjustment.original_settlement_id);
  if (originalSettlement) {
    addOperationLog('settlement', adjustment.original_settlement_id, '收到调整单', confirmor,
      `调整单${id}确认，调整金额¥${adjustment.adjustment_amount.toFixed(2)}，原结算金额不变`);
  }

  addOperationLog('settlement_adjustment', id, '确认调整单', confirmor,
    `确认调整单，调整金额¥${adjustment.adjustment_amount.toFixed(2)}，原结算¥${adjustment.original_total_deduction.toFixed(2)}保持不变`);

  res.json({ code: 0, message: '调整单确认成功', data: { id } });
});

router.post('/confirm-repair-and-detect', (req, res) => {
  const { work_order_id, repair_time, duty_owner, duty_type, confirmor, confirm_remark } = req.body;

  if (!work_order_id || !repair_time || !duty_owner || !duty_type || !confirmor) {
    return res.json({ code: 1, message: '缺少必填字段' });
  }

  const order = tables.work_order.get(work_order_id);
  if (!order) {
    return res.json({ code: 1, message: '工单不存在' });
  }

  if (order.status !== 'pending' && order.status !== 'repaired') {
    return res.json({ code: 1, message: '工单状态不允许确认修复' });
  }

  const existingRepair = tables.repair_record.find(r => r.work_order_id === work_order_id);

  if (existingRepair) {
    tables.repair_record.update(existingRepair.id, {
      repair_time, duty_owner, duty_type,
      confirmor, confirm_remark: confirm_remark || ''
    });
  } else {
    tables.repair_record.insert({
      id: generateId('rr_'),
      work_order_id, repair_time, duty_owner, duty_type,
      confirmor, confirm_remark: confirm_remark || '',
      created_at: now()
    });
  }

  tables.work_order.update(work_order_id, { status: 'repaired', updated_at: now() });

  addOperationLog('work_order', work_order_id, '确认修复', confirmor,
    `确认修复：责任方=${duty_owner}，责任类型=${duty_type}`);

  const recurrences = detectRecurrence(work_order_id);

  const savedChains = [];
  for (const rc of recurrences) {
    const chainId = generateId('rc_');
    tables.recurrence_chain.insert({
      id: chainId,
      original_work_order_id: rc.original_work_order_id,
      recurrence_work_order_id: rc.recurrence_work_order_id,
      pile_no: rc.pile_no,
      fault_type: rc.fault_type,
      is_warranty: rc.is_warranty,
      warranty_months: rc.warranty_months,
      original_downtime: rc.original_downtime,
      recurrence_downtime: rc.recurrence_downtime,
      total_downtime: rc.total_downtime,
      original_duty_owner: rc.original_duty_owner,
      recurrence_duty_owner: rc.recurrence_duty_owner,
      same_duty: rc.same_duty,
      warranty_end: rc.warranty_end,
      status: 'detected',
      created_at: now()
    });

    addOperationLog('recurrence_chain', chainId, '检测到复发', confirmor,
      `桩号${rc.pile_no} ${rc.fault_type}复发，质保期内=${rc.is_warranty ? '是' : '否'}，${rc.same_duty ? '同责任方' : '不同责任方'}`);

    savedChains.push({ id: chainId, ...rc });
  }

  res.json({
    code: 0,
    data: {
      work_order_id,
      status: 'repaired',
      recurrence_detected: recurrences.length > 0,
      recurrence_count: recurrences.length,
      recurrence_chains: savedChains
    }
  });
});

module.exports = router;
