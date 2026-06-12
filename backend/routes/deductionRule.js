const express = require('express');
const router = express.Router();
const { tables, now } = require('../db/jsonDB');
const { generateId, addOperationLog } = require('../utils');

router.get('/', (req, res) => {
  const rules = tables.deduction_rule.all().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ code: 0, data: rules });
});

router.get('/:id', (req, res) => {
  const rule = tables.deduction_rule.get(req.params.id);
  if (!rule) {
    return res.json({ code: 1, message: '规则不存在' });
  }
  res.json({ code: 0, data: rule });
});

router.post('/', (req, res) => {
  const { fault_type, rule_name, rate_per_hour, min_amount, max_amount, repeat_penalty, warranty_months, warranty_discount, operator } = req.body;

  if (!fault_type || !rule_name || rate_per_hour === undefined) {
    return res.json({ code: 1, message: '缺少必填字段' });
  }

  const id = generateId('rule_');
  tables.deduction_rule.insert({
    id,
    fault_type,
    rule_name,
    rate_per_hour: Number(rate_per_hour) || 0,
    min_amount: Number(min_amount) || 0,
    max_amount: max_amount ? Number(max_amount) : null,
    repeat_penalty: Number(repeat_penalty) || 1.0,
    warranty_months: Number(warranty_months) || 0,
    warranty_discount: Number(warranty_discount) || 0,
    is_active: 1,
    created_at: now()
  });

  addOperationLog('deduction_rule', id, '创建规则', operator || '系统', `创建扣款规则：${rule_name}`);

  res.json({ code: 0, data: { id } });
});

router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { rule_name, rate_per_hour, min_amount, max_amount, repeat_penalty, warranty_months, warranty_discount, is_active, operator } = req.body;

  const rule = tables.deduction_rule.get(id);
  if (!rule) {
    return res.json({ code: 1, message: '规则不存在' });
  }

  const updates = {};
  if (rule_name !== undefined) updates.rule_name = rule_name;
  if (rate_per_hour !== undefined) updates.rate_per_hour = Number(rate_per_hour);
  if (min_amount !== undefined) updates.min_amount = Number(min_amount);
  if (max_amount !== undefined) updates.max_amount = max_amount ? Number(max_amount) : null;
  if (repeat_penalty !== undefined) updates.repeat_penalty = Number(repeat_penalty);
  if (warranty_months !== undefined) updates.warranty_months = Number(warranty_months);
  if (warranty_discount !== undefined) updates.warranty_discount = Number(warranty_discount);
  if (is_active !== undefined) updates.is_active = is_active ? 1 : 0;

  tables.deduction_rule.update(id, updates);
  addOperationLog('deduction_rule', id, '修改规则', operator || '系统', '修改扣款规则');

  res.json({ code: 0, data: { id } });
});

router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const { operator } = req.query;

  const rule = tables.deduction_rule.get(id);
  if (!rule) {
    return res.json({ code: 1, message: '规则不存在' });
  }

  tables.deduction_rule.delete(id);
  addOperationLog('deduction_rule', id, '删除规则', operator || '系统', '删除扣款规则');

  res.json({ code: 0, data: { id } });
});

module.exports = router;
