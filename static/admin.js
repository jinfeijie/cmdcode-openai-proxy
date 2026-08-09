const state = {
  keys: [],
  accounts: [],
  models: null,
  marketQuery: '',
  marketMode: 'recommended',
  marketVendor: 'all',
  view: 'overview',
  oauthTimer: null,
  oauthWin: null,
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

const vendorBrand = {
  anthropic: { icon: 'anthropic', label: 'Anthropic' },
  openai: { icon: 'openai', label: 'OpenAI' },
  deepseek: { icon: 'deepseek', label: 'DeepSeek' },
  qwen: { icon: 'qwen', label: 'Qwen' },
  google: { icon: 'google', label: 'Google' },
  minimax: { icon: 'minimax', label: 'MiniMax' },
  xiaomi: { icon: 'xiaomi', label: 'Xiaomi' },
  moonshot: { icon: 'moonshot', label: 'Moonshot / Kimi' },
  zhipu: { icon: 'zhipu', label: 'Zhipu AI' },
  tencent: { icon: 'tencent', label: 'Tencent Hunyuan' },
  stepfun: { icon: 'stepfun', label: 'StepFun' },
  xai: { icon: 'xai', label: 'xAI' },
  meta: { icon: 'meta', label: 'Meta' },
  nvidia: { icon: 'nvidia', label: 'NVIDIA' },
  poolside: { icon: 'poolside', label: 'Poolside' },
  'sakana ai': { asset: 'sakana.png', label: 'Sakana AI' },
  inclusionai: { asset: 'inclusionai.jpg', label: 'InclusionAI' },
  'thinking machines': { asset: 'thinkingmachines.png', label: 'Thinking Machines' },
  others: { mark: '·', label: 'Others' },
};

const modelVendorByPrefix = {
  xai: 'xAI',
  meta: 'Meta',
  nvidia: 'NVIDIA',
  poolside: 'Poolside',
  sakana: 'Sakana AI',
  inclusionai: 'InclusionAI',
  thinkingmachines: 'Thinking Machines',
};

function displayVendor(groupVendor, model) {
  const prefix = String(model || '').split('/', 1)[0].toLowerCase();
  return groupVendor === 'Others' ? modelVendorByPrefix[prefix] || groupVendor : groupVendor;
}

function vendorLogo(vendor) {
  const key = String(vendor || 'others').toLowerCase();
  const classKey = key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const brand = vendorBrand[key] || { mark: String(vendor || '?').slice(0, 1).toUpperCase(), label: vendor || '其他厂商' };
  const asset = brand.asset || (brand.icon ? `${brand.icon}.svg` : '');
  const content = asset
    ? `<img src="/vendor-logos/${asset}" alt="">`
    : `<b aria-hidden="true">${esc(brand.mark)}</b>`;
  return `<span class="vendor-logo vendor-logo--${esc(classKey)}" title="${esc(brand.label)}" aria-hidden="true">${content}</span>`;
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
  $('#keyCountBadge').textContent = state.keys.length + ' 个';
  if (!state.keys.length) {
    rows.innerHTML = '';
    empty.style.display = 'grid';
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
          <button class="mini-btn" onclick="copyKey('${esc(k.id)}')">复制密钥</button>
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
  $('#accCountBadge').textContent = state.accounts.length + ' 个';
  if (!state.accounts.length) {
    rows.innerHTML = '';
    empty.style.display = 'grid';
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
  const briefingDate = $('#briefingDate');
  if (briefingDate) {
    briefingDate.textContent = new Intl.DateTimeFormat('zh-CN', {
      month: 'long', day: 'numeric', weekday: 'long',
    }).format(new Date());
  }
  const enabledKeys = state.keys.filter((k) => k.enabled !== false).length;
  const healthy = state.accounts.filter((a) => a.healthy !== false).length;
  const totalBalance = state.accounts.reduce((sum, a) => sum + Number(a.creditBalance || 0), 0);
  $('#statKeys').textContent = state.keys.length;
  $('#statKeysSub').textContent = `${enabledKeys} 个启用`;
  $('#statAccounts').textContent = state.accounts.length;
  $('#statAccountsSub').textContent = `${healthy} 个健康`;
  $('#statBalance').textContent = fmtBalance(totalBalance);
  $('#statBalanceSub').textContent = state.accounts.length ? '账号池合计' : '暂未添加账号';
  $('#statModels').textContent = state.models ? state.models.total : '—';
  $('#statModelsSub').textContent = state.models ? `${state.models.vendorCount} 个厂商分组` : '网关模型';

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
  $('#baseUrlDisplay').textContent = base;
  $('#endpointLabel').textContent = new URL(base).pathname;
  renderHealth();
}

function renderHealth() {
  const hasKeys = state.keys.some((k) => k.enabled !== false);
  const hasAccounts = state.accounts.some((a) => a.healthy !== false);
  const loaded = state.models !== null;
  $('#healthLocal').textContent = '运行中';
  $('#healthGateway').textContent = loaded ? '可达' : '未连接';
  $('#healthGatewayDot').className = 'dot' + (loaded ? ' ok' : '');
  $('#healthAccounts').textContent = hasAccounts ? `${state.accounts.length} 个` : '待添加';
  const summary = $('#statusSummary');
  summary.className = 'ops-health';
  if (loaded && hasKeys && hasAccounts) {
    summary.classList.add('ok');
    $('#healthTitle').textContent = '所有服务运行正常';
    $('#healthDescription').textContent = '代理、上游网关与账号池均已就绪';
  } else if (loaded) {
    summary.classList.add('warn');
    $('#healthTitle').textContent = '还有配置需要完成';
    $('#healthDescription').textContent = !hasKeys ? '请先创建一个可用的访问密钥' : '请添加一个可用的 Command Code 账号';
  } else {
    summary.classList.add('err');
    $('#healthTitle').textContent = '无法连接上游网关';
    $('#healthDescription').textContent = '请检查网络连接后重新刷新';
  }
}

function renderMarket() {
  const groups = state.models?.groups || [];
  $('#summaryTotal').textContent = state.models ? state.models.total : '—';
  $('#summaryVendors').textContent = state.models ? state.models.vendorCount : '—';
  $('#summaryFallback').textContent = state.models?.fallback?.length || '—';
  $('#modelCountPill').textContent = state.models ? state.models.total : '—';

  const grid = $('#vendorGrid');
  const vendorSelect = $('#vendorSelect');
  if (!groups.length) {
    vendorSelect.innerHTML = '<option value="all">全部厂商</option>';
    grid.innerHTML = '<div class="empty"><span class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5 7.5 4h9L20 7.5v9L16.5 20h-9L4 16.5Z"/><path d="M8.2 12h7.6"/><path d="M12 8.2v7.6"/></svg></span><strong>模型列表暂不可用</strong><p>稍后刷新重试。</p></div>';
    return;
  }

  const query = state.marketQuery.trim().toLowerCase();
  vendorSelect.innerHTML = [
    '<option value="all">全部厂商</option>',
    ...groups.map((g) => `<option value="${esc(g.vendor)}">${esc(g.vendor)} · ${g.models.length}</option>`),
  ].join('');
  vendorSelect.value = state.marketVendor;
  document.querySelectorAll('#marketMode [data-mode]').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === state.marketMode);
  });

  const recommended = new Set(state.models?.fallback || []);
  const visible = groups.map((g) => {
    if (state.marketVendor !== 'all' && g.vendor !== state.marketVendor) return null;
    const groupMatches = !query || `${g.group} ${g.vendor} ${g.tag}`.toLowerCase().includes(query);
    let models = groupMatches ? g.models : g.models.filter((m) => m.toLowerCase().includes(query));
    if (state.marketMode === 'recommended') models = models.filter((m) => recommended.has(m));
    return models.length ? { ...g, models } : null;
  }).filter(Boolean);
  const resultCount = visible.reduce((sum, g) => sum + g.models.length, 0);
  $('#directoryTitle').textContent = query ? '搜索结果' : state.marketMode === 'recommended' ? '推荐模型' : state.marketVendor === 'all' ? '全部模型' : state.marketVendor;
  $('#directoryCount').textContent = query ? `找到 ${resultCount} 个结果` : `${resultCount} 个可用模型`;

  if (!visible.length) {
    grid.innerHTML = '<div class="market-empty"><strong>没有匹配的模型</strong><span>换一个关键词，或查看全部厂商。</span></div>';
    return;
  }
  grid.innerHTML = visible.flatMap((g) => g.models.map((model) => {
    const vendor = displayVendor(g.vendor, model);
    return `
    <button class="model-row" data-model="${esc(model)}" title="复制 ${esc(model)}">
      <code>${esc(model)}</code>
      <span class="model-vendor">${vendorLogo(vendor)}<span>${esc(vendor)}</span></span>
      <span class="model-tag">${esc(g.tag)}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    </button>`;
  })).join('');
}

