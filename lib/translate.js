// 双向转换: OpenAI chat/completions <-> Command Code 私有 wire 协议
// wire 格式逆向自 cli.mjs 的 toWireMessages / toWireTools / consumeStream

// 逆向自 cli.mjs 的 effort 白名单 map `tr`
const EFFORT_MAP = new Map([
  ['claude-sonnet-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-sonnet-4-6', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-fable-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-4-8', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-4-7', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.6-sol', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.6-terra', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.6-luna', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.5', ['low', 'medium', 'high', 'xhigh']],
  ['gpt-5.4', ['low', 'medium', 'high', 'xhigh']],
  ['gpt-5.3-codex', ['low', 'medium', 'high', 'xhigh']],
  ['gpt-5.4-mini', ['low', 'medium', 'high']],
  ['deepseek/deepseek-v4-pro', ['high', 'max']],
  ['deepseek/deepseek-v4-flash', ['high', 'max']],
  ['zai-org/GLM-5.2', ['high', 'max']],
  ['google/gemini-3.6-flash', ['low', 'medium', 'high']],
  ['google/gemini-3.5-flash', ['low', 'medium', 'high']],
  ['google/gemini-3.5-flash-lite', ['low', 'medium', 'high']],
  ['google/gemini-3.1-flash-lite', ['low', 'medium', 'high']],
  ['sakana/fugu-ultra', ['high', 'xhigh']],
  ['xai/grok-4.5', ['low', 'medium', 'high']],
  ['Qwen/Qwen3.8-Max', ['low', 'medium', 'xhigh']],
]);

export function getSupportedEfforts(model) {
  return EFFORT_MAP.get(model) ?? null;
}

// OpenAI 工具 parameters -> 网关 input_schema
export function toWireTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t) => ({
    name: t.function?.name ?? t.name,
    description: t.function?.description ?? t.description,
    input_schema: t.function?.parameters ?? t.parameters,
  }));
}

// 逆向自 toWireToolOutput: 把 OpenAI 工具结果内容拼成纯文本
function toWireToolOutput(content) {
  if (typeof content === 'string') return { type: 'text', value: content };
  if (Array.isArray(content)) {
    const text = content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return { type: 'text', value: text };
  }
  return { type: 'text', value: JSON.stringify(content) };
}

// OpenAI messages -> 网关 wire messages
// 注意: CLI 把 system 作为 {role:"system"} 消息放进 messages,而不是 params.system 字段
export function openaiToWireMessages(messages) {
  const out = [];
  const systemParts = [];
  for (const msg of messages) {
    // developer 角色等同 system(OpenAI 新角色,网关无对应,合并进 system)
    if (msg.role === 'system' || msg.role === 'developer') {
      systemParts.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
      continue;
    }
    if (msg.role === 'user') {
      const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
      const blocks = [];
      for (const part of content) {
        if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
        else if (part.type === 'image_url') {
          // data:image/png;base64,xxx 或 http(s) URL
          const raw = part.image_url?.url ?? '';
          const m = /^data:(.+?);base64,(.+)$/.exec(raw);
          if (m) blocks.push({ type: 'image', image: raw, mimeType: m[1] });
          else blocks.push({ type: 'image', image: raw, mimeType: '' });
        } else if (part.type === 'input_text') {
          blocks.push({ type: 'text', text: part.text });
        }
      }
      if (blocks.length > 0) out.push({ role: 'user', content: blocks });
      continue;
    }
    if (msg.role === 'assistant') {
      const blocks = [];
      const content = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
      for (const part of content) {
        if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
      }
      if (msg.reasoning) blocks.push({ type: 'reasoning', text: msg.reasoning });
      for (const tc of msg.tool_calls ?? []) {
        blocks.push({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function?.name,
          input: parseArguments(tc.function?.arguments),
        });
      }
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (msg.role === 'tool') {
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: msg.tool_call_id,
            toolName: '',
            output: toWireToolOutput(msg.content),
          },
        ],
      });
      continue;
    }
  }
  // system 通过 params.system 传给网关(CLI 抓包确认: params 有 system 字段,messages 里不放 system role)
  // 客户端没传 system 时,用"做好自己"占位:上游网关只在 system 非空时使用客户端值,
  // 否则会注入约 34KB 的默认系统提示词;占位可顶掉该注入,且不附加任何额外设定
  return { messages: out, system: systemParts.join('\n\n') };
}

