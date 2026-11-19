// store.ts — github-core-clone-01 v3 forge: in-memory store + git object model.
//
// Written from scratch for the v3 perf rebuild. The scenario is fixed by the kit
// (program/env/src/wire.ts SCENARIO_SEED_HEX is a constant), so the token owner's
// login is the constant below; every other owner is a stranger and reads 404.

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ZERO_OID = '0'.repeat(40);
export const DEFAULT_BRANCH = 'main';
export const FORGE_VERSION = '3.0.0';
export const MCP_SERVER_NAME = 'github-core-clone';

/** The trial clock: MAKEFUN_TRIAL_NOW when set, else a fixed epoch (never Date.now()). */
export function trialEpochSec(): number {
  const ms = Date.parse(process.env.MAKEFUN_TRIAL_NOW ?? '');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 1700000000;
}

export function trialNowIso(): string {
  const ms = Date.parse(process.env.MAKEFUN_TRIAL_NOW ?? '');
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '2026-11-20T02:30:00.000Z';
}

/** SHA-1 of "<type> <len>\0" + bytes. */
export function hashObject(type: string, data: Buffer): string {
  return createHash('sha1')
    .update(Buffer.from(`${type} ${data.length}\0`, 'ascii'))
    .update(data)
    .digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

/** Parse a commit object's headers (tree/parents) and message. */
export function parseCommit(data: Buffer): CommitInfo {
  let blank = -1;
  for (let i = 0; i + 1 < data.length; i += 1) {
    if (data[i] === 0x0a && data[i + 1] === 0x0a) {
      blank = i;
      break;
    }
  }
  const head = (blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8')).split('\n');
  let tree = '';
  const parents: string[] = [];
  for (const line of head) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  return { tree, parents, message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}

/** The target of an annotated tag object (the "object" header), or ''. */
export function parseTagTarget(data: Buffer): string {
  const m = /^object ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return m === null ? '' : m[1];
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

/** Build a tree object; entries sorted the way git sorts them (a dir compares as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = entries.slice().sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build a commit object. `message` is stored verbatim (callers include the trailing newline). */
export function buildCommit(tree: string, parents: readonly string[], message: string): Buffer {
  const ts = trialEpochSec();
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${who}\ncommitter ${who}\n\n${message}`;
  return Buffer.from(s, 'utf8');
}

// ---------------------------------------------------------------------------
// opaque global ids (base64 of a typed key; never the plain database id/number)
// ---------------------------------------------------------------------------

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

export function repoGid(owner: string, name: string): string {
  return b64(`R:${owner}/${name}#0`);
}

export function issueGid(owner: string, repo: string, number: number): string {
  return b64(`I:${owner}/${repo}#${number}`);
}

export function pullGid(owner: string, repo: string, number: number): string {
  return b64(`P:${owner}/${repo}#${number}`);
}

export function commentGid(owner: string, repo: string, issue: number, id: number): string {
  return b64(`C:${owner}/${repo}#${issue}:${id}`);
}

/** Decode an opaque id back to its typed key, or null. */
export function decodeGid(gid: string): { kind: string; owner: string; repo: string; num: number; sub: number } | null {
  try {
    const text = Buffer.from(gid, 'base64').toString('utf8');
    const m = /^([RIPC]):([^/]+)\/([^#:]*)#(\d+)(?::(\d+))?$/.exec(text);
    if (m === null) return null;
    return { kind: m[1], owner: m[2], repo: m[3], num: Number(m[4]), sub: m[5] === undefined ? 0 : Number(m[5]) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  gid: string;
  cached: Buffer | null;
}

export interface Comment {
  id: number;
  body: string;
  gid: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string;
  mergeSha: string;
  gid: string;
  cached: Buffer | null;
}

export interface Repo {
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  databaseId: number;
  gid: string;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  parents: Map<string, string[]>;
  trees: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  nextIssue: number;
  nextComment: number;
  comments: Map<number, Comment[]>;
  pulls: Pull[];
  nextPull: number;
  cachedRepoJson: Buffer | null;
  /** Bumped on any ref/object change; git caches are rebuilt when it moves. */
  version: number;
  advV2: Buffer | null;
  advV0Up: Buffer | null;
  advV0Recv: Buffer | null;
  advVersion: number;
  lsRefsVersion: number;
  lsRefs: Array<{ name: string; oid: string; peeled: string }> | null;
  /** Depth-1 single-tip pack per tip oid (valid while version holds). */
  clonePack: Map<string, Buffer>;
  clonePackVersion: number;
  /** Flattened file map per tree oid (trees are immutable, so this never goes stale). */
  flatTrees: Map<string, Map<string, string>>;
}

const repos = new Map<string, Repo>();
const reposByOwner = new Map<string, Repo[]>();
let nextDatabaseId = 1;

export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(`${owner}\n${name}`);
}

export function createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
  const key = `${owner}\n${name}`;
  if (repos.has(key)) return null;
  const repo: Repo = {
    name,
    owner,
    description: description ?? '',
    isPrivate,
    databaseId: nextDatabaseId,
    gid: repoGid(owner, name),
    refs: new Map(),
    objects: new Map(),
    parents: new Map(),
    trees: new Map(),
    labels: new Map(),
    issues: [],
    nextIssue: 1,
    nextComment: 1,
    comments: new Map(),
    pulls: [],
    nextPull: 1,
    cachedRepoJson: null,
    version: 0,
    advV2: null,
    advV0Up: null,
    advV0Recv: null,
    advVersion: -1,
    lsRefsVersion: -1,
    lsRefs: null,
    clonePack: new Map(),
    clonePackVersion: -1,
    flatTrees: new Map(),
  };
  nextDatabaseId += 1;
  repos.set(key, repo);
  let list = reposByOwner.get(owner);
  if (list === undefined) {
    list = [];
    reposByOwner.set(owner, list);
  }
  list.push(repo);
  return repo;
}

export function deleteRepo(owner: string, name: string): boolean {
  const key = `${owner}\n${name}`;
  const repo = repos.get(key);
  if (repo === undefined) return false;
  repos.delete(key);
  const list = reposByOwner.get(owner);
  if (list !== undefined) {
    const i = list.indexOf(repo);
    if (i >= 0) list.splice(i, 1);
  }
  return true;
}

export function listRepos(owner: string): Repo[] {
  return reposByOwner.get(owner) ?? [];
}

// ---------------------------------------------------------------------------
// git objects
// ---------------------------------------------------------------------------

/** Store an object (idempotent) and return its oid. Caches commit parents/tree. */
export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data });
    if (type === 'commit') {
      const info = parseCommit(data);
      repo.parents.set(oid, info.parents);
      repo.trees.set(oid, info.tree);
    }
  }
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObj | undefined {
  return repo.objects.get(oid);
}

export function commitParents(repo: Repo, oid: string): string[] {
  let p = repo.parents.get(oid);
  if (p !== undefined) return p;
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return [];
  const info = parseCommit(obj.data);
  repo.parents.set(oid, info.parents);
  repo.trees.set(oid, info.tree);
  return info.parents;
}

export function commitTree(repo: Repo, oid: string): string {
  let t = repo.trees.get(oid);
  if (t !== undefined) return t;
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return '';
  const info = parseCommit(obj.data);
  repo.parents.set(oid, info.parents);
  repo.trees.set(oid, info.tree);
  return info.tree;
}

/** True when `anc` is reachable from `desc` (or equal). */
export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === anc) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of commitParents(repo, cur)) stack.push(p);
  }
  return false;
}

