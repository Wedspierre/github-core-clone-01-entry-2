// store.ts — the forge's own store: git objects, refs, repositories, issues and pull
// requests, plus the deterministic clock every timestamp in the store derives from.
//
// Everything here is in-memory and deterministic: ids and timestamps come from counters
// seeded by MAKEFUN_TRIAL_NOW (or a fixed epoch when it is absent), never from the wall
// clock or Math.random, so two runs on the same instance reach the same state.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

/** The viewer the trial's token names (the suite's fixed scenario identity). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});
/** The stranger login: a repository under this owner is never the viewer's. */
export const STRANGER_LOGIN = 'olgabauer';
/** The default branch every repository starts on. */
export const DEFAULT_BRANCH = 'main';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjectType, data: Buffer | Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** Parse a tree object into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes. */
export function buildCommit(tree: string, parents: string[], message: string, who: string, timestamp: number): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who} ${timestamp} +0000`, `committer ${who} ${timestamp} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

/** Build an annotated tag object's bytes. */
export function buildTag(object: string, type: string, tag: string, message: string, who: string, timestamp: number): Buffer {
  return Buffer.from(`object ${object}\ntype ${type}\ntag ${tag}\ntagger ${who} ${timestamp} +0000\n\n${message}`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  const first = byte;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjectType;
  resolved?: Buffer;
  oid?: string;
}

/** Read a packfile, resolving OFS_DELTA and REF_DELTA entries. Thin packs resolve bases via `lookup`. */
export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = lookup?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  const objects = new Map<string, GitObject>();
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function writePackObjectHeader(type: ObjectType, size: number): Buffer {
  const typeCode = TYPE_CODE[type];
  const first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  const bytes: number[] = [size === 0 ? first : first | 0x80];
  while (size !== 0) {
    const byte = size & 0x7f;
    size >>= 7;
    bytes.push(size === 0 ? byte : byte | 0x80);
  }
  return Buffer.from(bytes);
}

/** Write a packfile (version 2, no deltas) holding the given objects. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------------------------
// reachability and trees
// ---------------------------------------------------------------------------------------------

/** Every object reachable from `roots` (commit -> tree + parents, tag -> target, tree -> entries). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Flatten a tree (recursively) into path -> blob oid. */
export function flattenTree(
  treeOid: string,
  lookup: (oid: string) => GitObject | undefined,
  prefix = '',
  out: Map<string, string> = new Map(),
): Map<string, string> {
  const object = lookup(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.oid, lookup, path, out);
    else if (entry.mode !== '160000') out.set(path, entry.oid);
  }
  return out;
}

/** Build the tree objects for a path -> blob map, returning the root tree oid. */
export function buildTreeFromFiles(
  files: Map<string, string>,
  put: (type: ObjectType, data: Buffer) => string,
): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

/** A line-count diff between two blob contents, as {additions, deletions}. */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const countLines = (data: Buffer | null): Map<string, number> => {
    const counts = new Map<string, number>();
    if (data === null) return counts;
    for (const line of data.toString('utf8').split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const oldLines = countLines(oldData);
  const newLines = countLines(newData);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newLines) additions += Math.max(0, count - (oldLines.get(line) ?? 0));
  for (const [line, count] of oldLines) deletions += Math.max(0, count - (newLines.get(line) ?? 0));
  return { additions, deletions };
}

// ---------------------------------------------------------------------------------------------
// the store's records
// ---------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  seq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  /** commit oid -> generation (depth from the root), for O(1)-ish fast-forward checks. */
  depth: Map<string, number>;
  labels: Map<string, Label>;
  issues: Issue[];
  issuesByNumber: Map<number, Issue>;
  pulls: PullRequest[];
  pullsByNumber: Map<number, PullRequest>;
  comments: Map<number, Comment[]>;
  /** next shared issue/pull-request number. */
  nextNumber: number;
  nextCommentId: number;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

/** Deterministic time: a base instant plus one second per stamp handed out. */
export class Clock {
  private readonly baseMs: number;
  private ticks = 0;

  constructor() {
    const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = raw === '' ? NaN : Date.parse(raw);
    this.baseMs = Number.isFinite(parsed) ? parsed : Date.parse('2025-01-01T00:00:00Z');
  }

  /** The next timestamp, ISO 8601 UTC. */
  stamp(): string {
    this.ticks += 1;
    return new Date(this.baseMs + this.ticks * 1000).toISOString().replace('.000Z', 'Z');
  }

  /** The next timestamp as Unix seconds (for commit objects). */
  stampSec(): number {
    this.ticks += 1;
    return Math.floor(this.baseMs / 1000) + this.ticks;
  }
}

