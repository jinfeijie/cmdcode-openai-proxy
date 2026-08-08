// 网关请求 + SSE 解析(裸 JSON 行,逆向自 cli.mjs 的 readLines / consumeStream / createNodeTransport)
import { BASE_URL, ROUTE_GENERATE, buildGatewayHeaders, joinUrl } from './auth.js';

const DEFAULT_TIMEOUT_MS = 120_000;

// 逆向自 parseEmbeddedErrorJSON: 响应体可能是 "400 {json}" 或纯 JSON
export function parseEmbeddedError(body) {
  if (!body) return null;
  const i = body.indexOf('{');
  if (i === -1) return null;
  try {
    const parsed = JSON.parse(body.slice(i));
    if (typeof parsed?.error?.message !== 'string') return null;
    const statusPrefix = body.slice(0, i).trim();
    return {
      status: /^\d+$/.test(statusPrefix) ? Number(statusPrefix) : null,
      type: typeof parsed.error.type === 'string' ? parsed.error.type : null,
      message: parsed.error.message,
    };
  } catch {
    return null;
  }
}

// 逆向自 readStreamErrorEvent
function readStreamErrorEvent(event) {
  if (typeof event.error === 'string' && event.error) return { message: event.error };
  const t = typeof event.error === 'object' && event.error ? event.error : {};
  return {
    message: (typeof t.message === 'string' && t.message) || 'Stream error',
    statusCode: t.statusCode,
    isRetryable: t.isRetryable,
  };
}

async function* readJsonLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
      nl = buf.indexOf('\n');
    }
  }
  const rest = buf.trim();
  if (rest) yield rest;
}

export class GatewayError extends Error {
  constructor(message, { status, type, retryable } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.type = type;
    this.retryable = retryable;
  }
}

// 发起网关请求,返回异步事件迭代器
export async function streamGateway({ body, apiKey, sessionId, cliVersion, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = joinUrl(BASE_URL, ROUTE_GENERATE);
    const resp = await fetch(url, {
      method: 'POST',
      headers: buildGatewayHeaders({ apiKey, sessionId, cliVersion }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const parsed = parseEmbeddedError(text);
      const status = parsed?.status ?? resp.status;
      const type = parsed?.type ?? 'gateway_error';
      const message = parsed?.message ?? `${status}: ${text.slice(0, 300)}`;
      throw new GatewayError(message, { status, type });
    }

    return (async function* () {
      try {
        for await (const line of readJsonLines(resp)) {
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue; // 非 JSON 行跳过
          }
          if (event?.type === 'error') {
            const e = readStreamErrorEvent(event);
            const embedded = parseEmbeddedError(e.message);
            const status = embedded?.status ?? e.statusCode ?? 500;
            throw new GatewayError(embedded?.message ?? e.message, { status, type: embedded?.type, retryable: e.isRetryable });
          }
          yield event;
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onOuterAbort);
      }
    })();
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
    if (err instanceof GatewayError) throw err;
    if (err.name === 'AbortError') {
      throw new GatewayError('Request timed out or aborted', { status: 408, type: 'timeout' });
    }
    throw new GatewayError(`Gateway network error: ${err.message}`, { status: 502, type: 'network' });
  }
}