function parseArguments(args) {
  if (typeof args !== 'string') return args ?? {};
  if (!args.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

export function openaiToWireBody({ model, messages, tools, temperature, max_tokens, stream, reasoning_effort, permissionMode, sessionId, tool_choice, response_format, top_p, stop, seed, parallel_tool_calls, presence_penalty, frequency_penalty, logprobs, top_logprobs, user, logit_bias, service_tier, store, metadata, prediction, audio, modalities, web_search_options }) {
  const { messages: wireMessages, system } = openaiToWireMessages(messages ?? []);
  const params = {
    model,
    messages: wireMessages,
    max_tokens: max_tokens ?? 64000,
    stream: true, // CLI 固定 stream:true,服务端按流返回
  };
  // system 通过 params.system 传给网关(CLI 抓包确认 system 在 params.system,空字符串会触发网关校验失败)
  // 客户端没传 system 时补"做好自己"占位:网关只在 system 非空时用客户端值,否则注入 34KB 默认提示词
  params.system = system || '做好自己';
  // store/metadata/prediction/audio/modalities/web_search_options: OpenAI 高级参数,网关无对应能力。
  // 静默忽略(不写入 params)—— 网关对多余字段会报 "Proxy use detected",绝不能透传
  void store; void metadata; void prediction; void audio; void modalities; void web_search_options;
  if (tools?.length) params.tools = toWireTools(tools);
  if (temperature !== undefined) params.temperature = temperature;
  if (top_p !== undefined) params.top_p = top_p;
  if (stop !== undefined) params.stop = Array.isArray(stop) ? stop : [stop];
  if (seed !== undefined) params.seed = seed;
  if (presence_penalty !== undefined) params.presence_penalty = presence_penalty;
  if (frequency_penalty !== undefined) params.frequency_penalty = frequency_penalty;
  if (logprobs !== undefined) params.logprobs = logprobs;
  if (top_logprobs !== undefined) params.top_logprobs = top_logprobs;
  if (user !== undefined) params.user = user;
  if (logit_bias !== undefined) params.logit_bias = logit_bias;
  if (service_tier !== undefined) params.service_tier = service_tier;
  // tool_choice 映射到网关格式(从网关 400 错误信息还原,只接受 auto/any/tool 三种 type):
  //   OpenAI {type:"function",function:{name}} -> {type:"tool", name}
  //   OpenAI "auto" -> {type:"auto"}
  //   OpenAI "none" -> 网关不支持,降级为 auto
  //   OpenAI "required" -> {type:"any"}
  if (tool_choice !== undefined) {
    if (typeof tool_choice === 'string') {
      const map = { auto: { type: 'auto' }, none: { type: 'auto' }, required: { type: 'any' } };
      if (map[tool_choice]) params.tool_choice = map[tool_choice];
    } else if (tool_choice?.type === 'function' && tool_choice.function?.name) {
      params.tool_choice = { type: 'tool', name: tool_choice.function.name };
    } else if (tool_choice?.type === 'tool') {
      params.tool_choice = tool_choice;
    }
  }
  if (parallel_tool_calls !== undefined) params.parallel_tool_calls = parallel_tool_calls;
  // response_format: OpenAI 的 {type:"json_object"} / {type:"json_schema",...}
  // 网关用 response_format 字段,透传
  if (response_format !== undefined) params.response_format = response_format;
  if (reasoning_effort && getSupportedEfforts(model)?.includes(reasoning_effort)) {
    params.reasoning_effort = reasoning_effort;
  }
  return {
    // 逆向自 buildServerConfig: 真实 CLI 会带上工作区结构等字段,字段必须齐全否则 400
    // workingDir 是网关必填字段,但代理不该暴露真实 cwd(会导致上游把项目名注入系统提示词),
    // 因此填中性假值
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
    permissionMode: toWirePermissionMode(permissionMode),
    threadId: sessionId, // CLI 中 threadId 与 session-id 相同(uuid 格式,必须)
    // 注意: 不带 mode 字段(真实 CLI 无此字段,带了会被识别为代理)
    params,
  };
}

// 逆向自 toWirePermissionMode
function toWirePermissionMode(mode) {
  if (mode === 'bypass') return 'auto-accept';
  if (mode === 'auto-accept' || mode === 'plan') return mode;
  return 'standard';
}

// ---------- 响应方向: 网关事件 -> OpenAI chunk ----------

// 网关 totalUsage -> OpenAI usage 结构(含细分字段)
function toOpenAIUsage(totalUsage) {
  if (!totalUsage) return undefined;
  const inputTokens = totalUsage.inputTokens ?? 0;
  const outputTokens = totalUsage.outputTokens ?? 0;
  const cachedTokens = totalUsage.cachedInputTokens ?? totalUsage.inputTokenDetails?.cacheReadTokens ?? 0;
  const reasoningTokens = totalUsage.reasoningTokens ?? totalUsage.outputTokenDetails?.reasoningTokens ?? 0;
  const usage = {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
  // 细分字段: 有值时附带(官方结构)
  if (cachedTokens > 0 || totalUsage.inputTokenDetails?.cacheReadTokens) {
    usage.prompt_tokens_details = {
      cached_tokens: cachedTokens,
      audio_tokens: totalUsage.inputTokenDetails?.audioTokens ?? 0,
    };
  }
  if (reasoningTokens > 0 || totalUsage.outputTokenDetails?.reasoningTokens) {
    usage.completion_tokens_details = {
      reasoning_tokens: reasoningTokens,
      audio_tokens: totalUsage.outputTokenDetails?.audioTokens ?? 0,
      accepted_prediction_tokens: totalUsage.outputTokenDetails?.acceptedPredictionTokens ?? 0,
      rejected_prediction_tokens: totalUsage.outputTokenDetails?.rejectedPredictionTokens ?? 0,
    };
  }
  return usage;
}

export function createWireToOpenAI() {
  let toolCallIndex = 0;
  const usedIds = new Map(); // toolCallId -> index
  let finished = false;

  function toolIndex(toolCallId) {
    if (usedIds.has(toolCallId)) return usedIds.get(toolCallId);
    const idx = toolCallIndex++;
    usedIds.set(toolCallId, idx);
    return idx;
  }

  return function wireToOpenAI(event) {
    switch (event.type) {
      case 'text-delta':
        return {
          type: 'delta',
          delta: { content: event.text ?? '' },
          finish_reason: null,
        };
      case 'reasoning-delta':
        // OpenAI chat 无 reasoning 字段,忽略(避免客户端解析错误)
        return null;
      case 'tool-call': {
        const idx = toolIndex(event.toolCallId ?? event.toolCallId);
        return {
          type: 'delta',
          delta: {
            tool_calls: [
              {
                index: idx,
                id: event.toolCallId,
                type: 'function',
                function: {
                  name: event.toolName,
                  arguments: JSON.stringify(event.input ?? {}),
                },
              },
            ],
          },
          finish_reason: null,
        };
      }
      case 'tool-result':
        return null; // 工具结果不回传给 OpenAI 流(由客户端本地执行)
      case 'finish': {
        if (finished) return null;
        finished = true;
        const raw = (event.rawFinishReason ?? event.finishReason ?? '').toLowerCase();
        let finishReason = 'stop';
        if (raw === 'tool_calls' || raw === 'tool-calls' || raw === 'tool_use' || raw === 'tool-call') finishReason = 'tool_calls';
        else if (raw === 'max_tokens' || raw === 'length') finishReason = 'length';
        return {
          type: 'finish',
          finish_reason: finishReason,
          usage: toOpenAIUsage(event.totalUsage),
        };
      }
      case 'error':
        return { type: 'error', error: event };
      default:
        return null;
    }
  };
}

export function finishToOpenAI({ rawFinishReason, totalUsage }) {
  const raw = (rawFinishReason ?? '').toLowerCase();
  let finishReason = 'stop';
  if (raw === 'tool_calls' || raw === 'tool-calls' || raw === 'tool_use' || raw === 'tool-call') finishReason = 'tool_calls';
  else if (raw === 'max_tokens' || raw === 'length') finishReason = 'length';
  return {
    finish_reason: finishReason,
    usage: toOpenAIUsage(totalUsage),
  };
}
