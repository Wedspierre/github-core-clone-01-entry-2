// graphql.ts — github-core-clone-01 v3 forge: GraphQL v4 endpoint.
//
// Written from scratch for the v3 perf rebuild. A small parser for the exact
// documents the suite sends (query/mutation, variables, inline fragments,
// __type introspection, batched arrays) and an executor over the store.

import {
  DEFAULT_BRANCH,
  VIEWER_LOGIN,
  addComment,
  commitTree,
  createIssue,
  createPull,
  decodeGid,
  diffTrees,
  getIssue,
  getPull,
  getRepo,
  mergeBase,
  mergePull,
  prMergeable,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

export interface GqlField {
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  children: GqlField[];
  /** Inline fragment type condition (`... on Repository`), or null. */
  fragmentOn: string | null;
}

export interface GqlOperation {
  kind: 'query' | 'mutation';
  fields: GqlField[];
}

type Token =
  | { t: 'name'; v: string }
  | { t: 'string'; v: string }
  | { t: 'int'; v: number }
  | { t: 'var'; v: string }
  | { t: 'punct'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '"' ? '"' : e === '\\' ? '\\' : e;
          j += 2;
        } else {
          s += src[j];
          j += 1;
        }
      }
      out.push({ t: 'string', v: s });
      i = j + 1;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      out.push({ t: 'var', v: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      out.push({ t: 'int', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      out.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      out.push({ t: 'punct', v: '...' });
      i += 3;
      continue;
    }
    out.push({ t: 'punct', v: c });
    i += 1;
  }
  return out;
}

class Parser {
  private pos = 0;
  private readonly toks: Token[];
  private readonly vars: Record<string, unknown>;

  constructor(toks: Token[], vars: Record<string, unknown>) {
    this.toks = toks;
    this.vars = vars;
  }

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }

  private next(): Token {
    return this.toks[this.pos++];
  }

  private expectPunct(v: string): void {
    const t = this.next();
    if (t.t !== 'punct' || t.v !== v) throw new Error(`expected ${v}`);
  }

  private isPunct(v: string): boolean {
    const t = this.peek();
    return t !== undefined && t.t === 'punct' && t.v === v;
  }

  parseOperation(): GqlOperation {
    // Skip the operation keyword + optional name + variable definitions.
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first !== undefined && first.t === 'name' && (first.v === 'query' || first.v === 'mutation')) {
      kind = first.v;
      this.next();
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName.t === 'name') this.next();
    }
    // Variable definitions: (...).
    if (this.isPunct('(')) {
      let depth = 0;
      do {
        const t = this.next();
        if (t.t === 'punct' && t.v === '(') depth += 1;
        else if (t.t === 'punct' && t.v === ')') depth -= 1;
      } while (depth > 0 && this.pos < this.toks.length);
    }
    this.expectPunct('{');
    const fields = this.parseSelectionSet();
    return { kind, fields };
  }

  private parseSelectionSet(): GqlField[] {
    const fields: GqlField[] = [];
    while (this.pos < this.toks.length) {
      if (this.isPunct('}')) {
        this.next();
        break;
      }
      fields.push(this.parseField());
    }
    return fields;
  }

  private parseField(): GqlField {
    // Inline fragment: ... on Type { ... }
    if (this.isPunct('...')) {
      this.next();
      const on = this.next();
      let fragmentOn: string | null = null;
      if (on.t === 'name' && on.v === 'on') {
        const typeTok = this.next();
        if (typeTok.t === 'name') fragmentOn = typeTok.v;
      }
      this.expectPunct('{');
      const children = this.parseSelectionSet();
      return { name: '', alias: null, args: {}, children, fragmentOn };
    }
    const first = this.next();
    if (first.t !== 'name') throw new Error('expected field name');
    let alias: string | null = null;
    let name = first.v;
    if (this.isPunct(':')) {
      this.next();
      const real = this.next();
      if (real.t !== 'name') throw new Error('expected field name after alias');
      alias = name;
      name = real.v;
    }
    const args: Record<string, unknown> = {};
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argName = this.next();
        if (argName.t !== 'name') throw new Error('expected argument name');
        this.expectPunct(':');
        args[argName.v] = this.parseValue();
      }
      this.next();
    }
    let children: GqlField[] = [];
    if (this.isPunct('{')) {
      this.next();
      children = this.parseSelectionSet();
    }
    return { name, alias, args, children, fragmentOn: null };
  }

  private parseValue(): unknown {
    const t = this.next();
    if (t.t === 'string' || t.t === 'int') return t.v;
    if (t.t === 'var') return this.vars[t.v] ?? null;
    if (t.t === 'name') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      return t.v; // enum value, kept as its name
    }
    if (t.t === 'punct' && t.v === '[') {
      const out: unknown[] = [];
      while (!this.isPunct(']')) out.push(this.parseValue());
      this.next();
      return out;
    }
    if (t.t === 'punct' && t.v === '{') {
      const out: Record<string, unknown> = {};
      while (!this.isPunct('}')) {
        const key = this.next();
        if (key.t !== 'name') throw new Error('expected object key');
        this.expectPunct(':');
        out[key.v] = this.parseValue();
      }
      this.next();
      return out;
    }
    throw new Error('unexpected value');
  }
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'labels', 'author', 'createdAt'];
const PULL_TYPE_FIELDS = ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPO_TYPE_FIELDS = [
  'id',
  'databaseId',
  'name',
  'nameWithOwner',
  'owner',
  'defaultBranchRef',
  'viewerPermission',
  'hasIssuesEnabled',
  'issue',
  'issues',
  'pullRequests',
  'pullRequest',
];
const SEARCH_ENUM = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'CODE'];

