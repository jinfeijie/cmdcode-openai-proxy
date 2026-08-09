# cmdcode-openai-proxy

将 Command Code 网关转换为 OpenAI 兼容的 `/v1/chat/completions` 接口,可供 Cursor、OpenWebUI、LobeChat、LangChain 及 OpenAI SDK 使用。

支持流式响应、多轮对话、工具调用、图片输入、多账号调度和客户端访问密钥管理。

## 快速开始

要求 Node.js 18 或更高版本。项目没有第三方运行时依赖,无需执行 `npm install`。

```bash
git clone https://github.com/jinfeijie/cmdcode-openai-proxy.git
cd cmdcode-openai-proxy
npm start
```

默认地址:

- 管理后台: [http://127.0.0.1:8787/admin](http://127.0.0.1:8787/admin)
- API Base URL: `http://127.0.0.1:8787/v1`

首次使用:

1. 打开管理后台并设置管理密码
2. 在“账号池”中添加 Command Code API Key
3. 在“访问密钥”中复制或创建客户端密钥
4. 将 Base URL 和客户端密钥填入 OpenAI 兼容客户端

服务不会读取 `~/.commandcode` 或其他用户主目录配置。账号仅来自项目数据文件或显式设置的 `CMDCODE_API_KEY`。

## 调用示例

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer <客户端访问密钥>' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

可用模型以管理后台“模型市场”或 `GET /v1/models` 的实时结果为准。

## 部署

默认仅监听本机。需要允许其他设备访问时:

```bash
HOST=0.0.0.0 PORT=8787 npm start
```

服务器部署可使用任意 Node.js 进程管理器托管 `node index.js`。必须固定工作目录,因为账号和密钥保存在当前目录。公网使用时请配置 HTTPS 和访问控制,不要直接暴露未加密的服务端口。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `CMDCODE_API_KEY` | 无 | 账号池为空时初始化一个上游账号 |
| `CMDCODE_BASE_URL` | `https://api.commandcode.ai` | 上游网关地址 |
| `CMDCODE_CLI_VERSION` | `1.14.1` | `x-command-code-version` 请求头 |
| `PROXY_API_KEY` | 自动生成 | 预设客户端访问密钥 |
| `CMDCODE_VISION_MODEL` | `gpt-5.6-luna` | 纯文本模型的辅助识图模型 |

## 数据与安全

`admin.json`、`proxy-keys.json`、`accounts.json` 和 `oauth-key` 位于服务工作目录,包含管理密码和各类密钥。这些文件已加入 `.gitignore`,请限制文件权限并妥善备份。

管理密码仅用于登录 `/admin`;客户端访问密钥用于 `Authorization: Bearer <key>`,两者不可混用。

## 说明

- 不支持 embeddings、moderation、images 和 audio 端点
- 账号池为空时返回 `503 no_accounts`
- 上游提示 CLI 版本过旧时,更新 `CMDCODE_CLI_VERSION` 后重启服务
