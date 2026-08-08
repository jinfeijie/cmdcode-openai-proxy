// 视觉外挂: 当目标模型不支持视觉时,用 gpt-5.6-luna 把图片转成文字描述
// 设计:
//   1. 把用户随图提问一起带给 luna,让它按用户意图针对性提取信息
//   2. 描述按图片内容哈希持久化缓存到磁盘,同一张图不重复识别
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_URL, ROUTE_GENERATE, buildGatewayHeaders, joinUrl } from './auth.js';

export const VISION_MODEL = process.env.CMDCODE_VISION_MODEL || 'gpt-5.6-luna';
export const VISION_CACHE_DIR = process.env.CMDCODE_VISION_CACHE_DIR || join(process.cwd(), 'vision-cache');
const VISION_TIMEOUT_MS = 120_000;

// ---------- 图片收集 ----------

// 收集 user 消息里的图片(data URL 或 http URL),返回 images: [{raw, mimeType, isDataUrl, hash}]
export function collectImagesFromMessages(messages) {
  const images = [];
  for (const msg of messages ?? []) {
    if (msg.role !== 'user') continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const part of content) {
      if (part.type !== 'image_url') continue;
      const raw = part.image_url?.url ?? '';
      if (!raw) continue;
      const m = /^data:(.+?);base64,(.+)$/.exec(raw);
      const info = m ? { raw, mimeType: m[1], isDataUrl: true } : { raw, mimeType: '', isDataUrl: false };
      info.hash = imageHash(info);
      images.push(info);
    }
  }
  return images;
}

// 图片内容哈希(data URL 用 base64 部分,http URL 用整个 URL)
function imageHash(img) {
  const content = img.isDataUrl ? img.raw.slice(img.raw.indexOf(',') + 1) : img.raw;
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

// ---------- 持久化缓存 ----------

function cachePath(hash) {
  return join(VISION_CACHE_DIR, `${hash}.txt`);
}

// 读缓存,命中返回描述,否则 null
function readCache(hash) {
  try {
    const p = cachePath(hash);
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function writeCache(hash, description) {
  try {
    mkdirSync(VISION_CACHE_DIR, { recursive: true });
    writeFileSync(cachePath(hash), description, 'utf8');
  } catch {
    // 缓存写失败不影响主流程
  }
}

// ---------- 用户意图提取 ----------

// 从含图片的 user 消息里提取用户文字(可能包含多轮上下文)
function extractUserIntents(messages) {
  const texts = [];
  for (const msg of messages ?? []) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    const parts = msg.content.filter((p) => p.type === 'text' && p.text?.trim());
    if (parts.length) texts.push(parts.map((p) => p.text).join('\n').trim());
  }
  return texts;
}

// ---------- luna 识别 ----------

// 调 luna 识别单张图片,返回文字描述(带用户意图引导)
async function describeSingleImage({ img, userIntents, apiKey, sessionId, cliVersion }) {
  // 缓存命中直接返回
  const cached = readCache(img.hash);
  if (cached) return { description: cached, fromCache: true };

  const intentText = userIntents.length
    ? `用户同时提供了以下文字(可能是对图片的提问或说明,请据此推测用户想从图中提取什么信息,并重点描述相关部分):\n${userIntents.join('\n---\n')}`
    : '';

  const lunaContent = [
    {
      type: 'text',
      text: `请详细描述这张图片,做到以下几点:
1. 全面描述: 画面里的物体、人物、场景、环境、颜色、布局,以及所有可见的文字、数字、表格、界面元素、代码或 UI 组件。
2. 按需提取: 如果图片里有文字内容(如报错信息、截图、文档、代码),请逐字准确转录,不要遗漏。
3. 重点回答: 结合用户可能关心的问题,突出与问题相关的信息。
${intentText ? `\n${intentText}` : ''}

请用中文回答,组织成清晰的分点描述。`,
    },
    { type: 'image', image: img.raw, mimeType: img.mimeType },
  ];

  const body = {
    config: {
      workingDir: '.',
      date: new Date().toISOString().split('T')[0],
      environment: process.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,
    permissionMode: 'standard',
    threadId: sessionId,
    params: {
      model: VISION_MODEL,
      messages: [{ role: 'user', content: lunaContent }],
      max_tokens: 2048,
      stream: true,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  try {
    const resp = await fetch(joinUrl(BASE_URL, ROUTE_GENERATE), {
      method: 'POST',
      headers: buildGatewayHeaders({ apiKey, sessionId, cliVersion }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Vision gateway ${resp.status}: ${text.slice(0, 200)}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let description = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'text-delta') description += ev.text ?? '';
            if (ev.type === 'error') throw new Error(ev.message ?? 'vision stream error');
          } catch (err) {
            if (err instanceof SyntaxError) continue; // 非 JSON 行跳过
            throw err;
          }
        }
        nl = buf.indexOf('\n');
      }
    }
    const result = description.trim();
    if (result) writeCache(img.hash, result);
    return { description: result, fromCache: false };
  } finally {
    clearTimeout(timer);
  }
}

// 批量识别多张图片(串行,各自独立缓存)
export async function describeImagesWithLuna({ messages, images, apiKey, sessionId, cliVersion }) {
  const userIntents = extractUserIntents(messages);
  const results = [];
  for (let i = 0; i < images.length; i++) {
    const { description, fromCache } = await describeSingleImage({
      img: images[i],
      userIntents,
      apiKey,
      sessionId,
      cliVersion,
    });
    results.push({ description, fromCache });
  }
  return results;
}

// ---------- 视觉模型白名单 ----------

// 判定某模型是否需要视觉外挂(已知支持视觉的模型直接放行)
const VISION_NATIVE_MODELS = new Set([
  'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-fable-5', 'claude-opus-5',
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-haiku-4-5-20251001',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.4-mini',
  'google/gemini-3.6-flash', 'google/gemini-3.5-flash', 'google/gemini-3.5-flash-lite', 'google/gemini-3.1-flash-lite',
  'moonshotai/Kimi-K2.7-Code', 'moonshotai/Kimi-K2.6', 'moonshotai/Kimi-K2.5', 'moonshotai/Kimi-K3',
  'MiniMaxAI/MiniMax-M3', 'MiniMaxAI/MiniMax-M2.7', 'MiniMaxAI/MiniMax-M2.5', 'MiniMaxAI/MiniMax-M3-Free',
  'Qwen/Qwen3.7-Max', 'Qwen/Qwen3.7-Plus', 'Qwen/Qwen3.8-Max', 'Qwen/Qwen3.6-Plus', 'Qwen/Qwen3.6-Max-Preview',
]);

export function needsVisionAssist(model) {
  if (!model) return false;
  const base = model.split(':').pop();
  if (VISION_NATIVE_MODELS.has(base)) return false;
  return true;
}

// ---------- 消息替换 ----------

// 把消息里的图片块替换成描述文本(多图带编号)
export function replaceImagesWithDescription(messages, results) {
  return (messages ?? []).map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    const hasImage = msg.content.some((p) => p.type === 'image_url');
    if (!hasImage) return msg;
    const textParts = msg.content.filter((p) => p.type === 'text').map((p) => p.text);
    const userText = textParts.join('\n').trim();

    // 生成多图描述文本
    const descLines = results.map((r, i) => `【图片${i + 1}】\n${r.description}`).join('\n\n');
    const descText = `[图片内容说明(${results.length}张图):\n${descLines}\n]`;
    return {
      ...msg,
      content: userText
        ? [{ type: 'text', text: `${userText}\n\n${descText}` }]
        : [{ type: 'text', text: descText }],
    };
  });
}
