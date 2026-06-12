const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');
const { tables } = require('../db/jsonDB');

function generateId(prefix = '') {
  return prefix + uuidv4().replace(/-/g, '').substring(0, 16);
}

function addOperationLog(bizType, bizId, action, operator, detail = '') {
  const log = {
    id: generateId('log_'),
    biz_type: bizType,
    biz_id: bizId,
    action: action,
    operator: operator,
    detail: detail,
    created_at: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
  };
  tables.operation_log.insert(log);
}

function calculateDowntime(downtimeStart, repairTime) {
  const start = dayjs(downtimeStart);
  const end = dayjs(repairTime);
  const diffMinutes = end.diff(start, 'minute');
  return Math.max(0, diffMinutes / 60);
}

function getSettlementPeriod(dateStr) {
  return dayjs(dateStr).format('YYYY-MM');
}

function isSamePeriod(date1, date2) {
  return getSettlementPeriod(date1) === getSettlementPeriod(date2);
}

function validateTimeRange(downtimeStart, repairTime) {
  const start = dayjs(downtimeStart);
  const end = dayjs(repairTime);
  const downtime = calculateDowntime(downtimeStart, repairTime);

  if (!start.isValid() || !end.isValid()) {
    return { valid: false, reason: '时间格式不正确' };
  }
  if (end.isBefore(start)) {
    return { valid: false, reason: '修复时间早于停机开始时间' };
  }
  if (downtime <= 0) {
    return { valid: false, reason: '停机时长为零' };
  }
  return { valid: true, downtime };
}

function calculateDeduction(faultType, downtime, isRepeat = false) {
  const rule = tables.deduction_rule.find(r => r.fault_type === faultType && r.is_active === 1);
  
  if (!rule) {
    return { amount: 0, rule: '默认规则(未配置)', rate_per_hour: 0, is_repeat: isRepeat ? 1 : 0 };
  }

  let amount = downtime * rule.rate_per_hour;
  
  if (amount < rule.min_amount) {
    amount = rule.min_amount;
  }
  if (rule.max_amount && amount > rule.max_amount) {
    amount = rule.max_amount;
  }

  if (isRepeat) {
    amount = amount * rule.repeat_penalty;
  }

  return {
    amount: Math.round(amount * 100) / 100,
    rule: rule.rule_name,
    rate_per_hour: rule.rate_per_hour,
    is_repeat: isRepeat ? 1 : 0
  };
}

function isWithinWarranty(repairTime, newFaultTime, faultType) {
  const rule = tables.deduction_rule.find(r => r.fault_type === faultType && r.is_active === 1);
  const warrantyMonths = rule ? (rule.warranty_months || 0) : 0;

  if (warrantyMonths <= 0) {
    return { within: false, warrantyMonths: 0 };
  }

  const repair = dayjs(repairTime);
  const fault = dayjs(newFaultTime);
  const warrantyEnd = repair.add(warrantyMonths, 'month');

  return {
    within: fault.isBefore(warrantyEnd) || fault.isSame(warrantyEnd, 'second'),
    warrantyMonths,
    warrantyEnd: warrantyEnd.format('YYYY-MM-DD HH:mm:ss')
  };
}

function detectRecurrence(newWorkOrderId) {
  const newOrder = tables.work_order.get(newWorkOrderId);
  if (!newOrder) return [];

  const newRepair = tables.repair_record.find(r => r.work_order_id === newWorkOrderId);
  if (!newRepair) return [];

  const previousOrders = tables.work_order.filter(wo => {
    if (wo.id === newWorkOrderId) return false;
    if (wo.pile_no !== newOrder.pile_no) return false;
    if (wo.fault_type !== newOrder.fault_type) return false;
    if (wo.status !== 'repaired' && wo.status !== 'settled') return false;

    const prevRepair = tables.repair_record.find(r => r.work_order_id === wo.id);
    if (!prevRepair) return false;

    return true;
  });

  const recurrences = [];

  for (const prevOrder of previousOrders) {
    const prevRepair = tables.repair_record.find(r => r.work_order_id === prevOrder.id);

    const warranty = isWithinWarranty(prevRepair.repair_time, newOrder.downtime_start, newOrder.fault_type);

    const existingChain = tables.recurrence_chain.find(rc =>
      rc.original_work_order_id === prevOrder.id && rc.recurrence_work_order_id === newWorkOrderId
    );
    if (existingChain) continue;

    const prevDowntime = calculateDowntime(prevOrder.downtime_start, prevRepair.repair_time);
    const newDowntime = calculateDowntime(newOrder.downtime_start, newRepair.repair_time);

    recurrences.push({
      original_work_order_id: prevOrder.id,
      recurrence_work_order_id: newWorkOrderId,
      pile_no: newOrder.pile_no,
      fault_type: newOrder.fault_type,
      is_warranty: warranty.within ? 1 : 0,
      warranty_months: warranty.warrantyMonths,
      original_downtime: Math.round(prevDowntime * 100) / 100,
      recurrence_downtime: Math.round(newDowntime * 100) / 100,
      total_downtime: Math.round((prevDowntime + newDowntime) * 100) / 100,
      original_duty_owner: prevRepair.duty_owner,
      recurrence_duty_owner: newRepair.duty_owner,
      same_duty: prevRepair.duty_owner === newRepair.duty_owner && prevRepair.duty_type === newRepair.duty_type ? 1 : 0,
      warranty_end: warranty.warrantyEnd || null
    });
  }

  return recurrences;
}

