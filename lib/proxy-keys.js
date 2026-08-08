// Proxy Key 管理: 多个授权 key(门票),认证时校验是否在列表内
// 存储: 当前目录 proxy-keys.json
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_STORE_FILE = join(process.cwd(), 'proxy-keys.json');

export const proxyKeysStoreFile = process.env.CMDCODE_PROXY_KEYS_FILE || DEFAULT_STORE_FILE;

function loadStore() {
  try {
    if (!existsSync(proxyKeysStoreFile)) return [];
    const parsed = JSON.parse(readFileSync(proxyKeysStoreFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : parsed.keys ?? [];
  } catch {
    return [];
  }
}

function saveStore(keys) {
  mkdirSync(join(proxyKeysStoreFile, '..'), { recursive: true });
  writeFileSync(proxyKeysStoreFile, JSON.stringify({ keys }, null, 2), 'utf8');
}

// 生成一个随机 key
export function generateProxyKey() {
  return `cc-${randomBytes(18).toString('base64url')}`;
}

export function createProxyKeyStore() {
  let keys = loadStore();

  function persist() {
    saveStore(keys);
  }

  return {
    // 环境变量 PROXY_API_KEY 作为初始化: 存在且不在列表时自动加入
    init() {
      const envKey = process.env.PROXY_API_KEY;
      if (envKey && !keys.some((k) => k.key === envKey)) {
        keys.push({ id: randomUUID(), key: envKey, name: 'env-init', enabled: true, createdAt: new Date().toISOString() });
        persist();
      }
      // 空池时生成一个 admin key
      if (keys.length === 0) {
        const k = { id: randomUUID(), key: generateProxyKey(), name: 'admin', enabled: true, createdAt: new Date().toISOString() };
        keys.push(k);
        persist();
        return k;
      }
      return null;
    },

    // 认证: key 是否在启用的列表内
    validate(authHeader) {
      const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : '';
      if (!token) return false;
      const hit = keys.find((k) => k.key === token && k.enabled !== false);
      return Boolean(hit);
    },

    // 管理认证: 密码校验(admin 密码单独存,首次设置)
    setAdminPassword(password) {
      persistAdmin({ password });
    },

    validateAdmin(password) {
      const cfg = loadAdmin();
      return Boolean(cfg?.password && cfg.password === password);
    },

    hasAdminPassword() {
      return Boolean(loadAdmin()?.password);
    },

    list() {
      // 管理页受 admin 密码保护,返回完整 key 用于复制
      return keys.map((k) => ({
        id: k.id,
        name: k.name,
        key: k.key,
        keyTail: k.key.slice(-6),
        keyPrefix: k.key.slice(0, 6),
        enabled: k.enabled !== false,
        createdAt: k.createdAt,
      }));
    },

    // 返回完整 key(仅管理页展示用)
    listFull() {
      return keys.map((k) => ({ ...k }));
    },

    add({ name, key }) {
      const k = key && key.trim() ? key.trim() : generateProxyKey();
      if (keys.some((x) => x.key === k)) {
        const err = new Error('This proxy key already exists');
        err.code = 'duplicate';
        throw err;
      }
      const entry = {
        id: randomUUID(),
        key: k,
        name: name?.trim() || 'unnamed',
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      keys.push(entry);
      persist();
      return entry;
    },

    remove(id) {
      const before = keys.length;
      keys = keys.filter((k) => k.id !== id);
      if (keys.length !== before) persist();
      return keys.length !== before;
    },

    setEnabled(id, enabled) {
      const k = keys.find((x) => x.id === id);
      if (!k) return false;
      k.enabled = Boolean(enabled);
      persist();
      return true;
    },

    count() {
      return keys.length;
    },
  };
}

// ---------- admin 密码存储 ----------
const ADMIN_FILE = join(process.cwd(), 'admin.json');

function loadAdmin() {
  try {
    if (!existsSync(ADMIN_FILE)) return null;
    return JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function persistAdmin(data) {
  mkdirSync(join(ADMIN_FILE, '..'), { recursive: true });
  writeFileSync(ADMIN_FILE, JSON.stringify(data, null, 2), 'utf8');
}
