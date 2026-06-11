const { app } = require('../server');
const http = require('http');

const server = app.listen(0, '127.0.0.1', async () => {
  const PORT = server.address().port;
  console.log('端口:', PORT);

  function api(method, path, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: PORT,
        path: '/api' + path,
        method,
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(d) });
          } catch (e) {
            resolve({ status: res.statusCode, body: d });
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  try {
    // 创建工单1：待修复
    const r1 = await api('POST', '/work-orders', {
      pile_no: 'T1',
      fault_type: '硬件故障',
      fault_desc: 'pending test',
      downtime_start: '2024-06-01 10:00:00',
      reporter: 'test'
    });
    console.log('\n1. 创建待修复工单:');
    console.log('   code:', r1.body.code, 'status:', r1.body.data?.status);

    // 创建工单2：已修复
    const r2 = await api('POST', '/work-orders', {
      pile_no: 'T1',
      fault_type: '软件故障',
      fault_desc: 'repaired test',
      downtime_start: '2024-06-02 08:00:00',
      reporter: 'test'
    });
    const id2 = r2.body.data.id;
    console.log('\n2. 创建工单2:');
    console.log('   code:', r2.body.code, 'id:', id2, 'status:', r2.body.data?.status);

    // 确认修复
    const conf = await api('POST', '/work-orders/' + id2 + '/confirm-repair', {
      repair_time: '2024-06-02 10:30:00',
      duty_owner: '运维方',
      duty_type: '主要责任',
      confirmor: '站长'
    });
    console.log('\n3. 确认修复:');
    console.log('   code:', conf.body.code, 'msg:', conf.body.message || '');
    if (conf.body.code !== 0) {
      console.log('   完整响应:', JSON.stringify(conf.body, null, 2));
    }

    // 查询 repaired 状态的工单
    const q = await api('GET', '/work-orders?status=repaired');
    console.log('\n4. 查询已修复工单:');
    console.log('   total:', q.body.data?.total);

    // 生成结算
    const gen = await api('POST', '/settlements/generate', { settlement_period: '2024-06' });
    console.log('\n5. 生成结算:');
    console.log('   code:', gen.body.code, 'msg:', gen.body.message || '');
    console.log('   完整data keys:', Object.keys(gen.body.data || {}));
    if (gen.body.data?.items) {
      console.log('   items数量:', gen.body.data.items.length);
    }
    console.log('   完整响应:', JSON.stringify(gen.body, null, 2).substring(0, 500));

  } catch (e) {
    console.error('错误:', e.message);
    console.error(e.stack);
  }

  server.close();
});
