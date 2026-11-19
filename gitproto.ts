// gitproto.ts — github-core-clone-01 v3 forge: git smart HTTP (protocol v0/v2).
//
// Written from scratch for the v3 perf rebuild. Packs are written without deltas
// (the suite's pack checks accept 0 deltas); packs are read with full OFS/REF
// delta resolution. The depth-1 clone pack for a repo tip is cached per version.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  DEFAULT_BRANCH,
  ZERO_OID,
  buildTree,
  bumpVersion,
  commitParents,
  commitTree,
  getObject,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTagTarget,
  parseTree,
  putObject,
  type ObjType,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.allocUnsafe(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Split a buffer into pkt-line packets; stops at the first malformed length. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.subarray(off, off + 4).toString('ascii');
    if (hex === '0000') {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (hex === '0001') {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (hex === '0002') {
      out.push({ kind: 'end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// pack read / write
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function readPackVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off];
    off += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start];
  let off = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[off];
    off += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: off };
}

function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(offset, end), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta stream to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off];
      off += 1;
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
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOff += delta[off] * 2 ** shift;
          off += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += delta[off] * 2 ** shift;
          off += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjType;
  resolved?: Buffer;
  oid?: string;
}

/**
 * Parse a packfile and resolve every object (OFS/REF deltas included).
 * `resolveBase` supplies a base a thin pack leaves out (an object the repo holds).
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => { type: ObjType; data: Buffer } | undefined,
): Map<string, { type: ObjType; data: Buffer }> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    const header = readPackVarint(pack, off);
    off = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, off);
      off = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (TYPE_CODE[typeCode] === undefined) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const inflated = inflateAt(pack, off, trailerStart);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, { type: ObjType; data: Buffer }>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const ext = resolveBase !== undefined ? resolveBase(wanted) : undefined;
        if (ext === undefined) throw new Error(`ref-delta base ${wanted} missing`);
        type = ext.type;
        data = applyDelta(ext.data, entry.data);
      }
    } else {
      type = TYPE_CODE[entry.typeCode];
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
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_NUM[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile (no deltas) from objects, deflate level 1, SHA-1 trailer. */
export function writePack(objects: ReadonlyArray<{ type: ObjType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    parts.push(packObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// ref listing (cached per repo version)
// ---------------------------------------------------------------------------

export interface ListedRef {
  name: string;
  oid: string;
  peeled: string;
}

export function listRefs(repo: Repo): ListedRef[] {
  if (repo.lsRefs !== null && repo.lsRefsVersion === repo.version) return repo.lsRefs;
  const out: ListedRef[] = [];
  const heads: string[] = [];
  const tags: string[] = [];
  for (const name of repo.refs.keys()) {
    if (name.startsWith('refs/heads/')) heads.push(name);
    else if (name.startsWith('refs/tags/')) tags.push(name);
  }
  heads.sort();
  tags.sort();
  for (const name of heads) {
    out.push({ name, oid: repo.refs.get(name)!, peeled: '' });
  }
  for (const name of tags) {
    const oid = repo.refs.get(name)!;
    let peeled = '';
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      const targetObj = repo.objects.get(target);
      if (targetObj !== undefined && targetObj.type === 'commit') peeled = target;
    }
    out.push({ name, oid, peeled });
  }
  repo.lsRefs = out;
  repo.lsRefsVersion = repo.version;
  return out;
}

function defaultTip(repo: Repo): string {
  return repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? '';
}

/** The v2 capability advertisement (cached per version). */
export function advertisementV2(repo: Repo): Buffer {
  if (repo.advV2 !== null && repo.advVersion === repo.version) return repo.advV2;
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  repo.advV2 = Buffer.concat(parts);
  repo.advVersion = repo.version;
  return repo.advV2;
}

const V0_UP_CAPS = 'side-band-64k multi_ack thin-pack ofs-delta shallow symref=HEAD:refs/heads/main';
const V0_RECV_CAPS = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';

/** The v0 upload-pack advertisement (cached per version). */
export function advertisementV0Upload(repo: Repo): Buffer {
  if (repo.advV0Up !== null && repo.advVersion === repo.version) return repo.advV0Up;
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${V0_UP_CAPS}\n`));
  } else {
    const tip = defaultTip(repo);
    parts.push(pktLine(`${tip === '' ? refs[0].oid : tip} HEAD\0${V0_UP_CAPS}\n`));
    for (const r of refs) parts.push(pktLine(`${r.oid} ${r.name}\n`));
  }
  parts.push(PKT_FLUSH);
  repo.advV0Up = Buffer.concat(parts);
  return repo.advV0Up;
}

/** The v0 receive-pack advertisement (cached per version). */
export function advertisementV0Receive(repo: Repo): Buffer {
  if (repo.advV0Recv !== null && repo.advVersion === repo.version) return repo.advV0Recv;
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${V0_RECV_CAPS}\n`));
  } else {
    const tip = defaultTip(repo);
    parts.push(pktLine(`${tip === '' ? refs[0].oid : tip} HEAD\0${V0_RECV_CAPS}\n`));
    for (const r of refs) parts.push(pktLine(`${r.oid} ${r.name}\n`));
  }
  parts.push(PKT_FLUSH);
  repo.advV0Recv = Buffer.concat(parts);
  return repo.advV0Recv;
}