interface Ctx {
  errors: Array<{ message: string }>;
}

function gqlState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function gqlPrState(pr: Pull): string {
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueNode(repo: Repo, issue: Issue, fields: GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragmentOn !== null) continue;
    const key = f.alias ?? f.name;
    if (f.name === 'id') out[key] = issue.gid;
    else if (f.name === 'number') out[key] = issue.number;
    else if (f.name === 'title') out[key] = issue.title;
    else if (f.name === 'body') out[key] = issue.body;
    else if (f.name === 'state') out[key] = gqlState(issue);
    else out[key] = null;
  }
  return out;
}

function prNode(repo: Repo, pr: Pull, fields: GqlField[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragmentOn !== null) continue;
    const key = f.alias ?? f.name;
    if (f.name === 'id') out[key] = pr.gid;
    else if (f.name === 'number') out[key] = pr.number;
    else if (f.name === 'title') out[key] = pr.title;
    else if (f.name === 'body') out[key] = pr.body;
    else if (f.name === 'headRefName') out[key] = pr.head;
    else if (f.name === 'baseRefName') out[key] = pr.base;
    else if (f.name === 'mergeable') out[key] = prMergeable(repo, pr);
    else if (f.name === 'state') out[key] = gqlPrState(pr);
    else if (f.name === 'merged') out[key] = pr.merged;
    else if (f.name === 'files') {
      const first = typeof f.args.first === 'number' ? f.args.first : 10;
      const all = prFilesForGql(repo, pr);
      const conn: Record<string, unknown> = {};
      for (const child of f.children) {
        if (child.name === 'nodes') {
          conn[child.alias ?? 'nodes'] = all.slice(0, first).map((file) => {
            const node: Record<string, unknown> = {};
            for (const leaf of child.children) {
              if (leaf.name === 'path') node[leaf.alias ?? 'path'] = file.filename;
              else node[leaf.alias ?? leaf.name] = null;
            }
            return node;
          });
        } else {
          conn[child.alias ?? child.name] = null;
        }
      }
      out[key] = conn;
    } else {
      ctx.errors.push({ message: `Cannot query field "${f.name}" on type "PullRequest".` });
      out[key] = null;
    }
  }
  return out;
}

function prFilesForGql(repo: Repo, pr: Pull): Array<{ filename: string }> {
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  if (headTip === undefined || baseTip === undefined) return [];
  const mb = mergeBase(repo, headTip, baseTip);
  const baseTree = mb === null ? '' : commitTree(repo, mb);
  return diffTrees(repo, baseTree, commitTree(repo, headTip)).map((c) => ({ filename: c.filename }));
}

