// graphql.ts — a small GraphQL executor for the subset the suite's documents use:
// operations, variables, aliases, arguments (literals, enums, lists, input objects,
// null), nested selections, inline fragments and named fragments. Field names are
// validated against the schema tables below; an unknown field is a validation error
// with the exact message the suite expects.

import {
  VIEWER,
  decodeGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

export interface GqlValue {
  kind: 'string' | 'int' | 'float' | 'bool' | 'null' | 'enum' | 'list' | 'object' | 'var';
  value: unknown;
}

export interface GqlSelection {
  name: string;
  alias: string | null;
  args: Record<string, GqlValue>;
  children: GqlSelection[];
  /** For `... on Type { ... }` the selections live in children and this is set. */
  fragmentType: string | null;
  /** For `...Name` spreads. */
  fragmentName: string | null;
}

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variableDefs: Record<string, { type: string; defaultValue: GqlValue | null }>;
  selections: GqlSelection[];
}

export interface GqlDocument {
  operations: GqlOperation[];
  fragments: Record<string, { type: string; selections: GqlSelection[] }>;
}

class Parser {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private peek(): string {
    return this.text[this.pos] ?? '';
  }

  private skipSpace(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]!;
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',' || ch === ';') {
        this.pos += 1;
      } else if (ch === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
      } else {
        break;
      }
    }
  }

  private readName(): string {
    this.skipSpace();
    const start = this.pos;
    while (this.pos < this.text.length && /[_A-Za-z0-9]/.test(this.text[this.pos]!)) this.pos += 1;
    if (this.pos === start) throw new Error(`expected a name at offset ${this.pos}`);
    return this.text.slice(start, this.pos);
  }

  private expect(ch: string): void {
    this.skipSpace();
    if (this.text[this.pos] !== ch) throw new Error(`expected ${ch} at offset ${this.pos}`);
    this.pos += 1;
  }

  private readString(): string {
    this.skipSpace();
    this.expect('"');
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]!;
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        this.pos += 1;
        const esc = this.text[this.pos]!;
        this.pos += 1;
        out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
      } else {
        out += ch;
        this.pos += 1;
      }
    }
    throw new Error('unterminated string');
  }

  private readNumber(): GqlValue {
    this.skipSpace();
    const start = this.pos;
    if (this.peek() === '-') this.pos += 1;
    while (this.pos < this.text.length && /[0-9.]/.test(this.text[this.pos]!)) this.pos += 1;
    const raw = this.text.slice(start, this.pos);
    if (raw.includes('.')) return { kind: 'float', value: Number(raw) };
    return { kind: 'int', value: Number(raw) };
  }

  private readValue(): GqlValue {
    this.skipSpace();
    const ch = this.peek();
    if (ch === '"') return { kind: 'string', value: this.readString() };
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'var', value: this.readName() };
    }
    if (ch === '[') {
      this.pos += 1;
      const items: GqlValue[] = [];
      this.skipSpace();
      while (this.peek() !== ']') {
        items.push(this.readValue());
        this.skipSpace();
      }
      this.pos += 1;
      return { kind: 'list', value: items };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: Record<string, GqlValue> = {};
      this.skipSpace();
      while (this.peek() !== '}') {
        const name = this.readName();
        this.expect(':');
        fields[name] = this.readValue();
        this.skipSpace();
      }
      this.pos += 1;
      return { kind: 'object', value: fields };
    }
    if (ch === '-' || /[0-9]/.test(ch)) return this.readNumber();
    const name = this.readName();
    if (name === 'true') return { kind: 'bool', value: true };
    if (name === 'false') return { kind: 'bool', value: false };
    if (name === 'null') return { kind: 'null', value: null };
    return { kind: 'enum', value: name };
  }

  private readType(): string {
    this.skipSpace();
    if (this.peek() === '[') {
      this.pos += 1;
      const inner = this.readType();
      this.expect(']');
      this.skipSpace();
      if (this.peek() === '!') this.pos += 1;
      return `[${inner}]`;
    }
    const name = this.readName();
    this.skipSpace();
    if (this.peek() === '!') this.pos += 1;
    return name;
  }

  private readArgs(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    this.skipSpace();
    if (this.peek() !== '(') return args;
    this.pos += 1;
    this.skipSpace();
    while (this.peek() !== ')') {
      const name = this.readName();
      this.expect(':');
      args[name] = this.readValue();
      this.skipSpace();
    }
    this.pos += 1;
    return args;
  }

  private readSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    this.skipSpace();
    while (this.peek() !== '}') {
      if (this.text.startsWith('...', this.pos)) {
        this.pos += 3;
        this.skipSpace();
        if (this.text.startsWith('on ', this.pos)) {
          this.pos += 3;
          const type = this.readName();
          const children = this.readSelectionSet();
          selections.push({ name: '', alias: null, args: {}, children, fragmentType: type, fragmentName: null });
        } else {
          const name = this.readName();
          selections.push({ name: '', alias: null, args: {}, children: [], fragmentType: null, fragmentName: name });
        }
      } else {
        const first = this.readName();
        let name = first;
        let alias: string | null = null;
        this.skipSpace();
        if (this.peek() === ':') {
          this.pos += 1;
          alias = first;
          name = this.readName();
        }
        const args = this.readArgs();
        let children: GqlSelection[] = [];
        this.skipSpace();
        if (this.peek() === '{') children = this.readSelectionSet();
        selections.push({ name, alias, args, children, fragmentType: null, fragmentName: null });
      }
      this.skipSpace();
    }
    this.pos += 1;
    return selections;
  }

  parseDocument(): GqlDocument {
    const doc: GqlDocument = { operations: [], fragments: {} };
    while (true) {
      this.skipSpace();
      if (this.pos >= this.text.length) break;
      if (this.text.startsWith('fragment ', this.pos)) {
        this.pos += 'fragment '.length;
        const name = this.readName();
        this.skipSpace();
        if (this.text.startsWith('on ', this.pos)) this.pos += 3;
        const type = this.readName();
        const selections = this.readSelectionSet();
        doc.fragments[name] = { type, selections };
        continue;
      }
      let kind: 'query' | 'mutation' = 'query';
      let name: string | null = null;
      this.skipSpace();
      if (this.text.startsWith('query', this.pos) && !/[_A-Za-z0-9]/.test(this.text[this.pos + 5] ?? '')) {
        this.pos += 5;
        this.skipSpace();
        if (this.peek() !== '(' && this.peek() !== '{') name = this.readName();
      } else if (this.text.startsWith('mutation', this.pos) && !/[_A-Za-z0-9]/.test(this.text[this.pos + 8] ?? '')) {
        kind = 'mutation';
        this.pos += 8;
        this.skipSpace();
        if (this.peek() !== '(' && this.peek() !== '{') name = this.readName();
      }
      const variableDefs: GqlOperation['variableDefs'] = {};
      this.skipSpace();
      if (this.peek() === '(') {
        this.pos += 1;
        this.skipSpace();
        while (this.peek() !== ')') {
          this.expect('$');
          const varName = this.readName();
          this.expect(':');
          const type = this.readType();
          let defaultValue: GqlValue | null = null;
          this.skipSpace();
          if (this.peek() === '=') {
            this.pos += 1;
            defaultValue = this.readValue();
          }
          variableDefs[varName] = { type, defaultValue };
          this.skipSpace();
        }
        this.pos += 1;
      }
      const selections = this.readSelectionSet();
      doc.operations.push({ kind, name, variableDefs, selections });
    }
    return doc;
  }
}