/** A common ancestor of a and b (the first found walking from b), or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (ancA.has(cur)) continue;
    ancA.add(cur);
    for (const p of commitParents(repo, cur)) stack.push(p);
  }
  const seen = new Set<string>();
  const stack2 = [b];
  while (stack2.length > 0) {
    const cur = stack2.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (ancA.has(cur)) return cur;
    for (const p of commitParents(repo, cur)) stack2.push(p);
  }
  return null;
}

/** Commits reachable from `tip`, newest-first (stack walk; linear history stays in order). */
export function commitList(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(cur);
    const parents = commitParents(repo, cur);
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
  }
  return out;
}

/** The commit message as the REST API reports it (one trailing newline stripped). */
export function commitMessageForRest(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return '';
  const msg = parseCommit(obj.data).message;
  return msg.endsWith('\n') ? msg.slice(0, -1) : msg;
}

/** Path -> blob oid for every file under a tree (recursive). Cached per tree oid. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, string> {
  const cached = repo.flatTrees.get(treeOid);
  if (cached !== undefined) return cached;
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
      else if (e.mode !== '160000') out.set(`${prefix}${e.name}`, e.oid);
    }
  };
  walk(treeOid, '');
  repo.flatTrees.set(treeOid, out);
  return out;
}

/**
 * A new root tree with `path` (segments) set to `blobOid`, built on `baseTreeOid`
 * (null = empty tree). Intermediate trees are stored. Returns the new root tree oid.
 */