function issuesConnection(repo: Repo, args: Record<string, unknown>, fields: GqlField[]): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : 10;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = typeof args.orderBy === 'object' && args.orderBy !== null ? (args.orderBy as Record<string, unknown>) : null;
  const after = typeof args.after === 'string' ? args.after : null;
  let list = repo.issues.slice();
  if (states !== null) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  if (orderBy !== null && orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') {
    list.sort((a, b) => b.number - a.number);
  } else {
    list.sort((a, b) => a.number - b.number);
  }
  if (after !== null) {
    const m = /^c:(\d+)$/.exec(after);
    if (m !== null) {
      const n = Number(m[1]);
      list = list.filter((i) => (orderBy !== null && orderBy.direction === 'DESC' ? i.number < n : i.number > n));
    }
  }
  const page = list.slice(0, first);
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragmentOn !== null) continue;
    const key = f.alias ?? f.name;
    if (f.name === 'nodes') {
      out[key] = page.map((issue) => issueNode(repo, issue, f.children));
    } else if (f.name === 'pageInfo') {
      const info: Record<string, unknown> = {};
      for (const child of f.children) {
        if (child.name === 'hasNextPage') info[child.alias ?? 'hasNextPage'] = list.length > first;
        else if (child.name === 'endCursor') {
          info[child.alias ?? 'endCursor'] = page.length > 0 ? `c:${page[page.length - 1].number}` : null;
        } else info[child.alias ?? child.name] = null;
      }
      out[key] = info;
    } else {
      out[key] = null;
    }
  }
  return out;
}

function repoNode(repo: Repo, fields: GqlField[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragmentOn !== null) continue;
    const key = f.alias ?? f.name;
    if (f.name === 'id') out[key] = repo.gid;
    else if (f.name === 'databaseId') out[key] = repo.databaseId;
    else if (f.name === 'name') out[key] = repo.name;
    else if (f.name === 'nameWithOwner') out[key] = `${repo.owner}/${repo.name}`;
    else if (f.name === 'owner') {
      const owner: Record<string, unknown> = {};
      for (const child of f.children) {
        if (child.name === 'login') owner[child.alias ?? 'login'] = repo.owner;
        else owner[child.alias ?? child.name] = null;
      }
      out[key] = owner;
    } else if (f.name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
      const ref: Record<string, unknown> = {};
      for (const child of f.children) {
        if (child.name === 'name') ref[child.alias ?? 'name'] = DEFAULT_BRANCH;
        else if (child.name === 'target') ref[child.alias ?? 'target'] = tip !== undefined ? { oid: tip } : null;
        else ref[child.alias ?? child.name] = null;
      }
      out[key] = tip === undefined ? null : ref;
    } else if (f.name === 'viewerPermission') out[key] = 'ADMIN';
    else if (f.name === 'hasIssuesEnabled') out[key] = true;
    else if (f.name === 'issue') {
      const number = typeof f.args.number === 'number' ? f.args.number : -1;
      const issue = getIssue(repo, number);
      out[key] = issue === undefined ? null : issueNode(repo, issue, f.children);
    } else if (f.name === 'issues') {
      out[key] = issuesConnection(repo, f.args, f.children);
    } else if (f.name === 'pullRequests') {
      const first = typeof f.args.first === 'number' ? f.args.first : 10;
      const open = repo.pulls.filter((p) => p.state === 'open').sort((a, b) => b.number - a.number);
      const page = open.slice(0, first);
      const conn: Record<string, unknown> = {};
      for (const child of f.children) {
        if (child.name === 'nodes') conn[child.alias ?? 'nodes'] = page.map((pr) => prNode(repo, pr, child.children, ctx));
        else conn[child.alias ?? child.name] = null;
      }
      out[key] = conn;
    } else if (f.name === 'pullRequest') {
      const number = typeof f.args.number === 'number' ? f.args.number : -1;
      const pr = getPull(repo, number);
      out[key] = pr === undefined ? null : prNode(repo, pr, f.children, ctx);
    } else {
      ctx.errors.push({ message: `Cannot query field "${f.name}" on type "Repository".` });
      out[key] = null;
    }
  }
  return out;
}

