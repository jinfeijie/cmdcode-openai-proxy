# cmdcode-openai-proxy

把 Command Code 的私有网关协议(`POST https://api.commandcode.ai/alpha/generate`)翻译成标准的 **OpenAI `/v1/chat/completions`** 协议。任何支持 OpenAI API 的工具(Cursor、OpenWebUI、LobeChat、langchain 等)都可以把 base URL 指向本服务,用 Command Code 的订阅跑各家模型。

## 工作原理

```
┌──────────────┐   POST /v1/chat/completions   ┌──────────────────┐   POST /alpha/generate   ┌─────────────────┐
│ 任意 OpenAI  │ ────────────────────────────► │  cmdcode-proxy    │ ──────────────────────► │ api.commandcode │
│  客户端       │ ◄──────────────────────────── │  (Node HTTP)      │ ◄────────────────────── │     .ai         │
└──────────────┘   SSE/JSON                    └──────────────────┘     裸JSON行SSE          └─────────────────┘
```

- 网关协议逆向自 `cli.mjs`(请求头 `buildCommandAuthHeaders`、消息转换 `toWireMessages`、响应解析 `consumeStream`)
- 支持:流式 / 非流式、多轮对话、function calling、图片(转 data URL)

## 快速开始

```bash
cd cmdcode-openai-proxy
node index.js
# => cmdcode-openai-proxy listening on http://127.0.0.1:8787/v1
```

前提:已执行过 `command-code auth login`,`~/.commandcode/auth.json` 里有 `apiKey`。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址(想局域网访问改 `0.0.0.0`) |
| `CMDCODE_API_KEY` | 从 auth.json 读 | 覆盖 API key(仅当账号池为空时作为 fallback) |
| `CMDCODE_BASE_URL` | `https://api.commandcode.ai` | 覆盖网关地址 |
| `CMDCODE_CLI_VERSION` | 无 | 模拟 CLI 版本头 `x-command-code-version` |
| `PROXY_API_KEY` | 自动生成 | 首次启动自动生成一个 admin key 打印到终端;也可用此环境变量预设 |
| `CMDCODE_ACCOUNTS_FILE` | `accounts.json` | 账号池存储文件 |

## 管理页面

启动后访问 **http://127.0.0.1:8787/admin**:

1. **首次访问**:设置管理密码
2. **Proxy Keys 区**:管理客户端授权 key(添加/删除/启用停用),每个 key 可给不同使用者
3. **Command Code 账号区**:管理额度账号池(添加/删除,显示用户名/邮箱/余额/状态)

客户端调用 API 时带 `Authorization: Bearer <proxy_key>`(任一启用的 key 均可)。
管理 API 用 `X-Admin-Pass: <管理密码>` 头。

## 多账号

代理支持**多个 Command Code 账号**(每个一个 API key),请求自动分配。

### 账号管理 API(需带 proxy key)

```bash
# 列出账号(脱敏,含余额)
curl http://127.0.0.1:8787/v1/accounts -H 'Authorization: Bearer <PROXY_API_KEY>'

# 添加账号(直接贴 key,自动 whoami 验证)
curl -X POST http://127.0.0.1:8787/v1/accounts/add \
  -H 'Authorization: Bearer <PROXY_API_KEY>' -H 'Content-Type: application/json' \
  -d '{"apiKey":"user_..."}'

# 删除账号
curl -X POST http://127.0.0.1:8787/v1/accounts/remove \
  -H 'Authorization: Bearer <PROXY_API_KEY>' -H 'Content-Type: application/json' \
  -d '{"id":"<account_id>"}'
```

### 设备码授权流程(模拟 Command Code 登录)

```bash
# 1. 启动设备码流程
curl -X POST http://127.0.0.1:8787/v1/accounts/device -H 'Authorization: Bearer <PROXY_API_KEY>'
# => { user_code: "AB12CD34", verification_uri: "http://127.0.0.1:8787/v1/accounts/verify/AB12CD34", ... }

# 2. 浏览器打开 verification_uri,粘贴 API key 提交
# 3. whoami 验证通过后自动入库
```