function calculateAdjustmentAmounts(recurrenceInfo) {
  const rule = tables.deduction_rule.find(r => r.fault_type === recurrenceInfo.fault_type && r.is_active === 1);
  if (!rule) {
    return { originalAmount: 0, newAmount: 0, adjustmentAmount: 0, rule: '默认规则(未配置)' };
  }

  const originalItem = tables.settlement_item.find(si => si.work_order_id === recurrenceInfo.original_work_order_id);
  const originalAmount = originalItem ? originalItem.deduction_amount : 0;

  const warrantyDiscount = recurrenceInfo.is_warranty ? (rule.warranty_discount || 0) : 0;

  let newRecurrenceBase = recurrenceInfo.recurrence_downtime * rule.rate_per_hour;
  if (newRecurrenceBase < rule.min_amount) newRecurrenceBase = rule.min_amount;
  if (rule.max_amount && newRecurrenceBase > rule.max_amount) newRecurrenceBase = rule.max_amount;

  let newRecurrenceAmount = newRecurrenceBase * rule.repeat_penalty;

  const originalDutyOwner = recurrenceInfo.original_duty_owner;
  const recurrenceDutyOwner = recurrenceInfo.recurrence_duty_owner;
  const sameDuty = recurrenceInfo.same_duty;

  if (recurrenceInfo.is_warranty && warrantyDiscount > 0) {
    if (sameDuty) {
      const combinedDowntime = recurrenceInfo.total_downtime;
      let combinedBase = combinedDowntime * rule.rate_per_hour;
      if (combinedBase < rule.min_amount) combinedBase = rule.min_amount;
      if (rule.max_amount && combinedBase > rule.max_amount) combinedBase = rule.max_amount;
      const combinedAmount = Math.round(combinedBase * rule.repeat_penalty * 100) / 100;
      const warrantyReduction = Math.round(originalAmount * warrantyDiscount * 100) / 100;
      newRecurrenceAmount = Math.round((combinedAmount - warrantyReduction) * 100) / 100;
    } else {
      const recurrenceItemBase = newRecurrenceAmount;
      const warrantyReduction = Math.round(originalAmount * warrantyDiscount * 100) / 100;
      newRecurrenceAmount = Math.round((recurrenceItemBase - warrantyReduction) * 100) / 100;
    }
  }

  newRecurrenceAmount = Math.max(0, Math.round(newRecurrenceAmount * 100) / 100);
  const adjustmentAmount = Math.round((newRecurrenceAmount - originalAmount) * 100) / 100;

  return {
    originalAmount,
    newAmount: newRecurrenceAmount,
    adjustmentAmount,
    warrantyDiscount,
    rule: rule.rule_name,
    sameDuty
  };
}

function getRecurrenceChain(workOrderId) {
  const asOriginal = tables.recurrence_chain.filter(rc => rc.original_work_order_id === workOrderId);
  const asRecurrence = tables.recurrence_chain.filter(rc => rc.recurrence_work_order_id === workOrderId);

  const chain = [];
  const visited = new Set();

  let current = workOrderId;
  while (current) {
    if (visited.has(current)) break;
    visited.add(current);

    const wo = tables.work_order.get(current);
    if (!wo) break;

    const repair = tables.repair_record.find(r => r.work_order_id === current);
    const settleItem = tables.settlement_item.find(si => si.work_order_id === current);

    chain.push({
      work_order_id: current,
      pile_no: wo.pile_no,
      fault_type: wo.fault_type,
      downtime_start: wo.downtime_start,
      repair_time: repair?.repair_time || null,
      duty_owner: repair?.duty_owner || null,
      duty_type: repair?.duty_type || null,
      status: wo.status,
      downtime: settleItem?.downtime || (repair ? calculateDowntime(wo.downtime_start, repair.repair_time) : 0),
      deduction_amount: settleItem?.deduction_amount || 0
    });

    const nextLink = tables.recurrence_chain.find(rc => rc.original_work_order_id === current);
    current = nextLink ? nextLink.recurrence_work_order_id : null;
  }

  const prevLink = tables.recurrence_chain.find(rc => rc.recurrence_work_order_id === workOrderId);
  if (prevLink && !visited.has(prevLink.original_work_order_id)) {
    const prevChain = getRecurrenceChain(prevLink.original_work_order_id);
    const newEntries = prevChain.filter(item => !visited.has(item.work_order_id));
    chain.unshift(...newEntries);
  }

  return chain;
}

module.exports = {
  generateId,
  addOperationLog,
  calculateDowntime,
  getSettlementPeriod,
  isSamePeriod,
  validateTimeRange,
  calculateDeduction,
  isWithinWarranty,
  detectRecurrence,
  calculateAdjustmentAmounts,
  getRecurrenceChain,
};
