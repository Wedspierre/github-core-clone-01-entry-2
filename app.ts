// app.ts — github-core-clone-01 v3 forge: the HTTP server and router.
//
// Written from scratch for the v3 perf rebuild. One node:http server, no
// framework: manual routing, sync handlers over the in-memory store, cached
// Buffers on the hot paths, keep-alive throughout.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest, type RestReply } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertisementV0Receive,
  advertisementV0Upload,
  advertisementV2,
  applyPush,
  fetchResponse,
  lsRefsResponse,
  parseFetch,
  parseLsRefs,
  parsePush,
  pushResponse,
} from './gitproto.ts';
import { getIssue, getRepo, issueJson } from './store.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const EXPECTED_AUTH = TOKEN === '' ? '' : `Bearer ${TOKEN}`;
const JSON_TYPE = 'application/json; charset=utf-8';

let reqSeq = 0;

function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return false;
  if (EXPECTED_AUTH === '') return h.startsWith('Bearer ') && h.length > 7;
  return h === EXPECTED_AUTH;
}

function send(res: ServerResponse, status: number, body: Buffer, contentType: string, extra?: Record<string, string>): void {
  const headers: Record<string, string | number> = {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `r${++reqSeq}`,
  };
  if (extra !== undefined) {
    for (const k of Object.keys(extra)) headers[k] = extra[k];
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra?: Record<string, string>): void {
  send(res, status, Buffer.from(JSON.stringify(value), 'utf8'), JSON_TYPE, extra);
}

function sendErr(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return Buffer.alloc(0);
  if (chunks.length === 1) return chunks[0];
  return Buffer.concat(chunks);
}

function decodeSeg(seg: string): string {
  if (seg.indexOf('%') < 0) return seg;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const q = rawUrl.indexOf('?');
  const pathname = q < 0 ? rawUrl : rawUrl.slice(0, q);
  const queryString = q < 0 ? '' : rawUrl.slice(q + 1);

  // The read workload's hot path: GET /api/v3/repos/{owner}/{repo}/issues/{n}.
  if (method === 'GET' && pathname.startsWith('/api/v3/repos/')) {
    const parts = pathname.slice('/api/v3/repos/'.length).split('/');
    if (parts.length === 4 && parts[2] === 'issues') {
      const num = Number(parts[3]);
      if (Number.isInteger(num) && num > 0) {
        if (!authed(req)) {
          sendErr(res, 401, 'Unauthorized');
          return;
        }
        const repo = getRepo(decodeSeg(parts[0]), decodeSeg(parts[1]));
        if (repo === undefined) {
          sendErr(res, 404, 'Not Found');
          return;
        }
        const issue = getIssue(repo, num);
        if (issue === undefined) {
          sendErr(res, 404, 'Not Found');
          return;
        }
        send(res, 200, issueJson(repo, issue), JSON_TYPE);
        return;
      }
    }
  }

  // Bodies are read (and discarded when refused) before any refusal, so a
  // keep-alive socket is never left with unread bytes.
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body = needsBody ? await readBody(req) : Buffer.alloc(0);
  const query = new URLSearchParams(queryString);

  // Health probe (the env's boot check): no auth.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const segs = pathname.split('/').filter((s) => s !== '');

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segs.length >= 2 && segs[1].endsWith('.git')) {
    const owner = decodeSeg(segs[0]);
    const repoName = decodeSeg(segs[1].slice(0, -4));
    const repo = getRepo(owner, repoName);
    if (!authed(req)) {
      sendErr(res, 401, 'Unauthorized');
      return;
    }
    if (repo === undefined) {
      sendErr(res, 404, 'Not Found');
      return;
    }
    const tail = segs.slice(2).join('/');
    if (method === 'GET' && tail === 'info/refs') {
      const service = query.get('service') ?? '';
      if (service === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        const ad = v2 ? advertisementV2(repo) : advertisementV0Upload(repo);
        send(res, 200, ad, 'application/x-git-upload-pack-advertisement');
        return;
      }
      if (service === 'git-receive-pack') {
        send(res, 200, advertisementV0Receive(repo), 'application/x-git-receive-pack-advertisement');
        return;
      }
      sendErr(res, 400, 'unknown service');
      return;
    }
    if (method === 'POST' && tail === 'git-upload-pack') {
      try {
        const ls = parseLsRefs(body);
        if (ls !== null) {
          send(res, 200, lsRefsResponse(repo, ls), 'application/x-git-upload-pack-result');
          return;
        }
        const fetch = parseFetch(body);
        if (fetch !== null) {
          send(res, 200, fetchResponse(repo, fetch), 'application/x-git-upload-pack-result');
          return;
        }
      } catch {
        send(res, 400, Buffer.from('bad request', 'utf8'), 'application/x-git-upload-pack-result');
        return;
      }
      send(res, 400, Buffer.from('bad request', 'utf8'), 'application/x-git-upload-pack-result');
      return;
    }
    if (method === 'POST' && tail === 'git-receive-pack') {
      const parsed = parsePush(body);
      if (parsed === null) {
        send(res, 400, Buffer.from('bad request', 'utf8'), 'application/x-git-receive-pack-result');
        return;
      }
      const result = applyPush(repo, parsed.commands, parsed.pack);
      send(res, 200, pushResponse(result), 'application/x-git-receive-pack-result');
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  // GraphQL v4.
  if (segs.length === 2 && segs[0] === 'api' && segs[1] === 'graphql' && method === 'POST') {
    if (!authed(req)) {
      sendErr(res, 401, 'Unauthorized');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendErr(res, 400, 'request body is not valid JSON');
      return;
    }
    if (Array.isArray(parsed)) {
      const answers = parsed.map((entry) => {
        if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'Invalid Request' }] };
        const doc = entry as { query?: unknown; variables?: unknown };
        if (typeof doc.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
        const vars = (typeof doc.variables === 'object' && doc.variables !== null ? (doc.variables as Record<string, unknown>) : {}) as Record<string, unknown>;
        return executeGraphQL(doc.query, vars);
      });
      sendJson(res, 200, answers);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      sendErr(res, 400, 'request body is not valid JSON');
      return;
    }
    const doc = parsed as { query?: unknown; variables?: unknown };
    if (typeof doc.query !== 'string') {
      sendErr(res, 400, 'query is required');
      return;
    }
    const vars = (typeof doc.variables === 'object' && doc.variables !== null ? (doc.variables as Record<string, unknown>) : {}) as Record<string, unknown>;
    sendJson(res, 200, executeGraphQL(doc.query, vars));
    return;
  }

  // MCP.
  if (segs.length === 1 && segs[0] === 'mcp' && method === 'POST') {
    if (!authed(req)) {
      sendErr(res, 401, 'Unauthorized');
      return;
    }
    const reply = handleMcp(body.toString('utf8'));
    if (reply.body === '') {
      res.writeHead(reply.status, { 'x-github-request-id': `r${++reqSeq}` });
      res.end();
      return;
    }
    send(res, reply.status, Buffer.from(reply.body, 'utf8'), JSON_TYPE);
    return;
  }

  // REST v3.
  if (segs.length >= 1 && segs[0] === 'api' && segs[1] === 'v3') {
    const restSegs = segs.slice(2);
    const isPublic = method === 'GET' && (restSegs.length === 0 || (restSegs.length === 1 && restSegs[0] === 'meta'));
    if (!isPublic && !authed(req)) {
      sendErr(res, 401, 'Unauthorized');
      return;
    }
    let parsedBody: Record<string, unknown> | null = null;
    if (needsBody && body.length > 0) {
      try {
        const value = JSON.parse(body.toString('utf8'));
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) parsedBody = value as Record<string, unknown>;
        else if (value === null) parsedBody = null;
        else {
          sendErr(res, 400, 'request body must be a JSON object');
          return;
        }
      } catch {
        sendErr(res, 400, 'request body is not valid JSON');
        return;
      }
    }
    const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
    let reply: RestReply | null;
    try {
      reply = handleRest(method, restSegs, query, origin, parsedBody);
    } catch {
      sendErr(res, 500, 'Internal Server Error');
      return;
    }
    if (reply === null) {
      sendErr(res, 404, 'Not Found');
      return;
    }
    if (reply.status === 204) {
      res.writeHead(204, { 'x-github-request-id': `r${++reqSeq}` });
      res.end();
      return;
    }
    const out = typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : reply.body;
    send(res, reply.status, out, reply.contentType, reply.headers);
    return;
  }

  sendErr(res, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((err: unknown) => {
      process.stderr.write(`[app] unhandled: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      try {
        sendErr(res, 500, 'Internal Server Error');
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
}
