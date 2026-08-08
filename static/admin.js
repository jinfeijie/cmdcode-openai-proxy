// 管理页前端脚本(独立文件,避免模板字符串转义问题)
async function api(path, opts = {}) {
  opts.headers = opts.headers || {};
  opts.headers['Content-Type'] = 'application/json';
  const r = await fetch(path, opts);
  return r.json();
}

function showMsg(text, ok) {
  const m = document.getElementById('msg');
  m.innerHTML = '<div class="msg ' + (ok ? 'ok' : 'err') + '">' + text + '</div>';
  setTimeout(() => (m.innerHTML = ''), 4000);
}

async function loadKeys() {
  const d = await api('/api/admin/keys');
  const tb = document.querySelector('#keyTable tbody');
  tb.innerHTML = d.keys.map((k) =>
    '<tr><td>' + k.name + '</td><td><code>' + k.keyPrefix + '...' + k.keyTail + '</code></td>' +
    '<td><span class="badge ' + (k.enabled ? 'on' : 'off') + '">' + (k.enabled ? '启用' : '停用') + '</span></td>' +
    '<td><button onclick="copyKey(\'' + k.id + '\',\'http\')" title="复制 HTTP 连接串">HTTP</button> ' +
    '<button onclick="copyKey(\'' + k.id + '\',\'https\')" title="复制 HTTPS 连接串">HTTPS</button></td>' +
    '<td><button onclick="toggleKey(\'' + k.id + '\',' + k.enabled + ')">' + (k.enabled ? '停用' : '启用') + '</button> ' +
    '<button onclick="removeKey(\'' + k.id + '\')">删除</button></td></tr>'
  ).join('');
}

// 复制连接串: HTTP 用当前地址,HTTPS 用配置的 https base
function getKeyById(keys, id) {
  return keys.find((k) => k.id === id);
}

async function copyKey(id, proto) {
  const d = await api('/api/admin/keys');
  const k = getKeyById(d.keys, id);
  if (!k) {
    showMsg('未找到该 key', false);
    return;
  }
  let base, label;
  if (proto === 'http') {
    base = location.origin + '/v1';
    label = 'HTTP';
  } else {
    const httpsBase = (document.getElementById('httpsBase').value || '').trim();
    if (!httpsBase) {
      showMsg('请先填写 HTTPS base', false);
      return;
    }
    base = httpsBase.replace(/\/+$/, '');
    label = 'HTTPS';
  }
  // 生成给客户端的配置文本(base URL + 完整 key + 示例)
  const text = [
    'Base URL: ' + base,
    'API Key: ' + k.key,
    '',
    'curl 示例:',
    'curl ' + base + '/chat/completions \\',
    '  -H "Authorization: Bearer ' + k.key + '" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"stream":false}\'',
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showMsg('✅ ' + label + ' 连接串已复制(' + k.name + ')', true);
  } catch {
    // 剪贴板失败时 fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showMsg('✅ ' + label + ' 连接串已复制(' + k.name + ')', true);
  }
}

function saveHttpsBase() {
  localStorage.setItem('httpsBase', document.getElementById('httpsBase').value);
  showMsg('HTTPS base 已保存', true);
}

function loadHttpsBase() {
  const v = localStorage.getItem('httpsBase') || '';
  document.getElementById('httpsBase').value = v;
}

async function loadAccounts() {
  const d = await api('/api/admin/accounts');
  const tb = document.querySelector('#accTable tbody');
  tb.innerHTML = d.accounts.map((a) =>
    '<tr><td>' + a.userName + '</td><td>' + (a.email || '') + '</td>' +
    '<td>' + a.creditBalance + '</td><td><span class="badge ' + (a.healthy ? 'on' : 'off') + '">' + (a.healthy ? '可用' : '不可用') + '</span></td>' +
    '<td><button onclick="removeAccount(\'' + a.id + '\')">删除</button></td></tr>'
  ).join('');
}

async function addKey(e) {
  e.preventDefault();
  const d = await api('/api/admin/keys', { method: 'POST', body: JSON.stringify({ name: document.getElementById('keyName').value, key: document.getElementById('keyValue').value }) });
  if (d.success) {
    showMsg('已添加 key: ' + d.key.key, true);
    loadKeys();
  } else {
    showMsg(d.error?.message || '失败', false);
  }
  return false;
}

async function addAccount(e) {
  e.preventDefault();
  const d = await api('/api/admin/accounts', { method: 'POST', body: JSON.stringify({ apiKey: document.getElementById('accKey').value }) });
  if (d.success) {
    showMsg('已添加账号: ' + d.account.userName, true);
    loadAccounts();
  } else {
    showMsg(d.error?.message || '失败', false);
  }
  return false;
}

async function startOAuth() {
  // 在用户手势内同步开窗口(避免浏览器弹窗拦截),后续设置其 URL
  const win = window.open('about:blank', '_blank');
  if (!win) {
    showMsg('浏览器拦截了弹窗,请允许本站弹出窗口后重试', false);
    return;
  }
  showMsg('正在启动 OAuth 授权流程...', true);
  const d = await api('/api/admin/accounts/oauth', { method: 'POST' });
  if (!d.success || !d.url) {
    win.close();
    showMsg('启动失败: ' + (d.error?.message || 'unknown'), false);
    return;
  }
  win.location.href = d.url;
  // 轮询状态
  const flowId = d.flowId;
  const timer = setInterval(async () => {
    const s = await api('/api/admin/accounts/oauth/status/' + flowId);
    if (s.status === 'done') {
      clearInterval(timer);
      try { win.close(); } catch {}
      showMsg('✅ 账号添加成功: ' + s.account.userName + '(' + s.account.email + ')', true);
      loadAccounts();
    } else if (s.status === 'error') {
      clearInterval(timer);
      showMsg('❌ 授权失败: ' + (s.error || 'unknown'), false);
    } else if (s.status === 'expired') {
      clearInterval(timer);
      showMsg('授权超时,请重试', false);
    }
  }, 1500);
}

async function toggleKey(id, cur) {
  await api('/api/admin/keys/' + id, { method: 'PATCH', body: JSON.stringify({ enabled: !cur }) });
  loadKeys();
}

async function removeKey(id) {
  await api('/api/admin/keys/' + id, { method: 'DELETE' });
  loadKeys();
}

async function removeAccount(id) {
  await api('/api/admin/accounts/' + id, { method: 'DELETE' });
  loadAccounts();
}

loadHttpsBase();
loadKeys();
loadAccounts();