// ---------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------

export interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Parse a v2 ls-refs request body. Returns null when it is not ls-refs. */
export function parseLsRefs(body: Buffer): LsRefsArgs | null {
  const packets = decodePktLines(body);
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let sawCommand = false;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'command=ls-refs') {
      sawCommand = true;
      continue;
    }
    if (!sawCommand) continue;
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return sawCommand ? args : null;
}

/** The v2 ls-refs answer for a repo. */
export function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const refs = listRefs(repo);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  } else {
    const tip = defaultTip(repo);
    const headOid = tip === '' ? refs[0].oid : tip;
    if (keep('HEAD')) {
      parts.push(pktLine(`${headOid} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
    for (const r of refs) {
      if (!keep(r.name)) continue;
      let line = `${r.oid} ${r.name}`;
      if (args.peel && r.peeled !== '') line += ` peeled:${r.peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// v2 fetch
// ---------------------------------------------------------------------------

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

/** Parse a v2 fetch request body. Returns null when it is not a fetch. */
export function parseFetch(body: Buffer): FetchArgs | null {
  const packets = decodePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  let sawCommand = false;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'command=fetch') {
      sawCommand = true;
      continue;
    }
    if (!sawCommand) continue;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) args.depth = Math.trunc(n);
    } else if (line === 'done') args.done = true;
  }
  return sawCommand ? args : null;
}

interface FetchPlan {
  /** Objects to send, in pack order. */
  objects: Array<{ type: ObjType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
}

/**
 * The object set a fetch delivers: reachable(wants) minus reachable(haves),
 * cut to `depth` generations when given. Generation 0 is the want commits;
 * a commit at generation depth-1 (its parents excluded) is a new shallow boundary.
 */
export function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const held = new Set<string>();
  // Held = reachable(haves), but never below a shallow boundary: the
  // client holds a shallow commit's content, not its parents.
  const shallowSet = new Set(args.shallow);
  {
    const stack = [...args.haves];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (held.has(cur)) continue;
      const obj = repo.objects.get(cur);
      if (obj === undefined) continue;
      held.add(cur);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        stack.push(info.tree);
        if (!shallowSet.has(cur)) {
          for (const p of info.parents) stack.push(p);
        }
      } else if (obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target !== '') stack.push(target);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) {
          if (e.mode !== '160000') stack.push(e.oid);
        }
      }
    }
  }

  const objects: Array<{ type: ObjType; data: Buffer }> = [];
  const seen = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const depth = args.depth;
  // BFS by commit generation; trees/blobs ride with their commit's generation.
  const queue: Array<{ oid: string; gen: number }> = args.wants
    .filter((w) => isOid(w))
    .map((w) => ({ oid: w, gen: 0 }));
  const addObject = (oid: string): void => {
    if (seen.has(oid) || held.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined) return;
    seen.add(oid);
    objects.push(obj);
  };
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      if (depth !== null && gen >= depth) continue;
      addObject(oid);
      const info = parseCommit(obj.data);
      addObject(info.tree);
      const treeObj = repo.objects.get(info.tree);
      if (treeObj !== undefined && treeObj.type === 'tree') {
        const walk = (treeOid: string): void => {
          for (const e of parseTree(repo.objects.get(treeOid)!.data)) {
            if (e.mode === '40000') {
              addObject(e.oid);
              walk(e.oid);
            } else if (e.mode !== '160000') {
              addObject(e.oid);
            }
          }
        };
        walk(info.tree);
      }
      if (depth !== null && gen === depth - 1) {
        shallow.push(oid);
      } else {
        for (const p of info.parents) queue.push({ oid: p, gen: gen + 1 });
      }
    } else if (obj.type === 'tag') {
      addObject(oid);
      const target = parseTagTarget(obj.data);
      if (target !== '') queue.push({ oid: target, gen });
    } else {
      addObject(oid);
    }
  }
  // A previously-shallow boundary is unshallow when its parent is now delivered.
  for (const s of args.shallow) {
    const obj = repo.objects.get(s);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = commitParents(repo, s);
    if (parents.some((p) => seen.has(p))) unshallow.push(s);
  }
  return { objects, shallow, unshallow };
}

/** The cached depth-1 pack for one tip (the clone workload's hot path). */
export function depth1Pack(repo: Repo, tip: string): Buffer {
  if (repo.clonePackVersion === repo.version) {
    const hit = repo.clonePack.get(tip);
    if (hit !== undefined) return hit;
  } else {
    repo.clonePack.clear();
    repo.clonePackVersion = repo.version;
  }
  const plan = planFetch(repo, { wants: [tip], haves: [], shallow: [], depth: 1, done: true });
  const pack = writePack(plan.objects);
  repo.clonePack.set(tip, pack);
  return pack;
}

