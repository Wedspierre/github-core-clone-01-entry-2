// mcp.ts — the Model Context Protocol endpoint (POST /mcp, JSON-RPC 2.0 over
// Streamable HTTP). The suite drives the modern `server/discover` handshake first and
// falls back to legacy `initialize`; both are answered, plus `ping`, `tools/list` and
// `tools/call` for the six forge tools.

import { VIEWER, type Repo, type Store } from './store.ts';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with the squash method.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The six tools, byte-identical on every call (built once, never mutated). */
export function toolsList(): { tools: ToolDef[] } {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

function ok(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function fail(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolTextResult(obj: unknown, isError = false): Record<string, unknown> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj, isError };
}

function needString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

// ---------------------------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------------------------

export function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const getRepo = (owner: string, repoName: string): Repo | null => {
    if (owner !== VIEWER.login) return null;
    return store.getRepo(owner, repoName) ?? null;
  };

  if (name === 'create_repo') {
    const repoName = needString(args, 'name');
    if (repoName === null) return toolTextResult({ error: 'name is required' }, true);
    if (store.getRepo(VIEWER.login, repoName)) return toolTextResult({ error: 'Repository already exists' }, true);
    const repo = store.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
    return toolTextResult(repoJson(repo));
  }

  if (name === 'get_repo') {
    const owner = needString(args, 'owner') ?? needString(args, 'owner_login');
    const repoName = needString(args, 'repo') ?? needString(args, 'repository');
    if (owner === null || repoName === null) return toolTextResult({ error: 'owner and repo are required' }, true);
    const repo = getRepo(owner, repoName);
    if (!repo) return toolTextResult({ error: 'Not Found' }, true);
    return toolTextResult(repoJson(repo));
  }

  if (name === 'create_issue') {
    const owner = needString(args, 'owner') ?? needString(args, 'owner_login');
    const repoName = needString(args, 'repo') ?? needString(args, 'repository');
    const title = needString(args, 'title');
    if (owner === null || repoName === null || title === null) {
      return toolTextResult({ error: 'owner, repo and title are required' }, true);
    }
    const repo = getRepo(owner, repoName);
    if (!repo) return toolTextResult({ error: 'Not Found' }, true);
    const issue = store.createIssue(repo, title, typeof args.body === 'string' ? args.body : (typeof args.description === 'string' ? args.description : ''), []);
    return toolTextResult({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      repository: `${repo.owner}/${repo.name}`,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
    });
  }

  if (name === 'list_issues') {
    const owner = needString(args, 'owner') ?? needString(args, 'owner_login');
    const repoName = needString(args, 'repo') ?? needString(args, 'repository');
    if (owner === null || repoName === null) return toolTextResult({ error: 'owner and repo are required' }, true);
    const repo = getRepo(owner, repoName);
    if (!repo) return toolTextResult({ error: 'Not Found' }, true);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const issues = repo.issues
      .filter((issue) => state === 'all' || issue.state === state)
      .map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
      }));
    return toolTextResult({ issues, total_count: issues.length });
  }

  if (name === 'create_pull_request') {
    const owner = needString(args, 'owner') ?? needString(args, 'owner_login');
    const repoName = needString(args, 'repo') ?? needString(args, 'repository');
    const title = needString(args, 'title');
    const head = needString(args, 'head') ?? needString(args, 'head_branch');
    const base = needString(args, 'base') ?? needString(args, 'base_branch');
    if (owner === null || repoName === null || title === null || head === null || base === null) {
      return toolTextResult({ error: 'owner, repo, title, head and base are required' }, true);
    }
    const repo = getRepo(owner, repoName);
    if (!repo) return toolTextResult({ error: 'Not Found' }, true);
    const headSha = store.resolveRef(repo, head);
    const baseSha = store.resolveRef(repo, base);
    if (headSha === undefined || baseSha === undefined) {
      return toolTextResult({ error: 'head or base branch does not exist' }, true);
    }
    const pull = store.createPull(repo, title, typeof args.body === 'string' ? args.body : (typeof args.description === 'string' ? args.description : ''), head, base, headSha, baseSha);
    return toolTextResult({
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
      repository: `${repo.owner}/${repo.name}`,
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
    });
  }

  if (name === 'merge_pull_request') {
    const owner = needString(args, 'owner') ?? needString(args, 'owner_login');
    const repoName = needString(args, 'repo') ?? needString(args, 'repository');
    const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : null;
    if (owner === null || repoName === null || pullNumber === null) {
      return toolTextResult({ error: 'owner, repo and pull_number are required' }, true);
    }
    const repo = getRepo(owner, repoName);
    if (!repo) return toolTextResult({ error: 'Not Found' }, true);
    const pull = repo.pullsByNumber.get(pullNumber);
    if (!pull) return toolTextResult({ error: 'Not Found' }, true);
    if (pull.state !== 'open' || pull.merged) return toolTextResult({ error: 'Pull request is already closed' }, true);
    if (store.pullConflicts(repo, pull)) return toolTextResult({ error: 'Merge conflict' }, true);
    const sha = store.mergePull(repo, pull);
    if (sha === null) return toolTextResult({ error: 'Merge conflict' }, true);
    return toolTextResult({ sha, merged: true, number: pull.number, message: `Pull request #${pull.number} merged` });
  }

  return toolTextResult({ error: `Unknown tool: ${name}` }, true);
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------------------------

