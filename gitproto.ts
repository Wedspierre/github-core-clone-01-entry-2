// gitproto.ts — git smart HTTP: protocol v2 upload-pack, v0 upload-pack and
// receive-pack, over pkt-lines and sideband-64k, speaking the exact wire the suite's
// git client drives (see the kit's program/env/src/git-client.ts for the client side).

import {
  ZERO_OID,
  collectReachable,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(total.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a pkt-line stream into packets. Throws on a malformed length. */
export function decodePktLines(bytes: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** The text lines of a pkt-line stream's data packets (delim/flush split sections). */
export function pktSections(bytes: Buffer): string[][] {
  const sections: string[][] = [[]];
  for (const packet of decodePktLines(bytes)) {
    if (packet.kind === 'data') sections[sections.length - 1]!.push(packet.payload.toString('utf8'));
    else if (packet.kind === 'delim' || packet.kind === 'flush') sections.push([]);
  }
  return sections;
}

/** The ref a tag object peels to (its target commit), or the oid itself. */
function peelOid(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (object && object.type === 'tag') {
    const target = parseTag(object.data).object;
    if (isOid(target)) return peelOid(repo, target);
  }
  return oid;
}

/** Refs sorted by name, with HEAD first when it resolves. */
export function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const name of [...repo.refs.keys()].sort()) out.push({ name, oid: repo.refs.get(name)! });
  return out;
}

const AGENT = 'github-core-clone/1.0';

/** The v0 ref advertisement body for a service. */
export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headLine = headTip !== undefined ? `${headTip} HEAD\0${caps}\n` : null;
    if (headLine !== null) lines.push(headLine);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peelOid(repo, ref.oid);
        if (peeled !== ref.oid) lines.push(`${peeled} ${ref.name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

/** The protocol v2 capability advertisement body for upload-pack. */
export function advertiseV2(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

/** One sideband packet: band 1 is pack data, band 2 progress, band 3 an error. */
export function sideband(band: 1 | 2 | 3, data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return pktLine(Buffer.concat([Buffer.from([band]), body]));
}

/** Split a buffer into sideband-64k packets (at most 65520 bytes a pkt-line). */
export function sidebandChunks(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const max = 65520 - 4 - 1;
  for (let offset = 0; offset < data.length; offset += max) {
    out.push(sideband(band, data.subarray(offset, Math.min(data.length, offset + max))));
  }
  if (data.length === 0) out.push(sideband(band, Buffer.alloc(0)));
  return out;
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------------------------

export interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Parse a v2 ls-refs request body into its arguments. */
export function parseLsRefs(body: Buffer): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const section of pktSections(body)) {
    for (const line of section) {
      const text = line.replace(/\n$/, '');
      if (text === 'peel') args.peel = true;
      else if (text === 'symrefs') args.symrefs = true;
      else if (text === 'unborn') args.unborn = true;
      else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
    }
  }
  return args;
}

/** Answer a v2 ls-refs command. */
export function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const lines: Array<string | 'flush'> = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  // HEAD is returned when no prefix is given, or when a prefix matches it —
  // real git sends `ref-prefix HEAD` precisely to learn the symref target.
  const wantHead = args.prefixes.length === 0 || args.prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (wantHead) {
    if (headTip !== undefined) {
      lines.push(`${headTip} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.name.startsWith('refs/tags/')) {
      const peeled = peelOid(repo, ref.oid);
      if (peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return pktLines(lines);
}

// ---------------------------------------------------------------------------------------------
// fetch (upload-pack)
// ---------------------------------------------------------------------------------------------

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  filter: string | null;
  /** The client sent `done`, ending have negotiation. */
  done: boolean;
}

/** Parse a v2 fetch request body. */
export function parseFetchV2(body: Buffer): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, filter: null, done: false };
  for (const section of pktSections(body)) {
    for (const line of section) {
      const text = line.replace(/\n$/, '');
      if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) args.deepen = Number(text.slice(7).trim());
      else if (text.startsWith('filter ')) args.filter = text.slice(7).trim();
      else if (text === 'done') args.done = true;
    }
  }
  return args;
}

