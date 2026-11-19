// The GraphQL v4 API: a small parser and executor for the documents gh and
// github-mcp-server send (viewer, repository, issues, pull requests, the
// __type feature probes, the create/close/merge/comment mutations), plus
// operation batching. No GraphQL library: the parser reads the document
// text, the executor resolves it against the same store the REST surface
// reads, and global ids are opaque base64 of a type and a key.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { STORE, nowIso, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { VIEWER, userByLogin, type ScenarioUser } from './scenario.ts';
import { bearerToken, isObject, sendJson } from './http.ts';

/** Everything a GraphQL handler needs for one request. */
export interface GraphQLRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly body: Buffer;
  readonly requestId: string;
}

// ---------------------------------------------------------------- tokenizer

type TokenKind =
  | 'name'
  | 'int'
  | 'float'
  | 'string'
  | '{'
  | '}'
  | '('
  | ')'
  | '['
  | ']'
  | ':'
  | '$'
  | '!'
  | '='
  | '@'
  | '...'
  | '|'
  | '&';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

/** Split a document into tokens. Throws a SyntaxError on bad input. */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  const isDigit = (ch: string): boolean => /[0-9]/.test(ch);
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: '...', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === ':' || ch === '$' || ch === '!' || ch === '=' || ch === '@' || ch === '|' || ch === '&') {
      tokens.push({ kind: ch as TokenKind, value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // A string (possibly a block string """).
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end === -1) throw new SyntaxError('an unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < input.length) {
        const c = input[j] as string;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\n') throw new SyntaxError('a string ends before its line does');
        if (c === '\\') {
          const esc = input[j + 1] as string;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else throw new SyntaxError(`a bad string escape \\${esc}`);
          j += 2;
          continue;
        }
        value += c;
        j += 1;
      }
      if (!closed) throw new SyntaxError('an unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || isDigit(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      let isFloat = false;
      while (j < input.length && isDigit(input[j] as string)) j += 1;
      if (input[j] === '.' && isDigit(input[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < input.length && isDigit(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && isDigit(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new SyntaxError(`an unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

/** A literal value in a document. */
type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly items: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: ReadonlyArray<{ readonly name: string; readonly value: ValueNode }> };

/** One field's argument. */
interface ArgNode {
  readonly name: string;
  readonly value: ValueNode;
}

/** One selection: a field, an inline fragment, or a fragment spread. */
type SelectionNode =
  | { readonly kind: 'field'; readonly alias: string | null; readonly name: string; readonly args: readonly ArgNode[]; readonly selections: readonly SelectionNode[] | null }
  | { readonly kind: 'inline-fragment'; readonly typeCondition: string | null; readonly selections: readonly SelectionNode[] }
  | { readonly kind: 'fragment-spread'; readonly name: string };

/** One variable definition: `$name: Type = default`. */
interface VariableDef {
  readonly name: string;
  readonly defaultValue: ValueNode | null;
}

/** One operation (query or mutation) of a document. */
interface OperationNode {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: readonly VariableDef[];
  readonly selections: readonly SelectionNode[];
}

/** One named fragment definition. */
interface FragmentNode {
  readonly name: string;
  readonly typeCondition: string;
  readonly selections: readonly SelectionNode[];
}

/** A parsed document. */
interface DocumentNode {
  readonly operations: readonly OperationNode[];
  readonly fragments: ReadonlyMap<string, FragmentNode>;
}

/** A recursive-descent parser over the token list. */
class Parser {
  private readonly tokens: readonly Token[];
  private pos = 0;

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek() !== null) {
      if (this.peekIsName('fragment')) {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else {
        operations.push(this.parseOperation());
      }
    }
    if (operations.length === 0) throw new SyntaxError('a document holds no operation');
    return { operations, fragments };
  }

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  private peekIsName(name: string): boolean {
    const token = this.peek();
    return token !== null && token.kind === 'name' && token.value === name;
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new SyntaxError('the document ends early');
    this.pos += 1;
    return token;
  }

  private expect(kind: TokenKind): Token {
    const token = this.next();
    if (token.kind !== kind) throw new SyntaxError(`expected ${kind}, got ${token.kind} ${JSON.stringify(token.value)}`);
    return token;
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new SyntaxError(`expected a name, got ${token.kind} ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new SyntaxError(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === '(') this.parseArguments();
    }
  }

  private parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token !== null && token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next !== null && next.kind === 'name') name = this.next().value;
    }
    const variables = this.peek()?.kind === '(' ? this.parseVariableDefinitions() : [];
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseVariableDefinitions(): VariableDef[] {
    this.expect('(');
    const defs: VariableDef[] = [];
    while (this.peek()?.kind !== ')') {
      this.expect('$');
      const name = this.expectName();
      this.expect(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek()?.kind === '=') {
        this.next();
        // A default value is a literal: a variable is not allowed here.
        defaultValue = this.parseValue(false);
      }
      defs.push({ name, defaultValue });
    }
    this.expect(')');
    return defs;
  }

  /** A type reference (`String`, `[IssueState!]`, `Int!`): parsed and discarded. */
  private parseType(): void {
    const token = this.peek();
    if (token?.kind === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === '!') this.next();
  }

  private parseFragment(): FragmentNode {
    this.expectName('fragment');
    const name = this.expectName();
    this.expectName('on');
    const typeCondition = this.expectName();
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { name, typeCondition, selections };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek()?.kind !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek()?.kind === '...') {
      this.next();
      const token = this.peek();
      if (token !== null && token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline-fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (token !== null && token.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragment-spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline-fragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.peek()?.kind === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selections = this.peek()?.kind === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): ArgNode[] {
    this.expect('(');
    const args: ArgNode[] = [];
    while (this.peek()?.kind !== ')') {
      const name = this.expectName();
      this.expect(':');
      args.push({ name, value: this.parseValue(true) });
    }
    this.expect(')');
    return args;
  }

  private parseValue(allowVariable: boolean): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case '$': {
        if (!allowVariable) throw new SyntaxError('a variable is not allowed here');
        return { kind: 'variable', name: this.expectName() };
      }
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(token.value) };
      case '[': {
        const items: ValueNode[] = [];
        while (this.peek()?.kind !== ']') items.push(this.parseValue(allowVariable));
        this.expect(']');
        return { kind: 'list', items };
      }
      case '{': {
        const fields: Array<{ name: string; value: ValueNode }> = [];
        while (this.peek()?.kind !== '}') {
          const name = this.expectName();
          this.expect(':');
          fields.push({ name, value: this.parseValue(allowVariable) });
        }
        this.expect('}');
        return { kind: 'object', fields };
      }
      case 'name': {
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      }
      default:
        throw new SyntaxError(`an unexpected value token ${token.kind}`);
    }
  }
}

// ---------------------------------------------------------------- executor

/** One GraphQL error entry. */
interface GraphQLError {
  readonly message: string;
  readonly path?: ReadonlyArray<string | number>;
}

/** The executor's per-request state. */
interface ExecutorContext {
  readonly store: Store;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly fragments: ReadonlyMap<string, FragmentNode>;
  readonly errors: GraphQLError[];
}

/** Resolve a document value node to a plain JavaScript value. */
function valueFromNode(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => valueFromNode(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromNode(field.value, variables);
      return out;
    }
  }
}

/** Resolve a field's arguments from its document nodes. */
function argsFromNodes(args: readonly ArgNode[], variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = valueFromNode(arg.value, variables);
  return out;
}

/** A value the executor can complete: a scalar, an object tagged with its
 *  GraphQL type, an array of either, or null. */
type GqlValue = unknown;

/** The GraphQL type of a resolved object value. */
function typeOfValue(value: GqlValue): string | null {
  if (isObject(value) && typeof value.__typename === 'string') return value.__typename;
  return null;
}

/** One field resolver: (context, parent, args) -> a value. */
type Resolver = (ctx: ExecutorContext, parent: Record<string, unknown>, args: Record<string, unknown>) => GqlValue;

/** Complete a resolved value against the field's selection set. */
function completeValue(ctx: ExecutorContext, value: GqlValue, selections: readonly SelectionNode[] | null, path: readonly (string | number)[]): GqlValue {
  if (selections === null) {
    // A leaf field: scalars and null pass through; an object asked for with
    // no selection set is a client error, so null it.
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return null;
    return value;
  }
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const itemType = typeOfValue(item);
      if (itemType === null) return item;
      return executeSelectionSet(ctx, itemType, item as Record<string, unknown>, selections, path);
    });
  }
  const typeName = typeOfValue(value);
  if (typeName === null) return null;
  return executeSelectionSet(ctx, typeName, value as Record<string, unknown>, selections, path);
}