async function copyModel(model) {
  try {
    await navigator.clipboard.writeText(model);
    toast(`已复制 ${model}`);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = model;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(`已复制 ${model}`);
  }
}

function renderAll() {
  renderKeys();
  renderAccounts();
  renderOverview();
  renderMarket();
  const ok = state.keys.some((k) => k.enabled !== false) && state.accounts.some((a) => a.healthy !== false);
  $('#navStatusText').textContent = ok ? '运行正常' : '等待配置';
  $('#navDot').className = 'dot' + (ok ? ' ok' : '');
  $('#navStatusSub').textContent = ok ? '密钥与账号池已就绪' : '添加密钥或账号后开始转发';
}

async function loadAll() {
  const btn = $('#refreshBtn');
  btn.classList.add('spinning');
  try {
    const [keysRes, accRes, marketRes] = await Promise.all([
      fetch('/api/admin/keys').then((r) => r.json()),
      fetch('/api/admin/accounts').then((r) => r.json()),
      fetch('/api/admin/models/market').then((r) => r.json()),
    ]);
    state.keys = keysRes.keys || [];
    state.accounts = accRes.accounts || [];
    state.models = marketRes || null;
    renderAll();
  } catch (err) {
    toast('加载失败：' + (err.message || '未知错误'), false);
    $('#navStatusText').textContent = '加载失败';
    $('#navDot').className = 'dot err';
  } finally {
    btn.classList.remove('spinning');
  }
}