export interface McpRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

/** Answer one JSON-RPC request. Returns null for notifications (no reply expected). */
export function handleMcp(store: Store, request: McpRequest): Record<string, unknown> | null {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params ?? {};

  if (method === 'server/discover') {
    return ok(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26';
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-03-26';
    return ok(id, {
      protocolVersion: version,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
    });
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }

  if (method === 'ping') {
    return ok(id, {});
  }

  if (method === 'tools/list') {
    return ok(id, toolsList());
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '') return fail(id, -32602, 'Tool name is required');
    if (!TOOLS.some((tool) => tool.name === name)) return fail(id, -32602, `Unknown tool: ${name}`);
    const tool = TOOLS.find((candidate) => candidate.name === name)!;
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        return ok(id, toolTextResult({ error: `${required} is required` }, true));
      }
    }
    return ok(id, callTool(store, name, args));
  }

  if (method === 'resources/list') return ok(id, { resources: [] });
  if (method === 'prompts/list') return ok(id, { prompts: [] });

  return fail(id, -32601, `Method not found: ${method}`);
}

/**
 * Handle a raw POST /mcp body. Returns the HTTP status and the JSON-RPC reply object
 * (null when the request was a notification and no reply is due).
 */
export function handleMcpBody(
  store: Store,
  raw: Buffer,
): { status: number; body: Record<string, unknown> | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    const id = extractId(raw.toString('utf8'));
    return { status: 400, body: { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    // A batch: answer each request in order (notifications produce no entry).
    const replies: Record<string, unknown>[] = [];
    for (const item of parsed) {
      if (item !== null && typeof item === 'object') {
        const reply = handleMcp(store, item as McpRequest);
        if (reply !== null) replies.push(reply);
      }
    }
    return { status: 200, body: replies.length === 1 ? replies[0]! : (replies as unknown as Record<string, unknown>) };
  }
  if (parsed !== null && typeof parsed === 'object') {
    const reply = handleMcp(store, parsed as McpRequest);
    if (reply === null) return { status: 200, body: {} };
    return { status: 200, body: reply };
  }
  return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
}

/** Best-effort extraction of a JSON-RPC id from malformed text (for parse errors). */
function extractId(raw: string): unknown {
  const match = /"id"\s*:\s*("[^"]*"|-?\d+)/.exec(raw);
  if (!match) return null;
  const token = match[1]!;
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token);
    } catch {
      return null;
    }
  }
  return Number(token);
}