/**
 * The v2 fetch answer. The acknowledgments section exists only for a
 * negotiation round (haves sent, no `done`): a final request goes straight
 * to shallow-info and the packfile, which is what git itself expects —
 * with `done` it skips the acknowledgments section entirely and reads the
 * packfile section header first.
 */
export function fetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  const negotiating = args.haves.length > 0 && !args.done;
  if (negotiating) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine(`ACK ${args.haves[0]}\n`));
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }

  // The clone hot path: depth 1, one want, no haves -> the cached pack.
  let pack: Buffer;
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (args.depth === 1 && args.haves.length === 0 && args.wants.length === 1 && isOid(args.wants[0])) {
    pack = depth1Pack(repo, args.wants[0]);
    shallow = [args.wants[0]];
  } else {
    const plan = planFetch(repo, args);
    pack = writePack(plan.objects);
    shallow = plan.shallow;
    unshallow = plan.unshallow;
  }
  if (args.depth !== null) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  // Sideband band 1, chunked under the pkt-line ceiling.
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([0x01]), slice]);
    parts.push(pktLine(payload));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// v0 receive-pack
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportEntry {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Parse a receive-pack body: pkt-line commands up to the flush, then the pack.
 * Returns null when the body is not a command list at all.
 */
export function parsePush(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } | null {
  const packets = decodePktLines(body);
  const commands: PushCommand[] = [];
  let i = 0;
  let packStart = body.length;
  for (; i < packets.length; i += 1) {
    const p = packets[i];
    if (p.kind === 'flush') {
      // The pack starts right after this flush packet's 4 bytes.
      let off = 0;
      for (let j = 0; j <= i; j += 1) {
        const q = packets[j];
        off += q.kind === 'data' ? 4 + q.payload.length : 4;
      }
      packStart = off;
      break;
    }
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3 || !isOid(parts[0]) || !isOid(parts[1]) || !parts[2].startsWith('refs/')) {
      return null;
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) return null;
  const pack = packStart < body.length ? body.subarray(packStart) : null;
  return { commands, pack };
}

/**
 * Apply a push: store the pack's objects, validate fast-forward per ref, apply
 * the ok refs, and build the report-status stream (inner pkt-lines).
 */
export function applyPush(repo: Repo, commands: PushCommand[], pack: Buffer | null): { unpackOk: boolean; unpackDetail: string; refs: PushReportEntry[] } {
  const report: PushReportEntry[] = [];
  if (pack !== null && pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => {
        const o = repo.objects.get(oid);
        return o === undefined ? undefined : { type: o.type, data: o.data };
      });
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) {
          repo.objects.set(oid, { type: obj.type, data: obj.data });
          if (obj.type === 'commit') {
            const info = parseCommit(obj.data);
            repo.parents.set(oid, info.parents);
            repo.trees.set(oid, info.tree);
          }
        }
      }
    } catch (err) {
      for (const c of commands) report.push({ ref: c.ref, ok: false, reason: 'unpack failed' });
      return { unpackOk: false, unpackDetail: err instanceof Error ? err.message : 'unpack failed', refs: report };
    }
  }
  let changed = false;
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    if (cmd.oldOid !== current) {
      report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // delete
      repo.refs.delete(cmd.ref);
      changed = true;
      report.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    const newObj = repo.objects.get(cmd.newOid);
    if (newObj === undefined) {
      report.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current !== ZERO_OID && !cmd.ref.startsWith('refs/tags/')) {
      // fast-forward: the new commit's ancestry must contain the current tip.
      if (newObj.type !== 'commit' || !isAncestor(repo, current, cmd.newOid)) {
        report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    changed = true;
    report.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  if (changed) bumpVersion(repo);
  return { unpackOk: true, unpackDetail: 'ok', refs: report };
}

/** The receive-pack answer: report-status inside sideband band 1. */
export function pushResponse(result: { unpackOk: boolean; unpackDetail: string; refs: PushReportEntry[] }): Buffer {
  const inner: Buffer[] = [pktLine(`unpack ${result.unpackOk ? 'ok' : result.unpackDetail}\n`)];
  for (const r of result.refs) {
    inner.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  }
  inner.push(PKT_FLUSH);
  const innerBuf = Buffer.concat(inner);
  const parts: Buffer[] = [];
  for (let off = 0; off < innerBuf.length; off += 65515) {
    const slice = innerBuf.subarray(off, Math.min(innerBuf.length, off + 65515));
    parts.push(pktLine(Buffer.concat([Buffer.from([0x01]), slice])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A pack with zero objects (the nothing-new fetch). */
export function emptyPack(): Buffer {
  return writePack([]);
}

export { buildTree };