export function writeFileToTree(repo: Repo, baseTreeOid: string | null, segments: readonly string[], blobOid: string): string {
  const rec = (treeOid: string | null, depth: number): string => {
    const entries = new Map<string, TreeEntry>();
    if (treeOid !== null) {
      const obj = repo.objects.get(treeOid);
      if (obj !== undefined && obj.type === 'tree') {
        for (const e of parseTree(obj.data)) entries.set(e.name, e);
      }
    }
    const name = segments[depth];
    if (depth === segments.length - 1) {
      entries.set(name, { mode: '100644', name, oid: blobOid });
    } else {
      const child = entries.get(name);
      const childOid = rec(child !== undefined && child.mode === '40000' ? child.oid : null, depth + 1);
      entries.set(name, { mode: '40000', name, oid: childOid });
    }
    return putObject(repo, 'tree', buildTree([...entries.values()]));
  };
  return rec(baseTreeOid, 0);
}

/** A new root tree with `path` removed (null when the tree becomes empty). */
export function deleteFileFromTree(repo: Repo, baseTreeOid: string, segments: readonly string[]): string | null {
  const rec = (treeOid: string, depth: number): string | null => {
    const entries = new Map<string, TreeEntry>();
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return null;
    for (const e of parseTree(obj.data)) entries.set(e.name, e);
    const name = segments[depth];
    if (depth === segments.length - 1) {
      entries.delete(name);
    } else {
      const child = entries.get(name);
      if (child === undefined || child.mode !== '40000') return treeOid;
      const next = rec(child.oid, depth + 1);
      if (next === null) entries.delete(name);
      else entries.set(name, { mode: '40000', name, oid: next });
    }
    if (entries.size === 0) return null;
    return putObject(repo, 'tree', buildTree([...entries.values()]));
  };
  return rec(baseTreeOid, 0);
}

/** The subtree oid at `segments` under a tree, or null. */
export function subtreeAt(repo: Repo, treeOid: string, segments: readonly string[]): string | null {
  let cur = treeOid;
  for (const seg of segments) {
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === seg);
    if (entry === undefined || entry.mode !== '40000') return null;
    cur = entry.oid;
  }
  return cur;
}

/** Resolve a ref-ish (branch name, full ref, or commit oid) to a commit oid. */
export function resolveRefish(repo: Repo, refish: string): string | null {
  if (isOid(refish)) {
    const obj = repo.objects.get(refish);
    return obj !== undefined && obj.type === 'commit' ? refish : null;
  }
  if (refish.startsWith('refs/')) return repo.refs.get(refish) ?? null;
  return repo.refs.get(`refs/heads/${refish}`) ?? null;
}

/** Invalidate the git caches after a ref/object change. */
export function bumpVersion(repo: Repo): void {
  repo.version += 1;
  repo.cachedRepoJson = null;
}

/** Create a commit on `branch` writing one file; creates the branch when missing. */
export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; contentSha: string } {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  let parents: string[] = [];
  let baseTree: string | null = null;
  if (tip !== undefined) {
    parents = [tip];
    baseTree = commitTree(repo, tip);
  } else if (branch !== DEFAULT_BRANCH) {
    const defTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
    if (defTip !== undefined) {
      parents = [defTip];
      baseTree = commitTree(repo, defTip);
    }
  }
  const blobOid = putObject(repo, 'blob', content);
  const segments = path.split('/').filter((s) => s !== '');
  const treeOid = writeFileToTree(repo, baseTree, segments, blobOid);
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  const commitOid = putObject(repo, 'commit', buildCommit(treeOid, parents, msg));
  repo.refs.set(ref, commitOid);
  bumpVersion(repo);
  return { commitSha: commitOid, contentSha: blobOid };
}

