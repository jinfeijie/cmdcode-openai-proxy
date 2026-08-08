// OAuth 授权流程: 模拟 command-code CLI 的浏览器登录(获取 API key)
// 逆向自 cli.mjs:
//   buildCommandAuthUrl: `${studioBase}/studio/auth/cli?callback=${callback}&state=${state}`
//   studioBase(prod) = https://commandcode.ai
//   回调: 官方页面 POST {apiKey, state, userId, userName, keyName} 到本地回调服务器
//   generateCommandAuthStateToken: randomBytes(32).toString('base64url')
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const STUDIO_BASE = { prod: 'https://commandcode.ai', staging: 'https://staging.commandcode.ai', local: 'http://localhost:3000' };
const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

export function generateStateToken() {
  return randomBytes(32).toString('base64url');
}

export function buildAuthUrl({ port, state, apiEnv = 'prod' }) {
  const base = STUDIO_BASE[apiEnv] ?? STUDIO_BASE.prod;
  const callback = `http://localhost:${port}/callback`;
  return `${base}/studio/auth/cli?callback=${encodeURIComponent(callback)}&state=${encodeURIComponent(state)}`;
}

// 启动临时回调服务器,等待官方页面 POST {apiKey, state, userId, userName, keyName}
// 回调到达时调用 onResult({apiKey, userId, userName, keyName}),同时 resolve { port, close }
export function startOAuthCallbackServer({ port = 0, state, onLog = () => {}, onResult = () => {} }) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // CORS: 官方允许的 origin
      const origin = req.headers.origin ?? '';
      const allowed = ['http://localhost:3000', 'https://staging.commandcode.ai', 'https://commandcode.ai'];
      const corsOrigin = allowed.includes(origin) ? origin : allowed[0];
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      if (req.url !== '/callback') {
        res.writeHead(404);
        return res.end(JSON.stringify({ success: false, error: 'Not found' }));
      }
      if (req.method !== 'POST') {
        res.writeHead(405);
        return res.end(JSON.stringify({ success: false, error: 'Method not allowed. Use POST.' }));
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          // 校验回调结构
          const isCallback = typeof data.apiKey === 'string' && typeof data.state === 'string' &&
            typeof data.userId === 'string' && typeof data.userName === 'string' && typeof data.keyName === 'string';
          if (!isCallback) {
            res.writeHead(400);
            return res.end(JSON.stringify({ success: false, error: 'Invalid callback payload' }));
          }
          if (data.state !== state) {
            res.writeHead(400);
            return res.end(JSON.stringify({ success: false, error: 'State mismatch' }));
          }
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
          onLog('OAuth callback received, authenticating...');
          server.close();
          onResult({
            apiKey: data.apiKey,
            userId: data.userId,
            userName: data.userName,
            keyName: data.keyName,
          });
          resolve({
            apiKey: data.apiKey,
            userId: data.userId,
            userName: data.userName,
            keyName: data.keyName,
          });
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      onLog(`OAuth callback server listening on 127.0.0.1:${actualPort}`);
      resolve({
        port: actualPort,
        close: () => server.close(),
      });
    });
  });
}
