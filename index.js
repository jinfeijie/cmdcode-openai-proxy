// Command Code -> OpenAI 兼容翻译层入口
// 暴露 OpenAI /v1/chat/completions(流式 + 非流式),内部走 Command Code 私有网关
// 支持多账号池 + 设备码授权 + 对外 Bearer 认证
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadApiKey, buildGatewayHeaders } from './lib/auth.js';
import { streamGateway, GatewayError } from './lib/gateway.js';
import { openaiToWireBody, createWireToOpenAI, finishToOpenAI } from './lib/translate.js';
import { collectImagesFromMessages, describeImagesWithLuna, replaceImagesWithDescription, needsVisionAssist, VISION_MODEL } from './lib/vision.js';
import { createAccountPool } from './lib/accounts.js';
import { startDeviceFlow, submitDeviceCode, consumeDeviceFlow, peekDeviceFlow } from './lib/device-flow.js';
import { createProxyKeyStore } from './lib/proxy-keys.js';
import { generateStateToken, buildAuthUrl, startOAuthCallbackServer } from './lib/oauth.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
// 默认 CLI 版本(网关要求 x-command-code-version 头,缺失会报 "CLI out of date")
// 环境变量可覆盖;CLI 升级后记得更新这里
const cliVersion = process.env.CMDCODE_CLI_VERSION || '1.14.1';

// Proxy key 池: 多个授权 key,认证校验;首次启动自动生成 admin key
const proxyKeys = createProxyKeyStore();
const initKey = proxyKeys.init();
if (initKey) {
  console.log('\n==========================================');
  console.log('  首次启动: 已生成管理用 proxy key');
  console.log(`  KEY: ${initKey.key}`);
  console.log('  用它作为客户端 Authorization,或访问管理页设置');
  console.log('==========================================\n');
}

// 账号池: 多 Command Code 账号;项目 oauth-key 优先,空池时回退到 ~/.commandcode/auth.json
const pool = createAccountPool();
if (pool.count() === 0) {
  try {
    const fallbackKey = loadApiKey();
    pool.addAccountByKey(fallbackKey, { withBalance: false }).catch((err) => {
      console.error(`[accounts] fallback auth.json key failed validation: ${err.message}`);
    });
  } catch (err) {
    console.error(`[accounts] no accounts configured and no auth.json fallback: ${err.message}`);
  }
}