/** Execute a selection set against an object of a known type. */
function executeSelectionSet(
  ctx: ExecutorContext,
  typeName: string,
  parent: Record<string, unknown>,
  selections: readonly SelectionNode[],
  path: readonly (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const resolvers = RESOLVERS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const responseKey = selection.alias ?? selection.name;
      const fieldPath = [...path, responseKey];
      if (selection.name === '__typename') {
        out[responseKey] = typeName;
        continue;
      }
      const resolver = resolvers?.[selection.name];
      if (resolver === undefined) {
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".`, path: fieldPath });
        out[responseKey] = null;
        continue;
      }
      const args = argsFromNodes(selection.args, ctx.variables);
      let value: GqlValue;
      try {
        value = resolver(ctx, parent, args);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
        out[responseKey] = null;
        continue;
      }
      out[responseKey] = completeValue(ctx, value, selection.selections, fieldPath);
    } else if (selection.kind === 'inline-fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      Object.assign(out, executeSelectionSet(ctx, typeName, parent, selection.selections, path));
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== typeName) continue;
      Object.assign(out, executeSelectionSet(ctx, typeName, parent, fragment.selections, path));
    }
  }
  return out;
}

/** Run one operation document and build its response object. */
function executeOperation(document: DocumentNode, operationName: string | undefined, variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const errors: GraphQLError[] = [];
  let operation: OperationNode | undefined;
  if (operationName !== undefined) operation = document.operations.find((op) => op.name === operationName);
  if (operation === undefined) operation = document.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'the document holds no operation' }] };
  }
  // Fill in defaults for variables the caller did not pass.
  const merged: Record<string, unknown> = { ...variables };
  for (const def of operation.variables) {
    if (!(def.name in merged) && def.defaultValue !== null) merged[def.name] = valueFromNode(def.defaultValue, variables);
  }
  const ctx: ExecutorContext = { store: STORE, variables: merged, fragments: document.fragments, errors };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, rootType, {}, operation.selections, []);
  const response: Record<string, unknown> = { data };
  if (errors.length > 0) response.errors = errors;
  return response;
}