export function parseGraphql(query: string): GqlDocument {
  return new Parser(query).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// schema tables (the only types the suite queries)
// ---------------------------------------------------------------------------------------------

/** The fields of each type, with the __Type introspection answers derived from them. */
export const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'repositories'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'url', 'createdAt', 'updatedAt',
  ],
  RepositoryOwner: ['id', 'login'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'labels', 'comments', 'repository', 'author', 'url'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  Label: ['id', 'name', 'color'],
  Comment: ['id', 'body', 'createdAt', 'author'],
  CommentEdge: ['node'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRefOid', 'baseRefOid', 'mergeCommit', 'files', 'createdAt', 'updatedAt',
    'repository', 'author', 'url', 'mergedAt', 'mergeCommitSha',
  ],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  SearchResultItemConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name', 'type'],
  __EnumValue: ['name'],
  __Schema: ['queryType', 'mutationType'],
  __InputValue: ['name', 'type'],
};

export const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueStateReason: ['COMPLETED', 'NOT_PLANNED', 'REOPENED'],
};

const TYPE_KIND: Record<string, string> = {
  Query: 'OBJECT', Mutation: 'OBJECT', User: 'OBJECT', Repository: 'OBJECT',
  Issue: 'OBJECT', PullRequest: 'OBJECT', Label: 'OBJECT', Comment: 'OBJECT',
  Ref: 'OBJECT', IssueConnection: 'OBJECT', PullRequestConnection: 'OBJECT',
  IssueEdge: 'OBJECT', PullRequestEdge: 'OBJECT', PageInfo: 'OBJECT',
  IssueState: 'ENUM', PullRequestState: 'ENUM', SearchType: 'ENUM',
  MergeableState: 'ENUM', RepositoryPermission: 'ENUM', MergeMethod: 'ENUM',
  IssueOrderField: 'ENUM', OrderDirection: 'ENUM', PullRequestOrderField: 'ENUM',
  __Type: 'OBJECT', __Field: 'OBJECT', __EnumValue: 'OBJECT', __Schema: 'OBJECT',
};