// 逆向自 cli.mjs 的 `nr` 模型集合(54 个)
const MODEL_IDS = [
  'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8',
  'claude-opus-4-7', 'claude-haiku-4-5-20251001', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.4-mini', 'MiniMaxAI/MiniMax-M3-Free',
  'moonshotai/Kimi-K3', 'thinkingmachines/inkling', 'thinkingmachines/inkling-small',
  'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'moonshotai/Kimi-K2.7-Code',
  'moonshotai/Kimi-K2.7-Code-Highspeed', 'moonshotai/Kimi-K2.6', 'moonshotai/Kimi-K2.5',
  'zai-org/GLM-5.2', 'zai-org/GLM-5.2-Fast', 'zai-org/GLM-5.1', 'zai-org/GLM-5',
  'MiniMaxAI/MiniMax-M3', 'MiniMaxAI/MiniMax-M2.7', 'MiniMaxAI/MiniMax-M2.5',
  'xiaomi/mimo-v2.5-pro', 'xiaomi/mimo-v2.5', 'Qwen/Qwen3.6-Max-Preview', 'Qwen/Qwen3.6-Plus',
  'Qwen/Qwen3.7-Max', 'Qwen/Qwen3.7-Plus', 'Qwen/Qwen3.8-Max', 'Qwen/Qwen3.7-Flash',
  'stepfun/Step-3.7-Flash', 'stepfun/Step-3.5-Flash', 'tencent/hy3-paid', 'tencent/Hy3',
  'google/gemini-3.6-flash', 'google/gemini-3.5-flash', 'google/gemini-3.5-flash-lite',
  'google/gemini-3.1-flash-lite', 'sakana/fugu-ultra', 'xai/grok-4.5', 'meta/muse-spark-1.1',
  'meta/muse-spark-1.2', 'meta/muse-spark-1.2-contributor', 'nvidia/nemotron-3-ultra-550b-a55b',
  'poolside/laguna-s-2.1-free', 'inclusionai/ling-3.0-flash-free',
];

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, status, obj) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function openaiError(status, message, type = 'invalid_request_error') {
  return { error: { message, type, param: null, code: null } };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

// 对外认证: proxy key 池校验(任一启用的 key 有效即放行)
function checkProxyAuth(req) {
  return proxyKeys.validate(req.headers.authorization);
}

// 会话亲和 key: 优先客户端 user 参数,其次 x-session-id 头,兜底来源 IP
function extractSessionId(input, req) {
  if (typeof input?.user === 'string' && input.user) return `u:${input.user}`;
  const sid = req.headers['x-session-id'];
  if (typeof sid === 'string' && sid) return `h:${sid}`;
  return `ip:${req.socket.remoteAddress ?? 'unknown'}`;
}

// 处理单次 chat completion 请求
async function handleChatCompletions(req, res) {
  cors(res);
  if (!checkProxyAuth(req)) {
    return sendJson(res, 401, openaiError(401, 'Invalid or missing proxy API key. Set Authorization: Bearer <PROXY_API_KEY>', 'authentication_error'));
  }
  let input;
  try {
    input = await readBody(req);
  } catch {
    return sendJson(res, 400, openaiError(400, 'Invalid JSON body'));
  }
  const {
    model, messages, tools, temperature, max_tokens, max_completion_tokens, stream,
    reasoning_effort, tool_choice, response_format, top_p, stop, seed, parallel_tool_calls,
    presence_penalty, frequency_penalty, logprobs, top_logprobs, user, n, logit_bias, service_tier,
    store, metadata, prediction, audio, modalities, web_search_options,
  } = input;
  if (!model || !Array.isArray(messages)) {
    return sendJson(res, 400, openaiError(400, "Missing required field: 'model' or 'messages'"));
  }
  console.log(`[chat] ${new Date().toISOString()} model=${model} stream=${stream === true} messages=${messages.length}`);

  const isStream = stream === true;
  const sessionKey = extractSessionId(input, req); // 会话亲和 key(非 uuid)
  const threadId = randomUUID(); // 网关 threadId 必须是合法 uuid

  // 从账号池选账号(会话亲和 + 余额排序)
  let account;
  try {
    account = pool.pickAccount({ sessionId: sessionKey });
  } catch (err) {
    return sendJson(res, 503, openaiError(503, err.message, 'no_accounts'));
  }
  const apiKey = account.apiKey;
  const accountId = account.id;

  // 视觉外挂: 目标模型不支持视觉但消息里有图片时,先用 luna 识别成文字
  let effectiveMessages = messages;
  const images = collectImagesFromMessages(messages);
  if (images.length > 0 && needsVisionAssist(model)) {
    console.log(`[vision-assist] ${new Date().toISOString()} model=${model} 触发视觉外挂, ${images.length} 张图 -> ${VISION_MODEL}`);
    try {
      const results = await describeImagesWithLuna({
        messages,
        images,
        apiKey,
        sessionId: threadId,
        cliVersion,
      });
      console.log(`[vision-assist] ${new Date().toISOString()} 外挂成功, ${results.length} 张图已转文字描述`);
      for (const [i, r] of results.entries()) {
        console.log(`[vision-assist]   图 ${i + 1}/${results.length}${r.fromCache ? '(缓存)' : ''}: ${r.description}`);
      }
      effectiveMessages = replaceImagesWithDescription(messages, results);
    } catch (err) {
      // 外挂失败不阻断主流程: 降级为直接转发(模型会说自己看不到图)
      console.error(`[vision-assist] ${new Date().toISOString()} luna failed: ${err.message}`);
    }
  }

  const wireBody = openaiToWireBody({
    model, messages: effectiveMessages, tools, temperature,
    max_tokens: max_tokens ?? max_completion_tokens,
    stream: isStream, reasoning_effort, sessionId: threadId,
    tool_choice, response_format, top_p, stop, seed, parallel_tool_calls,
    presence_penalty, frequency_penalty, logprobs, top_logprobs, user, logit_bias, service_tier,
    store, metadata, prediction, audio, modalities, web_search_options,
  });

  const signal = req.signal ?? new AbortController().signal;

  // n>1: 并发跑多个独立网关流,拼成多个 choices
  const nChoices = Number.isInteger(n) && n > 1 ? n : 1;
  const includeUsage = input.stream_options?.include_usage === true;

  // 账号重试: 当前账号 429/403 时标记不可用,换账号重试一次
  let currentAccount = account;
  let retried = false;

  for (;;) {
    try {
      const key = currentAccount.apiKey;
      if (nChoices === 1) {
        // 解析强制工具名(用于软重试): 仅 {type:"function",function:{name}} 需要
        const forceToolName =
          typeof tool_choice === 'object' && tool_choice?.type === 'function'
            ? tool_choice.function?.name
            : undefined;
        if (!isStream) {
          const payload = await handleNonStreaming({ wireBody, apiKey: key, cliVersion, signal, sessionId: threadId, forceToolName, model });
          return sendJson(res, 200, payload);
        }
        const events = await streamGateway({
          body: wireBody,
          apiKey: key,
          sessionId: threadId,
          cliVersion,
          signal,
        });
        return handleStreaming(events, res, { includeUsage, model });
      }

      // n>1: 每个 choice 独立 session/thread,并发请求
      if (!isStream) {
        const runs = await Promise.allSettled(
          Array.from({ length: nChoices }, (_, i) =>
            runSingleChoice({ wireBody, apiKey: key, cliVersion, signal, sessionId: randomUUID() })
          )
        );
        const choices = [];
        let firstError = null;
        let usage = null;
        runs.forEach((run, i) => {
          if (run.status === 'fulfilled') {
            choices.push({ index: i, logprobs: null, ...run.value.choice });
            if (run.value.usage) usage = run.value.usage;
          } else if (!firstError) {
            firstError = run.reason;
          }
        });
        if (choices.length === 0) {
          throw firstError;
        }
        const payload = {
          id: `chatcmpl-${randomUUID()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices,
          system_fingerprint: 'fp_cmdcode_proxy',
        };
        if (usage) payload.usage = usage;
        return sendJson(res, 200, payload);
      }

      // n>1 流式: 并发 n 个流,交错输出多 choice 的 delta
      const streams = await Promise.all(
        Array.from({ length: nChoices }, () =>
          streamGateway({ body: wireBody, apiKey: key, sessionId: randomUUID(), cliVersion, signal })
        )
      );
      return handleMultiStreaming(streams, res, { includeUsage, n: nChoices, model });
    } catch (err) {
      // 账号级故障(429/403/401/余额): 标记 + 换账号重试一次
      const status = err instanceof GatewayError ? err.status : null;
      const isAccountIssue = status === 429 || status === 401 || status === 403 || (err.message ?? '').includes('insufficient credits');
      if (isAccountIssue && !retried) {
        pool.markUnhealthy(currentAccount.id);
        retried = true;
        try {
          currentAccount = pool.pickAccount({ sessionId: undefined }); // 解除亲和,选其他
          if (currentAccount.id === account.id) {
            // 没有别的账号,保持报错
            if (err instanceof GatewayError) {
              return sendJson(res, err.status ?? 502, openaiError(err.status ?? 502, err.message, err.type ?? 'gateway_error'));
            }
            return sendJson(res, 500, openaiError(500, err.message));
          }
          continue; // 换账号重试
        } catch {
          // 无可用账号
          if (err instanceof GatewayError) {
            return sendJson(res, err.status ?? 502, openaiError(err.status ?? 502, err.message, err.type ?? 'gateway_error'));
          }
          return sendJson(res, 500, openaiError(500, err.message));
        }
      }
      if (err instanceof GatewayError) {
        return sendJson(res, err.status ?? 502, openaiError(err.status ?? 502, err.message, err.type ?? 'gateway_error'));
      }
      return sendJson(res, 500, openaiError(500, err.message));
    }
  }
}

// 跑单个网关流,聚合成一个 OpenAI choice + usage
async function runSingleChoice({ wireBody, apiKey, cliVersion, signal, sessionId }) {
  const events = await streamGateway({ body: wireBody, apiKey, sessionId, cliVersion, signal });
  const converter = createWireToOpenAI();
  const chunks = [];
  let finish = null;
  let streamError = null;
  for await (const event of events) {
    if (event.type === 'error') {
      streamError = event;
      break;
    }
    const chunk = converter(event);
    if (chunk) chunks.push(chunk);
    if (chunk?.type === 'finish') finish = chunk;
  }
  if (streamError) {
    const err = new GatewayError(streamError.message ?? 'Gateway stream error', { status: 502 });
    throw err;
  }

  const message = { role: 'assistant', content: '' };
  const toolCalls = [];
  for (const chunk of chunks) {
    if (chunk.delta?.content) message.content += chunk.delta.content;
    for (const tc of chunk.delta?.tool_calls ?? []) {
      let slot = toolCalls[tc.index];
      if (!slot) {
        slot = { id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } };
        toolCalls[tc.index] = slot;
      }
      slot.function.arguments += tc.function.arguments;
    }
  }
  if (toolCalls.length) message.tool_calls = toolCalls.filter(Boolean);

  const finishReason = finish?.finish_reason ?? 'stop';
  const usage = finish?.usage;
  return { choice: { message, finish_reason: finishReason }, usage };
}

async function handleNonStreaming({ wireBody, apiKey, cliVersion, signal, sessionId, forceToolName, model }) {
  let attempt = 0;
  let result;
  // 强制工具调用时,若模型没调用,重试一次(网关对 {type:"tool"} 有时忽略)
  for (;;) {
    result = await runSingleChoice({ wireBody, apiKey, cliVersion, signal, sessionId });
    if (!forceToolName || result.choice.message.tool_calls?.length || attempt >= 1) break;
    attempt++;
    // 重试时保持强制,换新 session
    sessionId = randomUUID();
  }
  const payload = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, logprobs: null, ...result.choice }],
    system_fingerprint: 'fp_cmdcode_proxy',
  };
  if (result.usage) payload.usage = result.usage;
  return payload;
}

async function handleStreaming(events, res, { includeUsage = false, model = 'unknown' } = {}) {
  cors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const converter = createWireToOpenAI();
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let finishReason = 'stop';
  let usage;
  let errored = false;

  const sendChunk = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const base = { id, object: 'chat.completion.chunk', created, model, system_fingerprint: 'fp_cmdcode_proxy' };

  // 起始 chunk(role)
  sendChunk({
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  });

  try {
    for await (const event of events) {
      const chunk = converter(event);
      if (!chunk) continue;
      if (chunk.type === 'finish') {
        finishReason = chunk.finish_reason;
        usage = chunk.usage;
        sendChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
      } else if (chunk.type === 'error') {
        errored = true;
        sendChunk({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
          error: chunk.error,
        });
      } else {
        sendChunk({ ...base, choices: [{ index: 0, delta: chunk.delta, finish_reason: null }] });
      }
    }
  } catch (err) {
    errored = true;
    sendChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'error' }], error: { message: err.message } });
  } finally {
    if (!errored) {
      if (!finishReason) sendChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
      // stream_options.include_usage: 在 [DONE] 前发一个带 usage 的 chunk(choices 为空)
      if (includeUsage && usage) {
        sendChunk({ ...base, choices: [], usage });
      }
      res.write('data: [DONE]\n\n');
    }
    res.end();
  }
}

// 流式 n>1: 并发 n 个网关流,交错输出多个 choice 的 delta
async function handleMultiStreaming(streams, res, { includeUsage = false, n = 2, model = 'unknown' } = {}) {
  cors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: 'chat.completion.chunk', created, model, system_fingerprint: 'fp_cmdcode_proxy' };
  const sendChunk = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  // 每个 choice 独立的 converter(保持各 choice 的 tool_call index 独立)
  const converters = Array.from({ length: n }, () => createWireToOpenAI());
  const finishReasons = new Array(n).fill(null);
  const usages = new Array(n).fill(null);
  const errored = new Array(n).fill(false);

  // 起始 chunk: 所有 choice 的 role
  sendChunk({
    ...base,
    choices: Array.from({ length: n }, (_, i) => ({
      index: i,
      delta: { role: 'assistant', content: '' },
      finish_reason: null,
    })),
  });

  // 并行消费所有流,每来一个事件就按 index 转发
  await Promise.all(
    streams.map(async (stream, i) => {
      try {
        for await (const event of stream) {
          const chunk = converters[i](event);
          if (!chunk) continue;
          if (chunk.type === 'finish') {
            finishReasons[i] = chunk.finish_reason;
            usages[i] = chunk.usage;
            sendChunk({ ...base, choices: [{ index: i, delta: {}, finish_reason: chunk.finish_reason }] });
          } else if (chunk.type === 'error') {
            errored[i] = true;
            sendChunk({ ...base, choices: [{ index: i, delta: {}, finish_reason: 'error' }], error: chunk.error });
          } else {
            sendChunk({ ...base, choices: [{ index: i, delta: chunk.delta, finish_reason: null }] });
          }
        }
      } catch (err) {
        errored[i] = true;
        sendChunk({ ...base, choices: [{ index: i, delta: {}, finish_reason: 'error' }], error: { message: err.message } });
      }
    })
  );

  // 补发未 finish 的 choice 的结束事件
  for (let i = 0; i < n; i++) {
    if (!errored[i] && !finishReasons[i]) {
      sendChunk({ ...base, choices: [{ index: i, delta: {}, finish_reason: 'stop' }] });
    }
  }

  if (includeUsage) {
    const totalUsage = usages.find(Boolean);
    if (totalUsage) {
      sendChunk({ ...base, choices: [], usage: totalUsage });
    }
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// ---------- 管理页面 ----------

// 管理会话: 登录成功种 cookie,刷新保持登录
const adminSessions = new Map(); // token -> expiresAt
const ADMIN_SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天

// OAuth 授权流程状态: flowId -> { status, url, close, account, error, startedAt }
const oauthFlows = new Map();
// 定期清理超时的 OAuth flow(5 分钟)
setInterval(() => {
  const now = Date.now();
  for (const [id, flow] of oauthFlows) {
    if (flow.status === 'waiting' && now - flow.startedAt > 5 * 60 * 1000) {
      flow.close?.();
      oauthFlows.delete(id);
    }
  }
}, 60_000).unref();

function createAdminSession() {
  const token = randomUUID() + randomUUID();
  adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL);
  // 清理过期
  for (const [t, exp] of adminSessions) {
    if (exp < Date.now()) adminSessions.delete(t);
  }
  return token;
}

function validateAdminSession(req) {
  const cookie = req.headers.cookie ?? '';
  const match = /admin_session=([^;]+)/.exec(cookie);
  if (!match) return false;
  const token = decodeURIComponent(match[1]);
  const exp = adminSessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function readCookies(req) {
  const out = {};
  const cookie = req.headers.cookie ?? '';
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('='));
  }
  return out;
}

const ADMIN_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Command Code Proxy 管理</title>
<style>
body{font-family:system-ui,max-width:900px;margin:40px auto;padding:0 20px;color:#222}
h1{font-size:22px}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:6px}
.card{background:#f8f8f8;border-radius:8px;padding:16px;margin:12px 0}
table{width:100%;border-collapse:collapse;font-size:14px}
td,th{text-align:left;padding:8px;border-bottom:1px solid #eee}
input,button{padding:8px 12px;font-size:14px;margin:4px}
input[type=text]{font-family:monospace;width:380px}
button{cursor:pointer}
.badge{padding:2px 8px;border-radius:10px;font-size:12px}
.on{background:#d4edda;color:#155724}.off{background:#f8d7da;color:#721c24}
.msg{padding:8px;margin:8px 0;border-radius:6px}
.ok{background:#d4edda;color:#155724}.err{background:#f8d7da;color:#721c24}
code{background:#eee;padding:2px 6px;border-radius:4px}
</style></head><body>
<h1>Command Code Proxy 管理</h1>
<div id="msg"></div>
<h2>Proxy Keys(客户端授权)</h2>
<div class="card">
  <p>客户端请求需带 <code>Authorization: Bearer &lt;key&gt;</code>。每个 key 可给不同使用者。</p>
  <form id="keyForm" onsubmit="return addKey(event)">
    <input type="text" id="keyName" placeholder="名称(如: 朋友A)" required>
    <input type="text" id="keyValue" placeholder="留空自动生成">
    <button type="submit">添加</button>
  </form>
  <p style="font-size:13px;color:#666">HTTPS base(留空则只生成 HTTP 连接串,适用于已配置 TLS 反代的场景):
  <input type="text" id="httpsBase" placeholder="https://proxy.example.com/v1" style="width:280px" onchange="saveHttpsBase()"></p>
  <table id="keyTable"><thead><tr><th>名称</th><th>Key</th><th>状态</th><th>复制</th><th>操作</th></tr></thead><tbody></tbody></table>
</div>
<h2>Command Code 账号(额度池)</h2>
<div class="card">
  <p>请求分配:首次按余额智能选择 → 会话亲和 → 账号不可用自动切换。</p>
  <button onclick="startOAuth()" style="background:#007bff;color:#fff;border:none;padding:10px 18px;border-radius:6px">🔐 用 Command Code 账号登录(OAuth)</button>
  <p style="font-size:13px;color:#666">点击后用浏览器打开官方授权页,登录后自动添加账号,无需手动复制 API key。</p>
  <form id="accForm" onsubmit="return addAccount(event)">
    <input type="text" id="accKey" placeholder="user_...(或手动粘贴 API key)" required>
    <button type="submit">添加账号</button>
  </form>
  <table id="accTable"><thead><tr><th>用户</th><th>邮箱</th><th>余额</th><th>状态</th><th>操作</th></tr></thead><tbody></tbody></table>
</div>
<script src="/admin.js"></script>
</body></html>`;

// 管理页登录/渲染
async function handleAdminPage(req, res, url) {
  cors(res);
  // 禁止缓存管理页(避免浏览器用旧版 JS)
  res.setHeader('Cache-Control', 'no-store');
  // 首次: 未设置密码时显示设置密码页
  if (!proxyKeys.hasAdminPassword() && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>设置管理密码</title></head>
<body style="font-family:system-ui;max-width:400px;margin:80px auto;text-align:center">
<h2>设置管理密码</h2>
<p>首次使用,请设置管理密码。之后管理页需要登录。</p>
<form method="POST" action="/admin">
  <input type="password" name="password" placeholder="管理密码" required style="padding:10px;width:200px">
  <br><br><button type="submit" style="padding:10px 30px">设置并进入</button>
</form>
</body></html>`);
  }
  if (!proxyKeys.hasAdminPassword() && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const password = params.get('password')?.trim();
    if (!password || password.length < 4) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      return res.end('<h3>密码至少 4 位,请返回重试</h3><a href="/admin">返回</a>');
    }
    proxyKeys.setAdminPassword(password);
    // PRG: 设置密码后重定向到 /admin 显示登录页
    res.writeHead(302, { Location: '/admin' });
    return res.end();
  }
  // 已设置密码: 校验
  if (proxyKeys.hasAdminPassword()) {
    // 登录 POST: 验证密码 → 种 cookie → 进管理页
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if (proxyKeys.validateAdmin(params.get('password'))) {
        const token = createAdminSession();
        // PRG: POST 后 302 重定向到 GET,避免刷新时重发表单
        res.writeHead(302, {
          Location: '/admin',
          'Set-Cookie': `admin_session=${token}; HttpOnly; Path=/; Max-Age=${ADMIN_SESSION_TTL / 1000}; SameSite=Lax`,
        });
        return res.end();
      }
      res.writeHead(401, { 'Content-Type': 'text/html' });
      return res.end('<h3>密码错误</h3><a href="/admin">返回</a>');
    }
    // GET: 已有有效会话 cookie 直接进管理页
    if (validateAdminSession(req)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(ADMIN_HTML);
    }
    // GET: X-Admin-Pass 头兼容(API 调试用)
    const pass = req.headers['x-admin-pass'];
    if (pass && proxyKeys.validateAdmin(pass)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(ADMIN_HTML);
    }
    // GET: 未登录 → 登录页
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>管理登录</title></head>
<body style="font-family:system-ui;max-width:400px;margin:80px auto;text-align:center">
<h2>Command Code Proxy 管理</h2>
<form method="POST" action="/admin">
  <input type="password" name="password" placeholder="管理密码" required style="padding:10px;width:200px">
  <br><br><button type="submit" style="padding:10px 30px">登录</button>
</form>
</body></html>`);
  }
  res.writeHead(404).end();
}

// 管理页静态资源
function serveAdminStatic(res, pathname) {
  try {
    const file = readFileSync(join(process.cwd(), 'static', pathname.replace(/^\//, '')), 'utf8');
    cors(res);
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
    return res.end(file);
  } catch {
    return sendJson(res, 404, openaiError(404, 'Static file not found'));
  }
}

// 管理 API: /api/admin/*
async function handleAdminApi(req, res, url) {
  cors(res);
  // 管理 API 认证: 会话 cookie 或 X-Admin-Pass 头
  const pass = req.headers['x-admin-pass'];
  const authed = validateAdminSession(req) || proxyKeys.validateAdmin(pass);
  if (!authed) {
    return sendJson(res, 401, openaiError(401, 'Admin authentication required. Login at /admin first.', 'admin_auth'));
  }

  const parts = url.pathname.split('/').filter(Boolean); // ['api','admin',...]

  // GET /api/admin/keys
  if (req.method === 'GET' && parts.length === 3 && parts[2] === 'keys') {
    return sendJson(res, 200, { keys: proxyKeys.list() });
  }
  // POST /api/admin/keys
  if (req.method === 'POST' && parts.length === 3 && parts[2] === 'keys') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, openaiError(400, 'Invalid JSON')); }
    try {
      const key = proxyKeys.add({ name: body?.name, key: body?.key });
      return sendJson(res, 200, { success: true, key });
    } catch (err) {
      return sendJson(res, 400, openaiError(400, err.message, err.code ?? 'proxy_key_error'));
    }
  }
  // PATCH /api/admin/keys/:id
  const keyPatch = req.method === 'PATCH' && parts.length === 4 && parts[2] === 'keys' ? parts[3] : null;
  if (keyPatch) {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, openaiError(400, 'Invalid JSON')); }
    proxyKeys.setEnabled(keyPatch, body?.enabled);
    return sendJson(res, 200, { success: true });
  }
  // DELETE /api/admin/keys/:id
  const keyDel = req.method === 'DELETE' && parts.length === 4 && parts[2] === 'keys' ? parts[3] : null;
  if (keyDel) {
    proxyKeys.remove(keyDel);
    return sendJson(res, 200, { success: true });
  }

  // GET /api/admin/accounts
  if (req.method === 'GET' && parts.length === 3 && parts[2] === 'accounts') {
    return sendJson(res, 200, { accounts: pool.list(), count: pool.count() });
  }
  // POST /api/admin/accounts
  if (req.method === 'POST' && parts.length === 3 && parts[2] === 'accounts') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, openaiError(400, 'Invalid JSON')); }
    try {
      // 写入项目目录 oauth-key(项目级授权)
      const account = await pool.addOauthAccount(body?.apiKey);
      return sendJson(res, 200, { success: true, account });
    } catch (err) {
      const status = err.code === 'invalid_key' ? 401 : 400;
      return sendJson(res, status, openaiError(status, err.message, err.code ?? 'account_error'));
    }
  }

  // POST /api/admin/accounts/oauth — 启动 OAuth 浏览器授权(模拟 CLI auth login)
  if (req.method === 'POST' && parts.length === 4 && parts[2] === 'accounts' && parts[3] === 'oauth') {
    const state = generateStateToken();
    const flowId = randomUUID();
    oauthFlows.set(flowId, { status: 'starting', startedAt: Date.now() });
    // 启动临时回调服务器;官方回调到达时自动把 apiKey 加入账号池
    startOAuthCallbackServer({
      port: 0,
      state,
      onLog: (m) => console.log(`[oauth] ${m}`),
      onResult: (result) => {
        const flow = oauthFlows.get(flowId);
        if (!flow) return;
        // 异步加账号(写入项目目录 oauth-key)
        pool.addOauthAccount(result.apiKey)
          .then((account) => {
            flow.status = 'done';
            flow.account = account;
            console.log(`[oauth] flow ${flowId.slice(0, 8)} account added: ${account.userName}`);
          })
          .catch((err) => {
            flow.status = 'error';
            flow.error = err.message;
          });
      },
    })
      .then(({ port, close }) => {
        const url = buildAuthUrl({ port, state });
        const flow = oauthFlows.get(flowId);
        if (!flow) { close(); return; }
        flow.url = url;
        flow.status = 'waiting';
        flow.close = close;
        console.log(`[oauth] flow ${flowId.slice(0, 8)} started: ${url}`);
      })
      .catch((err) => {
        const flow = oauthFlows.get(flowId);
        if (flow) {
          flow.status = 'error';
          flow.error = err.message;
        }
      });
    // 等服务器起来拿到 url(最多 2s,非阻塞)
    const flow = oauthFlows.get(flowId);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const cur = oauthFlows.get(flowId);
      if (cur && cur.url) {
        return sendJson(res, 200, { success: true, flowId, url: cur.url });
      }
      if (cur && cur.status === 'error') {
        return sendJson(res, 500, openaiError(500, cur.error, 'oauth_error'));
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    void flow;
    return sendJson(res, 500, openaiError(500, 'Failed to start OAuth server', 'oauth_error'));
  }

  // GET /api/admin/accounts/oauth/status/:flowId — 轮询 OAuth 结果
  const oauthFlowMatch = /^\/api\/admin\/accounts\/oauth\/status\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (oauthFlowMatch) {
    const flowId = oauthFlowMatch[1];
    const flow = oauthFlows.get(flowId);
    if (!flow) return sendJson(res, 404, openaiError(404, 'OAuth flow not found'));
    if (flow.status === 'waiting') {
      if (Date.now() - flow.startedAt > 5 * 60 * 1000) {
        flow.close?.();
        oauthFlows.delete(flowId);
        return sendJson(res, 200, { status: 'expired' });
      }
      return sendJson(res, 200, { status: 'waiting' });
    }
    if (flow.status === 'error') {
      flow.close?.();
      oauthFlows.delete(flowId);
      return sendJson(res, 200, { status: 'error', error: flow.error });
    }
    if (flow.status === 'done') {
      const account = flow.account;
      flow.close?.();
      oauthFlows.delete(flowId);
      return sendJson(res, 200, { status: 'done', account });
    }
    return sendJson(res, 200, { status: flow.status });
  }
  // DELETE /api/admin/accounts/:id
  const accDel = req.method === 'DELETE' && parts.length === 4 && parts[2] === 'accounts' ? parts[3] : null;
  if (accDel) {
    pool.removeAccount(accDel);
    return sendJson(res, 200, { success: true });
  }

  return sendJson(res, 404, openaiError(404, 'Unknown admin API'));
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return cors(res), res.writeHead(204).end();

  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  // 设备码 verify 页/提交: 无需 proxy key(授权流程面向还没账号的人)
  const isVerifyPath = /^\/v1\/accounts\/verify\/[A-Z0-9]{8}$/.test(url.pathname);

  // 管理页相关路径: /admin 及 /api/admin/*
  const isAdminPath = url.pathname === '/admin' || url.pathname === '/admin.js' || url.pathname.startsWith('/api/admin');

  // 对外认证(verify 页和管理页除外——它们有自己的认证机制)
  if (checkProxyAuth(req) === false && !isVerifyPath && !isAdminPath) {
    return sendJson(res, 401, openaiError(401, 'Invalid or missing proxy API key. Set Authorization: Bearer <PROXY_API_KEY>', 'authentication_error'));
  }

  // ---------- 管理页面 ----------
  if (url.pathname === '/admin') {
    return handleAdminPage(req, res, url);
  }
  if (url.pathname.startsWith('/api/admin')) {
    return handleAdminApi(req, res, url);
  }
  // 管理页静态资源(需 admin 会话)
  if (url.pathname === '/admin.js') {
    if (!validateAdminSession(req)) {
      return sendJson(res, 401, openaiError(401, 'Admin authentication required', 'admin_auth'));
    }
    return serveAdminStatic(res, '/admin.js');
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return sendJson(res, 200, {
      object: 'list',
      data: MODEL_IDS.map((id) => ({ id, object: 'model', created: 0, owned_by: 'command-code' })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(req, res);
  }

  // ---------- 账号管理 ----------
  if (req.method === 'GET' && url.pathname === '/v1/accounts') {
    return sendJson(res, 200, { accounts: pool.list(), count: pool.count() });
  }

  if (req.method === 'POST' && url.pathname === '/v1/accounts/add') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, openaiError(400, 'Invalid JSON body')); }
    const apiKeyInput = body?.apiKey ?? body?.key;
    if (!apiKeyInput) return sendJson(res, 400, openaiError(400, 'Missing "apiKey" in request body'));
    try {
      // 写入项目目录 oauth-key(项目级授权)
      const account = await pool.addOauthAccount(apiKeyInput);
      return sendJson(res, 200, { success: true, account });
    } catch (err) {
      const status = err.code === 'invalid_key' ? 401 : 400;
      return sendJson(res, status, openaiError(status, err.message, err.code ?? 'account_error'));
    }
  }

  if (req.method === 'POST' && url.pathname === '/v1/accounts/device') {
    const flow = startDeviceFlow();
    const base = `http://${req.headers.host ?? `${HOST}:${PORT}`}`;
    return sendJson(res, 200, {
      success: true,
      user_code: flow.userCode,
      verification_uri: `${base}${flow.verificationUri}`,
      expires_in: flow.expiresIn,
      instructions: 'Open the verification URL in a browser and paste your Command Code API key.',
    });
  }

  // 设备码验证页: GET /v1/accounts/verify/:code
  const verifyMatch = req.method === 'GET' && /^\/v1\/accounts\/verify\/([A-Z0-9]{8})$/.exec(req.url);
  if (verifyMatch) {
    const userCode = verifyMatch[1];
    const flow = peekDeviceFlow(userCode);
    if (!flow) {
      return sendJson(res, 404, openaiError(404, 'Device code expired or invalid'));
    }
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Command Code 账号授权</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;padding:0 20px}input{width:100%;padding:10px;margin:8px 0;font-family:monospace}button{padding:10px 24px}</style>
</head><body>
<h2>Command Code 账号授权</h2>
<p>设备码: <code>${userCode}</code></p>
<p>粘贴你的 Command Code API key(<code>user_...</code>),从官网或 CLI 获取:</p>
<form method="POST" action="/v1/accounts/verify/${userCode}">
  <input type="text" name="apiKey" placeholder="user_..." autocomplete="off" required>
  <br><button type="submit">提交授权</button>
</form>
</body></html>`);
  }

  // 设备码提交: POST /v1/accounts/verify/:code (表单)
  const verifyPostMatch = req.method === 'POST' && /^\/v1\/accounts\/verify\/([A-Z0-9]{8})$/.exec(req.url);
  if (verifyPostMatch) {
    const userCode = verifyPostMatch[1];
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const apiKeyInput = params.get('apiKey')?.trim();
    if (!apiKeyInput) {
      return sendJson(res, 400, openaiError(400, 'Missing apiKey'));
    }
    submitDeviceCode(userCode, apiKeyInput);
    const flow = consumeDeviceFlow(userCode);
    try {
      const account = await pool.addOauthAccount(flow.apiKey);
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>授权成功</title></head><body style="font-family:system-ui;text-align:center;margin-top:80px"><h2>✅ 授权成功</h2><p>账号: ${account.userName}(${account.email ?? ''})</p><p>你现在可以关闭此页面,回到终端使用。</p></body></html>`);
    } catch (err) {
      const status = err.code === 'invalid_key' ? 401 : 400;
      return sendJson(res, status, openaiError(status, `授权失败: ${err.message}`, err.code ?? 'account_error'));
    }
  }

  if (req.method === 'POST' && req.url === '/v1/accounts/remove') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, openaiError(400, 'Invalid JSON body')); }
    const removed = pool.removeAccount(body?.id);
    if (!removed) return sendJson(res, 404, openaiError(404, 'Account not found'));
    return sendJson(res, 200, { success: true });
  }

  return sendJson(res, 404, openaiError(404, `Unknown route: ${req.method} ${req.url}`));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${PORT} 已被占用!可能已有旧版代理在运行。`);
    console.error(`   请先停止旧进程再启动:`);
    console.error(`   lsof -ti:${PORT} | xargs kill -9`);
    console.error(`   或换端口启动: PORT=${Number(PORT) + 1} node index.js\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`cmdcode-openai-proxy listening on http://${HOST}:${PORT}/v1`);
  console.log(`Gateway: ${process.env.CMDCODE_BASE_URL || 'https://api.commandcode.ai'}/alpha/generate`);
  console.log(`Models available via GET /v1/models (${MODEL_IDS.length})`);
  console.log(`Accounts in pool: ${pool.count()}`);
  console.log(`Proxy keys configured: ${proxyKeys.count()}`);
  console.log(`Admin page: http://${HOST}:${PORT}/admin`);
  if (!proxyKeys.hasAdminPassword()) console.log('Admin password: not set (open /admin to set it on first visit)');
});
