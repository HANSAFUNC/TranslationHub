/**
 * Walk the four-step onboarding exactly as a reader would, over the real MCP transport.
 *
 * Step 1 signs a token, step 2 reads the project id from the API (the UI shows the same value),
 * step 3 is the config snippet the page renders, step 4 is the verification prompt — "list my
 * projects, then read that project's locales".
 */
const BASE = process.env.API_BASE ?? 'http://localhost:3001/api/v1';

async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

const login = await call('/auth/login', {
  method: 'POST',
  body: { email: 'demo@localehub.dev', password: 'demo-password-123' },
});
if (login.status >= 300) throw new Error(`login failed: ${JSON.stringify(login.body)}`);
const session = login.body.data.token;

// Step 2: the id the project page now displays and copies.
const projects = await call('/projects', { token: session });
const project = projects.body.data[0];
console.log(`step 2 — project_id from the project page: ${project.id} (${project.name})`);

// Step 1: a token bound to that one project, as the tutorial instructs.
const issued = await call('/mcp-tokens', {
  method: 'POST',
  token: session,
  body: {
    name: `onboarding-${Date.now().toString(36)}`,
    scopes: ['project.read', 'translation.read'],
    // Bound to exactly this project — the "data adapts to the user" mechanism.
    projectIds: [project.id],
    expiresInDays: 1,
  },
});
if (issued.status >= 300) throw new Error(`token failed: ${JSON.stringify(issued.body)}`);
const token = issued.body.data.token;
console.log(`step 1 — token ${issued.body.data.tokenPrefix}… bound to ${issued.body.data.projectIds.length} project(s)`);

// Step 3: the snippet the page renders.
const config = await call('/mcp/tools');
console.log('step 3 — snippet url:', JSON.parse(config.body.data.snippets.remote).mcpServers['localehub-remote'].url);

// Step 4: the verification prompt, over the real transport.
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const client = new Client({ name: 'onboarding-check', version: '0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(config.body.data.remoteUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);

const list = await client.callTool({ name: 'list_projects', arguments: {} });
const visible = JSON.parse(list.content[0].text);
console.log(
  `step 4 — list_projects returns ${visible.length} project(s):`,
  visible.map((entry) => entry.name).join(', '),
);
if (visible.length !== 1 || visible[0].id !== project.id) {
  throw new Error('list_projects did not narrow to the bound project');
}

const locales = await client.callTool({ name: 'list_project_locales', arguments: { project_id: project.id } });
const localeList = JSON.parse(locales.content[0].text);
console.log(`step 4 — list_project_locales: ${localeList.length} locale(s):`, localeList.map((l) => l.code).join(', '));

await client.close();

// Clean up the token this check created.
const tokens = await call('/mcp-tokens', { token: session });
const created = tokens.body.data.find((entry) => entry.name.startsWith('onboarding-'));
if (created) await call(`/mcp-tokens/${created.id}`, { method: 'DELETE', token: session });
console.log('RESULT: the four steps work end to end');