// ---------------------------------------------------------------- global ids

/** An opaque, stable global id: base64 of a type and a key. */
function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

/** Decode a global id back to its type and key. */
function parseGlobalId(id: string): { readonly kind: string; readonly key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon === -1) return null;
    const kind = text.slice(0, colon);
    const key = text.slice(colon + 1);
    if (kind === '' || key === '') return null;
    return { kind, key };
  } catch {
    return null;
  }
}

/** A cursor for issue pagination: base64 of the created sequence it follows. */
function cursorOf(createdSeq: number): string {
  return Buffer.from(`cursor:${createdSeq}`, 'utf8').toString('base64');
}

/** Decode a pagination cursor back to its created sequence. */
function seqOfCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const seq = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(seq) ? seq : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- values

/** The GraphQL value for a user. */
function userValue(user: ScenarioUser): Record<string, unknown> {
  return { __typename: 'User', id: globalId('User', String(user.id)), login: user.login, name: user.name, email: user.email };
}

/** The GraphQL value for a repository. */
function repoValue(repo: Repo): Record<string, unknown> {
  return { __typename: 'Repository', repo };
}

/** The GraphQL value for an issue. */
function issueValue(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __typename: 'Issue', repo, issue };
}

/** The GraphQL value for a pull request. */
function pullValue(repo: Repo, pull: Pull): Record<string, unknown> {
  return { __typename: 'PullRequest', repo, pull };
}