### OAuth 浏览器授权(推荐,完全模拟 CLI `auth login`)

管理页点 **"🔐 用 Command Code 账号登录(OAuth)"** 按钮:
1. 代理启动临时回调服务器(`127.0.0.1` 随机端口)
2. 打开官方授权页 `https://commandcode.ai/studio/auth/cli?callback=...&state=...`
3. 用户在官方页面登录授权
4. 官方自动回调,把 `apiKey` 回传给代理
5. 代理校验 state → whoami 验证 → **写入项目目录 `oauth-key` 文件并加入账号池**

安全性:state token 校验防 CSRF(错误 state 直接拒绝);回调服务器只监听 127.0.0.1,5 分钟超时自动清理。

### oauth-key 存储

- OAuth 授权 / 设备码 / 管理页添加的账号 key 统一写入**代理工作目录的 `oauth-key`** 文件(项目级授权)
- 启动时自动从 `oauth-key` 加载账号;`oauth-key` 不存在时才回退 `~/.commandcode/auth.json`
- 已加入 `.gitignore`,防止 key 被提交到 git
- 每个项目目录可各自授权,互不干扰

### 请求分配策略

- **首次请求**:按余额从高到低选健康账号
- **会话亲和**:同一会话(`user` 参数或 `x-session-id` 头)固定用同一账号
- **失败切换**:账号 429/401/403/余额不足时自动标记不可用(30s 冷却),换账号重试一次
- 账号池为空时,自动用 `~/.commandcode/auth.json` 的 key 作为 fallback

### 用法示例(客户端带 proxy key)

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer <PROXY_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"user":"my-session-id"}'
```

> 启用 `PROXY_API_KEY` 后,OpenAI SDK 等客户端配置 `apiKey` 为 `<PROXY_API_KEY>` 即可。

## 用法示例

### curl 非流式

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "用一句话介绍你自己"}]
  }'
```

### curl 流式

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-sonnet-5",
    "messages": [{"role": "user", "content": "数到3"}],
    "stream": true
  }'
```

### OpenAI SDK(JS)

```js
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'cmdcode', // 任意值,本服务不校验
  baseURL: 'http://127.0.0.1:8787/v1',
});

