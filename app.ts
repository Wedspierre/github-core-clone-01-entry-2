// app.ts — the HTTP server: routing, Bearer auth, JSON bodies, and the response
// envelope (JSON content type + X-GitHub-Request-Id on every reply). It binds nothing
// itself; main.ts owns the lifecycle.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { VIEWER, type Store } from './store.ts';
import {
  advertiseV0,
  advertiseV2,
  applyPush,
  fetchV0Response,
  fetchV2Response,
  lsRefsResponse,
  parseFetchV0,
  parseFetchV2,
  parseLsRefs,
  parseReceivePack,
  pushReportResponse,
  v2Command,
} from './gitproto.ts';
import * as rest from './rest.ts';
import { executeGraphql } from './graphql.ts';
import { handleMcpBody } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** True when `text` is a non-empty run of ASCII digits (a REST issue/pull number). */
function isDigits(text: string): boolean {
  if (text === '') return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

export function createApp(store: Store): Server {
  let requestCounter = 0;

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      // A handler that throws after headers were sent cannot be answered; log and drop.
      if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
    });
  });

  function nextRequestId(): string {
    requestCounter += 1;
    return `req-${requestCounter}`;
  }

  function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
      'Content-Type': JSON_TYPE,
      'X-GitHub-Request-Id': nextRequestId(),
      'Content-Length': payload.length,
      ...extraHeaders,
    });
    res.end(payload);
  }

  function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
    res.writeHead(status, {
      'Content-Type': contentType,
      'X-GitHub-Request-Id': nextRequestId(),
      'Content-Length': body.length,
    });
    res.end(body);
  }

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readBody(req);
    if (raw.length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      return {};
    } catch {
      throw new rest.HttpError(400, 'Malformed JSON body');
    }
  }

  /** The Bearer check. A missing/wrong token is a 401 with a JSON message. */
  function authorized(req: IncomingMessage): boolean {
    const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const token = header.slice(7);
    if (expected === '') return token.length > 0;
    return token === expected;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const host = req.headers.host ?? 'localhost';

    // --- health, no auth ---
    if (path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // --- git smart HTTP ---
    // /<owner>/<repo>.git/<suffix>, parsed by hand: the regex this replaced ran on
    // every git request, and push/clone workloads issue hundreds of them.
    const gitIdx = path.lastIndexOf('.git/');
    if (gitIdx > 1) {
      const prefix = path.slice(1, gitIdx);
      const slash = prefix.indexOf('/');
      if (slash > 0 && prefix.indexOf('/', slash + 1) < 0) {
        const owner = prefix.slice(0, slash);
        const repoName = prefix.slice(slash + 1);
        const suffix = path.slice(gitIdx + 5);
        if (owner !== '' && repoName !== '' && suffix !== '') {
          await handleGit(req, res, owner, repoName, suffix, url);
          return;
        }
      }
    }

    // --- API surface: everything below needs a valid token ---
    if (path.startsWith('/api/v3') || path === '/api/graphql' || path === '/mcp') {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
    }

    if (path === '/api/v3/' || path === '/api/v3') {
      sendJson(res, 200, {}, { 'X-OAuth-Scopes': 'repo, read:org' });
      return;
    }
    if (path === '/api/v3/meta' && method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return;
    }
    if (path === '/api/v3/user' && method === 'GET') {
      sendJson(res, 200, {
        login: VIEWER.login,
        id: VIEWER.id,
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
        site_admin: false,
      });
      return;
    }

    if (path.startsWith('/api/v3')) {
      await handleRest(req, res, path, method, url, host);
      return;
    }

    if (path === '/api/graphql' && method === 'POST') {
      await handleGraphql(req, res);
      return;
    }

    if (path === '/mcp' && method === 'POST') {
      const raw = await readBody(req);
      const { status, body } = handleMcpBody(store, raw);
      if (body === null) {
        sendJson(res, 200, {});
        return;
      }
      sendJson(res, status, body);
      return;
    }
    if (path === '/mcp' && method === 'DELETE') {
      sendJson(res, 200, {});
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  // -------------------------------------------------------------------------------------------
  // git
  // -------------------------------------------------------------------------------------------

  async function handleGit(
    req: IncomingMessage,
    res: ServerResponse,
    owner: string,
    repoName: string,
    suffix: string,
    url: URL,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    if (owner !== VIEWER.login) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    if (suffix === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service');
      if (service === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', v2 ? advertiseV2() : advertiseV0(repo, 'git-upload-pack'));
        return;
      }
      if (service === 'git-receive-pack') {
        sendBytes(res, 200, 'application/x-git-receive-pack-advertisement', advertiseV0(repo, 'git-receive-pack'));
        return;
      }
      sendJson(res, 400, { message: 'service is required' });
      return;
    }

    if (suffix === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      try {
        if ((req.headers['git-protocol'] ?? '') === 'version=2') {
          const command = v2Command(body);
          if (command === 'ls-refs') {
            sendBytes(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, parseLsRefs(body)));
            return;
          }
          if (command === 'fetch') {
            sendBytes(res, 200, 'application/x-git-upload-pack-result', fetchV2Response(repo, parseFetchV2(body)));
            return;
          }
          sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.alloc(0));
          return;
        }
        sendBytes(res, 200, 'application/x-git-upload-pack-result', fetchV0Response(repo, parseFetchV0(body)));
      } catch (err) {
        sendJson(res, 400, { message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (suffix === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      try {
        const { commands, pack } = parseReceivePack(body);
        const result = applyPush(store, repo, commands, pack);
        sendBytes(res, 200, 'application/x-git-receive-pack-result', pushReportResponse(result));
      } catch (err) {
        sendJson(res, 400, { message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  // -------------------------------------------------------------------------------------------
  // REST v3
  // -------------------------------------------------------------------------------------------

  async function handleRest(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string,
    url: URL,
    host: string,
  ): Promise<void> {
    const ctx: rest.Ctx = { store, host, query: url.searchParams };
    const tail = path.slice('/api/v3'.length);
    try {
      // POST /user/repos, GET /user/repos
      if (tail === '/user/repos') {
        if (method === 'POST') {
          const body = await readJsonBody(req);
          const { status, json } = rest.createUserRepo(ctx, body);
          sendJson(res, status, json);
          return;
        }
        if (method === 'GET') {
          const { status, json, link } = rest.listUserRepos(ctx);
          sendJson(res, status, json, link !== null ? { Link: link } : {});
          return;
        }
      }

      // /repos/:owner/:repo/... — split by hand; the previous version ran ~20 regexes
      // per request, which the read workload (2,000 sequential GETs) paid in full.
      if (tail.startsWith('/repos/')) {
        const afterRepos = tail.slice(7);
        const ownerEnd = afterRepos.indexOf('/');
        if (ownerEnd > 0) {
          const ownerRaw = afterRepos.slice(0, ownerEnd);
          const afterOwner = afterRepos.slice(ownerEnd + 1);
          const nameEnd = afterOwner.indexOf('/');
          const nameRaw = nameEnd < 0 ? afterOwner : afterOwner.slice(0, nameEnd);
          const restPath = nameEnd < 0 ? '' : afterOwner.slice(nameEnd + 1);
          if (nameRaw !== '') {
            const owner = decodeURIComponent(ownerRaw);
            const name = decodeURIComponent(nameRaw);

            if (restPath === '') {
              if (method === 'GET') {
                sendJson(res, 200, rest.getRepo(ctx, owner, name));
                return;
              }
              if (method === 'PATCH') {
                const body = await readJsonBody(req);
                sendJson(res, 200, rest.patchRepo(ctx, owner, name, body));
                return;
              }
              if (method === 'DELETE') {
                rest.deleteRepo(ctx, owner, name);
                res.writeHead(204, { 'X-GitHub-Request-Id': nextRequestId() });
                res.end();
                return;
              }
            } else if (restPath === 'git/refs') {
              if (method === 'POST') {
                const body = await readJsonBody(req);
                const { status, json } = rest.createRef(ctx, owner, name, body);
                sendJson(res, status, json);
                return;
              }
            } else if (restPath.startsWith('git/refs/')) {
              const refPath = restPath.slice(9);
              if (refPath !== '' && method === 'GET') {
                sendJson(res, 200, rest.getRef(ctx, owner, name, decodeURIComponent(refPath)));
                return;
              }
            } else if (restPath === 'branches') {
              if (method === 'GET') {
                sendJson(res, 200, rest.listBranches(ctx, owner, name));
                return;
              }
            } else if (restPath.startsWith('branches/')) {
              const branch = restPath.slice(9);
              if (branch !== '' && method === 'GET') {
                sendJson(res, 200, rest.getBranch(ctx, owner, name, decodeURIComponent(branch)));
                return;
              }
            } else if (restPath === 'commits') {
              if (method === 'GET') {
                sendJson(res, 200, rest.listCommits(ctx, owner, name));
                return;
              }
            } else if (restPath.startsWith('contents/')) {
              const contentPath = decodeURIComponent(restPath.slice(9));
              if (method === 'GET') {
                sendJson(res, 200, rest.getContents(ctx, owner, name, contentPath));
                return;
              }
              if (method === 'PUT') {
                const body = await readJsonBody(req);
                const { status, json } = rest.putContents(ctx, owner, name, contentPath, body);
                sendJson(res, status, json);
                return;
              }
              if (method === 'DELETE') {
                const body = await readJsonBody(req);
                sendJson(res, 200, rest.deleteContents(ctx, owner, name, contentPath, body));
                return;
              }
            } else if (restPath === 'labels') {
              if (method === 'POST') {
                const body = await readJsonBody(req);
                const { status, json } = rest.createLabel(ctx, owner, name, body);
                sendJson(res, status, json);
                return;
              }
              if (method === 'GET') {
                sendJson(res, 200, rest.listLabels(ctx, owner, name));
                return;
              }
            } else if (restPath === 'issues') {
              if (method === 'POST') {
                const body = await readJsonBody(req);
                const { status, buffer } = rest.createIssueBuffer(ctx, owner, name, body);
                sendBytes(res, status, JSON_TYPE, buffer);
                return;
              }
              if (method === 'GET') {
                sendJson(res, 200, rest.listIssues(ctx, owner, name));
                return;
              }
            } else if (restPath.startsWith('issues/')) {
              const afterIssues = restPath.slice(7);
              const slashAt = afterIssues.indexOf('/');
              if (slashAt < 0) {
                if (isDigits(afterIssues)) {
                  const number = Number(afterIssues);
                  if (method === 'GET') {
                    sendBytes(res, 200, JSON_TYPE, rest.getIssueBuffer(ctx, owner, name, number));
                    return;
                  }
                  if (method === 'PATCH') {
                    const body = await readJsonBody(req);
                    sendJson(res, 200, rest.patchIssue(ctx, owner, name, number, body));
                    return;
                  }
                }
              } else if (isDigits(afterIssues.slice(0, slashAt)) && afterIssues.slice(slashAt + 1) === 'comments') {
                const number = Number(afterIssues.slice(0, slashAt));
                if (method === 'POST') {
                  const body = await readJsonBody(req);
                  const { status, json } = rest.createComment(ctx, owner, name, number, body);
                  sendJson(res, status, json);
                  return;
                }
                if (method === 'GET') {
                  sendJson(res, 200, rest.listComments(ctx, owner, name, number));
                  return;
                }
              }
            } else if (restPath === 'pulls') {
              if (method === 'POST') {
                const body = await readJsonBody(req);
                const { status, json } = rest.createPull(ctx, owner, name, body);
                sendJson(res, status, json);
                return;
              }
              if (method === 'GET') {
                sendJson(res, 200, rest.listPulls(ctx, owner, name));
                return;
              }
            } else if (restPath.startsWith('pulls/')) {
              const afterPulls = restPath.slice(6);
              const slashAt = afterPulls.indexOf('/');
              if (slashAt < 0) {
                if (isDigits(afterPulls) && method === 'GET') {
                  sendJson(res, 200, rest.getPull(ctx, owner, name, Number(afterPulls)));
                  return;
                }
              } else if (isDigits(afterPulls.slice(0, slashAt))) {
                const number = Number(afterPulls.slice(0, slashAt));
                const sub = afterPulls.slice(slashAt + 1);
                if (sub === 'files' && method === 'GET') {
                  sendJson(res, 200, rest.listPullFiles(ctx, owner, name, number));
                  return;
                }
                if (sub === 'merge' && method === 'PUT') {
                  const body = await readJsonBody(req);
                  sendJson(res, 200, rest.mergePull(ctx, owner, name, number, body));
                  return;
                }
              }
            }
          }
        }
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (err instanceof rest.HttpError) {
        sendJson(res, err.status, { message: err.message });
        return;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------------------------
  // GraphQL
  // -------------------------------------------------------------------------------------------

  async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Malformed JSON body' });
      return;
    }
    if (Array.isArray(parsed)) {
      const results = parsed.map((entry) =>
        entry !== null && typeof entry === 'object'
          ? executeGraphql(store, entry as { query?: string; operationName?: string; variables?: Record<string, unknown> })
          : { data: null, errors: [{ message: 'Invalid operation' }] },
      );
      sendJson(res, 200, results);
      return;
    }
    if (parsed !== null && typeof parsed === 'object') {
      sendJson(
        res,
        200,
        executeGraphql(store, parsed as { query?: string; operationName?: string; variables?: Record<string, unknown> }),
      );
      return;
    }
    sendJson(res, 400, { message: 'Malformed JSON body' });
  }

  return server;
}