/** The GraphQL state enum for an issue. */
function issueState(issue: Issue): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

/** The GraphQL state enum for a pull request. */
function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

/** Look a repository up by its numeric id. */
function repoById(store: Store, id: number): Repo | null {
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return null;
}

/** Resolve a global id to the repository it names, or null. */
function repoFromGlobalId(store: Store, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  const numeric = Number.parseInt(parsed.key, 10);
  if (!Number.isFinite(numeric)) return null;
  return repoById(store, numeric);
}

/** Resolve a global id to the issue it names, or null. */
function issueFromGlobalId(store: Store, id: string): { readonly repo: Repo; readonly issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const [repoIdText, numberText] = parsed.key.split(':');
  const repoId = Number.parseInt(repoIdText ?? '', 10);
  const number = Number.parseInt(numberText ?? '', 10);
  if (!Number.isFinite(repoId) || !Number.isFinite(number)) return null;
  const repo = repoById(store, repoId);
  if (repo === null) return null;
  const issue = store.getIssue(repo, number) ?? null;
  if (issue === null) return null;
  return { repo, issue };
}

/** Resolve a global id to the pull request it names, or null. */
function pullFromGlobalId(store: Store, id: string): { readonly repo: Repo; readonly pull: Pull } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const [repoIdText, numberText] = parsed.key.split(':');
  const repoId = Number.parseInt(repoIdText ?? '', 10);
  const number = Number.parseInt(numberText ?? '', 10);
  if (!Number.isFinite(repoId) || !Number.isFinite(number)) return null;
  const repo = repoById(store, repoId);
  if (repo === null) return null;
  const pull = store.getPull(repo, number) ?? null;
  if (pull === null) return null;
  return { repo, pull };
}

// ---------------------------------------------------------------- resolvers

/** The field resolvers, per type. The introspection field lists are derived
 *  from these, so a listed field is always one the executor can answer. */
const RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: () => userValue(VIEWER),
    repository: (ctx, _parent, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = ctx.store.getRepo(owner, name) ?? null;
      return repo === null ? null : repoValue(repo);
    },
    node: (ctx, _parent, args) => {
      const id = typeof args.id === 'string' ? args.id : '';
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = repoFromGlobalId(ctx.store, id);
        return repo === null ? null : repoValue(repo);
      }
      if (parsed.kind === 'Issue') {
        const found = issueFromGlobalId(ctx.store, id);
        return found === null ? null : issueValue(found.repo, found.issue);
      }
      if (parsed.kind === 'PullRequest') {
        const found = pullFromGlobalId(ctx.store, id);
        return found === null ? null : pullValue(found.repo, found.pull);
      }
      return null;
    },
    __type: (_ctx, _parent, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (!(name in RESOLVERS) && !(name in ENUM_TYPES)) return null;
      return { __typename: '__Type', typeName: name };
    },
    __schema: () => ({ __typename: '__Schema', description: null }),
  },
  Mutation: {
    createIssue: (ctx, _parent, args) => {
      const input = isObject(args.input) ? args.input : {};
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const repo = repoFromGlobalId(ctx.store, repositoryId);
      if (repo === null) throw new Error('the repositoryId names no repository');
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = ctx.store.createIssue(repo, { title, body, labelNames: [] });
      if (issue === null) throw new Error('the issue could not be created');
      return { __typename: 'CreateIssuePayload', issue: issueValue(repo, issue) };
    },
    closeIssue: (ctx, _parent, args) => {
      const input = isObject(args.input) ? args.input : {};
      const issueId = typeof input.issueId === 'string' ? input.issueId : '';
      const found = issueFromGlobalId(ctx.store, issueId);
      if (found === null) throw new Error('the issueId names no issue');
      const now = nowIso();
      found.issue.state = 'closed';
      found.issue.closedAt = now;
      found.issue.updatedAt = now;
      return { __typename: 'CloseIssuePayload', issue: issueValue(found.repo, found.issue) };
    },
    createPullRequest: (ctx, _parent, args) => {
      const input = isObject(args.input) ? args.input : {};
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const repo = repoFromGlobalId(ctx.store, repositoryId);
      if (repo === null) throw new Error('the repositoryId names no repository');
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const pull = ctx.store.createPull(repo, { title, body: '', head, base });
      if (pull === null) throw new Error('the pull request could not be created');
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull) };
    },
    mergePullRequest: (ctx, _parent, args) => {
      const input = isObject(args.input) ? args.input : {};
      const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const found = pullFromGlobalId(ctx.store, pullRequestId);
      if (found === null) throw new Error('the pullRequestId names no pull request');
      const merged = ctx.store.mergePull(found.repo, found.pull);
      if (!merged.ok) throw new Error(`the pull request cannot be merged: ${merged.error}`);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(found.repo, found.pull) };
    },
    addComment: (ctx, _parent, args) => {
      const input = isObject(args.input) ? args.input : {};
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issueFound = issueFromGlobalId(ctx.store, subjectId);
      const pullFound = issueFound === null ? pullFromGlobalId(ctx.store, subjectId) : null;
      if (issueFound === null && pullFound === null) throw new Error('the subjectId names no issue or pull request');
      const repo = issueFound !== null ? issueFound.repo : (pullFound as { repo: Repo }).repo;
      const number = issueFound !== null ? issueFound.issue.number : (pullFound as { pull: Pull }).pull.number;
      const comment =
        issueFound !== null
          ? ctx.store.addIssueComment(repo, issueFound.issue, body)
          : ctx.store.addPullComment(repo, (pullFound as { pull: Pull }).pull, body);
      const node = { __typename: 'IssueComment', id: globalId('IssueComment', `${repo.id}:${number}:${comment.id}`), body: comment.body };
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node, cursor: '' } };
    },
  },
  User: {
    id: (_ctx, parent) => parent.id,
    login: (_ctx, parent) => parent.login,
    name: (_ctx, parent) => parent.name,
    email: (_ctx, parent) => parent.email,
  },
  Repository: {
    id: (_ctx, parent) => globalId('Repository', String((parent.repo as Repo).id)),
    databaseId: (_ctx, parent) => (parent.repo as Repo).id,
    name: (_ctx, parent) => (parent.repo as Repo).name,
    nameWithOwner: (_ctx, parent) => `${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}`,
    description: (_ctx, parent) => (parent.repo as Repo).description,
    isPrivate: (_ctx, parent) => (parent.repo as Repo).private,
    owner: (_ctx, parent) => userValue(userByLogin((parent.repo as Repo).owner) ?? VIEWER),
    defaultBranchRef: (_ctx, parent) => {
      const repo = parent.repo as Repo;
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return { __typename: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (_ctx, parent) => (parent.repo as Repo).createdAt,
    updatedAt: (_ctx, parent) => (parent.repo as Repo).updatedAt,
    issue: (ctx, parent, args) => {
      const repo = parent.repo as Repo;
      const number = typeof args.number === 'number' ? args.number : -1;
      const issue = ctx.store.getIssue(repo, number) ?? null;
      return issue === null ? null : issueValue(repo, issue);
    },
    issues: (_ctx, parent, args) => issueConnection(parent.repo as Repo, args),
    pullRequests: (ctx, parent, args) => {
      const repo = parent.repo as Repo;
      const first = typeof args.first === 'number' ? args.first : 30;
      const pulls = ctx.store.listPulls(repo, 'open').slice(0, Math.max(0, Math.min(100, first)));
      return { __typename: 'PullRequestConnection', nodes: pulls.map((pull) => pullValue(repo, pull)) };
    },
    pullRequest: (ctx, parent, args) => {
      const repo = parent.repo as Repo;
      const number = typeof args.number === 'number' ? args.number : -1;
      const pull = ctx.store.getPull(repo, number) ?? null;
      return pull === null ? null : pullValue(repo, pull);
    },
  },
  Issue: {
    id: (_ctx, parent) => globalId('Issue', `${(parent.repo as Repo).id}:${(parent.issue as Issue).number}`),
    number: (_ctx, parent) => (parent.issue as Issue).number,
    title: (_ctx, parent) => (parent.issue as Issue).title,
    body: (_ctx, parent) => (parent.issue as Issue).body,
    state: (_ctx, parent) => issueState(parent.issue as Issue),
    author: (_ctx, parent) => userValue((parent.issue as Issue).user),
    createdAt: (_ctx, parent) => (parent.issue as Issue).createdAt,
    updatedAt: (_ctx, parent) => (parent.issue as Issue).updatedAt,
    closedAt: (_ctx, parent) => (parent.issue as Issue).closedAt,
  },
  IssueConnection: {
    nodes: (_ctx, parent) => parent.nodes,
    pageInfo: (_ctx, parent) => parent.pageInfo,
  },
  PageInfo: {
    hasNextPage: (_ctx, parent) => parent.hasNextPage,
    endCursor: (_ctx, parent) => parent.endCursor,
  },
  PullRequest: {
    id: (_ctx, parent) => globalId('PullRequest', `${(parent.repo as Repo).id}:${(parent.pull as Pull).number}`),
    number: (_ctx, parent) => (parent.pull as Pull).number,
    title: (_ctx, parent) => (parent.pull as Pull).title,
    body: (_ctx, parent) => (parent.pull as Pull).body,
    state: (_ctx, parent) => pullState(parent.pull as Pull),
    merged: (_ctx, parent) => (parent.pull as Pull).merged,
    headRefName: (_ctx, parent) => (parent.pull as Pull).head,
    baseRefName: (_ctx, parent) => (parent.pull as Pull).base,
    mergeable: (ctx, parent) => ctx.store.pullMergeable(parent.repo as Repo, parent.pull as Pull),
    author: (_ctx, parent) => userValue((parent.pull as Pull).user),
    createdAt: (_ctx, parent) => (parent.pull as Pull).createdAt,
    updatedAt: (_ctx, parent) => (parent.pull as Pull).updatedAt,
    closedAt: (_ctx, parent) => (parent.pull as Pull).closedAt,
    mergedAt: (_ctx, parent) => (parent.pull as Pull).mergedAt,
    files: (ctx, parent, args) => {
      const repo = parent.repo as Repo;
      const pull = parent.pull as Pull;
      const first = typeof args.first === 'number' ? args.first : 30;
      const files = (ctx.store.pullFiles(repo, pull) ?? []).slice(0, Math.max(0, Math.min(100, first)));
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: files.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename })),
      };
    },
  },
  PullRequestConnection: {
    nodes: (_ctx, parent) => parent.nodes,
    pageInfo: (_ctx, parent) => parent.pageInfo,
  },
  PullRequestChangedFileConnection: {
    nodes: (_ctx, parent) => parent.nodes,
  },
  PullRequestChangedFile: {
    path: (_ctx, parent) => parent.path,
  },
  Ref: {
    name: (_ctx, parent) => parent.name,
  },
  CreateIssuePayload: {
    issue: (_ctx, parent) => parent.issue,
  },
  CloseIssuePayload: {
    issue: (_ctx, parent) => parent.issue,
  },
  CreatePullRequestPayload: {
    pullRequest: (_ctx, parent) => parent.pullRequest,
  },
  MergePullRequestPayload: {
    pullRequest: (_ctx, parent) => parent.pullRequest,
  },
  AddCommentPayload: {
    commentEdge: (_ctx, parent) => parent.commentEdge,
  },
  IssueCommentEdge: {
    node: (_ctx, parent) => parent.node,
    cursor: (_ctx, parent) => parent.cursor,
  },
  IssueComment: {
    id: (_ctx, parent) => parent.id,
    body: (_ctx, parent) => parent.body,
  },
  __Type: {
    name: (_ctx, parent) => parent.typeName,
    kind: (_ctx, parent) => (parent.typeName as string) in ENUM_TYPES ? 'ENUM' : 'OBJECT',
    description: () => null,
    fields: (_ctx, parent) => {
      const name = parent.typeName as string;
      if (name in ENUM_TYPES) return null;
      const fields = RESOLVERS[name];
      if (fields === undefined) return null;
      return Object.keys(fields).map((field) => ({ __typename: '__Field', name: field }));
    },
    enumValues: (_ctx, parent) => {
      const name = parent.typeName as string;
      const values = ENUM_TYPES[name];
      if (values === undefined) return null;
      return values.map((value) => ({ __typename: '__EnumValue', name: value }));
    },
  },
  __Field: {
    name: (_ctx, parent) => parent.name,
    description: () => null,
  },
  __EnumValue: {
    name: (_ctx, parent) => parent.name,
    description: () => null,
  },
  __Schema: {
    description: () => null,
  },
};

