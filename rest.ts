// rest.ts — the REST v3 API under /api/v3: repositories, branches, commits, contents,
// labels, issues, comments and pull requests, over the store in store.ts.

import {
  VIEWER,
  commitOf,
  flattenTree,
  isOid,
  parseTree,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface Ctx {
  store: Store;
  /** The request's Host header, for absolute pagination links. */
  host: string;
  /** Parsed query parameters. */
  query: URLSearchParams;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function err(status: number, message: string): HttpError {
  return new HttpError(status, message);
}

function b64encode(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, type: 'User', site_admin: false };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`repo:${repo.id}`, 'utf8').toString('base64url'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, VIEWER.id),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    topics: [],
    license: null,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(VIEWER.login, VIEWER.id),
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    assignees: [],
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`pull:${repo.id}:${pull.number}`, 'utf8').toString('base64url'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(VIEWER.login, VIEWER.id),
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, repo: repoJson(repo) },
    merged: pull.merged,
    mergeable: null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const commit = commitOf(repo, sha);
  if (!commit) return null;
  const who = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d+)$/.exec(line);
    if (!match) return { name: VIEWER.name, email: VIEWER.email, date: repo.createdAt };
    return {
      name: match[1]!,
      email: match[2]!,
      date: new Date(Number(match[3]) * 1000).toISOString().replace('.000Z', 'Z'),
    };
  };
  return {
    sha,
    node_id: Buffer.from(`commit:${sha}`, 'utf8').toString('base64url'),
    commit: {
      message: commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message,
      author: who(commit.author),
      committer: who(commit.committer),
      tree: { sha: commit.tree },
    },
    author: userJson(VIEWER.login, VIEWER.id),
    committer: userJson(VIEWER.login, VIEWER.id),
    parents: commit.parents.map((parent) => ({ sha: parent })),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

/** Resolve a repository from the URL, 404 unless it is the viewer's. */
function needRepo(ctx: Ctx, owner: string, name: string): Repo {
  if (owner !== VIEWER.login) throw err(404, 'Not Found');
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) throw err(404, 'Not Found');
  return repo;
}

function pageOf(ctx: Ctx): { page: number; perPage: number } {
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** A Link header for the next page, or null when this is the last page. */
function nextLink(ctx: Ctx, path: string, page: number, perPage: number, total: number): string | null {
  if (page * perPage >= total) return null;
  const url = new URL(`http://${ctx.host}${path}`);
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('page', String(page + 1));
  return `<${url.toString()}>; rel="next"`;
}

// ---------------------------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------------------------

export function createUserRepo(ctx: Ctx, body: Record<string, unknown>): { status: number; json: Record<string, unknown> } {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') throw err(422, 'name is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) throw err(422, 'name is invalid');
  if (ctx.store.getRepo(VIEWER.login, name)) throw err(422, 'Repository already exists');
  const repo = ctx.store.createRepo(
    name,
    body.private === true,
    typeof body.description === 'string' ? body.description : '',
  );
  return { status: 201, json: repoJson(repo) };
}

export function listUserRepos(ctx: Ctx): { status: number; json: unknown; link: string | null } {
  const { page, perPage } = pageOf(ctx);
  const repos = ctx.store.repoList;
  const link = nextLink(ctx, '/api/v3/user/repos', page, perPage, repos.length);
  return { status: 200, json: paginate(repos, page, perPage).map(repoJson), link };
}

export function getRepo(ctx: Ctx, owner: string, name: string): Record<string, unknown> {
  return repoJson(needRepo(ctx, owner, name));
}

export function patchRepo(ctx: Ctx, owner: string, name: string, body: Record<string, unknown>): Record<string, unknown> {
  const repo = needRepo(ctx, owner, name);
  if (typeof body.description === 'string') repo.description = body.description;
  if (body.private === true || body.private === false) repo.private = body.private;
  repo.updatedAt = ctx.store.clock.stamp();
  return repoJson(repo);
}

export function deleteRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = needRepo(ctx, owner, name);
  ctx.store.deleteRepo(repo);
}

// ---------------------------------------------------------------------------------------------
// branches, refs, commits
// ---------------------------------------------------------------------------------------------

