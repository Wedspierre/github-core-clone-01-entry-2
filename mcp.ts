// mcp.ts — github-core-clone-01 v3 forge: Model Context Protocol endpoint.
//
// Written from scratch for the v3 perf rebuild. Plain JSON answers (no SSE);
// the modern 2026-07-28 era via server/discover, plus a legacy initialize
// handshake for safety. Tools act on the same store as REST/GraphQL.

import {
  MCP_SERVER_NAME,
  VIEWER_LOGIN,
  addComment,
  createIssue,
  createPull,
  createRepo,
  getIssue,
  getPull,
  getRepo,
  issueJson,
  mergePull,
  pullJson,
  repoJson,
} from './store.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string }>;
    required: string[];
  };
}

const str = { type: 'string' };
const bool = { type: 'boolean' };
const int = { type: 'integer' };

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the token owner.',
    inputSchema: {
      type: 'object',
      properties: { owner: str, name: str, description: str, private: bool },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: str, repo: str, full_name: str },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: str, repo: str, full_name: str, title: str, body: str },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: str, repo: str, full_name: str, state: str },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: { owner: str, repo: str, full_name: str, title: str, body: str, head: str, base: str },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: { owner: str, repo: str, full_name: str, pull_number: int, number: int },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_MAP = new Map(MCP_TOOLS.map((t) => [t.name, t]));

/** Resolve owner/repo from tool arguments (owner+repo, or a full_name fallback). */
function resolveRepoArgs(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      if (owner === '') owner = parts[0];
      if (repo === '') repo = parts[1];
    }
  }
  if (owner === '' || repo === '') return null;
  return { owner, repo };
}

function toolText(obj: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown } {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function toolError(message: string): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

type RpcResult = { ok: true; result: unknown } | { ok: false; code: number; message: string };

function callTool(name: string, args: Record<string, unknown>): RpcResult {
  const tool = TOOL_MAP.get(name);
  if (tool === undefined) return { ok: false, code: -32602, message: `unknown tool: ${name}` };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { ok: false, code: -32602, message: `missing required argument: ${required}` };
    }
  }
  if (name === 'create_repo') {
    const repoName = String(args.name);
    const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN;
    const repo = createRepo(owner, repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
    if (repo === null) return { ok: true, result: toolError('Repository already exists') };
    return { ok: true, result: toolText(JSON.parse(repoJson(repo).toString('utf8'))) };
  }
  const target = resolveRepoArgs(args);
  if (target === null) return { ok: false, code: -32602, message: 'missing owner/repo' };
  const repo = getRepo(target.owner, target.repo);
  if (repo === undefined) return { ok: true, result: toolError('Repository not found') };

  if (name === 'get_repo') {
    return { ok: true, result: toolText(JSON.parse(repoJson(repo).toString('utf8'))) };
  }
  if (name === 'create_issue') {
    const result = createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    if ('badLabel' in result) return { ok: true, result: toolError(`label does not exist: ${result.badLabel}`) };
    return { ok: true, result: toolText(JSON.parse(issueJson(repo, result.issue).toString('utf8'))) };
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
    return { ok: true, result: toolText(list.map((i) => JSON.parse(issueJson(repo, i).toString('utf8')))) };
  }
  if (name === 'create_pull_request') {
    const result = createPull(
      repo,
      String(args.title),
      typeof args.body === 'string' ? args.body : '',
      String(args.head),
      String(args.base),
    );
    if ('error' in result) return { ok: true, result: toolError(result.error) };
    return { ok: true, result: toolText(JSON.parse(pullJson(repo, result.pr).toString('utf8'))) };
  }
  if (name === 'merge_pull_request') {
    const num = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : -1;
    const pr = getPull(repo, num);
    if (pr === undefined) return { ok: true, result: toolError('Pull request not found') };
    const result = mergePull(repo, num);
    if ('error' in result) return { ok: true, result: toolError(`merge failed: ${result.error}`) };
    return { ok: true, result: toolText(JSON.parse(pullJson(repo, pr).toString('utf8'))) };
  }
  return { ok: false, code: -32602, message: `unknown tool: ${name}` };
}

export interface McpReply {
  status: number;
  body: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';

function rpcOk(id: unknown, result: unknown): McpReply {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function rpcErr(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) };
}

/**
 * Handle one POST /mcp body. `bodyText` is the raw request text.
 * Returns the HTTP status + body (empty body means 202/no content).
 */
export function handleMcp(bodyText: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcErr(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(parsed)) {
    // A batch of requests: answer each in order.
    const answers = parsed.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
      return mcpOne(entry as Record<string, unknown>);
    });
    return { status: 200, body: JSON.stringify(answers) };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return rpcErr(null, -32600, 'Invalid Request', 400);
  }
  const reply = mcpOne(parsed as Record<string, unknown>);
  if (reply === null) return { status: 202, body: '' };
  return { status: 200, body: JSON.stringify(reply) };
}

/** One JSON-RPC request object -> the response object, or null for a notification. */
function mcpOne(req: Record<string, unknown>): Record<string, unknown> | null {
  const id = req.id === undefined ? null : req.id;
  const hasId = req.id !== undefined;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (typeof req.params === 'object' && req.params !== null ? (req.params as Record<string, unknown>) : {}) as Record<string, unknown>;
  if (!hasId) {
    // A notification (e.g. notifications/initialized): no answer.
    return null;
  }
  if (method === 'server/discover') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
        serverInfo: { name: MCP_SERVER_NAME, version: '3.0.0' },
        capabilities: { tools: {} },
      },
    };
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: '3.0.0' },
      },
    };
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {}) as Record<string, unknown>;
    const outcome = callTool(toolName, args);
    if (!outcome.ok) {
      return { jsonrpc: '2.0', id, error: { code: outcome.code, message: outcome.message } };
    }
    return { jsonrpc: '2.0', id, result: outcome.result };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

export { JSON_TYPE as MCP_JSON_TYPE };