const FIELD_NAMES: Record<string, string> = {
  Issue: 'Issue', PullRequest: 'PullRequest', Repository: 'Repository', User: 'User',
  IssueState: 'IssueState', PullRequestState: 'PullRequestState', SearchType: 'SearchType',
  MergeableState: 'MergeableState', RepositoryPermission: 'RepositoryPermission',
  MergeMethod: 'MergeMethod', IssueOrderField: 'IssueOrderField',
  OrderDirection: 'OrderDirection', PullRequestOrderField: 'PullRequestOrderField',
};

export function typeInfo(name: string): { name: string; kind: string; fields: string[]; enumValues: string[] } | null {
  if (!(name in TYPE_FIELDS) && !(name in ENUM_VALUES)) return null;
  return {
    name,
    kind: TYPE_KIND[name] ?? 'OBJECT',
    fields: TYPE_FIELDS[name] ?? [],
    enumValues: ENUM_VALUES[name] ?? [],
  };
}

// ---------------------------------------------------------------------------------------------
// value resolution
// ---------------------------------------------------------------------------------------------

export function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var': {
      const name = value.value as string;
      return variables[name];
    }
    case 'list':
      return (value.value as GqlValue[]).map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value.value as Record<string, GqlValue>)) {
        out[key] = resolveValue(item, variables);
      }
      return out;
    }
    default:
      return value.value;
  }
}

function argValue(selection: GqlSelection, name: string, variables: Record<string, unknown>): unknown {
  const value = selection.args[name];
  if (value === undefined) return undefined;
  return resolveValue(value, variables);
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

export class GqlError extends Error {
  constructor(message: string) {
    super(message);
  }
}

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: GqlDocument['fragments'];
  /** Collected errors (validation + runtime), reported at the top level. */
  errors: Array<{ message: string }>;
}

function issueCursor(number: number): string {
  return Buffer.from(`issue-cursor:${number}`, 'utf8').toString('base64url');
}

function pullCursor(number: number): string {
  return Buffer.from(`pull-cursor:${number}`, 'utf8').toString('base64url');
}

function checkFields(typeName: string, selections: GqlSelection[], ctx: ExecCtx): void {
  const allowed = TYPE_FIELDS[typeName];
  if (!allowed) return;
  for (const selection of selections) {
    if (selection.fragmentName !== null) {
      const fragment = ctx.fragments[selection.fragmentName];
      if (fragment) checkFields(fragment.type, fragment.selections, ctx);
      continue;
    }
    if (selection.fragmentType !== null) {
      checkFields(selection.fragmentType, selection.children, ctx);
      continue;
    }
    if (selection.name === '__typename') continue;
    if (!allowed.includes(selection.name)) {
      throw new GqlError(`Cannot query field "${selection.name}" on type "${typeName}".`);
    }
  }
}

/** Expand fragments and inline fragments into a flat selection list for a type. */
function expandSelections(typeName: string, selections: GqlSelection[], ctx: ExecCtx): GqlSelection[] {
  const out: GqlSelection[] = [];
  for (const selection of selections) {
    if (selection.fragmentName !== null) {
      const fragment = ctx.fragments[selection.fragmentName];
      if (!fragment) continue;
      if (fragment.type !== typeName && fragment.type !== '') continue;
      out.push(...expandSelections(typeName, fragment.selections, ctx));
      continue;
    }
    if (selection.fragmentType !== null) {
      if (selection.fragmentType !== typeName) continue;
      out.push(...expandSelections(typeName, selection.children, ctx));
      continue;
    }
    out.push(selection);
  }
  return out;
}

type NodeValue =
  | { __type: 'user'; id: number; login: string }
  | { __type: 'repo'; repo: Repo }
  | { __type: 'issue'; repo: Repo; number: number }
  | { __type: 'pull'; repo: Repo; number: number }
  | { __type: 'label'; name: string; color: string }
  | { __type: 'comment'; id: number; body: string; createdAt: string }
  | { __type: 'ref'; name: string; oid: string }
  | { __type: 'type'; name: string }
  | { __type: 'schema' };

function typeNameOf(value: NodeValue): string {
  switch (value.__type) {
    case 'user': return 'User';
    case 'repo': return 'Repository';
    case 'issue': return 'Issue';
    case 'pull': return 'PullRequest';
    case 'label': return 'Label';
    case 'comment': return 'Comment';
    case 'ref': return 'Ref';
    case 'type': return '__Type';
    case 'schema': return '__Schema';
  }
}