/** Delete one file on `branch`; null when the file is not there. */
export function deleteFile(
  repo: Repo,
  branch: string,
  path: string,
  message: string,
): { commitSha: string } | null {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined) return null;
  const treeOid = commitTree(repo, tip);
  const segments = path.split('/').filter((s) => s !== '');
  const files = flattenTree(repo, treeOid);
  if (!files.has(segments.join('/'))) return null;
  const next = deleteFileFromTree(repo, treeOid, segments);
  const newTree = next ?? putObject(repo, 'tree', buildTree([]));
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  const commitOid = putObject(repo, 'commit', buildCommit(newTree, [tip], msg));
  repo.refs.set(ref, commitOid);
  bumpVersion(repo);
  return { commitSha: commitOid };
}

// ---------------------------------------------------------------------------
// issues / comments / pulls
// ---------------------------------------------------------------------------

export function issueJson(repo: Repo, issue: Issue): Buffer {
  if (issue.cached !== null) return issue.cached;
  const labels = issue.labels.map((n) => {
    const l = repo.labels.get(n);
    return { name: n, color: l !== undefined ? l.color : 'ededed' };
  });
  const buf = Buffer.from(
    JSON.stringify({ id: issue.gid, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels }),
    'utf8',
  );
  issue.cached = buf;
  return buf;
}

export function createIssue(
  repo: Repo,
  title: string,
  body: string,
  labels: readonly string[],
): { issue: Issue } | { badLabel: string } {
  for (const l of labels) {
    if (!repo.labels.has(l)) return { badLabel: l };
  }
  const number = repo.nextIssue;
  repo.nextIssue += 1;
  const issue: Issue = {
    number,
    title,
    body: body ?? '',
    state: 'open',
    labels: [...labels],
    gid: issueGid(repo.owner, repo.name, number),
    cached: null,
  };
  repo.issues.push(issue);
  return { issue };
}

export function getIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((i) => i.number === number);
}

export function addComment(repo: Repo, issueNumber: number, body: string): Comment {
  const id = repo.nextComment;
  repo.nextComment += 1;
  const comment: Comment = { id, body, gid: commentGid(repo.owner, repo.name, issueNumber, id) };
  let list = repo.comments.get(issueNumber);
  if (list === undefined) {
    list = [];
    repo.comments.set(issueNumber, list);
  }
  list.push(comment);
  return comment;
}

export function pullJson(repo: Repo, pr: Pull): Buffer {
  if (pr.cached !== null) return pr.cached;
  const buf = Buffer.from(
    JSON.stringify({
      id: pr.gid,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged: pr.merged,
      merged_at: pr.merged ? pr.mergedAt : null,
      merge_commit_sha: pr.merged ? pr.mergeSha : null,
      head: { ref: pr.head, sha: pr.headSha },
      base: { ref: pr.base, sha: pr.baseSha },
    }),
    'utf8',
  );
  pr.cached = buf;
  return buf;
}

export function createPull(
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): { pr: Pull } | { error: string } {
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined || baseTip === undefined) return { error: 'head or base branch not found' };
  for (const p of repo.pulls) {
    if (p.state === 'open' && p.head === head && p.base === base) return { error: 'a pull request is already open for this head and base' };
  }
  const number = repo.nextPull;
  repo.nextPull += 1;
  const pr: Pull = {
    number,
    title,
    body: body ?? '',
    head,
    base,
    headSha: headTip,
    baseSha: baseTip,
    state: 'open',
    merged: false,
    mergedAt: '',
    mergeSha: '',
    gid: pullGid(repo.owner, repo.name, number),
    cached: null,
  };
  repo.pulls.push(pr);
  return { pr };
}

export function getPull(repo: Repo, number: number): Pull | undefined {
  return repo.pulls.find((p) => p.number === number);
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) n += 1;
  if (data[data.length - 1] !== 0x0a) n += 1;
  return n;
}

/** A naive line diff: multiset difference of the two line sets. */
function lineDiff(oldData: Buffer, newData: Buffer): { add: number; del: number } {
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  const counts = new Map<string, number>();
  for (const l of oldLines) counts.set(l, (counts.get(l) ?? 0) + 1);
  let add = 0;
  for (const l of newLines) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else add += 1;
  }
  let del = 0;
  for (const c of counts.values()) del += c;
  return { add, del };
}

