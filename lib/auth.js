import { randomUUID, randomBytes } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api.commandcode.ai';

export const BASE_URL = process.env.CMDCODE_BASE_URL || DEFAULT_BASE_URL;
export const ROUTE_GENERATE = '/alpha/generate';

// 逆向自 cli.mjs 的 buildCommandApiHeaders / buildCommandAuthHeaders
// 注意: generate 请求走 buildCommandApiHeaders,x-cli-environment 值是 normalizeCliEnvironment(getTelemetryEnv()) = "production"
const HEADER = {
  INTERNAL_TEAM_FLAG: 'x-co-flag',
  TASTE_LEARNING: 'x-taste-learning',
  CLI_ENVIRONMENT: 'x-cli-environment',
  CLI_VERSION: 'x-command-code-version',
  PROJECT_SLUG: 'x-project-slug',
  SESSION_ID: 'x-session-id',
};

export function makeTraceparent() {
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  return `00-${traceId}-${spanId}-01`;
}

export function buildGatewayHeaders({ apiKey, sessionId, cliVersion } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'cli',
    Authorization: `Bearer ${apiKey}`,
    [HEADER.CLI_ENVIRONMENT]: 'production',
    [HEADER.TASTE_LEARNING]: 'true',
    [HEADER.INTERNAL_TEAM_FLAG]: 'false',
    [HEADER.SESSION_ID]: sessionId ?? randomUUID(),
    traceparent: makeTraceparent(),
  };
  if (cliVersion) headers[HEADER.CLI_VERSION] = cliVersion;
  return headers;
}

export function joinUrl(baseUrl, route) {
  return `${baseUrl.replace(/\/$/, '')}${route.startsWith('/') ? route : `/${route}`}`;
}
