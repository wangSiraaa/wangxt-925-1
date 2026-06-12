const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const workOrderRoutes = require('./routes/workOrder');
const settlementRoutes = require('./routes/settlement');
const deductionRuleRoutes = require('./routes/deductionRule');
const operationLogRoutes = require('./routes/operationLog');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

const frontendDir = path.join(__dirname, '../frontend');
app.use('/static', express.static(frontendDir));

app.get('/api/health', (req, res) => {
  res.json({ code: 0, data: { status: 'ok', timestamp: new Date().toISOString() } });
});

app.use('/api/work-orders', workOrderRoutes);
app.use('/api/settlements', settlementRoutes);
app.use('/api/deduction-rules', deductionRuleRoutes);
app.use('/api/operation-logs', operationLogRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ code: 500, message: err.message || '服务器内部错误' });
});

function startServer(port = PORT, host = '0.0.0.0', onListenCallback) {
  const server = app.listen(port, host, () => {
    if (onListenCallback) {
      onListenCallback();
    } else {
      const displayHost = host === '0.0.0.0' ? 'localhost' : host;
      console.log('========================================');
      console.log('  充电桩运维结算系统');
      console.log('========================================');
      console.log(`🚀 服务已启动`);
      console.log(`📡 访问地址: http://${displayHost}:${server.address().port}`);
      console.log(`📚 API 前缀: /api`);
      console.log(`🌐 前端页面: http://${displayHost}:${server.address().port}`);
      console.log('');
    }
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