export class Store {
  readonly clock = new Clock();
  readonly repos = new Map<string, Repo>();
  /** creation order, for GET /user/repos. */
  readonly repoList: Repo[] = [];
  private nextRepoId = 1;
  private nextGlobalId = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const now = this.clock.stamp();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER.login,
      private: isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      depth: new Map(),
      labels: new Map(),
      issues: [],
      issuesByNumber: new Map(),
      pulls: [],
      pullsByNumber: new Map(),
      comments: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      createdAt: now,
      updatedAt: now,
      seq: this.nextGlobalId++,
    };
    this.repos.set(this.repoKey(repo.owner, name), repo);
    this.repoList.push(repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    const index = this.repoList.indexOf(repo);
    if (index >= 0) this.repoList.splice(index, 1);
  }

  /** Store one object, returning its id. */
  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  objectOf(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refOf(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** The tip of a branch (or a full ref) by name; accepts a branch name, a ref or a raw oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (isOid(ref)) return repo.objects.has(ref) ? ref : undefined;
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    return repo.refs.get(`refs/heads/${ref}`);
  }

  /** Record a commit's generation, from its parents' generations. */
  noteCommit(repo: Repo, oid: string): void {
    if (repo.depth.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return;
    let depth = 0;
    for (const parent of parseCommit(object.data).parents) {
      this.noteCommit(repo, parent);
      depth = Math.max(depth, (repo.depth.get(parent) ?? 0) + 1);
    }
    repo.depth.set(oid, depth);
  }

  /** True when `ancestor` is an ancestor of (or equal to) `oid`, walking parents. */
  isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    const aDepth = repo.depth.get(ancestor);
    const oDepth = repo.depth.get(oid);
    if (aDepth === undefined || oDepth === undefined || oDepth < aDepth) return false;
    let current = oid;
    let steps = oDepth - aDepth;
    while (steps > 0) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'commit') return false;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0) return false;
      current = parents[0]!;
      steps -= 1;
      if (current === ancestor) return true;
    }
    // Same depth but possibly a different first-parent line (merges): walk the full ancestry.
    if (current === ancestor) return true;
    const seen = new Set<string>([oid]);
    const queue = [oid];
    while (queue.length > 0) {
      const next = queue.pop()!;
      const object = repo.objects.get(next);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return false;
  }

  /** The commit at a branch tip, or undefined when the branch is unborn. */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** A commit on `branch` whose tree is `files` applied over the branch's current tree. */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; contentSha: string } {
    const blobSha = this.putObject(repo, 'blob', content);
    const tip = this.branchTip(repo, branch);
    const files = new Map<string, string>();
    if (tip !== undefined) {
      const commit = parseCommit(repo.objects.get(tip)!.data);
      for (const [filePath, oid] of flattenTree(commit.tree, (oid) => repo.objects.get(oid))) files.set(filePath, oid);
    }
    files.set(path, blobSha);
    const treeSha = buildTreeFromFiles(files, (type, data) => this.putObject(repo, type, data));
    const who = `${VIEWER.name} <${VIEWER.email}>`;
    const commitData = buildCommit(treeSha, tip === undefined ? [] : [tip], message.endsWith('\n') ? message : `${message}\n`, who, this.clock.stampSec());
    const commitSha = this.putObject(repo, 'commit', commitData);
    this.noteCommit(repo, commitSha);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.updatedAt = this.clock.stamp();
    return { commitSha, contentSha: blobSha };
  }

  /** Delete `path` from `branch` with a commit; null when the file is not there. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return null;
    const commit = parseCommit(repo.objects.get(tip)!.data);
    const files = flattenTree(commit.tree, (oid) => repo.objects.get(oid));
    if (!files.has(path)) return null;
    files.delete(path);
    const treeSha = buildTreeFromFiles(files, (type, data) => this.putObject(repo, type, data));
    const who = `${VIEWER.name} <${VIEWER.email}>`;
    const commitData = buildCommit(treeSha, [tip], message.endsWith('\n') ? message : `${message}\n`, who, this.clock.stampSec());
    const commitSha = this.putObject(repo, 'commit', commitData);
    this.noteCommit(repo, commitSha);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.updatedAt = this.clock.stamp();
    return commitSha;
  }

  /** All commits reachable from `tip`, newest first (parents after their children). */
  listCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const now = this.clock.stamp();
    const issue: Issue = {
      id: repo.id * 1000000 + repo.nextNumber,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: now,
      updatedAt: now,
      seq: this.nextGlobalId++,
    };
    repo.issues.push(issue);
    repo.issuesByNumber.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment {
    const comment: Comment = { id: repo.nextCommentId++, body, createdAt: this.clock.stamp(), seq: this.nextGlobalId++ };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string, headSha: string, baseSha: string): PullRequest {
    const now = this.clock.stamp();
    const pull: PullRequest = {
      id: repo.id * 1000000 + repo.nextNumber,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      createdAt: now,
      updatedAt: now,
      seq: this.nextGlobalId++,
    };
    repo.pulls.push(pull);
    repo.pullsByNumber.set(pull.number, pull);
    return pull;
  }

  /** The files changed between the base tip and the head tip of a pull request. */
  pullFiles(repo: Repo, pull: PullRequest): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseCommit = repo.objects.get(pull.baseSha);
    const headCommit = repo.objects.get(pull.headSha);
    const baseFiles = baseCommit ? flattenTree(parseCommit(baseCommit.data).tree, (oid) => repo.objects.get(oid)) : new Map<string, string>();
    const headFiles = headCommit ? flattenTree(parseCommit(headCommit.data).tree, (oid) => repo.objects.get(oid)) : new Map<string, string>();
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const baseOid = baseFiles.get(path);
      const headOid = headFiles.get(path);
      if (baseOid === headOid) continue;
      const oldData = baseOid === undefined ? null : repo.objects.get(baseOid)?.data ?? null;
      const newData = headOid === undefined ? null : repo.objects.get(headOid)?.data ?? null;
      const { additions, deletions } = lineDiff(oldData, newData);
      out.push({
        filename: path,
        status: baseOid === undefined ? 'added' : headOid === undefined ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return out;
  }

  /** True when merging `pull` would conflict with the default branch's current tip. */
  pullConflicts(repo: Repo, pull: PullRequest): boolean {
    const baseCommit = repo.objects.get(pull.baseSha);
    const headCommit = repo.objects.get(pull.headSha);
    const defaultTip = this.branchTip(repo, pull.baseRef);
    if (!baseCommit || !headCommit || defaultTip === undefined) return false;
    if (defaultTip === pull.baseSha) return false;
    const defaultCommit = repo.objects.get(defaultTip);
    if (!defaultCommit) return false;
    const baseFiles = flattenTree(parseCommit(baseCommit.data).tree, (oid) => repo.objects.get(oid));
    const headFiles = flattenTree(parseCommit(headCommit.data).tree, (oid) => repo.objects.get(oid));
    const defaultFiles = flattenTree(parseCommit(defaultCommit.data).tree, (oid) => repo.objects.get(oid));
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const bv = baseFiles.get(path);
      const hv = headFiles.get(path);
      if (bv === hv) continue;
      const dv = defaultFiles.get(path);
      if (dv !== bv && dv !== hv) return true;
    }
    return false;
  }

  /** Squash-merge `pull` onto its base branch; returns the merge commit sha, or null on conflict. */
  mergePull(repo: Repo, pull: PullRequest): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    if (this.pullConflicts(repo, pull)) return null;
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (baseTip === undefined) return null;
    const headCommit = repo.objects.get(pull.headSha);
    if (!headCommit) return null;
    const tree = parseCommit(headCommit.data).tree;
    const who = `${VIEWER.name} <${VIEWER.email}>`;
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    const commitData = buildCommit(tree, [baseTip], message, who, this.clock.stampSec());
    const commitSha = this.putObject(repo, 'commit', commitData);
    this.noteCommit(repo, commitSha);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.clock.stamp();
    pull.mergeCommitSha = commitSha;
    pull.updatedAt = pull.mergedAt;
    repo.updatedAt = pull.mergedAt;
    return commitSha;
  }
}

