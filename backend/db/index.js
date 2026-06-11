const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '../data/ops_settlement.db');
const dataDir = path.join(__dirname, '../data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDatabase() {
  const initSql = `
    -- 故障工单表
    CREATE TABLE IF NOT EXISTS work_order (
      id TEXT PRIMARY KEY,
      pile_no TEXT NOT NULL,
      fault_type TEXT NOT NULL,
      fault_desc TEXT,
      downtime_start TEXT NOT NULL,
      photo_url TEXT,
      reporter TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      remark TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    -- 修复记录表
    CREATE TABLE IF NOT EXISTS repair_record (
      id TEXT PRIMARY KEY,
      work_order_id TEXT NOT NULL,
      repair_time TEXT NOT NULL,
      duty_owner TEXT NOT NULL,
      duty_type TEXT NOT NULL,
      confirmor TEXT NOT NULL,
      confirm_remark TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (work_order_id) REFERENCES work_order(id) ON DELETE CASCADE
    );

    -- 结算单表
    CREATE TABLE IF NOT EXISTS settlement (
      id TEXT PRIMARY KEY,
      settlement_period TEXT NOT NULL,
      pile_no TEXT NOT NULL,
      total_downtime REAL NOT NULL DEFAULT 0,
      total_deduction REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      confirmor TEXT,
      confirm_time TEXT,
      settle_remark TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    -- 结算明细表
    CREATE TABLE IF NOT EXISTS settlement_item (
      id TEXT PRIMARY KEY,
      settlement_id TEXT NOT NULL,
      work_order_id TEXT NOT NULL,
      fault_type TEXT NOT NULL,
      downtime_start TEXT NOT NULL,
      repair_time TEXT,
      downtime REAL NOT NULL DEFAULT 0,
      duty_owner TEXT,
      duty_type TEXT,
      deduction_amount REAL NOT NULL DEFAULT 0,
      deduction_rule TEXT,
      is_repeat INTEGER NOT NULL DEFAULT 0,
      remark TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (settlement_id) REFERENCES settlement(id) ON DELETE CASCADE,
      FOREIGN KEY (work_order_id) REFERENCES work_order(id)
    );

    -- 操作日志表
    CREATE TABLE IF NOT EXISTS operation_log (
      id TEXT PRIMARY KEY,
      biz_type TEXT NOT NULL,
      biz_id TEXT NOT NULL,
      action TEXT NOT NULL,
      operator TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    -- 扣款规则表
    CREATE TABLE IF NOT EXISTS deduction_rule (
      id TEXT PRIMARY KEY,
      fault_type TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      rate_per_hour REAL NOT NULL DEFAULT 0,
      min_amount REAL NOT NULL DEFAULT 0,
      max_amount REAL,
      repeat_penalty REAL NOT NULL DEFAULT 1.0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_work_order_pile_no ON work_order(pile_no);
    CREATE INDEX IF NOT EXISTS idx_work_order_status ON work_order(status);
    CREATE INDEX IF NOT EXISTS idx_settlement_period ON settlement(settlement_period);
    CREATE INDEX IF NOT EXISTS idx_settlement_pile_no ON settlement(pile_no);
    CREATE INDEX IF NOT EXISTS idx_settlement_item_settlement ON settlement_item(settlement_id);
    CREATE INDEX IF NOT EXISTS idx_operation_log_biz ON operation_log(biz_type, biz_id);
  `;

  db.exec(initSql);

  const ruleCount = db.prepare('SELECT COUNT(*) as cnt FROM deduction_rule').get().cnt;
  if (ruleCount === 0) {
    const insertRule = db.prepare(`
      INSERT INTO deduction_rule (id, fault_type, rule_name, rate_per_hour, min_amount, max_amount, repeat_penalty)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const rules = [
      { id: 'rule001', fault_type: '硬件故障', rule_name: '硬件故障扣款标准', rate_per_hour: 50, min_amount: 100, max_amount: 2000, repeat_penalty: 1.5 },
      { id: 'rule002', fault_type: '软件故障', rule_name: '软件故障扣款标准', rate_per_hour: 30, min_amount: 50, max_amount: 1000, repeat_penalty: 1.2 },
      { id: 'rule003', fault_type: '网络故障', rule_name: '网络故障扣款标准', rate_per_hour: 40, min_amount: 80, max_amount: 1500, repeat_penalty: 1.3 },
      { id: 'rule004', fault_type: '其他', rule_name: '其他故障扣款标准', rate_per_hour: 20, min_amount: 30, max_amount: 500, repeat_penalty: 1.0 },
    ];

    const tx = db.transaction(() => {
      for (const rule of rules) {
        insertRule.run(rule.id, rule.fault_type, rule.rule_name, rule.rate_per_hour, rule.min_amount, rule.max_amount, rule.repeat_penalty);
      }
    });
    tx();
  }
}

initDatabase();

module.exports = db;