export function createRef(ctx: Ctx, owner: string, name: string, body: Record<string, unknown>): { status: number; json: Record<string, unknown> } {
  const repo = needRepo(ctx, owner, name);
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/heads/') || !isOid(sha)) throw err(422, 'ref and sha are required');
  if (!repo.objects.has(sha)) throw err(422, 'sha does not exist');
  if (repo.refs.has(ref)) throw err(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  return { status: 201, json: { ref, object: { sha, type: 'commit' } } };
}

export function getRef(ctx: Ctx, owner: string, name: string, refPath: string): Record<string, unknown> {
  const repo = needRepo(ctx, owner, name);
  const ref = `refs/${refPath}`;
  const sha = repo.refs.get(ref);
  if (!sha) throw err(404, 'Not Found');
  return { ref, object: { sha, type: 'commit' } };
}

export function listBranches(ctx: Ctx, owner: string, name: string): unknown[] {
  const repo = needRepo(ctx, owner, name);
  const out: unknown[] = [];
  for (const ref of [...repo.refs.keys()].sort()) {
    if (!ref.startsWith('refs/heads/')) continue;
    out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) }, protected: false });
  }
  return out;
}

export function getBranch(ctx: Ctx, owner: string, name: string, branch: string): Record<string, unknown> {
  const repo = needRepo(ctx, owner, name);
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (!sha) throw err(404, 'Not Found');
  return { name: branch, commit: { sha }, protected: false };
}

export function listCommits(ctx: Ctx, owner: string, name: string): unknown[] {
  const repo = needRepo(ctx, owner, name);
  const ref = ctx.query.get('sha');
  const tip = ref === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : ctx.store.resolveRef(repo, ref);
  if (tip === undefined) return [];
  const { page, perPage } = pageOf(ctx);
  const commits = ctx.store.listCommits(repo, tip);
  return paginate(commits, page, perPage)
    .map((sha) => commitJson(repo, sha))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function contentEntry(repo: Repo, path: string, blobSha: string, data: Buffer): Record<string, unknown> {
  const segments = path.split('/');
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: segments[segments.length - 1],
    path,
    content: b64encode(data),
    sha: blobSha,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    download_url: null,
  };
}

export function getContents(ctx: Ctx, owner: string, name: string, path: string): unknown {
  const repo = needRepo(ctx, owner, name);
  const ref = ctx.query.get('ref');
  const tip = ref === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : ctx.store.resolveRef(repo, ref);
  if (tip === undefined) throw err(404, 'Not Found');
  const commit = commitOf(repo, tip)!;
  const files = flattenTree(commit.tree, (oid) => repo.objects.get(oid), '', new Map(), repo);
  if (path === '') {
    // The repository root: list top-level entries.
    const seen = new Map<string, { type: string; sha: string }>();
    for (const [filePath, oid] of files) {
      const first = filePath.split('/')[0]!;
      if (filePath.includes('/')) {
        if (!seen.has(first)) {
          const tree = repo.objects.get(commit.tree)!;
          const entry = parseTree(tree.data).find((candidate) => candidate.name === first);
          if (entry) seen.set(first, { type: 'dir', sha: entry.oid });
        }
      } else {
        seen.set(first, { type: 'file', sha: oid });
      }
    }
    return [...seen.entries()].map(([entryName, entry]) => ({
      type: entry.type,
      name: entryName,
      path: entryName,
      sha: entry.sha,
      size: entry.type === 'file' ? repo.objects.get(entry.sha)?.data.length ?? 0 : 0,
    }));
  }
  const blobSha = files.get(path);
  if (blobSha !== undefined) {
    const data = repo.objects.get(blobSha)?.data ?? Buffer.alloc(0);
    return contentEntry(repo, path, blobSha, data);
  }
  // A directory: every file below it, one level deep.
  const prefix = `${path}/`;
  const children = new Map<string, { type: string; sha: string; size: number }>();
  for (const [filePath, oid] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const first = rest.split('/')[0]!;
    if (rest.includes('/')) {
      if (!children.has(first)) {
        // Find the subtree object for this directory.
        let current = commit.tree;
        let found: string | undefined;
        for (const segment of `${path}/${first}`.split('/')) {
          const tree = repo.objects.get(current);
          if (!tree) break;
          const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
          if (!entry) break;
          current = entry.oid;
          found = entry.oid;
        }
        if (found) children.set(first, { type: 'dir', sha: found, size: 0 });
      }
    } else {
      children.set(first, { type: 'file', sha: oid, size: repo.objects.get(oid)?.data.length ?? 0 });
    }
  }
  if (children.size === 0) throw err(404, 'Not Found');
  return [...children.entries()].map(([entryName, entry]) => ({
    type: entry.type,
    name: entryName,
    path: `${path}/${entryName}`,
    sha: entry.sha,
    size: entry.size,
  }));
}