function switchView(name) {
  const views = ['overview', 'keys', 'accounts', 'market'];
  if (!views.includes(name)) name = 'overview';
  state.view = name;
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('active', v.id === 'view-' + name);
  });
  const meta = {
    overview: ['控制台总览', '运行状态、资源与接入信息'],
    keys: ['访问密钥', '管理客户端认证凭据'],
    accounts: ['账号池', '管理 Command Code 账号与可用额度'],
    market: ['模型市场', '查看网关支持的模型与厂商'],
  }[name];
  $('#pageTitle').textContent = meta[0];
  $('#pageSub').textContent = meta[1];
  const nextHash = name === 'overview' ? '' : '#' + name;
  if (location.hash !== nextHash) history.replaceState(null, '', location.pathname + nextHash);
}

async function copyKey(id) {
  const k = state.keys.find((x) => x.id === id);
  if (!k) { toast('未找到该密钥', false); return; }
  try {
    await navigator.clipboard.writeText(k.key);
    toast('密钥已复制');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = k.key;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('密钥已复制');
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
  toast(enabled ? '密钥已停用' : '密钥已启用');
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

function setOauthStep(n) {
  for (let i = 1; i <= 3; i++) {
    const step = $('#oauthStep' + i);
    step.classList.toggle('active', i === n);
    step.classList.toggle('done', i < n);
  }
}

function closeOauth() {
  clearInterval(state.oauthTimer);
  state.oauthTimer = null;
  try { state.oauthWin?.close(); } catch {}
  state.oauthWin = null;
  $('#oauthModal').hidden = true;
  document.body.style.overflow = '';
}

function openOauth() {
  $('#oauthModal').hidden = false;
  document.body.style.overflow = 'hidden';
}

async function startOAuth() {
  const win = window.open('about:blank', '_blank');
  if (!win) { toast('浏览器拦截了弹窗，请允许本站弹出窗口', false); return; }
  state.oauthWin = win;
  openOauth();
  $('#oauthStep1').classList.add('active');
  $('#oauthStep2').classList.remove('active');
  $('#oauthStep3').classList.remove('active');
  $('#oauthStatus').textContent = '正在打开官方授权页面…';

  try {
    const res = await fetch('/api/admin/accounts/oauth', { method: 'POST' });
    const d = await res.json();
    if (!d.success || !d.url) {
      closeOauth();
      toast(d.error?.message || '启动失败', false);
      return;
    }
    win.location.href = d.url;
    setOauthStep(2);
    $('#oauthStatus').textContent = '请在授权窗口确认登录，等待 Command Code 回调…';
    const flowId = d.flowId;
    state.oauthTimer = setInterval(async () => {
      try {
        const s = await fetch('/api/admin/accounts/oauth/status/' + flowId).then((r) => r.json());
        if (s.status === 'done') {
          clearInterval(state.oauthTimer);
          setOauthStep(3);
          $('#oauthStatus').textContent = '授权成功，正在把账号加入池子…';
          try { win.close(); } catch {}
          await new Promise((r) => setTimeout(r, 700));
          closeOauth();
          toast('账号添加成功：' + (s.account?.userName || '未知'));
          await loadAll();
        } else if (s.status === 'error') {
          clearInterval(state.oauthTimer);
          closeOauth();
          toast(s.error || '授权失败', false);
        } else if (s.status === 'expired') {
          clearInterval(state.oauthTimer);
          closeOauth();
          toast('授权超时，请重试', false);
        }
      } catch {
        clearInterval(state.oauthTimer);
        closeOauth();
        toast('授权状态查询失败', false);
      }
    }, 1500);
  } catch (err) {
    closeOauth();
    toast('启动失败：' + (err.message || '未知错误'), false);
  }
}

async function logout() {
  try {
    await fetch('/api/admin/logout', { method: 'POST' });
  } catch {}
  location.href = '/admin';
}

function bindEvents() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  window.addEventListener('hashchange', () => switchView(location.hash.slice(1) || 'overview'));
  $('#refreshBtn').addEventListener('click', () => {
    toast('正在刷新…');
    loadAll();
  });
  $('#copySnippet').addEventListener('click', async () => {
    const key = state.keys.find((item) => item.enabled !== false);
    if (!key) {
      toast('暂无可用密钥，请先创建或启用一个密钥', false);
      return;
    }
    try {
      await navigator.clipboard.writeText(key.key);
      toast('密钥已复制');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = key.key;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('密钥已复制');
    }
  });
  $('#addKeyBtn').addEventListener('click', addKey);
  $('#addAccBtn').addEventListener('click', addAccount);
  $('#oauthBtn').addEventListener('click', startOAuth);
  $('#oauthClose').addEventListener('click', closeOauth);
  $('#logoutBtn').addEventListener('click', logout);
  const updateMarketQuery = (event) => {
    state.marketQuery = event.target.value;
    renderMarket();
  };
  $('#modelSearch').addEventListener('input', updateMarketQuery);
  $('#modelSearch').addEventListener('search', updateMarketQuery);
  $('#modelSearch').addEventListener('change', updateMarketQuery);
  $('#marketMode').addEventListener('click', (event) => {
    const button = event.target.closest('[data-mode]');
    if (!button) return;
    state.marketMode = button.dataset.mode;
    renderMarket();
  });
  $('#vendorSelect').addEventListener('change', (event) => {
    state.marketVendor = event.target.value;
    renderMarket();
  });
  $('#vendorGrid').addEventListener('click', (event) => {
    const button = event.target.closest('[data-model]');
    if (button) copyModel(button.dataset.model);
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      switchView('market');
      $('#modelSearch').focus();
    }
  });
}

bindEvents();
switchView(location.hash.slice(1) || 'overview');
loadAll();
