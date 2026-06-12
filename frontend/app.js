const API_BASE = '/api';
let currentPage = 'work-order';
let woPage = 1;
const PAGE_SIZE = 10;
let currentUser = '运维员_张工';

const statusMap = {
  pending: { label: '待修复', class: 'status-pending' },
  repaired: { label: '已修复', class: 'status-repaired' },
  settled: { label: '已结算', class: 'status-settled' },
  draft: { label: '草稿', class: 'status-draft' },
  confirmed: { label: '已确认', class: 'status-confirmed' }
};

const faultTypes = ['硬件故障', '软件故障', '网络故障', '其他'];
const dutyTypes = ['主要责任', '次要责任', '连带责任'];
const dutyOwners = ['运维方', '设备厂商', '第三方', '其他'];

function init() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchPage(btn.dataset.page);
    });
  });

  document.getElementById('currentUser').addEventListener('change', (e) => {
    currentUser = e.target.value;
  });

  loadWorkOrders();
}

function switchPage(page) {
  currentPage = page;
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
  document.querySelectorAll('.page').forEach(p => {
    p.classList.toggle('active', p.id === `page-${page}`);
  });

  switch (page) {
    case 'work-order':
      loadWorkOrders();
      break;
    case 'repair-confirm':
      loadRepairList();
      break;
    case 'settlement':
      loadSettlements();
      break;
    case 'rules':
      loadRules();
      break;
  }
}

