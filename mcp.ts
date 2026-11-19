// The MCP endpoint: JSON-RPC 2.0 over plain JSON at POST /mcp. The modern
// era (2026-07-28) is served: `server/discover` answers the server's
// identity, capabilities and supported revisions in one request, and there
// is no session. The legacy `initialize` handshake is answered too, for a
// client that predates discover. Six tools cover the forge: create_repo,
// get_repo, create_issue, list_issues, create_pull_request and
// merge_pull_request, all over the same store the REST surface reads.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { STORE, type Store } from './store.ts';
import { VIEWER } from './scenario.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { bearerToken, isObject, sendJson } from './http.ts';

/** Everything an MCP handler needs for one request. */
export interface McpRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly body: Buffer;
  readonly requestId: string;
}

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
/** The revisions this server speaks, newest first. */
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** JSON-RPC error codes. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** One tool, as tools/list answers it. Defined once: two calls answer byte-identically. */
interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, Record<string, unknown>>>;
    readonly required: readonly string[];
  };
}

const TOOLS: readonly McpToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner login (the token owner).' }),
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'open, closed or all.', enum: ['open', 'closed', 'all'] }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'number', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

/** Handle one POST /mcp request. `token` is the expected bearer token ('' to skip auth). */
export function handleMcp(ctx: McpRequest, token: string): void {
  const { res, requestId } = ctx;
  if (ctx.method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: METHOD_NOT_FOUND, message: 'Method not found' } }, requestId);
    return;
  }
  if (token !== '' && bearerToken(ctx.req) !== token) {
    // No JSON-RPC body is promised for a refused request: the status is the answer.
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
    res.end(`${JSON.stringify({ message: 'Bad credentials' })}\n`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    sendJson(
      res,
      400,
      { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } },
      requestId,
    );
    return;
  }
  if (!isObject(parsed)) {
    sendJson(
      res,
      200,
      { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request' } },
      requestId,
    );
    return;
  }
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const id = 'id' in parsed ? (parsed.id as string | number | null) : undefined;
  const params = isObject(parsed.params) ? parsed.params : {};

  // A notification has no id: answer 202 and do nothing.
  if (id === undefined) {
    res.writeHead(202, { 'x-github-request-id': requestId });
    res.end();
    return;
  }
  const result = (value: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: value }, requestId);
  };
  const failure = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } }, requestId);
  };

  if (method === '') {
    failure(INVALID_REQUEST, 'Invalid Request: no method');
    return;
  }
  if (method === 'server/discover') {
    result({
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : SUPPORTED_VERSIONS[0] ?? '2026-07-28';
    result({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === 'ping') {
    result({});
    return;
  }
  if (method === 'tools/list') {
    result({ tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isObject(params.arguments) ? params.arguments : {};
    const outcome = callTool(STORE, name, args);
    if (outcome.error !== undefined) {
      failure(outcome.error.code, outcome.error.message);
      return;
    }
    result(outcome.result);
    return;
  }
  failure(METHOD_NOT_FOUND, `Method not found: ${method}`);
}

/** A tool call's outcome: a result, or a JSON-RPC error. */
interface ToolOutcome {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

/** A successful tool result: a JSON text block and the same object structured. */
function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/** A failed tool execution: isError with the reason as text. */
function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** A string argument, or '' when it is absent or not a string. */
function argString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

/** A number argument, or null when it is absent or not a number. */
function argNumber(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Dispatch one tool call. */
function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name');
      if (repoName === '') return { error: { code: INVALID_PARAMS, message: 'create_repo needs a name' } };
      const description = argString(args, 'description');
      const isPrivate = args.private === true;
      const repo = store.createRepo(VIEWER.login, repoName, description, isPrivate);
      if (repo === null) return { result: toolError(`a repository named ${repoName} already exists`) };
      const json = repoJson(repo);
      return { result: toolResult(json) };
    }
    case 'get_repo': {
      const owner = argString(args, 'owner');
      const repoName = argString(args, 'repo');
      if (owner === '' || repoName === '') return { error: { code: INVALID_PARAMS, message: 'get_repo needs owner and repo' } };
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolError(`repository ${owner}/${repoName} not found`) };
      return { result: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const owner = argString(args, 'owner');
      const repoName = argString(args, 'repo');
      const title = argString(args, 'title');
      if (owner === '' || repoName === '' || title === '') {
        return { error: { code: INVALID_PARAMS, message: 'create_issue needs owner, repo and title' } };
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolError(`repository ${owner}/${repoName} not found`) };
      const issue = store.createIssue(repo, { title, body: argString(args, 'body'), labelNames: [] });
      if (issue === null) return { result: toolError('the issue could not be created') };
      return { result: toolResult(issueJson(issue)) };
    }
    case 'list_issues': {
      const owner = argString(args, 'owner');
      const repoName = argString(args, 'repo');
      if (owner === '' || repoName === '') return { error: { code: INVALID_PARAMS, message: 'list_issues needs owner and repo' } };
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolError(`repository ${owner}/${repoName} not found`) };
      const state = argString(args, 'state');
      const filter = state === 'closed' ? 'closed' : state === 'all' ? 'all' : 'open';
      const issues = store.listIssues(repo, filter, 'desc').map(issueJson);
      return {
        result: {
          content: [{ type: 'text', text: JSON.stringify(issues) }],
          structuredContent: { issues },
        },
      };
    }
    case 'create_pull_request': {
      const owner = argString(args, 'owner');
      const repoName = argString(args, 'repo');
      const title = argString(args, 'title');
      const head = argString(args, 'head');
      const base = argString(args, 'base');
      if (owner === '' || repoName === '' || title === '' || head === '' || base === '') {
        return { error: { code: INVALID_PARAMS, message: 'create_pull_request needs owner, repo, title, head and base' } };
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolError(`repository ${owner}/${repoName} not found`) };
      const pull = store.createPull(repo, { title, body: argString(args, 'body'), head, base });
      if (pull === null) return { result: toolError(`head branch ${head} or base branch ${base} does not exist`) };
      return { result: toolResult(pullJson(store, repo, pull)) };
    }
    case 'merge_pull_request': {
      const owner = argString(args, 'owner');
      const repoName = argString(args, 'repo');
      const pullNumber = argNumber(args, 'pull_number');
      if (owner === '' || repoName === '' || pullNumber === null) {
        return { error: { code: INVALID_PARAMS, message: 'merge_pull_request needs owner, repo and pull_number' } };
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolError(`repository ${owner}/${repoName} not found`) };
      const pull = store.getPull(repo, pullNumber);
      if (pull === undefined) return { result: toolError(`pull request #${pullNumber} not found`) };
      const merged = store.mergePull(repo, pull);
      if (!merged.ok) return { result: toolError(`the pull request could not be merged: ${merged.error}`) };
      return { result: toolResult({ merged: true, sha: merged.sha, number: pull.number, state: pull.state }) };
    }
    default:
      return { error: { code: INVALID_PARAMS, message: `unknown tool: ${name}` } };
  }
}