export function putContents(
  ctx: Ctx,
  owner: string,
  name: string,
  path: string,
  body: Record<string, unknown>,
): { status: number; json: Record<string, unknown> } {
  const repo = needRepo(ctx, owner, name);
  const message = typeof body.message === 'string' ? body.message : 'update';
  const content = typeof body.content === 'string' ? b64decode(body.content) : Buffer.alloc(0);
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  if (repo.refs.get(`refs/heads/${branch}`) === undefined && branch !== repo.defaultBranch) {
    // A write on a branch that does not exist yet starts it from the default tip.
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (tip !== undefined) repo.refs.set(`refs/heads/${branch}`, tip);
  }
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const isUpdate = tip !== undefined && flattenTree(commitOf(repo, tip)!.tree, (oid) => repo.objects.get(oid), '', new Map(), repo).has(path);
  if (isUpdate) {
    const files = flattenTree(commitOf(repo, tip!)!.tree, (oid) => repo.objects.get(oid), '', new Map(), repo);
    const currentSha = files.get(path)!;
    if (typeof body.sha === 'string' && body.sha !== '' && body.sha.toLowerCase() !== currentSha.toLowerCase()) {
      throw err(409, 'sha does not match the current file');
    }
  }
  const { commitSha, contentSha } = ctx.store.commitFile(repo, branch, path, content, message);
  return {
    status: isUpdate ? 200 : 201,
    json: {
      content: { name: path.split('/').pop(), path, sha: contentSha, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    },
  };
}

export function deleteContents(
  ctx: Ctx,
  owner: string,
  name: string,
  path: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const repo = needRepo(ctx, owner, name);
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const message = typeof body.message === 'string' ? body.message : 'delete';
  const commitSha = ctx.store.deleteFile(repo, branch, path, message);
  if (commitSha === null) throw err(404, 'Not Found');
  return { commit: { sha: commitSha, message } };
}

// ---------------------------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------------------------

export function createLabel(ctx: Ctx, owner: string, name: string, body: Record<string, unknown>): { status: number; json: Record<string, unknown> } {
  const repo = needRepo(ctx, owner, name);
  const labelName = typeof body.name === 'string' ? body.name.trim() : '';
  if (labelName === '') throw err(422, 'name is required');
  const color = typeof body.color === 'string' ? body.color : 'ededed';
  const existing = repo.labels.get(labelName);
  if (existing) return { status: 201, json: { name: existing.name, color: existing.color } };
  const label: Label = { name: labelName, color };
  repo.labels.set(labelName, label);
  return { status: 201, json: { name: label.name, color: label.color } };
}

export function listLabels(ctx: Ctx, owner: string, name: string): unknown[] {
  const repo = needRepo(ctx, owner, name);
  return [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color }));
}

// ---------------------------------------------------------------------------------------------
// issues and comments
// ---------------------------------------------------------------------------------------------

function parseIssueLabels(body: Record<string, unknown>): string[] {
  const raw = body.labels;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') out.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>).name === 'string') {
      out.push((entry as Record<string, unknown>).name as string);
    }
  }
  return out;
}

export function createIssue(ctx: Ctx, owner: string, name: string, body: Record<string, unknown>): { status: number; json: Record<string, unknown> } {
  const repo = needRepo(ctx, owner, name);
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') throw err(422, 'title is required');
  const labels: Label[] = [];
  for (const labelName of parseIssueLabels(body)) {
    const label = repo.labels.get(labelName);
    if (!label) throw err(422, `Label does not exist: ${labelName}`);
    labels.push(label);
  }
  const issue = ctx.store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
  return { status: 201, json: issueJson(repo, issue) };
}

