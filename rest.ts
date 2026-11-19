// rest.ts — github-core-clone-01 v3 forge: GitHub REST v3 surface.
//
// Written from scratch for the v3 perf rebuild. Every handler is sync over the
// in-memory store; the hot GET-issue path answers from a pre-serialized Buffer.

import {
  DEFAULT_BRANCH,
  FORGE_VERSION,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  addComment,
  commitFile,
  commitList,
  commitMessageForRest,
  commitTree,
  createIssue,
  createPull,
  createRepo,
  deleteFile,
  deleteRepo,
  diffTrees,
  flattenTree,
  getIssue,
  getPull,
  getRepo,
  issueJson,
  listRepos,
  mergeBase,
  mergePull,
  parseTree,
  prFiles,
  pullJson,
  repoJson,
  resolveRefish,
  subtreeAt,
  type Issue,
  type Repo,
} from './store.ts';

export interface RestReply {
  status: number;
  body: Buffer | string;
  contentType: string;
  headers?: Record<string, string>;
}

const JSON_TYPE = 'application/json; charset=utf-8';

function json(status: number, value: unknown, headers?: Record<string, string>): RestReply {
  return { status, body: Buffer.from(JSON.stringify(value), 'utf8'), contentType: JSON_TYPE, headers };
}

function jsonBuf(status: number, buf: Buffer, headers?: Record<string, string>): RestReply {
  return { status, body: buf, contentType: JSON_TYPE, headers };
}

function err(status: number, message: string): RestReply {
  return json(status, { message });
}

function decodeSeg(seg: string): string {
  if (seg.indexOf('%') < 0) return seg;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function parseIntQuery(v: string | null, def: number): number {
  if (v === null) return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : def;
}

/** Parse a request body as JSON; returns null on empty body, throws on malformed. */
export function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return null;
  return JSON.parse(body.toString('utf8'));
}