/** Parse a v0 fetch request body (two sections: wants, then haves). */
export function parseFetchV0(body: Buffer): FetchArgs {
  return parseFetchV2(body);
}

interface FetchPlan {
  /** Objects to send, in pack order. */
  objects: GitObject[];
  /** Commits that stay shallow boundaries after this fetch. */
  shallow: string[];
  /** Formerly shallow commits whose parents are now all present. */
  unshallow: string[];
}

/**
 * The objects a shallow client actually holds: the closure of its haves, cut at its
 * shallow boundaries — a boundary commit's tree and blobs are held, its parents are not.
 */
function heldObjects(repo: Repo, haves: Set<string>, shallow: Set<string>): Set<string> {
  const held = new Set<string>();
  const walk = (oid: string): void => {
    if (held.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object) return;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      walk(commit.tree);
      if (!shallow.has(oid)) {
        for (const parent of commit.parents) walk(parent);
      }
    } else if (object.type === 'tag') {
      walk(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') walk(entry.oid);
      }
    }
  };
  for (const have of haves) walk(have);
  return held;
}

/**
 * Work out what a fetch sends. `wants` are the tips, `haves` what the client holds,
 * `oldShallow` the client's current shallow boundaries, `deepen` the depth limit when set.
 *
 * Without deepen: reachable(wants) minus reachable(haves). With deepen D and no old
 * boundary: commits within D generations of a want (the want itself is generation 0);
 * the deepest sent commits stay shallow. With an old boundary S: the client may extend
 * D-1 generations below each boundary commit, and the new tips themselves are sent.
 */
