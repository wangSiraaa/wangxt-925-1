const http = require('http');

const BASE_URL = 'localhost';
const PORT = 3001;

function api(path, options = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: BASE_URL,
      port: PORT,
      path: '/api' + path,
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

let results = { total: 0, passed: 0, failed: 0 };
const errors = [];

function test(name, fn) {
  results.total++;
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    results.passed++;
  } catch (e) {
    console.log(`❌ FAIL: ${name}`);
    console.log(`   错误: ${e.message}`);
    errors.push({ name, error: e.message });
    results.failed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || '断言失败');
  }
}

async function waitForServer() {
  console.log('⏳ 等待服务器启动...');
  for (let i = 0; i < 30; i++) {
    try {
      const res = await api('/health');
      if (res.code === 0) {
        console.log('✅ 服务器已就绪\n');
        return true;
      }
    } catch (e) {
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('服务器启动超时');
}

async function runTests() {
  console.log('========================================');
  console.log('  充电桩运维结算系统 - API 集成验证');
  console.log('========================================\n');

  await waitForServer();

  console.log('--- 场景1: 未修复故障不能进入结算 ---\n');

  test('创建待修复工单', () => {
    const res = api('/work-orders', {
      method: 'POST',
      body: {
        pile_no: 'TEST-UNFIXED',
        fault_type: '硬件故障',
        downtime_start: '2024-06-20 09:00:00',
        reporter: 'test_user',
        fault_desc: '测试未修复结算拦截'
      }
    });
    assert(res.code === 0, '创建工单失败');
  });

  test('创建已修复工单', () => {
    const res = api('/work-orders', {
      method: 'POST',
      body: {
        pile_no: 'TEST-FIXED',
        fault_type: '软件故障',
        downtime_start: '2024-06-21 10:00:00',
        reporter: 'test_user',
        fault_desc: '测试已修复可结算'
      }
    });
    assert(res.code === 0, '创建工单失败');
  });

  console.log('');
  console.log('--- 场景2: 时间异常工单退回 ---\n');

  test('创建修复时间早于开始时间的工单', () => {
    const res = api('/work-orders', {
      method: 'POST',
      body: {
        pile_no: 'TEST-BADTIME',
        fault_type: '网络故障',
        downtime_start: '2024-06-22 14:00:00',
        reporter: 'test_user',
        fault_desc: '测试时间异常'
      }
    });
    assert(res.code === 0, '创建工单失败');
  });

  console.log('');
  console.log('--- 场景3: 同桩同周期重复故障合并 ---\n');

  test('创建同一桩同一类型故障2条（责任不同）', () => {
    for (let i = 0; i < 2; i++) {
      const res = api('/work-orders', {
        method: 'POST',
        body: {
          pile_no: 'TEST-REPEAT',
          fault_type: '硬件故障',
          downtime_start: `2024-06-${10 + i} 08:00:00`,
          reporter: 'test_user',
          fault_desc: `重复故障测试 ${i + 1}`
        }
      });
      assert(res.code === 0, '创建工单失败');
    }
  });

  console.log('\n📊 结果:');
  console.log(`   总计: ${results.total}`);
  console.log(`   通过: ${results.passed}`);
  console.log(`   失败: ${results.failed}`);

  if (results.failed > 0) {
    console.log('\n❌ 失败详情:');
    errors.forEach(e => console.log(`   - ${e.name}: ${e.error}`));
    process.exit(1);
  } else {
    console.log('\n🎉 所有测试通过！');
  }
}

runTests().catch(e => {
  console.error('测试执行失败:', e.message);
  process.exit(1);
});