/** The enum types introspection knows about. */
const ENUM_TYPES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

/** Build the issues connection for a repository: states filter, orderBy,
 *  first/after cursor pagination, and a pageInfo the client can walk. */
function issueConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).filter((entry): entry is string => typeof entry === 'string') : null;
  const orderBy = isObject(args.orderBy) ? args.orderBy : {};
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  const field = orderBy.field === 'UPDATED_AT' ? 'UPDATED_AT' : orderBy.field === 'COMMENTS' ? 'COMMENTS' : 'CREATED_AT';
  const first = typeof args.first === 'number' ? Math.max(0, Math.min(100, args.first)) : 30;
  const afterSeq = typeof args.after === 'string' && args.after !== '' ? seqOfCursor(args.after) : null;

  let issues = [...repo.issues.values()];
  if (states !== null) {
    issues = issues.filter((issue) => states.includes(issueState(issue)));
  }
  issues.sort((a, b) => {
    let cmp: number;
    if (field === 'COMMENTS') cmp = a.comments.length - b.comments.length;
    // ISO timestamps sort lexicographically, so a string comparison orders
    // updatedAt; ties (same second) fall through to the creation order.
    else if (field === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.createdSeq - b.createdSeq;
    else cmp = a.createdSeq - b.createdSeq;
    if (cmp === 0) cmp = a.number - b.number;
    return direction === 'ASC' ? cmp : -cmp;
  });
  if (afterSeq !== null) {
    // Skip everything up to and including the item the cursor names.
    const index = issues.findIndex((issue) => issue.createdSeq === afterSeq);
    issues = index === -1 ? [] : issues.slice(index + 1);
  }
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length > 0 ? cursorOf((page[page.length - 1] as Issue).createdSeq) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueValue(repo, issue)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

// ---------------------------------------------------------------- handler

/** Run one GraphQL operation document from a request body object. */
function executeRequestBody(body: unknown): Record<string, unknown> {
  if (!isObject(body)) {
    return { data: null, errors: [{ message: 'the request body must be a JSON object with a query field' }] };
  }
  const query = body.query;
  if (typeof query !== 'string' || query === '') {
    return { data: null, errors: [{ message: 'the request body holds no query' }] };
  }
  const variables = isObject(body.variables) ? body.variables : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? `Syntax Error: ${err.message}` : 'Syntax Error' }] };
  }
  return executeOperation(document, operationName, variables);
}

/** Handle POST /api/graphql, including batched operation arrays.
 *  `token` is the expected bearer token ('' to skip auth). */
export function handleGraphQL(request: GraphQLRequest, token: string): void {
  const { req, res, method, body, requestId } = request;
  if (method !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return;
  }
  if (token !== '' && bearerToken(req) !== token) {
    sendJson(res, 401, { message: 'Bad credentials' }, requestId);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.length === 0 ? 'null' : body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }, requestId);
    return;
  }
  if (Array.isArray(parsed)) {
    const responses = parsed.map((entry) => executeRequestBody(entry));
    sendJson(res, 200, responses, requestId);
    return;
  }
  sendJson(res, 200, executeRequestBody(parsed), requestId);
}