export function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const commitParents = (oid: string): string[] => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return [];
    return parseCommit(object.data).parents;
  };
  const wantSet = new Set(args.wants.filter((oid) => isOid(oid) && repo.objects.has(oid)));
  const haveSet = new Set(args.haves.filter((oid) => isOid(oid)));
  const oldShallow = new Set(args.shallow.filter((oid) => isOid(oid)));

  const sendCommits = new Set<string>();
  let shallow: string[] = [];
  let unshallow: string[] = [];

  if (args.deepen === null) {
    // Full fetch minus what the client holds.
    let haveReachable: Set<string>;
    try {
      haveReachable = collectReachable(haveSet, lookup);
    } catch {
      haveReachable = new Set();
    }
    for (const want of wantSet) {
      for (const oid of collectReachable([want], lookup)) {
        if (!haveReachable.has(oid)) sendCommits.add(oid);
      }
    }
    // Include the wanted commits' trees/blobs even when the want itself is held:
    // collectReachable already covers that (a held want contributes nothing new).
  } else {
    const depthLimit = Math.max(1, Math.trunc(args.deepen));
    if (oldShallow.size === 0) {
      // Fresh shallow fetch: BFS from the wants, depth 0 is the want itself.
      const depth = new Map<string, number>();
      const queue: string[] = [...wantSet];
      for (const want of wantSet) depth.set(want, 0);
      while (queue.length > 0) {
        const oid = queue.shift()!;
        const d = depth.get(oid)!;
        sendCommits.add(oid);
        if (d + 1 < depthLimit) {
          for (const parent of commitParents(oid)) {
            if (!depth.has(parent)) {
              depth.set(parent, d + 1);
              queue.push(parent);
            }
          }
        }
      }
      // The boundary is every sent commit at the deepest layer.
      for (const oid of sendCommits) {
        if ((depth.get(oid) ?? 0) === depthLimit - 1) shallow.push(oid);
      }
    } else {
      // Extending a shallow clone: the client holds the closure of its haves cut
      // at its shallow boundaries, so "held" is that cut closure, not the full
      // reachable set — a boundary's parents are absent on the client.
      const held = heldObjects(repo, haveSet, oldShallow);
      // Commit distances from the wants (0 = a want itself).
      const distance = new Map<string, number>();
      const queue: string[] = [...wantSet];
      for (const want of wantSet) distance.set(want, 0);
      while (queue.length > 0) {
        const oid = queue.shift()!;
        const d = distance.get(oid)!;
        for (const parent of commitParents(oid)) {
          if (!distance.has(parent)) {
            distance.set(parent, d + 1);
            queue.push(parent);
          }
        }
      }
      // The extension zone: up to depthLimit-1 generations below each old boundary.
      const zone = new Set<string>();
      for (const boundary of oldShallow) {
        let frontier = [boundary];
        for (let step = 0; step < depthLimit - 1; step += 1) {
          const next: string[] = [];
          for (const oid of frontier) {
            for (const parent of commitParents(oid)) {
              if (!zone.has(parent)) {
                zone.add(parent);
                next.push(parent);
              }
            }
          }
          frontier = next;
        }
      }
      // Send commits within the depth limit that the client does not hold, plus the
      // extension zone.
      for (const [oid, d] of distance) {
        if (d < depthLimit && !held.has(oid)) sendCommits.add(oid);
      }
      for (const oid of zone) {
        if (!held.has(oid)) sendCommits.add(oid);
      }
      const present = (oid: string): boolean => sendCommits.has(oid) || held.has(oid);
      // A boundary is unshallowed when all its parents are now present.
      for (const boundary of oldShallow) {
        const parents = commitParents(boundary);
        if (parents.length > 0 && parents.every((parent) => sendCommits.has(parent) || held.has(parent))) {
          if (parents.some((parent) => sendCommits.has(parent))) unshallow.push(boundary);
        }
      }
      // A sent commit stays a shallow boundary when some parent is still absent.
      for (const oid of sendCommits) {
        const parents = commitParents(oid);
        if (parents.length > 0 && !parents.every(present)) shallow.push(oid);
      }
      // Old boundaries that are still boundaries stay shallow.
      for (const boundary of oldShallow) {
        if (unshallow.includes(boundary)) continue;
        const parents = commitParents(boundary);
        if (parents.length > 0 && !parents.every(present)) {
          if (!shallow.includes(boundary)) shallow.push(boundary);
        }
      }
    }
  }

  // Expand the sent commits into their full object closure, but only the objects the
  // client does not already hold (for the non-deepened case) — for deepened fetches the
  // closure of the sent commits, minus objects reachable from held commits that are
  // not part of the extension zone.
  const objects = new Map<string, GitObject>();
  const addClosure = (root: string): void => {
    for (const oid of collectReachable([root], lookup)) {
      const object = repo.objects.get(oid);
      if (object && !objects.has(oid)) objects.set(oid, object);
    }
  };
  if (args.deepen === null) {
    let haveReachable: Set<string>;
    try {
      haveReachable = collectReachable(haveSet, lookup);
    } catch {
      haveReachable = new Set();
    }
    for (const oid of sendCommits) {
      if (haveReachable.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object && !objects.has(oid)) objects.set(oid, object);
    }
  } else {
    // A deepened fetch sends the closure of each sent commit, following only
    // parents that were sent too — never the cut history below a boundary.
    const include = (oid: string): void => {
      if (objects.has(oid)) return;
      const object = repo.objects.get(oid);
      if (!object) return;
      objects.set(oid, object);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        include(commit.tree);
        for (const parent of commit.parents) {
          if (sendCommits.has(parent)) include(parent);
        }
      } else if (object.type === 'tag') {
        include(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') include(entry.oid);
        }
      }
    };
    for (const oid of sendCommits) include(oid);
  }

  return { objects: [...objects.values()], shallow, unshallow };
}

/** Build a pack of the planned objects, ordered deterministically (commits, trees, blobs). */
export function packOf(objects: GitObject[]): Buffer {
  const order = { commit: 0, tree: 1, blob: 2, tag: 3 };
  const sorted = [...objects].sort((a, b) => {
    const byType = order[a.type] - order[b.type];
    if (byType !== 0) return byType;
    return 0;
  });
  return writePack(sorted);
}