/** Opaque, stable global ids (never the plain database id or number). */
export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`repo:${repo.id}`, 'utf8').toString('base64url');
}

export function issueGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`issue:${repo.id}:${number}`, 'utf8').toString('base64url');
}

export function pullGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`pull:${repo.id}:${number}`, 'utf8').toString('base64url');
}

export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return Buffer.from(`comment:${repo.id}:${issueNumber}:${commentId}`, 'utf8').toString('base64url');
}

/** Decode a global id back to its kind and parts; null when it is not one of ours. */
export function decodeGlobalId(id: string): { kind: string; repoId: number; number: number; extra: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0]!;
    const repoId = Number(parts[1]);
    if (!Number.isSafeInteger(repoId) || repoId <= 0) return null;
    if (kind === 'repo' && parts.length === 2) return { kind, repoId, number: 0, extra: 0 };
    if ((kind === 'issue' || kind === 'pull') && parts.length === 3) {
      const number = Number(parts[2]);
      if (!Number.isSafeInteger(number) || number <= 0) return null;
      return { kind, repoId, number, extra: 0 };
    }
    if (kind === 'comment' && parts.length === 4) {
      const number = Number(parts[2]);
      const extra = Number(parts[3]);
      if (!Number.isSafeInteger(number) || !Number.isSafeInteger(extra)) return null;
      return { kind, repoId, number, extra };
    }
    return null;
  } catch {
    return null;
  }
}
