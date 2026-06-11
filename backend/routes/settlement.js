const express = require('express');
const router = express.Router();
const { tables, transaction, now } = require('../db/jsonDB');
const { generateId, addOperationLog, calculateDowntime, validateTimeRange, calculateDeduction, getSettlementPeriod } = require('../utils');

const SETTLE_STATUS = {
  DRAFT: 'draft',
  CONFIRMED: 'confirmed'
};

const ORDER_STATUS = {
  PENDING: 'pending',
  REPAIRED: 'repaired',
  SETTLED: 'settled'
};

router.get('/', (req, res) => {
  const { status, settlement_period, pile_no, page = 1, page_size = 20 } = req.query;
  const offset = (page - 1) * page_size;

  let list = tables.settlement.all();

  if (status) {
    list = list.filter(s => s.status === status);
  }
  if (settlement_period) {
    list = list.filter(s => s.settlement_period === settlement_period);
  }
  if (pile_no) {
    list = list.filter(s => s.pile_no && s.pile_no.includes(pile_no));
  }

  list = list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const total = list.length;
  const pageList = list.slice(offset, offset + parseInt(page_size));

  const result = pageList.map(s => ({
    ...s,
    item_count: tables.settlement_item.filter(i => i.settlement_id === s.id).length
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

router.get('/:id', (req, res) => {
  const { id } = req.params;

  const settlement = tables.settlement.get(id);
  if (!settlement) {
    return res.json({ code: 1, message: '结算单不存在' });
  }

  const items = tables.settlement_item.filter(i => i.settlement_id === id)
    .map(item => {
      const wo = tables.work_order.get(item.work_order_id);
      return {
        ...item,
        pile_no: wo?.pile_no,
        fault_desc: wo?.fault_desc,
        reporter: wo?.reporter
      };
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const logs = tables.operation_log.filter(l => l.biz_type === 'settlement' && l.biz_id === id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({
    code: 0,
    data: {
      ...settlement,
      items,
      logs
    }
  });
});

router.post('/generate', (req, res) => {
  const { settlement_period, pile_no, operator } = req.body;

  if (!settlement_period) {
    return res.json({ code: 1, message: '请指定结算周期' });
  }

  const existing = tables.settlement.find(s => 
    s.settlement_period === settlement_period && 
    s.pile_no === (pile_no || '') && 
    s.status === SETTLE_STATUS.DRAFT
  );

  if (existing) {
    return res.json({ code: 1, message: '该桩该周期已有草稿结算单，请先处理' });
  }

  let orders = tables.work_order.filter(wo => {
    const repair = tables.repair_record.find(r => r.work_order_id === wo.id);
    if (!repair) return false;
    if (wo.status !== ORDER_STATUS.REPAIRED) return false;
    
    const period = getSettlementPeriod(wo.downtime_start);
    if (period !== settlement_period) return false;
    
    if (pile_no && wo.pile_no !== pile_no) return false;
    
    return true;
  }).map(wo => {
    const repair = tables.repair_record.find(r => r.work_order_id === wo.id);
    return {
      ...wo,
      repair_time: repair.repair_time,
      duty_owner: repair.duty_owner,
      duty_type: repair.duty_type
    };
  });

  if (orders.length === 0) {
    return res.json({ code: 1, message: '没有符合条件的可结算工单' });
  }

  const timeErrors = [];
  const validOrders = [];

  for (const order of orders) {
    const check = validateTimeRange(order.downtime_start, order.repair_time);
    if (!check.valid) {
      timeErrors.push({
        work_order_id: order.id,
        pile_no: order.pile_no,
        fault_type: order.fault_type,
        reason: check.reason
      });
    } else {
      validOrders.push({ ...order, downtime_hours: check.downtime });
    }
  }

  if (timeErrors.length > 0) {
    return res.json({ 
      code: 2, 
      message: `存在${timeErrors.length}条时间异常工单，已退回`,
      data: {
        time_errors: timeErrors,
        valid_count: validOrders.length
      }
    });
  }

  const pileGroups = {};
  for (const order of validOrders) {
    const key = pile_no || order.pile_no;
    if (!pileGroups[key]) {
      pileGroups[key] = [];
    }
    pileGroups[key].push(order);
  }

  const results = [];

  for (const [pile, pileOrders] of Object.entries(pileGroups)) {
    const settleId = generateId('st_');
    let totalDowntime = 0;
    let totalDeduction = 0;

    const faultTypeCount = {};
    for (const order of pileOrders) {
      if (!faultTypeCount[order.fault_type]) {
        faultTypeCount[order.fault_type] = 0;
      }
      faultTypeCount[order.fault_type]++;
    }

    for (const order of pileOrders) {
      const isRepeat = faultTypeCount[order.fault_type] > 1;
      const dedResult = calculateDeduction(order.fault_type, order.downtime_hours, isRepeat);
      
      const itemId = generateId('si_');
      
      tables.settlement_item.insert({
        id: itemId,
        settlement_id: settleId,
        work_order_id: order.id,
        fault_type: order.fault_type,
        downtime_start: order.downtime_start,
        repair_time: order.repair_time,
        downtime: order.downtime_hours,
        duty_owner: order.duty_owner,
        duty_type: order.duty_type,
        deduction_amount: dedResult.amount,
        deduction_rule: dedResult.rule,
        is_repeat: isRepeat ? 1 : 0,
        remark: '',
        created_at: now()
      });

      totalDowntime += order.downtime_hours;
      totalDeduction += dedResult.amount;
    }

    tables.settlement.insert({
      id: settleId,
      settlement_period,
      pile_no: pile,
      total_downtime: Math.round(totalDowntime * 100) / 100,
      total_deduction: Math.round(totalDeduction * 100) / 100,
      status: SETTLE_STATUS.DRAFT,
      confirmor: null,
      confirm_time: null,
      settle_remark: '',
      created_at: now(),
      updated_at: now()
    });

    addOperationLog('settlement', settleId, '生成结算单', operator || '系统',
      `生成${settlement_period}周期结算单，共${pileOrders.length}条工单，总扣款${totalDeduction.toFixed(2)}元`);

    results.push({
      id: settleId,
      pile_no: pile,
      settlement_period,
      item_count: pileOrders.length,
      total_downtime: Math.round(totalDowntime * 100) / 100,
      total_deduction: Math.round(totalDeduction * 100) / 100
    });
  }

  res.json({
    code: 0,
    message: `成功生成${results.length}份结算单`,
    data: results
  });
});

router.post('/:id/confirm', (req, res) => {
  const { id } = req.params;
  const { confirmor, settle_remark } = req.body;

  if (!confirmor) {
    return res.json({ code: 1, message: '请指定确认人' });
  }

  const settlement = tables.settlement.get(id);
  if (!settlement) {
    return res.json({ code: 1, message: '结算单不存在' });
  }

  if (settlement.status === SETTLE_STATUS.CONFIRMED) {
    return res.json({ code: 1, message: '结算单已确认，不能重复确认' });
  }

  const items = tables.settlement_item.filter(i => i.settlement_id === id);
  if (items.length === 0) {
    return res.json({ code: 1, message: '结算单没有明细，不能确认' });
  }

  tables.settlement.update(id, {
    status: SETTLE_STATUS.CONFIRMED,
    confirmor,
    confirm_time: now(),
    settle_remark: settle_remark || '',
    updated_at: now()
  });

  for (const item of items) {
    tables.work_order.update(item.work_order_id, {
      status: ORDER_STATUS.SETTLED,
      updated_at: now()
    });
    addOperationLog('work_order', item.work_order_id, '结算确认', confirmor, 
      `工单进入结算状态，结算单：${id}`);
  }

  addOperationLog('settlement', id, '确认结算', confirmor, 
    `确认结算，共${items.length}条工单，总扣款${settlement.total_deduction.toFixed(2)}元`);

  res.json({ code: 0, message: '结算确认成功', data: { id } });
});

router.post('/:id/add-remark', (req, res) => {
  const { id } = req.params;
  const { remark, operator, item_id } = req.body;

  if (!remark) {
    return res.json({ code: 1, message: '请输入追加说明' });
  }

  const settlement = tables.settlement.get(id);
  if (!settlement) {
    return res.json({ code: 1, message: '结算单不存在' });
  }

  if (item_id) {
    const item = tables.settlement_item.get(item_id);
    if (!item || item.settlement_id !== id) {
      return res.json({ code: 1, message: '结算明细不存在' });
    }
    const newRemark = item.remark ? item.remark + '\n' + remark : remark;
    tables.settlement_item.update(item_id, { remark: newRemark });
    addOperationLog('settlement', id, '追加明细说明', operator || '系统',
      `明细${item_id}追加说明：${remark}`);
  } else {
    const newRemark = settlement.settle_remark ? settlement.settle_remark + '\n' + remark : remark;
    tables.settlement.update(id, { settle_remark: newRemark, updated_at: now() });
    addOperationLog('settlement', id, '追加说明', operator || '系统',
      `追加说明：${remark}`);
  }

  res.json({ code: 0, message: '追加说明成功' });
});

router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const { operator } = req.query;

  const settlement = tables.settlement.get(id);
  if (!settlement) {
    return res.json({ code: 1, message: '结算单不存在' });
  }

  if (settlement.status === SETTLE_STATUS.CONFIRMED) {
    return res.json({ code: 1, message: '已确认的结算单不能删除' });
  }

  const items = tables.settlement_item.filter(i => i.settlement_id === id);
  
  for (const item of items) {
    const order = tables.work_order.get(item.work_order_id);
    if (order && order.status === ORDER_STATUS.SETTLED) {
      tables.work_order.update(item.work_order_id, { status: ORDER_STATUS.REPAIRED, updated_at: now() });
    }
    tables.settlement_item.delete(item.id);
  }

  tables.settlement.delete(id);
  addOperationLog('settlement', id, '删除结算单', operator || '系统', '删除结算单');

  res.json({ code: 0, data: { id } });
});

router.get('/summary/grouped', (req, res) => {
  const { settlement_period } = req.query;

  let list = tables.settlement.all();
  if (settlement_period) {
    list = list.filter(s => s.settlement_period === settlement_period);
  }

  const groups = {};
  for (const s of list) {
    const key = `${s.settlement_period}_${s.pile_no}`;
    if (!groups[key]) {
      groups[key] = {
        pile_no: s.pile_no,
        settlement_period: s.settlement_period,
        settle_count: 0,
        total_downtime: 0,
        total_deduction: 0,
        confirmed_count: 0
      };
    }
    groups[key].settle_count++;
    groups[key].total_downtime += s.total_downtime;
    groups[key].total_deduction += s.total_deduction;
    if (s.status === 'confirmed') {
      groups[key].confirmed_count++;
    }
  }

  const summary = Object.values(groups).sort((a, b) => {
    if (a.settlement_period !== b.settlement_period) {
      return b.settlement_period.localeCompare(a.settlement_period);
    }
    return a.pile_no.localeCompare(b.pile_no);
  });

  res.json({ code: 0, data: summary });
});

module.exports = router;