const res = await client.chat.completions.create({
  model: 'deepseek/deepseek-v4-flash',
  messages: [{ role: 'user', content: '你好' }],
});
console.log(res.choices[0].message.content);
```

### 工具调用(function calling)

```js
const res = await client.chat.completions.create({
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: '北京天气怎么样?' }],
  tools: [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询城市天气',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  }],
});
// res.choices[0].message.tool_calls 里会有 { id, type, function: { name, arguments } }
```

多轮工具调用:把 `assistant` 消息(含 `tool_calls`)和 `tool` 结果消息一起塞回 `messages`,翻译层会自动还原成网关的 `tool-call` / `tool-result` wire 格式。

## 参数支持

| OpenAI 参数 | 支持 | 说明 |
|---|---|---|
| `model` | ✅ | 透传,如 `deepseek/deepseek-v4-flash`,响应回显 |
| `messages` | ✅ | 多轮、图片(`image_url`)、工具消息、`developer` 角色 |
| `stream` | ✅ | 流式 / 非流式 |
| `tools` / `tool_calls` | ✅ | function calling,多轮往返 |
| `temperature` / `top_p` / `seed` | ✅ | 透传 |
| `max_tokens` / `max_completion_tokens` | ✅ | 归一化 |
| `stop` | ✅ | 透传 |
| `reasoning_effort` | ✅ | 仅支持 thinking 的模型生效(内置白名单) |
| `tool_choice` | ✅ | 格式映射到网关(`type:"tool"/"auto"/"any"`);`{type:"function"}` 强制调用带软重试 |
| `response_format` | ✅ | JSON mode 透传 |
| `parallel_tool_calls` | ✅ | 透传,实测网关支持并行工具调用(一次返回多个 tool_calls) |
| `n > 1` | ✅ | 非流式:并发请求拼 choices;流式:并发流交错输出多 choice |
| `stream_options.include_usage` | ✅ | 流式末尾发 usage chunk |
| `presence_penalty` / `frequency_penalty` | ✅ | 透传 |
| `user` | ✅ | 透传 |
| `logit_bias` / `service_tier` | ✅ | 透传 |
| `store` / `metadata` / `prediction` / `audio` / `modalities` / `web_search_options` | ⚠️ | 接收但静默忽略(网关无对应能力,透传会触发反代理检测) |
| `logprobs` / `top_logprobs` | ⚠️ | 透传,但网关 SSE 流无 logprob 事件,响应恒为 null |

**响应字段**:`id` / `object` / `created` / `model`(回显请求值) / `system_fingerprint` / `choices[].index/logprobs/message{role,content,tool_calls}/finish_reason` / `usage`(含 `prompt_tokens_details.cached_tokens`、`completion_tokens_details.reasoning_tokens` 细分)。

不支持(网关侧限制):`moderation`、`embeddings`、`images`、`audio` 端点。

## 模型列表

`GET /v1/models` 返回全部 58 个模型(逆向自 cli.mjs)。核心模型:

- **Claude**: `claude-sonnet-5`、`claude-opus-5`、`claude-fable-5`、`claude-haiku-4-5-20251001`
- **GPT**: `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`
- **DeepSeek**: `deepseek/deepseek-v4-pro`、`deepseek/deepseek-v4-flash`
- **Kimi**: `moonshotai/Kimi-K3`、`Kimi-K2.7-Code`、`Kimi-K2.5`
- **GLM**: `zai-org/GLM-5.2`、`GLM-5.2-Fast`、`GLM-5.1`、`GLM-5`
- **Gemini**: `google/gemini-3.6-flash`、`google/gemini-3.5-flash`
- **其他**: `xai/grok-4.5`、`sakana/fugu-ultra`、`Qwen/Qwen3.8-Max` 等

## 注意事项

- API key 绑定 `~/.commandcode/auth.json` 里的 userId,别外泄;服务默认只监听 `127.0.0.1`
- 非流式响应会把整个流攒完再返回,长回复可能较慢;流式则逐块转发
- 网关侧 `reasoning_effort` 仅部分模型支持(已内置白名单),不支持的模型会自动忽略该参数
- 若网关返回 400,可尝试设置 `CMDCODE_CLI_VERSION`(用 `command-code --version` 查)

## 视觉外挂(Vision Assist)

纯文本模型(如 `deepseek/deepseek-v4-flash`)收到图片时,代理会自动:
1. 先用 `gpt-5.6-luna` 识别图片 → 得到详细文字描述
2. 把图片替换成描述文本 → 再发给目标模型
3. 目标模型基于描述正常回答

**效果**:deepseek 这类廉价纯文本模型也能"看图",识别质量由 luna 保证,deepseek 保持纯文本计费。

**两个增强**:
- **意图引导**:跟随图片的用户文字(提问/说明)会一起带给 luna,让它推测用户想从图中提取什么信息,针对性描述。例如用户问"左半部分什么颜色",luna 会重点描述左侧。
- **持久化缓存**:图片描述按内容哈希(SHA-256)缓存到 `vision-cache/`,同一张图再次出现直接读缓存,不重复调 luna、不重复计费。换不同问题问同一张图也能直接答(描述足够详细)。

**其他**:
- 视觉模型(Claude/GPT/Gemini/Kimi 等)收到图片**直连**,不经过外挂
- 多图请求:每张图独立识别 + 独立缓存,注入时带编号(`【图片1】`/`【图片2】`)
- 外挂失败自动降级为直接转发(模型会说看不到图),不阻断请求
- 环境变量 `CMDCODE_VISION_MODEL` 可换识别模型(默认 `gpt-5.6-luna`);`CMDCODE_VISION_CACHE_DIR` 可换缓存目录