/** Answer a v2 fetch command. */
export function fetchV2Response(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  // The acknowledgments section only exists when the client sent at least one
  // `have` line; with no haves real git goes straight to the packfile section.
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    // This server never ACKs a have, so negotiation is finished as soon as the
    // client sent its haves: `ready` tells real git to read the packfile instead
    // of waiting to send more haves. (The client sends `done` only after the
    // acknowledgments, so waiting for it would deadlock the exchange.)
    parts.push(pktLine('ready\n'));
    parts.push(pktDelim());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  const pack = packOf(plan.objects);
  parts.push(...sidebandChunks(1, pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Answer a v0 fetch command (NAK, shallow lines, then the sideband pack). */
export function fetchV0Response(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = packOf(plan.objects);
  parts.push(...sidebandChunks(1, pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/** Parse a receive-pack request body into commands and the pack that follows them. */
export function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  // The command list is pkt-lines terminated by a flush; the pack follows raw.
  let offset = 0;
  const commands: PushCommand[] = [];
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line in push');
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('bad pkt-line length in push');
    const length = parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('truncated pkt-line in push');
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const nul = payload.indexOf('\0');
    const text = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
    const parts = text.split(' ');
    if (parts.length !== 3) throw new Error(`bad push command ${JSON.stringify(text.slice(0, 60))}`);
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  const pack = offset < body.length ? body.subarray(offset) : null;
  return { commands, pack };
}

/**
 * Apply a push to a repo: unpack the pack, then apply each command with a fast-forward
 * check. Returns the report lines in command order.
 */
export function applyPush(
  store: Store,
  repo: Repo,
  commands: PushCommand[],
  pack: Buffer | null,
): { unpackOk: boolean; unpackDetail: string; refs: PushReportLine[] } {
  if (pack !== null && pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
      for (const oid of objects.keys()) {
        const object = repo.objects.get(oid);
        if (object?.type === 'commit') store.noteCommit(repo, oid);
      }
    } catch (err) {
      return { unpackOk: false, unpackDetail: err instanceof Error ? err.message : String(err), refs: [] };
    }
  }
  const lines: PushReportLine[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // A delete.
      if (current === undefined) {
        lines.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        lines.push({ ref: command.ref, ok: false, reason: 'old oid mismatch' });
      } else {
        repo.refs.delete(command.ref);
        lines.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      lines.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        lines.push({ ref: command.ref, ok: false, reason: 'old oid mismatch' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      if (target.type === 'commit') store.noteCommit(repo, command.newOid);
      lines.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      lines.push({ ref: command.ref, ok: false, reason: 'old oid mismatch' });
      continue;
    }
    if (target.type === 'commit' && !store.isAncestor(repo, current, command.newOid)) {
      lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    if (target.type === 'commit') store.noteCommit(repo, command.newOid);
    lines.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { unpackOk: true, unpackDetail: 'ok', refs: lines };
}

/** The report-status stream (inside sideband band 1) for a push result. */
export function pushReportResponse(result: { unpackOk: boolean; unpackDetail: string; refs: PushReportLine[] }): Buffer {
  const lines: Array<string | 'flush'> = [];
  lines.push(`unpack ${result.unpackOk ? 'ok' : result.unpackDetail}\n`);
  for (const line of result.refs) {
    lines.push(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`);
  }
  lines.push('flush');
  const report = pktLines(lines);
  const parts: Buffer[] = [...sidebandChunks(1, report), pktFlush()];
  return Buffer.concat(parts);
}

/** Parse a v2 request body that starts with `command=<name>`. */
export function v2Command(body: Buffer): string | null {
  for (const section of pktSections(body)) {
    for (const line of section) {
      const text = line.replace(/\n$/, '');
      if (text.startsWith('command=')) return text.slice('command='.length);
    }
    break;
  }
  return null;
}
