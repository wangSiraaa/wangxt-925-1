const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '../data/db.json');
const dataDir = path.join(__dirname, '../data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let data = {
  work_order: [],
  repair_record: [],
  settlement: [],
  settlement_item: [],
  operation_log: [],
  deduction_rule: [],
  recurrence_chain: [],
  settlement_adjustment: [],
  adjustment_item: []
};

function loadData() {
  if (fs.existsSync(dbPath)) {
    try {
      const raw = fs.readFileSync(dbPath, 'utf8');
      data = JSON.parse(raw);
    } catch (e) {
      console.error('加载数据库失败，使用默认数据');
      initDefaultData();
    }
  } else {
    initDefaultData();
  }
}

function saveData() {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

function initDefaultData() {
  data.deduction_rule = [
    { id: 'rule001', fault_type: '硬件故障', rule_name: '硬件故障扣款标准', rate_per_hour: 50, min_amount: 100, max_amount: 2000, repeat_penalty: 1.5, warranty_months: 6, warranty_discount: 0.5, is_active: 1, created_at: new Date().toISOString() },
    { id: 'rule002', fault_type: '软件故障', rule_name: '软件故障扣款标准', rate_per_hour: 30, min_amount: 50, max_amount: 1000, repeat_penalty: 1.2, warranty_months: 3, warranty_discount: 0.3, is_active: 1, created_at: new Date().toISOString() },
    { id: 'rule003', fault_type: '网络故障', rule_name: '网络故障扣款标准', rate_per_hour: 40, min_amount: 80, max_amount: 1500, repeat_penalty: 1.3, warranty_months: 3, warranty_discount: 0.4, is_active: 1, created_at: new Date().toISOString() },
    { id: 'rule004', fault_type: '其他', rule_name: '其他故障扣款标准', rate_per_hour: 20, min_amount: 30, max_amount: 500, repeat_penalty: 1.0, warranty_months: 1, warranty_discount: 0.2, is_active: 1, created_at: new Date().toISOString() },
  ];
  saveData();
}

loadData();

function now() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

class Table {
  constructor(name) {
    this.name = name;
  }

  all() {
    return [...data[this.name]];
  }

  get(id) {
    return data[this.name].find(item => item.id === id);
  }

  filter(predicate) {
    return data[this.name].filter(predicate);
  }

  find(predicate) {
    return data[this.name].find(predicate);
  }

  insert(item) {
    data[this.name].push(item);
    saveData();
    return item;
  }

  update(id, updates) {
    const idx = data[this.name].findIndex(item => item.id === id);
    if (idx !== -1) {
      data[this.name][idx] = { ...data[this.name][idx], ...updates };
      saveData();
      return data[this.name][idx];
    }
    return null;
  }

  delete(id) {
    const idx = data[this.name].findIndex(item => item.id === id);
    if (idx !== -1) {
      const deleted = data[this.name].splice(idx, 1)[0];
      saveData();
      return deleted;
    }
    return null;
  }

  count(predicate) {
    if (predicate) {
      return data[this.name].filter(predicate).length;
    }
    return data[this.name].length;
  }

  sortBy(field, desc = true) {
    return [...data[this.name]].sort((a, b) => {
      if (a[field] < b[field]) return desc ? 1 : -1;
      if (a[field] > b[field]) return desc ? -1 : 1;
      return 0;
    });
  }
}

const tables = {
  work_order: new Table('work_order'),
  repair_record: new Table('repair_record'),
  settlement: new Table('settlement'),
  settlement_item: new Table('settlement_item'),
  operation_log: new Table('operation_log'),
  deduction_rule: new Table('deduction_rule'),
  recurrence_chain: new Table('recurrence_chain'),
  settlement_adjustment: new Table('settlement_adjustment'),
  adjustment_item: new Table('adjustment_item'),
};

function transaction(fn) {
  const backup = JSON.parse(JSON.stringify(data));
  try {
    fn();
    saveData();
    return true;
  } catch (e) {
    data = backup;
    saveData();
    throw e;
  }
}

module.exports = {
  tables,
  transaction,
  now,
  _raw: data,
  _reset: () => {
    data = { work_order: [], repair_record: [], settlement: [], settlement_item: [], operation_log: [], deduction_rule: [], recurrence_chain: [], settlement_adjustment: [], adjustment_item: [] };
    initDefaultData();
  }
};
