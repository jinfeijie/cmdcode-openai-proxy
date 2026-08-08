// 多账号池: 管理多个 Command Code API key,whoami 验证、会话亲和、余额排序、健康标记
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_URL, buildGatewayHeaders, joinUrl } from './auth.js';

// 项目级配置目录(全部存在代理当前工作目录)
const CONFIG_DIR = process.cwd();
const DEFAULT_STORE_FILE = join(CONFIG_DIR, 'accounts.json');
const UNHEALTHY_COOLDOWN_MS = 30_000;

// OAuth 授权的 key 存在代理当前工作目录的 oauth-key 文件(项目级授权)
// 格式: JSON 数组或单个 JSON 对象(兼容旧格式),每个元素 { apiKey, userId, userName, email, keyName }
export const OAUTH_KEY_FILE = join(process.cwd(), 'oauth-key');

export const accountsStoreFile = process.env.CMDCODE_ACCOUNTS_FILE || DEFAULT_STORE_FILE;

// ---------- 存储 ----------

// 从 oauth-key 文件加载项目级账号
function loadOauthKeyFile() {
  try {
    if (!existsSync(OAUTH_KEY_FILE)) return [];
    const raw = readFileSync(OAUTH_KEY_FILE, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // 兼容: 单对象或数组
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((a) => a?.apiKey)
      .map((a) => ({
        id: randomUUID(),
        apiKey: a.apiKey,
        userId: a.userId,
        userName: a.userName ?? a.name ?? 'unknown',
        email: a.email,
        keyName: a.keyName,
        addedAt: new Date().toISOString(),
        source: 'oauth-key',
      }));
  } catch {
    return [];
  }
}

// 把账号写入 oauth-key 文件(追加,去重)
export function saveOauthKey(account) {
  try {
    const existing = loadOauthKeyFile();
    const deduped = existing.filter((a) => a.apiKey !== account.apiKey);
    const entry = {
      apiKey: account.apiKey,
      userId: account.userId,
      userName: account.userName,
      email: account.email,
      keyName: account.keyName,
    };
    deduped.push(entry);
    writeFileSync(OAUTH_KEY_FILE, JSON.stringify(deduped, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

function loadStore() {
  try {
    if (!existsSync(accountsStoreFile)) return [];
    const parsed = JSON.parse(readFileSync(accountsStoreFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : parsed.accounts ?? [];
  } catch {
    return [];
  }
}

function saveStore(accounts) {
  mkdirSync(join(accountsStoreFile, '..'), { recursive: true });
  writeFileSync(accountsStoreFile, JSON.stringify({ accounts }, null, 2), 'utf8');
}

// ---------- whoami / 余额 ----------

async function whoami(apiKey) {
  const resp = await fetch(joinUrl(BASE_URL, '/alpha/whoami'), {
    method: 'GET',
    headers: buildGatewayHeaders({ apiKey }),
  });
  if (resp.status === 401) {
    const err = new Error('invalid_key');
    err.code = 'invalid_key';
    throw err;
  }
  if (!resp.ok) {
    const err = new Error(`whoami failed: ${resp.status}`);
    err.code = 'server_error';
    throw err;
  }
  const data = await resp.json();
  // 真实结构: { success, user: { id, name, email, userName }, org }
  return data?.user ?? data ?? {};
}

async function fetchCreditBalance(apiKey) {
  try {
    const resp = await fetch(joinUrl(BASE_URL, '/alpha/billing/credits'), {
      method: 'GET',
      headers: buildGatewayHeaders({ apiKey }),
    });
    if (!resp.ok) return 0;
    const data = await resp.json();
    // 真实结构: { credits: { monthlyCredits, purchasedCredits, freeCredits, ... } }
    const c = data?.credits ?? {};
    const balance = Number(c.monthlyCredits ?? 0) + Number(c.purchasedCredits ?? 0) + Number(c.freeCredits ?? 0);
    return balance || 0;
  } catch {
    return 0;
  }
}

// ---------- 账号池 ----------

export function createAccountPool() {
  // 加载: oauth-key 项目级账号 + 全局账号池,按 apiKey 去重
  const globalAccounts = loadStore();
  const oauthAccounts = loadOauthKeyFile();
  const seen = new Set();
  let accounts = [...oauthAccounts, ...globalAccounts]
    .filter((a) => {
      if (!a?.apiKey || seen.has(a.apiKey)) return false;
      seen.add(a.apiKey);
      return true;
    })
    .map((a) => ({
      ...a,
      healthy: true,
      unhealthyUntil: 0,
    }));
  const affinity = new Map(); // sessionId -> accountId

  function persist() {
    saveStore(
      accounts.map(({ healthy, unhealthyUntil, source, ...rest }) => rest)
    );
  }

  return {
    // 添加账号(自动 whoami 验证)
    async addAccountByKey(apiKey, { withBalance = true } = {}) {
      const key = String(apiKey ?? '').trim();
      if (!key) throw new Error('API key is required');
      // 重复检测
      if (accounts.some((a) => a.apiKey === key)) {
        const err = new Error('This account is already added');
        err.code = 'duplicate';
        throw err;
      }
      const user = await whoami(key);
      const account = {
        id: randomUUID(),
        apiKey: key,
        userId: user?.userId ?? user?.id,
        userName: user?.userName ?? user?.name ?? 'unknown',
        email: user?.email,
        keyName: user?.keyName,
        addedAt: new Date().toISOString(),
        lastUsedAt: null,
        healthy: true,
        unhealthyUntil: 0,
      };
      if (withBalance) account.creditBalance = await fetchCreditBalance(key);
      accounts.push(account);
      persist();
      return sanitize(account);
    },

    // OAuth 授权账号: 验证后写入项目目录的 oauth-key 文件(项目级授权)
    async addOauthAccount(apiKey, { withBalance = true } = {}) {
      const key = String(apiKey ?? '').trim();
      if (!key) throw new Error('API key is required');
      if (accounts.some((a) => a.apiKey === key)) {
        const err = new Error('This account is already added');
        err.code = 'duplicate';
        throw err;
      }
      const user = await whoami(key);
      const account = {
        id: randomUUID(),
        apiKey: key,
        userId: user?.userId ?? user?.id,
        userName: user?.userName ?? user?.name ?? 'unknown',
        email: user?.email,
        keyName: user?.keyName,
        addedAt: new Date().toISOString(),
        lastUsedAt: null,
        healthy: true,
        unhealthyUntil: 0,
        source: 'oauth-key',
      };
      if (withBalance) account.creditBalance = await fetchCreditBalance(key);
      // 写入项目目录 oauth-key
      if (!saveOauthKey(account)) {
        const err = new Error(`Failed to write ${OAUTH_KEY_FILE}`);
        err.code = 'write_error';
        throw err;
      }
      accounts.push(account);
      return sanitize(account);
    },

    list() {
      return accounts.map(sanitize);
    },

    removeAccount(id) {
      const before = accounts.length;
      accounts = accounts.filter((a) => a.id !== id);
      // 清理相关亲和绑定
      for (const [sid, accId] of affinity) {
        if (accId === id) affinity.delete(sid);
      }
      if (accounts.length !== before) persist();
      return accounts.length !== before;
    },

    // 会话亲和 + 余额排序选择
    pickAccount({ sessionId }) {
      const now = Date.now();
      // 清理过期 unhealthy
      for (const a of accounts) {
        if (!a.healthy && a.unhealthyUntil <= now) a.healthy = true;
      }
      // 亲和命中
      const pinned = sessionId ? affinity.get(sessionId) : null;
      if (pinned) {
        const acc = accounts.find((a) => a.id === pinned && a.healthy);
        if (acc) {
          acc.lastUsedAt = new Date().toISOString();
          return acc;
        }
        if (sessionId) affinity.delete(sessionId);
      }
      // 按余额从高到低
      let candidates = accounts
        .filter((a) => a.healthy)
        .sort((a, b) => (b.creditBalance ?? 0) - (a.creditBalance ?? 0));
      // 兜底: 没有健康账号时,强制恢复冷却最早过期的账号(避免永久不可用)
      if (!candidates.length && accounts.length > 0) {
        const expired = accounts
          .filter((a) => !a.healthy)
          .sort((a, b) => (a.unhealthyUntil ?? 0) - (b.unhealthyUntil ?? 0));
        if (expired.length) {
          expired[0].healthy = true;
          expired[0].unhealthyUntil = 0;
          candidates = [expired[0]];
        }
      }
      if (!candidates.length) throw new Error('No healthy Command Code accounts available. Add one via POST /v1/accounts/add');
      const chosen = candidates[0];
      chosen.lastUsedAt = new Date().toISOString();
      if (sessionId) affinity.set(sessionId, chosen.id);
      return chosen;
    },

    // 账号不可用(429/余额不足)临时标记
    markUnhealthy(accountId) {
      const acc = accounts.find((a) => a.id === accountId);
      if (acc) {
        acc.healthy = false;
        acc.unhealthyUntil = Date.now() + UNHEALTHY_COOLDOWN_MS;
      }
    },

    count() {
      return accounts.length;
    },
  };
}

// 脱敏: 不暴露完整 apiKey
function sanitize(account) {
  const key = account.apiKey ?? '';
  return {
    id: account.id,
    userId: account.userId,
    userName: account.userName,
    email: account.email,
    keyName: account.keyName,
    keyTail: key.slice(-6),
    keyPrefix: key.slice(0, 5),
    addedAt: account.addedAt,
    lastUsedAt: account.lastUsedAt,
    creditBalance: account.creditBalance ?? 0,
    healthy: account.healthy !== false,
  };
}