function pageInfoFor(items: Array<{ cursor: string }>, first: number | undefined, hasMore: boolean): Record<string, unknown> {
  return {
    hasNextPage: hasMore,
    hasPreviousPage: false,
    startCursor: items.length > 0 ? items[0]!.cursor : null,
    endCursor: items.length > 0 ? items[items.length - 1]!.cursor : null,
  };
}

function selectFields(typeName: string, value: NodeValue, selections: GqlSelection[], ctx: ExecCtx): Record<string, unknown> {
  checkFields(typeName, selections, ctx);
  const expanded = expandSelections(typeName, selections, ctx);
  const out: Record<string, unknown> = {};
  for (const selection of expanded) {
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(typeName, value, selection, ctx);
  }
  return out;
}

function resolveField(typeName: string, value: NodeValue, selection: GqlSelection, ctx: ExecCtx): unknown {
  const name = selection.name;
  if (name === '__typename') return typeName;

  // --- Query root ---
  if (typeName === 'Query') {
    if (name === 'viewer') {
      return selectFields('User', { __type: 'user', id: VIEWER.id, login: VIEWER.login }, selection.children, ctx);
    }
    if (name === 'repository') {
      const owner = argValue(selection, 'owner', ctx.variables) as string | undefined;
      const repoName = argValue(selection, 'name', ctx.variables) as string | undefined;
      if (owner !== VIEWER.login) return null;
      const repo = ctx.store.getRepo(owner, repoName ?? '');
      if (!repo) return null;
      return selectFields('Repository', { __type: 'repo', repo }, selection.children, ctx);
    }
    if (name === 'node') {
      const id = argValue(selection, 'id', ctx.variables) as string | undefined;
      if (!id) return null;
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'repo') {
        const repo = ctx.store.repoList.find((candidate) => candidate.id === decoded.repoId);
        if (!repo) return null;
        return selectFields('Repository', { __type: 'repo', repo }, selection.children, ctx);
      }
      return null;
    }
    if (name === 'search') {
      return { nodes: [], edges: [], totalCount: 0, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    }
    if (name === '__type') {
      const typeNameArg = argValue(selection, 'name', ctx.variables) as string | undefined;
      if (!typeNameArg) return null;
      const info = typeInfo(typeNameArg);
      if (!info) return null;
      return selectFields('__Type', { __type: 'type', name: typeNameArg }, selection.children, ctx);
    }
    if (name === '__schema') {
      return selectFields('__Schema', { __type: 'schema' }, selection.children, ctx);
    }
  }

  // --- Mutation root ---
  if (typeName === 'Mutation') {
    return resolveMutation(selection, ctx);
  }

  // --- __Type introspection ---
  if (typeName === '__Type' && value.__type === 'type') {
    const info = typeInfo(value.name);
    if (name === 'name') return value.name;
    if (name === 'kind') return info?.kind ?? null;
    if (name === 'fields') {
      const fields = (info?.fields ?? []).map((fieldName) => ({ name: fieldName }));
      if (selection.children.length === 0) return fields;
      return fields.map((field) => selectFields('__Field', field as never, selection.children, ctx));
    }
    if (name === 'enumValues') {
      const values = (info?.enumValues ?? []).map((enumName) => ({ name: enumName }));
      if (selection.children.length === 0) return values;
      return values.map((entry) => selectFields('__EnumValue', entry as never, selection.children, ctx));
    }
    return null;
  }
  if (typeName === '__Field' && (value as unknown as { name: string }).name !== undefined) {
    if (name === 'name') return (value as unknown as { name: string }).name;
    if (name === 'type') return null;
    return null;
  }
  if (typeName === '__EnumValue' && (value as unknown as { name: string }).name !== undefined) {
    if (name === 'name') return (value as unknown as { name: string }).name;
    return null;
  }
  if (typeName === '__Schema') {
    if (name === 'queryType') return { name: 'Query' };
    if (name === 'mutationType') return { name: 'Mutation' };
    return null;
  }

  // --- User ---
  if (typeName === 'User' && value.__type === 'user') {
    if (name === 'id') return Buffer.from(`user:${value.id}`, 'utf8').toString('base64url');
    if (name === 'login') return value.login;
    if (name === 'name') return VIEWER.name;
    if (name === 'email') return VIEWER.email;
    if (name === 'repositories') {
      const repos = ctx.store.repoList;
      return {
        nodes: repos.map((repo) => selectFields('Repository', { __type: 'repo', repo }, selection.children, ctx)),
        edges: repos.map((repo) => ({ node: selectFields('Repository', { __type: 'repo', repo }, selection.children, ctx) })),
        totalCount: repos.length,
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    }
    return null;
  }

  // --- Repository ---
  if (typeName === 'Repository' && value.__type === 'repo') {
    const repo = value.repo;
    if (name === 'id') return repoGlobalId(repo);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (name === 'description') return repo.description;
    if (name === 'owner') return selectFields('User', { __type: 'user', id: VIEWER.id, login: repo.owner }, selection.children, ctx);
    if (name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return selectFields('Ref', { __type: 'ref', name: repo.defaultBranch, oid: tip }, selection.children, ctx);
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'isPrivate') return repo.private;
    if (name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}`;
    if (name === 'createdAt') return repo.createdAt;
    if (name === 'updatedAt') return repo.updatedAt;
    if (name === 'issue') {
      const number = argValue(selection, 'number', ctx.variables) as number | undefined;
      const issue = number !== undefined ? repo.issuesByNumber.get(number) : undefined;
      if (!issue) return null;
      return selectFields('Issue', { __type: 'issue', repo, number: issue.number }, selection.children, ctx);
    }
    if (name === 'issues') return issuesConnection(repo, selection, ctx);
    if (name === 'pullRequest') {
      const number = argValue(selection, 'number', ctx.variables) as number | undefined;
      const pull = number !== undefined ? repo.pullsByNumber.get(number) : undefined;
      if (!pull) return null;
      return selectFields('PullRequest', { __type: 'pull', repo, number: pull.number }, selection.children, ctx);
    }
    if (name === 'pullRequests') return pullsConnection(repo, selection, ctx);
    return null;
  }

  // --- Issue ---
  if (typeName === 'Issue' && value.__type === 'issue') {
    const issue = value.repo.issuesByNumber.get(value.number)!;
    if (name === 'id') return issueGlobalId(value.repo, issue.number);
    if (name === 'databaseId') return issue.id;
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'body') return issue.body;
    if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (name === 'createdAt') return issue.createdAt;
    if (name === 'updatedAt') return issue.updatedAt;
    if (name === 'labels') {
      return {
        nodes: issue.labels.map((label) => selectFields('Label', { __type: 'label', name: label.name, color: label.color }, selection.children, ctx)),
        edges: issue.labels.map((label) => ({ node: selectFields('Label', { __type: 'label', name: label.name, color: label.color }, selection.children, ctx) })),
        totalCount: issue.labels.length,
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    }
    if (name === 'comments') {
      const comments = value.repo.comments.get(issue.number) ?? [];
      return {
        nodes: comments.map((comment) => selectFields('Comment', { __type: 'comment', id: comment.id, body: comment.body, createdAt: comment.createdAt }, selection.children, ctx)),
        edges: comments.map((comment) => ({ node: selectFields('Comment', { __type: 'comment', id: comment.id, body: comment.body, createdAt: comment.createdAt }, selection.children, ctx) })),
        totalCount: comments.length,
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    }
    if (name === 'repository') return selectFields('Repository', { __type: 'repo', repo: value.repo }, selection.children, ctx);
    if (name === 'author') return selectFields('User', { __type: 'user', id: VIEWER.id, login: VIEWER.login }, selection.children, ctx);
    if (name === 'url') return `https://example.invalid/${value.repo.owner}/${value.repo.name}/issues/${issue.number}`;
    return null;
  }

  // --- PullRequest ---
  if (typeName === 'PullRequest' && value.__type === 'pull') {
    const pull = value.repo.pullsByNumber.get(value.number)!;
    if (name === 'id') return pullGlobalId(value.repo, pull.number);
    if (name === 'databaseId') return pull.id;
    if (name === 'number') return pull.number;
    if (name === 'title') return pull.title;
    if (name === 'body') return pull.body;
    if (name === 'state') return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
    if (name === 'merged') return pull.merged;
    if (name === 'mergeable') return ctx.store.pullConflicts(value.repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    if (name === 'headRefName') return pull.headRef;
    if (name === 'baseRefName') return pull.baseRef;
    if (name === 'headRefOid') return pull.headSha;
    if (name === 'baseRefOid') return pull.baseSha;
    if (name === 'createdAt') return pull.createdAt;
    if (name === 'updatedAt') return pull.updatedAt;
    if (name === 'mergedAt') return pull.mergedAt;
    if (name === 'mergeCommitSha') return pull.mergeCommitSha;
    if (name === 'mergeCommit') {
      if (!pull.mergeCommitSha) return null;
      return { oid: pull.mergeCommitSha };
    }
    if (name === 'files') {
      const first = argValue(selection, 'first', ctx.variables) as number | undefined;
      const files = ctx.store.pullFiles(value.repo, pull);
      const sliced = first !== undefined ? files.slice(0, first) : files;
      return {
        nodes: sliced.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status })),
        edges: sliced.map((file) => ({ node: { path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status } })),
        totalCount: files.length,
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    }
    if (name === 'repository') return selectFields('Repository', { __type: 'repo', repo: value.repo }, selection.children, ctx);
    if (name === 'author') return selectFields('User', { __type: 'user', id: VIEWER.id, login: VIEWER.login }, selection.children, ctx);
    if (name === 'url') return `https://example.invalid/${value.repo.owner}/${value.repo.name}/pull/${pull.number}`;
    return null;
  }

  // --- Label / Comment / Ref ---
  if (typeName === 'Label' && value.__type === 'label') {
    if (name === 'id') return Buffer.from(`label:${value.name}`, 'utf8').toString('base64url');
    if (name === 'name') return value.name;
    if (name === 'color') return value.color;
    return null;
  }
  if (typeName === 'Comment' && value.__type === 'comment') {
    if (name === 'id') return Buffer.from(`comment:${value.id}`, 'utf8').toString('base64url');
    if (name === 'body') return value.body;
    if (name === 'createdAt') return value.createdAt;
    if (name === 'author') return selectFields('User', { __type: 'user', id: VIEWER.id, login: VIEWER.login }, selection.children, ctx);
    return null;
  }
  if (typeName === 'Ref' && value.__type === 'ref') {
    if (name === 'name') return value.name;
    if (name === 'target') return { oid: value.oid };
    return null;
  }

  // --- Connections ---
  if ((typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'SearchResultItemConnection')) {
    if (name === 'nodes' || name === 'edges' || name === 'totalCount' || name === 'pageInfo') {
      // Connections are built by their parent field resolvers and passed through here
      // as plain objects; this branch is only reached for nested selections.
      const raw = value as unknown as Record<string, unknown>;
      return raw[name] ?? null;
    }
    return null;
  }
  if (typeName === 'PageInfo') {
    const raw = value as unknown as Record<string, unknown>;
    if (name === 'hasNextPage') return raw.hasNextPage ?? false;
    if (name === 'hasPreviousPage') return raw.hasPreviousPage ?? false;
    if (name === 'startCursor') return raw.startCursor ?? null;
    if (name === 'endCursor') return raw.endCursor ?? null;
    return null;
  }
  if (typeName === 'IssueEdge' || typeName === 'PullRequestEdge' || typeName === 'CommentEdge') {
    const raw = value as unknown as Record<string, unknown>;
    if (name === 'node') return raw.node ?? null;
    if (name === 'cursor') return raw.cursor ?? null;
    return null;
  }

  return null;
}