export function listIssues(ctx: Ctx, owner: string, name: string): unknown[] {
  const repo = needRepo(ctx, owner, name);
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  if (sort === 'created') {
    issues = [...issues].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  const { page, perPage } = pageOf(ctx);
  return paginate(issues, page, perPage).map((issue) => issueJson(repo, issue));
}

export function getIssue(ctx: Ctx, owner: string, name: string, number: number): Record<string, unknown> {
  const repo = needRepo(ctx, owner, name);
  const issue = repo.issuesByNumber.get(number);
  if (!issue) throw err(404, 'Not Found');
  return issueJson(repo, issue);
}

/** The serialised GET-issue body, cached per issue (invalidated on any mutation of it). */
export function issueJsonBuffer(repo: Repo, issue: Issue): Buffer {
  const cached = issue.jsonCache;
  if (cached !== null) return cached;
  const buffer = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
  issue.jsonCache = buffer;
  return buffer;
}

/** GET one issue as a ready-to-send buffer. */
export function getIssueBuffer(ctx: Ctx, owner: string, name: string, number: number): Buffer {
  const repo = needRepo(ctx, owner, name);
  const issue = repo.issuesByNumber.get(number);
  if (!issue) throw err(404, 'Not Found');
  return issueJsonBuffer(repo, issue);
}

/** POST one issue as a ready-to-send buffer (the create path warms the same cache). */
export function createIssueBuffer(ctx: Ctx, owner: string, name: string, body: Record<string, unknown>): { status: number; buffer: Buffer } {
  const repo = needRepo(ctx, owner, name);
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') throw err(422, 'title is required');
  const labels: Label[] = [];
  for (const labelName of parseIssueLabels(body)) {
    const label = repo.labels.get(labelName);
    if (!label) throw err(422, `Label does not exist: ${labelName}`);
    labels.push(label);
  }
  const issue = ctx.store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
  return { status: 201, buffer: issueJsonBuffer(repo, issue) };
}

export function patchIssue(ctx: Ctx, owner: string, name: string, number: number, body: Record<string, unknown>): Record<string, unknown> {
  const repo = needRepo(ctx, owner, name);
  const issue = repo.issuesByNumber.get(number);
  if (!issue) throw err(404, 'Not Found');
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (Array.isArray(body.labels)) {
    const labels: Label[] = [];
    for (const labelName of parseIssueLabels(body)) {
      const label = repo.labels.get(labelName);
      if (!label) throw err(422, `Label does not exist: ${labelName}`);
      labels.push(label);
    }
    issue.labels = labels;
  }
  issue.updatedAt = ctx.store.clock.stamp();
  issue.jsonCache = null;
  return issueJson(repo, issue);
}

export function createComment(ctx: Ctx, owner: string, name: string, number: number, body: Record<string, unknown>): { status: number; json: Record<string, unknown> } {
  const repo = needRepo(ctx, owner, name);
  const issue = repo.issuesByNumber.get(number);
  if (!issue) throw err(404, 'Not Found');
  const text = typeof body.body === 'string' ? body.body : '';
  const comment = ctx.store.addComment(repo, number, text);
  return {
    status: 201,
    json: {
      id: comment.id,
      node_id: Buffer.from(`comment:${repo.id}:${number}:${comment.id}`, 'utf8').toString('base64url'),
      body: comment.body,
      user: userJson(VIEWER.login, VIEWER.id),
      created_at: comment.createdAt,
      updated_at: comment.createdAt,
    },
  };
}

export function listComments(ctx: Ctx, owner: string, name: string, number: number): unknown[] {
  const repo = needRepo(ctx, owner, name);
  if (!repo.issuesByNumber.has(number)) throw err(404, 'Not Found');
  return (repo.comments.get(number) ?? []).map((comment) => ({
    id: comment.id,
    node_id: Buffer.from(`comment:${repo.id}:${number}:${comment.id}`, 'utf8').toString('base64url'),
    body: comment.body,
    user: userJson(VIEWER.login, VIEWER.id),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  }));
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

export function createPull(ctx: Ctx, owner: string, name: string, body: Record<string, unknown>): { status: number; json: Record<string, unknown> } {
  const repo = needRepo(ctx, owner, name);
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  if (title === '' || head === '') throw err(422, 'title and head are required');
  const headSha = ctx.store.resolveRef(repo, head);
  const baseSha = ctx.store.resolveRef(repo, base);
  if (headSha === undefined || baseSha === undefined) throw err(422, 'head or base branch does not exist');
  const existing = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open');
  if (existing) throw err(422, 'A pull request already exists for this head and base');
  const pull = ctx.store.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base, headSha, baseSha);
  return { status: 201, json: pullJson(repo, pull) };
}

export function listPulls(ctx: Ctx, owner: string, name: string): unknown[] {
  const repo = needRepo(ctx, owner, name);
  const state = ctx.query.get('state') ?? 'open';
  const pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
  const { page, perPage } = pageOf(ctx);
  return paginate(pulls, page, perPage).map((pull) => pullJson(repo, pull));
}

export function getPull(ctx: Ctx, owner: string, name: string, number: number): Record<string, unknown> {
  const repo = needRepo(ctx, owner, name);
  const pull = repo.pullsByNumber.get(number);
  if (!pull) throw err(404, 'Not Found');
  return pullJson(repo, pull);
}

export function listPullFiles(ctx: Ctx, owner: string, name: string, number: number): unknown[] {
  const repo = needRepo(ctx, owner, name);
  const pull = repo.pullsByNumber.get(number);
  if (!pull) throw err(404, 'Not Found');
  return ctx.store.pullFiles(repo, pull).map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    sha: '',
  }));
}

export function mergePull(ctx: Ctx, owner: string, name: string, number: number, body: Record<string, unknown>): Record<string, unknown> {
  const repo = needRepo(ctx, owner, name);
  const pull = repo.pullsByNumber.get(number);
  if (!pull) throw err(404, 'Not Found');
  if (pull.state !== 'open' || pull.merged) throw err(405, 'Pull request is already closed');
  if (ctx.store.pullConflicts(repo, pull)) throw err(405, 'Merge conflict');
  const sha = ctx.store.mergePull(repo, pull);
  if (sha === null) throw err(405, 'Merge conflict');
  return { sha, merged: true, message: `Pull request #${number} merged` };
}
