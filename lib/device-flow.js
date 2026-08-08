// 设备码授权交互: 模拟 Command Code auth login 流程
// 用户调用 POST /v1/accounts/device -> 拿到 userCode + verificationUri
// 浏览器打开 verify 页 -> 粘贴 API key 提交 -> whoami 验证入库
import { randomBytes } from 'node:crypto';

const FLOW_TTL_MS = 10 * 60 * 1000; // 10 分钟有效

const pendingFlows = new Map(); // userCode -> { apiKey, expiresAt }

export function startDeviceFlow() {
  const userCode = randomBytes(4).toString('hex').toUpperCase().slice(0, 8);
  pendingFlows.set(userCode, { apiKey: null, expiresAt: Date.now() + FLOW_TTL_MS });
  return {
    userCode,
    verificationUri: `/v1/accounts/verify/${userCode}`,
    expiresIn: FLOW_TTL_MS / 1000,
  };
}

// 用户在 verify 页提交 API key,绑定到 flow
export function submitDeviceCode(userCode, apiKey) {
  const flow = pendingFlows.get(userCode);
  if (!flow || flow.expiresAt < Date.now()) {
    pendingFlows.delete(userCode);
    const err = new Error('Device code expired or invalid. Start a new flow.');
    err.code = 'flow_expired';
    throw err;
  }
  flow.apiKey = String(apiKey ?? '').trim();
  if (!flow.apiKey) {
    const err = new Error('API key is required');
    err.code = 'invalid_input';
    throw err;
  }
  return flow;
}

// 取回 flow(供验证入库用),验证后清理
export function consumeDeviceFlow(userCode) {
  const flow = pendingFlows.get(userCode);
  if (flow) pendingFlows.delete(userCode);
  return flow;
}

export function peekDeviceFlow(userCode) {
  const flow = pendingFlows.get(userCode);
  if (!flow || flow.expiresAt < Date.now()) {
    pendingFlows.delete(userCode);
    return null;
  }
  return flow;
}