function issuesConnection(repo: Repo, selection: GqlSelection, ctx: ExecCtx): Record<string, unknown> {
  const first = argValue(selection, 'first', ctx.variables) as number | undefined;
  const after = argValue(selection, 'after', ctx.variables) as string | undefined;
  const states = argValue(selection, 'states', ctx.variables) as string[] | undefined;
  const orderBy = argValue(selection, 'orderBy', ctx.variables) as Record<string, unknown> | undefined;
  let issues = [...repo.issues];
  if (states !== undefined && states.length > 0) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  if (orderBy !== undefined) {
    const field = orderBy.field as string | undefined;
    const direction = orderBy.direction as string | undefined;
    if (field === 'CREATED_AT') {
      issues.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
    }
  }
  let afterSeq = -1;
  if (after !== undefined) {
    try {
      const text = Buffer.from(after, 'base64url').toString('utf8');
      const match = /^issue-cursor:(\d+)$/.exec(text);
      if (match) {
        const found = repo.issuesByNumber.get(Number(match[1]));
        afterSeq = found ? found.seq : -1;
      }
    } catch {
      afterSeq = -1;
    }
  }
  issues = issues.filter((issue) => issue.seq > afterSeq);
  const total = issues.length;
  const page = first !== undefined ? issues.slice(0, first) : issues;
  const nodeSelections = selection.children.find((child) => child.name === 'nodes')?.children ?? [];
  const edgeSelections = selection.children.find((child) => child.name === 'edges')?.children ?? [];
  const edgeNodeSelections = edgeSelections.find((child) => child.name === 'node')?.children ?? [];
  const resolvedNodes = page.map((issue) => selectFields('Issue', { __type: 'issue', repo, number: issue.number }, nodeSelections, ctx));
  const edges = page.map((issue) => ({
    node: selectFields('Issue', { __type: 'issue', repo, number: issue.number }, edgeNodeSelections, ctx),
    cursor: issueCursor(issue.number),
  }));
  const pageInfo = pageInfoFor(edges, first, total > page.length);
  const out: Record<string, unknown> = { totalCount: total, pageInfo };
  if (selection.children.some((child) => child.name === 'nodes')) out.nodes = resolvedNodes;
  if (selection.children.some((child) => child.name === 'edges')) out.edges = edges;
  return out;
}