function b64decode(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

// ---------------------------------------------------------------------------
// repos
// ---------------------------------------------------------------------------

function createRepoHandler(body: Record<string, unknown>): RestReply {
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') return err(422, 'name is required');
  const repo = createRepo(VIEWER_LOGIN, name, body.private === true, typeof body.description === 'string' ? body.description : '');
  if (repo === null) return err(422, 'Repository already exists');
  return jsonBuf(201, repoJson(repo));
}

function listUserRepos(query: URLSearchParams, origin: string): RestReply {
  const perPage = parseIntQuery(query.get('per_page'), 30);
  const page = parseIntQuery(query.get('page'), 1);
  const all = listRepos(VIEWER_LOGIN);
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < all.length) {
    headers.link = `<${origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
  }
  return json(200, slice.map((r) => JSON.parse(repoJson(r).toString('utf8'))), headers);
}

function getRepoHandler(owner: string, name: string): RestReply {
  const repo = getRepo(owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  return jsonBuf(200, repoJson(repo));
}

function patchRepoHandler(repo: Repo, body: Record<string, unknown>): RestReply {
  if (typeof body.description === 'string') {
    repo.description = body.description;
    repo.cachedRepoJson = null;
  }
  if (typeof body.private === 'boolean') {
    repo.isPrivate = body.private;
    repo.cachedRepoJson = null;
  }
  return jsonBuf(200, repoJson(repo));
}

// ---------------------------------------------------------------------------
// branches / commits / refs
// ---------------------------------------------------------------------------

function listBranches(repo: Repo): RestReply {
  const out: Array<{ name: string; commit: { sha: string } }> = [];
  for (const name of [...repo.refs.keys()].filter((n) => n.startsWith('refs/heads/')).sort()) {
    out.push({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name)! } });
  }
  return json(200, out);
}

function getBranch(repo: Repo, branch: string): RestReply {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return err(404, 'Not Found');
  return json(200, { name: branch, commit: { sha: tip } });
}

function listCommits(repo: Repo, query: URLSearchParams): RestReply {
  const sha = query.get('sha');
  const tip = sha === null ? repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) : resolveRefish(repo, sha);
  if (tip === undefined || tip === null) return err(404, 'Not Found');
  const out = commitList(repo, tip).map((oid) => ({ sha: oid, commit: { message: commitMessageForRest(repo, oid) } }));
  return json(200, out);
}

function createRef(repo: Repo, body: Record<string, unknown>): RestReply {
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || sha === '') return err(422, 'ref and sha are required');
  if (repo.refs.has(ref)) return err(422, 'Reference already exists');
  if (repo.objects.get(sha) === undefined) return err(422, 'object not found');
  repo.refs.set(ref, sha);
  repo.version += 1;
  repo.cachedRepoJson = null;
  return json(201, { ref, object: { sha } });
}

function getRef(repo: Repo, ref: string): RestReply {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return err(404, 'Not Found');
  return json(200, { ref, object: { sha: oid } });
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function putContents(repo: Repo, path: string, body: Record<string, unknown>): RestReply {
  const message = typeof body.message === 'string' ? body.message : '';
  const content = typeof body.content === 'string' ? body.content : '';
  if (message === '' || content === '') return err(422, 'message and content are required');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : DEFAULT_BRANCH;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  let currentSha: string | undefined;
  if (tip !== undefined) {
    const files = flattenTree(repo, commitTree(repo, tip));
    currentSha = files.get(path);
  }
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  if (sha !== undefined && currentSha !== undefined && sha !== currentSha) {
    return err(409, 'sha does not match the current blob');
  }
  const isUpdate = currentSha !== undefined;
  if (sha !== undefined && currentSha === undefined && tip !== undefined) {
    // A sha was given but the file does not exist on this branch: stale in effect.
    return err(409, 'sha does not match the current blob');
  }
  const result = commitFile(repo, branch, path, b64decode(content), message);
  return json(isUpdate ? 200 : 201, {
    content: { sha: result.contentSha, encoding: 'base64', name: path.split('/').pop() ?? path, path },
    commit: { sha: result.commitSha },
  });
}

function getContents(repo: Repo, path: string, query: URLSearchParams): RestReply {
  const ref = query.get('ref');
  const tip = ref === null ? repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) : resolveRefish(repo, ref);
  if (tip === undefined || tip === null) return err(404, 'Not Found');
  const treeOid = commitTree(repo, tip);
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0) return err(404, 'Not Found');
  const files = flattenTree(repo, treeOid);
  const fileOid = files.get(segments.join('/'));
  if (fileOid !== undefined) {
    const obj = repo.objects.get(fileOid);
    if (obj === undefined) return err(404, 'Not Found');
    return json(200, {
      type: 'file',
      encoding: 'base64',
      content: obj.data.toString('base64'),
      sha: fileOid,
      size: obj.data.length,
      name: segments[segments.length - 1],
      path: segments.join('/'),
    });
  }
  // A directory: list the immediate children of the subtree.
  const dirOid = subtreeAt(repo, treeOid, segments);
  if (dirOid === null) return err(404, 'Not Found');
  const dirObj = repo.objects.get(dirOid);
  if (dirObj === undefined || dirObj.type !== 'tree') return err(404, 'Not Found');
  const prefix = segments.join('/');
  const out = parseTree(dirObj.data).map((e) => ({
    type: e.mode === '40000' ? 'dir' : 'file',
    name: e.name,
    path: `${prefix}/${e.name}`,
    sha: e.oid,
  }));
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return json(200, out);
}

function deleteContents(repo: Repo, path: string, body: Record<string, unknown> | null): RestReply {
  const branch = body !== null && typeof body.branch === 'string' && body.branch !== '' ? body.branch : DEFAULT_BRANCH;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return err(404, 'Not Found');
  const files = flattenTree(repo, commitTree(repo, tip));
  const currentSha = files.get(path);
  if (currentSha === undefined) return err(404, 'Not Found');
  const sha = body !== null && typeof body.sha === 'string' ? body.sha : undefined;
  if (sha !== undefined && sha !== currentSha) return err(409, 'sha does not match the current blob');
  const message = body !== null && typeof body.message === 'string' ? body.message : 'delete file';
  const result = deleteFile(repo, branch, path, message);
  if (result === null) return err(404, 'Not Found');
  return json(200, { commit: { sha: result.commitSha } });
}

// ---------------------------------------------------------------------------
// labels / issues / comments
// ---------------------------------------------------------------------------

function createLabel(repo: Repo, body: Record<string, unknown>): RestReply {
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') return err(422, 'name is required');
  const color = typeof body.color === 'string' && body.color !== '' ? body.color : 'ededed';
  repo.labels.set(name, { name, color });
  return json(201, { name, color });
}

function createIssueHandler(repo: Repo, body: Record<string, unknown>): RestReply {
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return err(422, 'title is required');
  const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  const result = createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
  if ('badLabel' in result) return err(422, `label does not exist: ${result.badLabel}`);
  return jsonBuf(201, issueJson(repo, result.issue));
}

function listIssues(repo: Repo, query: URLSearchParams): RestReply {
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  const perPage = parseIntQuery(query.get('per_page'), 30);
  const page = parseIntQuery(query.get('page'), 1);
  let list = repo.issues;
  if (state !== 'all') list = list.filter((i) => i.state === state);
  list = list.slice().sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const start = (page - 1) * perPage;
  const slice = list.slice(start, start + perPage);
  return json(200, slice.map((i) => JSON.parse(issueJson(repo, i).toString('utf8'))));
}

function getIssueHandler(repo: Repo, number: number): RestReply {
  const issue = getIssue(repo, number);
  if (issue === undefined) return err(404, 'Not Found');
  return jsonBuf(200, issueJson(repo, issue));
}

function patchIssueHandler(repo: Repo, number: number, body: Record<string, unknown>): RestReply {
  const issue = getIssue(repo, number);
  if (issue === undefined) return err(404, 'Not Found');
  if (body.state === 'open' || body.state === 'closed') {
    issue.state = body.state;
    issue.cached = null;
  }
  if (typeof body.title === 'string') {
    issue.title = body.title;
    issue.cached = null;
  }
  if (typeof body.body === 'string') {
    issue.body = body.body;
    issue.cached = null;
  }
  return jsonBuf(200, issueJson(repo, issue));
}

function createCommentHandler(repo: Repo, number: number, body: Record<string, unknown>): RestReply {
  const issue = getIssue(repo, number);
  if (issue === undefined) return err(404, 'Not Found');
  const text = typeof body.body === 'string' ? body.body : '';
  const comment = addComment(repo, number, text);
  return json(201, { id: comment.id, body: comment.body });
}

function listComments(repo: Repo, number: number): RestReply {
  const issue = getIssue(repo, number);
  if (issue === undefined) return err(404, 'Not Found');
  const list = repo.comments.get(number) ?? [];
  return json(
    200,
    list.map((c) => ({ id: c.id, body: c.body })),
  );
}

// ---------------------------------------------------------------------------
// pulls
// ---------------------------------------------------------------------------

function createPullHandler(repo: Repo, body: Record<string, unknown>): RestReply {
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : '';
  if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
  const result = createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
  if ('error' in result) return err(422, result.error);
  return jsonBuf(201, pullJson(repo, result.pr));
}

function listPulls(repo: Repo, query: URLSearchParams): RestReply {
  const state = query.get('state') ?? 'open';
  const perPage = parseIntQuery(query.get('per_page'), 30);
  const page = parseIntQuery(query.get('page'), 1);
  let list = repo.pulls;
  if (state === 'open') list = list.filter((p) => p.state === 'open');
  else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
  list = list.slice().sort((a, b) => b.number - a.number);
  const start = (page - 1) * perPage;
  const slice = list.slice(start, start + perPage);
  return json(200, slice.map((p) => JSON.parse(pullJson(repo, p).toString('utf8'))));
}

function getPullHandler(repo: Repo, number: number): RestReply {
  const pr = getPull(repo, number);
  if (pr === undefined) return err(404, 'Not Found');
  return jsonBuf(200, pullJson(repo, pr));
}

function listPullFiles(repo: Repo, number: number): RestReply {
  const pr = getPull(repo, number);
  if (pr === undefined) return err(404, 'Not Found');
  return json(200, prFiles(repo, pr));
}

function mergePullHandler(repo: Repo, number: number): RestReply {
  const pr = getPull(repo, number);
  if (pr === undefined) return err(404, 'Not Found');
  const result = mergePull(repo, number);
  if ('error' in result) {
    if (result.error === 'not-found') return err(404, 'Not Found');
    if (result.error === 'conflict') return err(405, 'Pull request is not mergeable');
    return err(405, 'Pull request is not mergeable');
  }
  return json(200, { sha: result.sha, merged: true, message: `Merge pull request #${number}` });
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

/**
 * Dispatch a REST v3 request. `segs` are the decoded path segments after
 * "/api/v3" (so segs[0] is the first resource segment). Returns null when the
 * path is not a REST route at all (the caller falls through to git/MCP/404).
 */
export function handleRest(
  method: string,
  segs: readonly string[],
  query: URLSearchParams,
  origin: string,
  body: Record<string, unknown> | null,
): RestReply | null {
  // GET /api/v3/ (root) and /api/v3/meta: no auth, no repo.
  if (segs.length === 0) {
    if (method === 'GET') {
      return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return null;
  }
  if (segs.length === 1 && segs[0] === 'meta') {
    if (method === 'GET') return json(200, { installed_version: FORGE_VERSION });
    return null;
  }
  if (segs.length === 1 && segs[0] === 'user') {
    if (method === 'GET') {
      return json(200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
    }
    return null;
  }
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'POST') return createRepoHandler(body ?? {});
    if (method === 'GET') return listUserRepos(query, origin);
    return null;
  }
  if (segs[0] !== 'repos' || segs.length < 3) return null;
  const owner = decodeSeg(segs[1]);
  const name = decodeSeg(segs[2]);
  const repo = getRepo(owner, name);
  if (repo === undefined) return err(404, 'Not Found');

  const rest = segs.slice(3);
  if (rest.length === 0) {
    if (method === 'GET') return getRepoHandler(owner, name);
    if (method === 'PATCH') return patchRepoHandler(repo, body ?? {});
    if (method === 'DELETE') {
      deleteRepo(owner, name);
      return { status: 204, body: '', contentType: JSON_TYPE };
    }
    return null;
  }
  const head = rest[0];
  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') return listBranches(repo);
    if (rest.length === 2 && method === 'GET') return getBranch(repo, decodeSeg(rest[1]));
    return null;
  }
  if (head === 'commits') {
    if (rest.length === 1 && method === 'GET') return listCommits(repo, query);
    return null;
  }
  if (head === 'git') {
    if (rest[1] === 'refs' && rest.length === 2 && method === 'POST') return createRef(repo, body ?? {});
    if (rest[1] === 'refs' && rest.length >= 3 && method === 'GET') {
      const ref = rest.slice(2).map(decodeSeg).join('/');
      return getRef(repo, `refs/${ref}`);
    }
    return null;
  }
  if (head === 'contents') {
    const path = rest.slice(1).map(decodeSeg).join('/');
    if (method === 'PUT') return putContents(repo, path, body ?? {});
    if (method === 'GET') return getContents(repo, path, query);
    if (method === 'DELETE') return deleteContents(repo, path, body);
    return null;
  }
  if (head === 'labels') {
    if (rest.length === 1 && method === 'POST') return createLabel(repo, body ?? {});
    return null;
  }
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') return createIssueHandler(repo, body ?? {});
      if (method === 'GET') return listIssues(repo, query);
      return null;
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num) || num <= 0) return null;
    if (rest.length === 2) {
      if (method === 'GET') return getIssueHandler(repo, num);
      if (method === 'PATCH') return patchIssueHandler(repo, num, body ?? {});
      return null;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'POST') return createCommentHandler(repo, num, body ?? {});
      if (method === 'GET') return listComments(repo, num);
      return null;
    }
    return null;
  }
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') return createPullHandler(repo, body ?? {});
      if (method === 'GET') return listPulls(repo, query);
      return null;
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num) || num <= 0) return null;
    if (rest.length === 2 && method === 'GET') return getPullHandler(repo, num);
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') return listPullFiles(repo, num);
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') return mergePullHandler(repo, num);
    return null;
  }
  return null;
}