/** The file diff between two tree oids. */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): FileChange[] {
  const base = baseTree === '' ? new Map<string, string>() : flattenTree(repo, baseTree);
  const head = headTree === '' ? new Map<string, string>() : flattenTree(repo, headTree);
  const out: FileChange[] = [];
  for (const [path, oid] of head) {
    const b = base.get(path);
    if (b === undefined) {
      const obj = repo.objects.get(oid);
      const n = obj !== undefined ? countLines(obj.data) : 0;
      out.push({ filename: path, status: 'added', additions: n, deletions: 0, changes: n });
    } else if (b !== oid) {
      const oldObj = repo.objects.get(b);
      const newObj = repo.objects.get(oid);
      const d = lineDiff(oldObj !== undefined ? oldObj.data : Buffer.alloc(0), newObj !== undefined ? newObj.data : Buffer.alloc(0));
      out.push({ filename: path, status: 'modified', additions: d.add, deletions: d.del, changes: d.add + d.del });
    }
  }
  for (const [path, oid] of base) {
    if (!head.has(path)) {
      const obj = repo.objects.get(oid);
      const n = obj !== undefined ? countLines(obj.data) : 0;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: n, changes: n });
    }
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return out;
}

/** The PR's changed files, diffed from the live merge-base to the live head tip. */
export function prFiles(repo: Repo, pr: Pull): FileChange[] {
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  if (headTip === undefined || baseTip === undefined) return [];
  const mb = mergeBase(repo, headTip, baseTip);
  const baseTree = mb === null ? '' : commitTree(repo, mb);
  return diffTrees(repo, baseTree, commitTree(repo, headTip));
}

/** MERGEABLE / CONFLICTING / UNKNOWN for a pull request. */
export function prMergeable(repo: Repo, pr: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  if (pr.state !== 'open') return 'UNKNOWN';
  return prConflicts(repo, pr, headTip, baseTip) ? 'CONFLICTING' : 'MERGEABLE';
}

/** True when a file the PR changes was also changed on base since the merge-base, differently. */
function prConflicts(repo: Repo, pr: Pull, headTip: string, baseTip: string): boolean {
  const mb = mergeBase(repo, headTip, baseTip);
  if (mb === null) return false;
  const mbTree = commitTree(repo, mb);
  const prChanged = diffTrees(repo, mbTree, commitTree(repo, headTip));
  if (prChanged.length === 0) return false;
  const baseChanged = diffTrees(repo, mbTree, commitTree(repo, baseTip));
  const baseFiles = flattenTree(repo, commitTree(repo, baseTip));
  const mbFiles = flattenTree(repo, mbTree);
  for (const change of prChanged) {
    const onBase = baseChanged.find((c) => c.filename === change.filename);
    if (onBase === undefined) continue;
    const headOid = flattenTree(repo, commitTree(repo, headTip)).get(change.filename);
    const baseOid = baseFiles.get(change.filename);
    const mbOid = mbFiles.get(change.filename);
    if (headOid !== baseOid && baseOid !== mbOid) return true;
  }
  return false;
}

/** Squash-merge a pull request. Returns the merge sha, or an error key. */
export function mergePull(
  repo: Repo,
  number: number,
): { sha: string } | { error: 'not-found' | 'closed' | 'conflict' } {
  const pr = getPull(repo, number);
  if (pr === undefined) return { error: 'not-found' };
  if (pr.state !== 'open') return { error: 'closed' };
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  if (headTip === undefined || baseTip === undefined) return { error: 'not-found' };
  if (prConflicts(repo, pr, headTip, baseTip)) return { error: 'conflict' };
  const tree = commitTree(repo, headTip);
  const msg = `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}\n`;
  const mergeSha = putObject(repo, 'commit', buildCommit(tree, [baseTip], msg));
  repo.refs.set(`refs/heads/${pr.base}`, mergeSha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = trialNowIso();
  pr.mergeSha = mergeSha;
  pr.cached = null;
  bumpVersion(repo);
  return { sha: mergeSha };
}

// ---------------------------------------------------------------------------
// repo JSON (REST)
// ---------------------------------------------------------------------------

export function repoJson(repo: Repo): Buffer {
  if (repo.cachedRepoJson !== null) return repo.cachedRepoJson;
  const buf = Buffer.from(
    JSON.stringify({
      id: repo.gid,
      node_id: repo.gid,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
      private: repo.isPrivate,
      description: repo.description,
      default_branch: DEFAULT_BRANCH,
      databaseId: repo.databaseId,
    }),
    'utf8',
  );
  repo.cachedRepoJson = buf;
  return buf;
}