function pullsConnection(repo: Repo, selection: GqlSelection, ctx: ExecCtx): Record<string, unknown> {
  const first = argValue(selection, 'first', ctx.variables) as number | undefined;
  const after = argValue(selection, 'after', ctx.variables) as string | undefined;
  const states = argValue(selection, 'states', ctx.variables) as string[] | undefined;
  let pulls = [...repo.pulls];
  if (states !== undefined && states.length > 0) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'MERGED' ? 'merged' : 'closed')));
    pulls = pulls.filter((pull) => wanted.has(pull.state));
  }
  let afterSeq = -1;
  if (after !== undefined) {
    try {
      const text = Buffer.from(after, 'base64url').toString('utf8');
      const match = /^pull-cursor:(\d+)$/.exec(text);
      if (match) {
        const found = repo.pullsByNumber.get(Number(match[1]));
        afterSeq = found ? found.seq : -1;
      }
    } catch {
      afterSeq = -1;
    }
  }
  pulls = pulls.filter((pull) => pull.seq > afterSeq);
  const total = pulls.length;
  const page = first !== undefined ? pulls.slice(0, first) : pulls;
  const nodeSelections = selection.children.find((child) => child.name === 'nodes')?.children ?? [];
  const edgeSelections = selection.children.find((child) => child.name === 'edges')?.children ?? [];
  const edgeNodeSelections = edgeSelections.find((child) => child.name === 'node')?.children ?? [];
  const resolvedNodes = page.map((pull) => selectFields('PullRequest', { __type: 'pull', repo, number: pull.number }, nodeSelections, ctx));
  const edges = page.map((pull) => ({
    node: selectFields('PullRequest', { __type: 'pull', repo, number: pull.number }, edgeNodeSelections, ctx),
    cursor: pullCursor(pull.number),
  }));
  const pageInfo = pageInfoFor(edges, first, total > page.length);
  const out: Record<string, unknown> = { totalCount: total, pageInfo };
  if (selection.children.some((child) => child.name === 'nodes')) out.nodes = resolvedNodes;
  if (selection.children.some((child) => child.name === 'edges')) out.edges = edges;
  return out;
}

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