async function api(url, options = {}) {
  try {
    const res = await fetch(API_BASE + url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    return await res.json();
  } catch (e) {
    showToast('网络请求失败', 'error');
    throw e;
  }
}

function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast show ${type}`;
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

function openModal(title, body, footer) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-footer').innerHTML = footer || '';
  document.getElementById('modal').classList.add('show');
}

function closeModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('modal').classList.remove('show');
}

async function loadWorkOrders() {
  const pileFilter = document.getElementById('wo-pile-filter')?.value || '';
  const statusFilter = document.getElementById('wo-status-filter')?.value || '';
  
  let url = `/work-orders?page=${woPage}&page_size=${PAGE_SIZE}`;
  if (pileFilter) url += `&pile_no=${encodeURIComponent(pileFilter)}`;
  if (statusFilter) url += `&status=${statusFilter}`;

  const res = await api(url);
  if (res.code === 0) {
    renderWorkOrders(res.data.list);
    document.getElementById('wo-page-info').textContent = 
      `第 ${woPage} 页 / 共 ${Math.ceil(res.data.total / PAGE_SIZE) || 1} 页 (${res.data.total}条)`;
  }
}

function renderWorkOrders(orders) {
  const tbody = document.getElementById('work-order-tbody');
  if (orders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">暂无工单数据</td></tr>`;
    return;
  }

  tbody.innerHTML = orders.map(wo => {
    const status = statusMap[wo.status] || { label: wo.status, class: '' };
    return `
      <tr>
        <td><strong>${wo.pile_no}</strong></td>
        <td>${wo.fault_type}</td>
        <td>${formatTime(wo.downtime_start)}</td>
        <td>${wo.repair_time ? formatTime(wo.repair_time) : '-'}</td>
        <td>${wo.downtime_hours ? wo.downtime_hours.toFixed(2) : '-'}</td>
        <td>${wo.duty_owner || '-'}</td>
        <td><span class="status-badge ${status.class}">${status.label}</span></td>
        <td>${wo.reporter}</td>
        <td>
          <div class="action-btns">
            <button class="btn btn-sm" onclick="viewWorkOrder('${wo.id}')">查看</button>
            ${wo.status === 'pending' ? `<button class="btn btn-sm btn-success" onclick="viewRepairConfirm('${wo.id}')">修复确认</button>` : ''}
            ${wo.status !== 'settled' ? `<button class="btn btn-sm btn-danger" onclick="deleteWorkOrder('${wo.id}')">删除</button>` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function changePage(type, delta) {
  if (type === 'wo') {
    woPage = Math.max(1, woPage + delta);
    loadWorkOrders();
  }
}

async function viewWorkOrder(id) {
  const res = await api(`/work-orders/${id}`);
  if (res.code !== 0) {
    showToast(res.message, 'error');
    return;
  }
  const wo = res.data;
  const status = statusMap[wo.status] || { label: wo.status, class: '' };

  const body = `
    <div class="detail-section">
      <h4>基本信息</h4>
      <div class="detail-row"><span class="detail-label">桩号：</span><span class="detail-value">${wo.pile_no}</span></div>
      <div class="detail-row"><span class="detail-label">故障类型：</span><span class="detail-value">${wo.fault_type}</span></div>
      <div class="detail-row"><span class="detail-label">状态：</span><span class="detail-value"><span class="status-badge ${status.class}">${status.label}</span></span></div>
      <div class="detail-row"><span class="detail-label">上报人：</span><span class="detail-value">${wo.reporter}</span></div>
      <div class="detail-row"><span class="detail-label">创建时间：</span><span class="detail-value">${formatTime(wo.created_at)}</span></div>
    </div>
    <div class="detail-section">
      <h4>故障详情</h4>
      <div class="detail-row"><span class="detail-label">故障描述：</span><span class="detail-value">${wo.fault_desc || '-'}</span></div>
      <div class="detail-row"><span class="detail-label">停机开始：</span><span class="detail-value">${formatTime(wo.downtime_start)}</span></div>
      ${wo.photo_url ? `<div class="detail-row"><span class="detail-label">现场照片：</span><span class="detail-value"><img src="${wo.photo_url}" style="max-width:200px;border-radius:4px;"></span></div>` : ''}
    </div>
    ${wo.repair_time ? `
    <div class="detail-section">
      <h4>修复信息</h4>
      <div class="detail-row"><span class="detail-label">修复时间：</span><span class="detail-value">${formatTime(wo.repair_time)}</span></div>
      <div class="detail-row"><span class="detail-label">责任方：</span><span class="detail-value">${wo.duty_owner}</span></div>
      <div class="detail-row"><span class="detail-label">责任类型：</span><span class="detail-value">${wo.duty_type}</span></div>
      <div class="detail-row"><span class="detail-label">确认人：</span><span class="detail-value">${wo.confirmor}</span></div>
      <div class="detail-row"><span class="detail-label">停机时长：</span><span class="detail-value">${wo.downtime_hours?.toFixed(2) || 0} 小时</span></div>
      <div class="detail-row"><span class="detail-label">扣款金额：</span><span class="detail-value">¥${wo.deduction_amount?.toFixed(2) || 0}</span></div>
    </div>
    ` : ''}
    <div class="detail-section">
      <h4>操作日志</h4>
      <div class="log-list">
        ${(wo.logs || []).map(log => `
          <div class="log-item">
            <span class="log-time">${formatTime(log.created_at)}</span>
            <span class="log-action">${log.action}</span>
            <span class="log-detail">${log.operator} - ${log.detail || ''}</span>
          </div>
        `).join('') || '<div class="empty-state">暂无日志</div>'}
      </div>
    </div>
    ${wo.status === 'settled' ? `
    <div class="remark-input">
      <input type="text" id="add-remark-input" placeholder="追加说明（已结算只能追加说明）">
      <button class="btn btn-primary btn-sm" onclick="addWorkOrderRemark('${wo.id}')">追加</button>
    </div>
    ` : ''}
  `;

  openModal('工单详情', body);
}

async function addWorkOrderRemark(id) {
  const remark = document.getElementById('add-remark-input').value;
  if (!remark) {
    showToast('请输入说明内容', 'warning');
    return;
  }
  const res = await api(`/work-orders/${id}`, {
    method: 'PUT',
    body: { remark, operator: currentUser }
  });
  if (res.code === 0) {
    showToast('追加成功', 'success');
    viewWorkOrder(id);
  } else {
    showToast(res.message, 'error');
  }
}

function openWorkOrderModal() {
  const body = `
    <div class="form-group">
      <label>桩号 *</label>
      <input type="text" id="wo-pile-no" placeholder="如：PILE-001">
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>故障类型 *</label>
        <select id="wo-fault-type">
          ${faultTypes.map(t => `<option value="${t}">${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>停机开始时间 *</label>
        <input type="datetime-local" id="wo-start-time">
      </div>
    </div>
    <div class="form-group">
      <label>故障描述</label>
      <textarea id="wo-desc" placeholder="请详细描述故障情况"></textarea>
    </div>
    <div class="form-group">
      <label>现场照片URL</label>
      <input type="text" id="wo-photo" placeholder="照片链接（可选）">
    </div>
    <div class="form-group">
      <label>备注</label>
      <textarea id="wo-remark" placeholder="备注信息"></textarea>
    </div>
  `;

  const footer = `
    <button class="btn" onclick="closeModal()">取消</button>
    <button class="btn btn-primary" onclick="submitWorkOrder()">提交</button>
  `;

  openModal('新建故障工单', body, footer);
  document.getElementById('wo-start-time').value = new Date().toISOString().slice(0, 16);
}

async function submitWorkOrder() {
  const pile_no = document.getElementById('wo-pile-no').value.trim();
  const fault_type = document.getElementById('wo-fault-type').value;
  let downtime_start = document.getElementById('wo-start-time').value;
  const fault_desc = document.getElementById('wo-desc').value;
  const photo_url = document.getElementById('wo-photo').value;
  const remark = document.getElementById('wo-remark').value;

  if (!pile_no || !fault_type || !downtime_start) {
    showToast('请填写必填项', 'warning');
    return;
  }

  downtime_start = downtime_start.replace('T', ' ') + ':00';

  const res = await api('/work-orders', {
    method: 'POST',
    body: { pile_no, fault_type, fault_desc, downtime_start, photo_url, reporter: currentUser, remark }
  });

  if (res.code === 0) {
    showToast('工单创建成功', 'success');
    closeModal();
    loadWorkOrders();
  } else {
    showToast(res.message, 'error');
  }
}

async function deleteWorkOrder(id) {
  if (!confirm('确定要删除这个工单吗？')) return;
  
  const res = await api(`/work-orders/${id}?operator=${encodeURIComponent(currentUser)}`, {
    method: 'DELETE'
  });

  if (res.code === 0) {
    showToast('删除成功', 'success');
    loadWorkOrders();
  } else {
    showToast(res.message, 'error');
  }
}

async function loadRepairList() {
  const pileFilter = document.getElementById('rc-pile-filter')?.value || '';
  
  let url = '/work-orders?status=pending&page_size=100';
  if (pileFilter) url += `&pile_no=${encodeURIComponent(pileFilter)}`;

  const res = await api(url);
  if (res.code === 0) {
    renderRepairList(res.data.list);
  }
}

function renderRepairList(orders) {
  const tbody = document.getElementById('repair-tbody');
  if (orders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">暂无待修复工单</td></tr>`;
    return;
  }

  tbody.innerHTML = orders.map(wo => `
    <tr>
      <td><strong>${wo.pile_no}</strong></td>
      <td>${wo.fault_type}</td>
      <td>${wo.fault_desc || '-'}</td>
      <td>${formatTime(wo.downtime_start)}</td>
      <td>${wo.reporter}</td>
      <td><span class="status-badge status-pending">待修复</span></td>
      <td><button class="btn btn-sm btn-success" onclick="viewRepairConfirm('${wo.id}')">确认修复</button></td>
    </tr>
  `).join('');
}

async function viewRepairConfirm(id) {
  const res = await api(`/work-orders/${id}`);
  if (res.code !== 0) {
    showToast(res.message, 'error');
    return;
  }
  const wo = res.data;

  const body = `
    <div class="detail-section">
      <h4>工单信息</h4>
      <div class="detail-row"><span class="detail-label">桩号：</span><span class="detail-value">${wo.pile_no}</span></div>
      <div class="detail-row"><span class="detail-label">故障类型：</span><span class="detail-value">${wo.fault_type}</span></div>
      <div class="detail-row"><span class="detail-label">故障描述：</span><span class="detail-value">${wo.fault_desc || '-'}</span></div>
      <div class="detail-row"><span class="detail-label">停机开始：</span><span class="detail-value">${formatTime(wo.downtime_start)}</span></div>
    </div>
    <div class="detail-section">
      <h4>修复确认</h4>
      <div class="form-row">
        <div class="form-group">
          <label>修复时间 *</label>
          <input type="datetime-local" id="repair-time">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>责任方 *</label>
          <select id="repair-duty-owner">
            ${dutyOwners.map(d => `<option value="${d}">${d}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>责任类型 *</label>
          <select id="repair-duty-type">
            ${dutyTypes.map(t => `<option value="${t}">${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>确认备注</label>
        <textarea id="repair-remark" placeholder="确认修复的备注信息"></textarea>
      </div>
    </div>
  `;

  const footer = `
    <button class="btn" onclick="closeModal()">取消</button>
    <button class="btn btn-primary" onclick="confirmRepair('${wo.id}')">确认修复</button>
  `;

  openModal('修复确认', body, footer);
  document.getElementById('repair-time').value = new Date().toISOString().slice(0, 16);
}

async function confirmRepair(id) {
  let repair_time = document.getElementById('repair-time').value;
  const duty_owner = document.getElementById('repair-duty-owner').value;
  const duty_type = document.getElementById('repair-duty-type').value;
  const confirm_remark = document.getElementById('repair-remark').value;

  if (!repair_time) {
    showToast('请选择修复时间', 'warning');
    return;
  }

  repair_time = repair_time.replace('T', ' ') + ':00';

  const res = await api(`/work-orders/${id}/confirm-repair`, {
    method: 'POST',
    body: { repair_time, duty_owner, duty_type, confirmor: currentUser, confirm_remark }
  });

  if (res.code === 0) {
    showToast('修复确认成功', 'success');
    closeModal();
    loadRepairList();
    loadWorkOrders();
  } else {
    showToast(res.message, 'error');
  }
}

async function loadSettlements() {
  const statusFilter = document.getElementById('settle-status-filter')?.value || '';
  
  let url = '/settlements?page_size=50';
  if (statusFilter) url += `&status=${statusFilter}`;

  const res = await api(url);
  if (res.code === 0) {
    renderSettlements(res.data.list);
  }
}

function renderSettlements(settlements) {
  const tbody = document.getElementById('settlement-tbody');
  if (settlements.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">暂无结算单</td></tr>`;
    return;
  }

  tbody.innerHTML = settlements.map(s => {
    const status = statusMap[s.status] || { label: s.status, class: '' };
    return `
      <tr>
        <td><strong>${s.settlement_period}</strong></td>
        <td>${s.pile_no}</td>
        <td>${s.item_count || 0}</td>
        <td>${s.total_downtime?.toFixed(2) || 0}</td>
        <td style="color:#ff4d4f;font-weight:500;">¥${s.total_deduction?.toFixed(2) || 0}</td>
        <td><span class="status-badge ${status.class}">${status.label}</span></td>
        <td>${formatTime(s.created_at)}</td>
        <td>
          <div class="action-btns">
            <button class="btn btn-sm" onclick="viewSettlement('${s.id}')">查看</button>
            ${s.status === 'draft' ? `
              <button class="btn btn-sm btn-success" onclick="confirmSettlement('${s.id}')">确认结算</button>
              <button class="btn btn-sm btn-danger" onclick="deleteSettlement('${s.id}')">删除</button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function generateSettlement() {
  const period = document.getElementById('settle-period').value;
  if (!period) {
    showToast('请选择结算周期', 'warning');
    return;
  }

  const res = await api('/settlements/generate', {
    method: 'POST',
    body: { settlement_period: period, operator: currentUser }
  });

  if (res.code === 0) {
    showToast(res.message, 'success');
    loadSettlements();
  } else if (res.code === 2) {
    const hasSettlements = res.data && res.data.settlements && res.data.settlements.length > 0;
    showToast(res.message, hasSettlements ? 'success' : 'warning');
    loadSettlements();

    if (res.data && res.data.time_errors && res.data.time_errors.length > 0) {
      setTimeout(() => {
        showTimeErrors(res.data.time_errors, () => loadSettlements());
      }, 150);
    }
  } else {
    showToast(res.message, 'error');
  }
}

function showTimeErrors(errors, onClose) {
  window._timeErrorCloseCallback = onClose || null;
  const body = `
    <p style="margin-bottom:12px;color:#ff4d4f;">以下工单存在时间异常，已退回。同周期有效工单已正常生成结算单，请刷新列表查看：</p>
    <div class="table-container">
      <table class="settle-items-table">
        <thead>
          <tr>
            <th>桩号</th>
            <th>故障类型</th>
            <th>异常原因</th>
          </tr>
        </thead>
        <tbody>
          ${errors.map(e => `
            <tr>
              <td>${e.pile_no}</td>
              <td>${e.fault_type}</td>
              <td style="color:#ff4d4f;">${e.reason}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  const footer = `
    <button class="btn btn-primary" onclick="handleTimeErrorClose()">知道了，刷新列表</button>
  `;
  openModal('时间异常提醒（部分退回）', body, footer);
}

function handleTimeErrorClose() {
  if (typeof window._timeErrorCloseCallback === 'function') {
    window._timeErrorCloseCallback();
    window._timeErrorCloseCallback = null;
  }
  closeModal();
}

async function viewSettlement(id) {
  const res = await api(`/settlements/${id}`);
  if (res.code !== 0) {
    showToast(res.message, 'error');
    return;
  }
  const s = res.data;
  const status = statusMap[s.status] || { label: s.status, class: '' };

  const body = `
    <div class="settle-summary">
      <div class="summary-item">
        <div class="summary-value">${s.items?.length || 0}</div>
        <div class="summary-label">工单数量</div>
      </div>
      <div class="summary-item">
        <div class="summary-value">${s.total_downtime?.toFixed(2) || 0}</div>
        <div class="summary-label">总停机(h)</div>
      </div>
      <div class="summary-item">
        <div class="summary-value" style="color:#ff4d4f;">¥${s.total_deduction?.toFixed(2) || 0}</div>
        <div class="summary-label">总扣款</div>
      </div>
    </div>

    <div class="detail-section">
      <h4>基本信息</h4>
      <div class="detail-row"><span class="detail-label">结算周期：</span><span class="detail-value">${s.settlement_period}</span></div>
      <div class="detail-row"><span class="detail-label">桩号：</span><span class="detail-value">${s.pile_no}</span></div>
      <div class="detail-row"><span class="detail-label">状态：</span><span class="detail-value"><span class="status-badge ${status.class}">${status.label}</span></span></div>
      ${s.confirmor ? `<div class="detail-row"><span class="detail-label">确认人：</span><span class="detail-value">${s.confirmor}</span></div>` : ''}
      ${s.confirm_time ? `<div class="detail-row"><span class="detail-label">确认时间：</span><span class="detail-value">${formatTime(s.confirm_time)}</span></div>` : ''}
      ${s.settle_remark ? `<div class="detail-row"><span class="detail-label">结算备注：</span><span class="detail-value">${s.settle_remark}</span></div>` : ''}
    </div>

    <div class="detail-section">
      <h4>结算明细 (${s.items?.length || 0})</h4>
      <div style="max-height:300px;overflow-y:auto;">
        <table class="settle-items-table">
          <thead>
            <tr>
              <th>故障类型</th>
              <th>停机开始</th>
              <th>停机时长(h)</th>
              <th>责任方</th>
              <th>扣款(元)</th>
              <th>规则</th>
            </tr>
          </thead>
          <tbody>
            ${(s.items || []).map(item => `
              <tr style="${item.is_repeat ? 'background:#fff1f0;' : ''}">
                <td>
                  ${item.fault_type}
                  ${item.is_repeat ? '<span class="repeat-tag">重复</span>' : ''}
                </td>
                <td>${formatTime(item.downtime_start)}</td>
                <td>${item.downtime?.toFixed(2) || 0}</td>
                <td>${item.duty_owner || '-'}</td>
                <td style="color:#ff4d4f;">¥${item.deduction_amount?.toFixed(2) || 0}</td>
                <td style="font-size:12px;color:#8c8c8c;">${item.deduction_rule || '-'}</td>
              </tr>
              ${item.remark ? `<tr><td colspan="6" style="font-size:12px;color:#8c8c8c;background:#fafafa;padding:4px 12px;">备注：${item.remark}</td></tr>` : ''}
            `).join('') || '<tr><td colspan="6" class="empty-state">暂无明细</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <div class="detail-section">
      <h4>操作日志</h4>
      <div class="log-list">
        ${(s.logs || []).map(log => `
          <div class="log-item">
            <span class="log-time">${formatTime(log.created_at)}</span>
            <span class="log-action">${log.action}</span>
            <span class="log-detail">${log.operator} - ${log.detail || ''}</span>
          </div>
        `).join('') || '<div class="empty-state">暂无日志</div>'}
      </div>
    </div>

    ${s.status === 'confirmed' ? `
    <div class="remark-input">
      <input type="text" id="settle-add-remark" placeholder="追加说明（已确认只能追加说明）">
      <button class="btn btn-primary btn-sm" onclick="addSettlementRemark('${s.id}')">追加</button>
    </div>
    ` : ''}
  `;

  const footer = s.status === 'draft' ? `
    <button class="btn" onclick="closeModal()">关闭</button>
    <button class="btn btn-danger" onclick="deleteSettlement('${s.id}')">删除</button>
    <button class="btn btn-primary" onclick="confirmSettlement('${s.id}')">确认结算</button>
  ` : `
    <button class="btn btn-primary" onclick="closeModal()">关闭</button>
  `;

  openModal('结算单详情', body, footer);
}

async function addSettlementRemark(id) {
  const remark = document.getElementById('settle-add-remark').value;
  if (!remark) {
    showToast('请输入说明内容', 'warning');
    return;
  }
  const res = await api(`/settlements/${id}/add-remark`, {
    method: 'POST',
    body: { remark, operator: currentUser }
  });
  if (res.code === 0) {
    showToast('追加成功', 'success');
    viewSettlement(id);
  } else {
    showToast(res.message, 'error');
  }
}

async function confirmSettlement(id) {
  if (!confirm('确定要确认该结算单吗？确认后将无法修改金额。')) return;
  
  const res = await api(`/settlements/${id}/confirm`, {
    method: 'POST',
    body: { confirmor: currentUser }
  });

  if (res.code === 0) {
    showToast('结算确认成功', 'success');
    closeModal();
    loadSettlements();
    loadWorkOrders();
  } else {
    showToast(res.message, 'error');
  }
}

async function deleteSettlement(id) {
  if (!confirm('确定要删除这个结算单吗？')) return;
  
  const res = await api(`/settlements/${id}?operator=${encodeURIComponent(currentUser)}`, {
    method: 'DELETE'
  });

  if (res.code === 0) {
    showToast('删除成功', 'success');
    closeModal();
    loadSettlements();
    loadWorkOrders();
  } else {
    showToast(res.message, 'error');
  }
}

async function loadRules() {
  const res = await api('/deduction-rules');
  if (res.code === 0) {
    renderRules(res.data);
  }
}

function renderRules(rules) {
  const tbody = document.getElementById('rules-tbody');
  tbody.innerHTML = rules.map(r => `
    <tr>
      <td>${r.fault_type}</td>
      <td>${r.rule_name}</td>
      <td>¥${r.rate_per_hour}/h</td>
      <td>¥${r.min_amount}</td>
      <td>${r.max_amount ? '¥' + r.max_amount : '无上限'}</td>
      <td>×${r.repeat_penalty}</td>
      <td>${r.is_active ? '<span class="status-badge status-confirmed">启用</span>' : '<span class="status-badge status-draft">停用</span>'}</td>
      <td>
        <button class="btn btn-sm" onclick="toggleRule('${r.id}', ${r.is_active})">${r.is_active ? '停用' : '启用'}</button>
      </td>
    </tr>
  `).join('');
}

function openRuleModal() {
  const body = `
    <div class="form-group">
      <label>故障类型 *</label>
      <select id="rule-fault-type">
        ${faultTypes.map(t => `<option value="${t}">${t}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label>规则名称 *</label>
      <input type="text" id="rule-name" placeholder="如：硬件故障扣款标准">
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>小时费率(元) *</label>
        <input type="number" id="rule-rate" value="50" min="0">
      </div>
      <div class="form-group">
        <label>最低扣款(元) *</label>
        <input type="number" id="rule-min" value="100" min="0">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>最高扣款(元)</label>
        <input type="number" id="rule-max" placeholder="留空表示无上限" min="0">
      </div>
      <div class="form-group">
        <label>重复故障加罚倍数</label>
        <input type="number" id="rule-penalty" value="1.5" min="1" step="0.1">
      </div>
    </div>
  `;

  const footer = `
    <button class="btn" onclick="closeModal()">取消</button>
    <button class="btn btn-primary" onclick="submitRule()">提交</button>
  `;

  openModal('新增扣款规则', body, footer);
}

async function submitRule() {
  const fault_type = document.getElementById('rule-fault-type').value;
  const rule_name = document.getElementById('rule-name').value.trim();
  const rate_per_hour = parseFloat(document.getElementById('rule-rate').value);
  const min_amount = parseFloat(document.getElementById('rule-min').value);
  const max_amount = document.getElementById('rule-max').value ? parseFloat(document.getElementById('rule-max').value) : null;
  const repeat_penalty = parseFloat(document.getElementById('rule-penalty').value);

  if (!rule_name || isNaN(rate_per_hour) || isNaN(min_amount)) {
    showToast('请填写必填项', 'warning');
    return;
  }

  const res = await api('/deduction-rules', {
    method: 'POST',
    body: { fault_type, rule_name, rate_per_hour, min_amount, max_amount, repeat_penalty, operator: currentUser }
  });

  if (res.code === 0) {
    showToast('规则创建成功', 'success');
    closeModal();
    loadRules();
  } else {
    showToast(res.message, 'error');
  }
}

async function toggleRule(id, isActive) {
  const res = await api(`/deduction-rules/${id}`, {
    method: 'PUT',
    body: { is_active: isActive ? 0 : 1, operator: currentUser }
  });

  if (res.code === 0) {
    showToast('操作成功', 'success');
    loadRules();
  } else {
    showToast(res.message, 'error');
  }
}

function formatTime(str) {
  if (!str) return '-';
  if (str.includes('T')) {
    return str.replace('T', ' ').substring(0, 19);
  }
  if (str.length > 19) {
    return str.substring(0, 19);
  }
  return str;
}

document.addEventListener('DOMContentLoaded', init);