function typeNode(name: string, fields: GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragmentOn !== null) continue;
    const key = f.alias ?? f.name;
    if (f.name === 'fields') {
      const names = name === 'Issue' ? ISSUE_TYPE_FIELDS : name === 'PullRequest' ? PULL_TYPE_FIELDS : name === 'Repository' ? REPO_TYPE_FIELDS : [];
      out[key] = names.map((n) => ({ name: n }));
    } else if (f.name === 'enumValues') {
      out[key] = name === 'SearchType' ? SEARCH_ENUM.map((n) => ({ name: n })) : [];
    } else if (f.name === 'name') {
      out[key] = name;
    } else {
      out[key] = null;
    }
  }
  return out;
}

function executeRoot(op: GqlOperation, ctx: Ctx): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const f of op.fields) {
    if (f.fragmentOn !== null) continue;
    const key = f.alias ?? f.name;
    if (op.kind === 'query') {
      if (f.name === 'viewer') {
        const viewer: Record<string, unknown> = {};
        for (const child of f.children) {
          if (child.name === 'login') viewer[child.alias ?? 'login'] = VIEWER_LOGIN;
          else {
            ctx.errors.push({ message: `Cannot query field "${child.name}" on type "User".` });
            viewer[child.alias ?? child.name] = null;
          }
        }
        data[key] = viewer;
      } else if (f.name === 'repository') {
        const owner = typeof f.args.owner === 'string' ? f.args.owner : '';
        const name = typeof f.args.name === 'string' ? f.args.name : '';
        const repo = getRepo(owner, name);
        data[key] = repo === undefined ? null : repoNode(repo, f.children, ctx);
      } else if (f.name === '__type') {
        const name = typeof f.args.name === 'string' ? f.args.name : '';
        data[key] = typeNode(name, f.children);
      } else if (f.name === 'node') {
        const id = typeof f.args.id === 'string' ? f.args.id : '';
        const decoded = decodeGid(id);
        if (decoded !== null && decoded.kind === 'R') {
          const repo = getRepo(decoded.owner, decoded.repo);
          if (repo !== undefined) {
            const node: Record<string, unknown> = { id: repo.gid };
            for (const child of f.children) {
              if (child.fragmentOn === 'Repository') {
                for (const grand of child.children) {
                  if (grand.name === 'name') node[grand.alias ?? 'name'] = repo.name;
                  else if (grand.name === 'nameWithOwner') node[grand.alias ?? 'nameWithOwner'] = `${repo.owner}/${repo.name}`;
                  else if (grand.name === 'id') node[grand.alias ?? 'id'] = repo.gid;
                  else node[grand.alias ?? grand.name] = null;
                }
              } else if (child.name === 'id') {
                node[child.alias ?? 'id'] = repo.gid;
              }
            }
            data[key] = node;
          } else {
            data[key] = null;
          }
        } else {
          data[key] = null;
        }
      } else {
        ctx.errors.push({ message: `Cannot query field "${f.name}" on type "Query".` });
        data[key] = null;
      }
    } else {
      // mutation
      if (f.name === 'createIssue') {
        const input = (f.args.input ?? {}) as Record<string, unknown>;
        const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
        const decoded = decodeGid(repoId);
        const repo = decoded !== null && decoded.kind === 'R' ? getRepo(decoded.owner, decoded.repo) : undefined;
        if (repo === undefined) {
          ctx.errors.push({ message: 'createIssue: repository not found' });
          data[key] = null;
        } else {
          const result = createIssue(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '', []);
          if ('badLabel' in result) {
            ctx.errors.push({ message: 'createIssue: unknown label' });
            data[key] = null;
          } else {
            const issueOut: Record<string, unknown> = {};
            for (const child of f.children) {
              if (child.name === 'issue') {
                issueOut[child.alias ?? 'issue'] = issueNode(repo, result.issue, child.children);
              }
            }
            data[key] = issueOut;
          }
        }
      } else if (f.name === 'closeIssue') {
        const input = (f.args.input ?? {}) as Record<string, unknown>;
        const issueId = typeof input.issueId === 'string' ? input.issueId : '';
        const decoded = decodeGid(issueId);
        const repo = decoded !== null && decoded.kind === 'I' ? getRepo(decoded.owner, decoded.repo) : undefined;
        const issue = repo !== undefined ? getIssue(repo, decoded!.num) : undefined;
        if (issue === undefined || repo === undefined) {
          ctx.errors.push({ message: 'closeIssue: issue not found' });
          data[key] = null;
        } else {
          issue.state = 'closed';
          issue.cached = null;
          const issueOut: Record<string, unknown> = {};
          for (const child of f.children) {
            if (child.name === 'issue') issueOut[child.alias ?? 'issue'] = issueNode(repo, issue, child.children);
          }
          data[key] = issueOut;
        }
      } else if (f.name === 'createPullRequest') {
        const input = (f.args.input ?? {}) as Record<string, unknown>;
        const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
        const decoded = decodeGid(repoId);
        const repo = decoded !== null && decoded.kind === 'R' ? getRepo(decoded.owner, decoded.repo) : undefined;
        if (repo === undefined) {
          ctx.errors.push({ message: 'createPullRequest: repository not found' });
          data[key] = null;
        } else {
          const result = createPull(
            repo,
            typeof input.title === 'string' ? input.title : '',
            typeof input.body === 'string' ? input.body : '',
            typeof input.headRefName === 'string' ? input.headRefName : '',
            typeof input.baseRefName === 'string' ? input.baseRefName : '',
          );
          if ('error' in result) {
            ctx.errors.push({ message: `createPullRequest: ${result.error}` });
            data[key] = null;
          } else {
            const prOut: Record<string, unknown> = {};
            for (const child of f.children) {
              if (child.name === 'pullRequest') prOut[child.alias ?? 'pullRequest'] = prNode(repo, result.pr, child.children, ctx);
            }
            data[key] = prOut;
          }
        }
      } else if (f.name === 'mergePullRequest') {
        const input = (f.args.input ?? {}) as Record<string, unknown>;
        const prId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
        const decoded = decodeGid(prId);
        const repo = decoded !== null && decoded.kind === 'P' ? getRepo(decoded.owner, decoded.repo) : undefined;
        const pr = repo !== undefined ? getPull(repo, decoded!.num) : undefined;
        if (pr === undefined || repo === undefined) {
          ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
          data[key] = null;
        } else {
          const result = mergePull(repo, pr.number);
          if ('error' in result) {
            ctx.errors.push({ message: `mergePullRequest: ${result.error}` });
            data[key] = null;
          } else {
            const prOut: Record<string, unknown> = {};
            for (const child of f.children) {
              if (child.name === 'pullRequest') prOut[child.alias ?? 'pullRequest'] = prNode(repo, pr, child.children, ctx);
            }
            data[key] = prOut;
          }
        }
      } else if (f.name === 'addComment') {
        const input = (f.args.input ?? {}) as Record<string, unknown>;
        const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
        const decoded = decodeGid(subjectId);
        const repo = decoded !== null && decoded.kind === 'I' ? getRepo(decoded.owner, decoded.repo) : undefined;
        const issue = repo !== undefined ? getIssue(repo, decoded!.num) : undefined;
        if (issue === undefined || repo === undefined) {
          ctx.errors.push({ message: 'addComment: issue not found' });
          data[key] = null;
        } else {
          const comment = addComment(repo, issue.number, typeof input.body === 'string' ? input.body : '');
          const edgeOut: Record<string, unknown> = {};
          for (const child of f.children) {
            if (child.name === 'commentEdge') {
              const nodeOut: Record<string, unknown> = {};
              for (const grand of child.children) {
                if (grand.name === 'node') {
                  const node: Record<string, unknown> = {};
                  for (const leaf of grand.children) {
                    if (leaf.name === 'id') node[leaf.alias ?? 'id'] = comment.gid;
                    else if (leaf.name === 'body') node[leaf.alias ?? 'body'] = comment.body;
                    else node[leaf.alias ?? leaf.name] = null;
                  }
                  nodeOut[grand.alias ?? 'node'] = node;
                }
              }
              edgeOut[child.alias ?? 'commentEdge'] = nodeOut;
            }
          }
          data[key] = edgeOut;
        }
      } else {
        ctx.errors.push({ message: `Cannot query field "${f.name}" on type "Mutation".` });
        data[key] = null;
      }
    }
  }
  return data;
}

/** Execute one GraphQL operation document. Returns the response body object. */
export function executeGraphQL(query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Ctx = { errors: [] };
  try {
    const parser = new Parser(tokenize(query), variables);
    const op = parser.parseOperation();
    const data = executeRoot(op, ctx);
    if (ctx.errors.length > 0) return { data, errors: ctx.errors };
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