function resolveMutation(selection: GqlSelection, ctx: ExecCtx): unknown {
  const input = argValue(selection, 'input', ctx.variables) as Record<string, unknown> | undefined;
  const inputObj = input ?? {};
  if (selection.name === 'createIssue') {
    const repositoryId = inputObj.repositoryId as string | undefined;
    const title = inputObj.title as string | undefined;
    const body = inputObj.body as string | undefined;
    if (!repositoryId || !title) throw new GqlError('repositoryId and title are required');
    const decoded = decodeGlobalId(repositoryId);
    if (!decoded || decoded.kind !== 'repo') throw new GqlError('Repository not found');
    const repo = ctx.store.repoList.find((candidate) => candidate.id === decoded.repoId);
    if (!repo) throw new GqlError('Repository not found');
    const issue = ctx.store.createIssue(repo, title, body ?? '', []);
    const issueNode = selectFields('Issue', { __type: 'issue', repo, number: issue.number }, selection.children.find((child) => child.name === 'issue')?.children ?? [], ctx);
    return { issue: issueNode };
  }
  if (selection.name === 'closeIssue') {
    const issueId = inputObj.issueId as string | undefined;
    if (!issueId) throw new GqlError('issueId is required');
    const decoded = decodeGlobalId(issueId);
    if (!decoded || decoded.kind !== 'issue') throw new GqlError('Issue not found');
    const repo = ctx.store.repoList.find((candidate) => candidate.id === decoded.repoId);
    const issue = repo?.issuesByNumber.get(decoded.number ?? 0);
    if (!repo || !issue) throw new GqlError('Issue not found');
    issue.state = 'closed';
    issue.updatedAt = ctx.store.clock.stamp();
    issue.jsonCache = null;
    const issueNode = selectFields('Issue', { __type: 'issue', repo, number: issue.number }, selection.children.find((child) => child.name === 'issue')?.children ?? [], ctx);
    return { issue: issueNode };
  }
  if (selection.name === 'createPullRequest') {
    const repositoryId = inputObj.repositoryId as string | undefined;
    const baseRefName = inputObj.baseRefName as string | undefined;
    const headRefName = inputObj.headRefName as string | undefined;
    const title = inputObj.title as string | undefined;
    if (!repositoryId || !baseRefName || !headRefName || !title) throw new GqlError('repositoryId, baseRefName, headRefName and title are required');
    const decoded = decodeGlobalId(repositoryId);
    if (!decoded || decoded.kind !== 'repo') throw new GqlError('Repository not found');
    const repo = ctx.store.repoList.find((candidate) => candidate.id === decoded.repoId);
    if (!repo) throw new GqlError('Repository not found');
    const headSha = ctx.store.resolveRef(repo, headRefName);
    const baseSha = ctx.store.resolveRef(repo, baseRefName);
    if (headSha === undefined || baseSha === undefined) throw new GqlError('head or base branch does not exist');
    const pull = ctx.store.createPull(repo, title, (inputObj.body as string | undefined) ?? '', headRefName, baseRefName, headSha, baseSha);
    const pullNode = selectFields('PullRequest', { __type: 'pull', repo, number: pull.number }, selection.children.find((child) => child.name === 'pullRequest')?.children ?? [], ctx);
    return { pullRequest: pullNode };
  }
  if (selection.name === 'mergePullRequest') {
    const pullRequestId = inputObj.pullRequestId as string | undefined;
    if (!pullRequestId) throw new GqlError('pullRequestId is required');
    const decoded = decodeGlobalId(pullRequestId);
    if (!decoded || decoded.kind !== 'pull') throw new GqlError('Pull request not found');
    const repo = ctx.store.repoList.find((candidate) => candidate.id === decoded.repoId);
    const pull = repo?.pullsByNumber.get(decoded.number ?? 0);
    if (!repo || !pull) throw new GqlError('Pull request not found');
    if (pull.state !== 'open' || pull.merged) throw new GqlError('Pull request is already closed');
    if (ctx.store.pullConflicts(repo, pull)) throw new GqlError('Merge conflict');
    ctx.store.mergePull(repo, pull);
    const pullNode = selectFields('PullRequest', { __type: 'pull', repo, number: pull.number }, selection.children.find((child) => child.name === 'pullRequest')?.children ?? [], ctx);
    return { pullRequest: pullNode };
  }
  if (selection.name === 'addComment') {
    const subjectId = inputObj.subjectId as string | undefined;
    const body = inputObj.body as string | undefined;
    if (!subjectId || !body) throw new GqlError('subjectId and body are required');
    const decoded = decodeGlobalId(subjectId);
    if (!decoded) throw new GqlError('Subject not found');
    const repo = ctx.store.repoList.find((candidate) => candidate.id === decoded.repoId);
    if (!repo) throw new GqlError('Subject not found');
    if (decoded.kind === 'issue') {
      const issue = repo.issuesByNumber.get(decoded.number ?? 0);
      if (!issue) throw new GqlError('Issue not found');
      const comment = ctx.store.addComment(repo, issue.number, body);
      const edge = selection.children.find((child) => child.name === 'commentEdge');
      const nodeSelections = edge?.children.find((child) => child.name === 'node')?.children ?? [];
      const node = selectFields('Comment', { __type: 'comment', id: comment.id, body: comment.body, createdAt: comment.createdAt }, nodeSelections, ctx);
      return { commentEdge: { node } };
    }
    if (decoded.kind === 'pull') {
      const pull = repo.pullsByNumber.get(decoded.number ?? 0);
      if (!pull) throw new GqlError('Pull request not found');
      const comment = ctx.store.addComment(repo, pull.number, body);
      const edge = selection.children.find((child) => child.name === 'commentEdge');
      const nodeSelections = edge?.children.find((child) => child.name === 'node')?.children ?? [];
      const node = selectFields('Comment', { __type: 'comment', id: comment.id, body: comment.body, createdAt: comment.createdAt }, nodeSelections, ctx);
      return { commentEdge: { node } };
    }
    throw new GqlError('Subject not found');
  }
  throw new GqlError(`Cannot query field "${selection.name}" on type "Mutation".`);
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export function executeGraphql(
  store: Store,
  body: { query?: string; operationName?: string; variables?: Record<string, unknown> },
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  const ctx: ExecCtx = { store, variables, fragments: {}, errors: [] };
  let doc: GqlDocument;
  try {
    doc = parseGraphql(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  ctx.fragments = doc.fragments;
  const operation = body.operationName !== undefined
    ? doc.operations.find((candidate) => candidate.name === body.operationName) ?? doc.operations[0]
    : doc.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'No operation found' }] };
  // Apply variable defaults.
  for (const [name, def] of Object.entries(operation.variableDefs)) {
    if (variables[name] === undefined && def.defaultValue !== null) {
      variables[name] = resolveValue(def.defaultValue, variables);
    }
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = selectFields(rootType, { __type: 'schema' } as never, operation.selections, ctx);
    // selectFields on the root passes a dummy value; the Query/Mutation branches in
    // resolveField do not read it.
    if (ctx.errors.length > 0) return { data, errors: ctx.errors };
    return { data };
  } catch (err) {
    if (err instanceof GqlError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
