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
    return { amount: 0, rule: '默认规则(未配置)' };
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

module.exports = {
  generateId,
  addOperationLog,
  calculateDowntime,
  getSettlementPeriod,
  isSamePeriod,
  validateTimeRange,
  calculateDeduction,
};
