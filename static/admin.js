const state = {
  keys: [],
  accounts: [],
  view: 'overview',
  base: localStorage.getItem('httpsBase') || '',
};

const $ = (sel) => document.querySelector(sel);

let toastTimer;
function toast(text, ok = true) {
  const el = $('#toast');
  el.textContent = text;
  el.className = 'toast show ' + (ok ? 'ok' : 'err');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3800);
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function badge(kind, label) {
  return `<span class="badge ${kind}">${esc(label)}</span>`;
}

function keyPreview(k) {
  return `<code class="key-preview">${esc(k.keyPrefix || '')}…${esc(k.keyTail || '')}</code>`;
}

function fmtBalance(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '0';
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderKeys() {
  const rows = $('#keyRows');
  const empty = $('#keyEmpty');
  if (!state.keys.length) {
    rows.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  rows.innerHTML = state.keys.map((k) => {
    const enabled = k.enabled !== false;
    return `<tr>
      <td><strong>${esc(k.name || '未命名')}</strong><div class="sub">${esc(fmtDate(k.createdAt))}</div></td>
      <td>${keyPreview(k)}</td>
      <td>${enabled ? badge('ok', '启用') : badge('off', '停用')}</td>
      <td>
        <div class="actions">
          <button class="mini-btn" onclick="copyKey('${esc(k.id)}', 'http')">HTTP</button>
          <button class="mini-btn" onclick="copyKey('${esc(k.id)}', 'https')">HTTPS</button>
        </div>
      </td>
      <td>
        <div class="actions">
          <button class="mini-btn" onclick="toggleKey('${esc(k.id)}', ${enabled})">${enabled ? '停用' : '启用'}</button>
          <button class="danger-btn" onclick="removeKey('${esc(k.id)}')">删除</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderAccounts() {
  const rows = $('#accRows');
  const empty = $('#accEmpty');
  if (!state.accounts.length) {
    rows.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  rows.innerHTML = state.accounts.map((a) => {
    const healthy = a.healthy !== false;
    return `<tr>
      <td><strong>${esc(a.userName || '未知用户')}</strong><div class="sub">${esc(a.keyName || '')}</div></td>
      <td class="sub">${esc(a.email || '—')}</td>
      <td><code class="key-preview">${esc((a.keyPrefix || '') + '…' + (a.keyTail || ''))}</code></td>
      <td class="num">${fmtBalance(a.creditBalance)}</td>
      <td>${healthy ? badge('ok', '可用') : badge('err', '冷却中')}</td>
      <td><div class="actions"><button class="danger-btn" onclick="removeAccount('${esc(a.id)}')">移除</button></div></td>
    </tr>`;
  }).join('');
}

function renderOverview() {
  const enabledKeys = state.keys.filter((k) => k.enabled !== false).length;
  const healthy = state.accounts.filter((a) => a.healthy !== false).length;
  const totalBalance = state.accounts.reduce((sum, a) => sum + Number(a.creditBalance || 0), 0);
  $('#statKeys').textContent = state.keys.length;
  $('#statKeysSub').textContent = `${enabledKeys} 个启用`;
  $('#statAccounts').textContent = state.accounts.length;
  $('#statAccountsSub').textContent = `${healthy} 个健康`;
  $('#statBalance').textContent = fmtBalance(totalBalance);
  $('#statBalanceSub').textContent = state.accounts.length ? '账号池合计' : '暂未添加账号';
  $('#statGateway').textContent = '在线';
  $('#statGatewaySub').textContent = 'api.commandcode.ai';

  const base = location.origin + '/v1';
  const exampleKey = state.keys.find((k) => k.enabled !== false);
  const keyPart = exampleKey ? exampleKey.key : '<PROXY_API_KEY>';
  $('#usageSnippet').textContent =
`BASE_URL=${base}
API_KEY=${keyPart}

curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${keyPart}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'`;
}

function renderAll() {
  renderKeys();
  renderAccounts();
  renderOverview();
  const ok = state.keys.length > 0 && state.accounts.length > 0;
  $('#navStatus').textContent = ok ? '运行正常' : '等待配置';
  $('#navStatus').parentElement.querySelector('.dot').className = 'dot' + (ok ? ' ok' : '');
}

async function loadAll() {
  try {
    const [keysRes, accRes] = await Promise.all([
      fetch('/api/admin/keys').then((r) => r.json()),
      fetch('/api/admin/accounts').then((r) => r.json()),
    ]);
    state.keys = keysRes.keys || [];
    state.accounts = accRes.accounts || [];
    renderAll();
  } catch (err) {
    toast('加载失败：' + (err.message || '未知错误'), false);
    $('#navStatus').textContent = '加载失败';
    $('#navStatus').parentElement.querySelector('.dot').className = 'dot err';
  }
}

function switchView(name) {
  state.view = name;
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('active', v.id === 'view-' + name);
  });
  const meta = {
    overview: ['概览', '代理运行状态与关键指标'],
    keys: ['访问密钥', '管理客户端授权密钥'],
    accounts: ['账号池', 'Command Code 额度账号'],
  }[name];
  $('#pageTitle').textContent = meta[0];
  $('#pageSub').textContent = meta[1];
}

async function copyKey(id, proto) {
  const k = state.keys.find((x) => x.id === id);
  if (!k) { toast('未找到该密钥', false); return; }
  let base;
  if (proto === 'http') {
    base = location.origin + '/v1';
  } else {
    const custom = state.base.trim();
    if (!custom) { toast('请先在 HTTPS 出口填写地址', false); return; }
    base = custom.replace(/\/+$/, '');
  }
  const text = [
    'Base URL: ' + base,
    'API Key: ' + k.key,
    '',
    'curl ' + base + '/chat/completions \\',
    '  -H "Authorization: Bearer ' + k.key + '" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"stream":false}\'',
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast((proto === 'http' ? 'HTTP' : 'HTTPS') + ' 连接串已复制');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('连接串已复制');
  }
}

async function addKey() {
  const name = $('#keyName').value.trim();
  const key = $('#keyValue').value.trim();
  if (!name) { toast('请填写密钥名称', false); return; }
  const res = await fetch('/api/admin/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, key }),
  });
  const d = await res.json();
  if (d.success) {
    toast('已创建密钥：' + d.key.key);
    $('#keyValue').value = '';
    $('#keyName').value = '';
    await loadAll();
  } else {
    toast(d.error?.message || '创建失败', false);
  }
}

async function toggleKey(id, enabled) {
  await fetch('/api/admin/keys/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !enabled }),
  });
  await loadAll();
}

async function removeKey(id) {
  if (!confirm('删除该密钥后，使用它的客户端将无法访问。确认删除？')) return;
  await fetch('/api/admin/keys/' + id, { method: 'DELETE' });
  toast('密钥已删除');
  await loadAll();
}

async function addAccount() {
  const apiKey = $('#accKey').value.trim();
  if (!apiKey) { toast('请粘贴 Command Code API key', false); return; }
  const res = await fetch('/api/admin/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  const d = await res.json();
  if (d.success) {
    toast('已添加账号：' + (d.account.userName || '未知'));
    $('#accKey').value = '';
    await loadAll();
  } else {
    toast(d.error?.message || '添加失败', false);
  }
}

async function removeAccount(id) {
  if (!confirm('移除该账号后，余额将不再参与分配。确认移除？')) return;
  await fetch('/api/admin/accounts/' + id, { method: 'DELETE' });
  toast('账号已移除');
  await loadAll();
}

async function startOAuth() {
  const win = window.open('about:blank', '_blank');
  if (!win) { toast('浏览器拦截了弹窗，请允许本站弹出窗口', false); return; }
  toast('正在启动 OAuth 授权…');
  const res = await fetch('/api/admin/accounts/oauth', { method: 'POST' });
  const d = await res.json();
  if (!d.success || !d.url) {
    win.close();
    toast(d.error?.message || '启动失败', false);
    return;
  }
  win.location.href = d.url;
  const flowId = d.flowId;
  const timer = setInterval(async () => {
    try {
      const s = await fetch('/api/admin/accounts/oauth/status/' + flowId).then((r) => r.json());
      if (s.status === 'done') {
        clearInterval(timer);
        try { win.close(); } catch {}
        toast('账号添加成功：' + (s.account?.userName || '未知'));
        await loadAll();
      } else if (s.status === 'error') {
        clearInterval(timer);
        toast(s.error || '授权失败', false);
      } else if (s.status === 'expired') {
        clearInterval(timer);
        toast('授权超时，请重试', false);
      }
    } catch {
      clearInterval(timer);
      toast('授权状态查询失败', false);
    }
  }, 1500);
}

function saveBase() {
  state.base = $('#httpsBase').value.trim();
  localStorage.setItem('httpsBase', state.base);
  toast('HTTPS 出口地址已保存');
}

function bindEvents() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  $('#refreshBtn').addEventListener('click', () => {
    toast('正在刷新…');
    loadAll();
  });
  $('#copySnippet').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#usageSnippet').textContent);
      toast('运行方式已复制');
    } catch {
      toast('复制失败，请手动选择', false);
    }
  });
  $('#addKeyBtn').addEventListener('click', addKey);
  $('#saveBaseBtn').addEventListener('click', saveBase);
  $('#addAccBtn').addEventListener('click', addAccount);
  $('#oauthBtn').addEventListener('click', startOAuth);
  $('#httpsBase').value = state.base;
}

bindEvents();
switchView('overview');
loadAll();
