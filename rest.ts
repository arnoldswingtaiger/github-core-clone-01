// The REST v3 API: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, as GitHub shapes them. Every reply is
// application/json with a non-empty X-GitHub-Request-Id; errors carry a
// string `message`. A request without the bearer token is 401 (except the
// API root, which the starter answers unauthenticated); a repository under
// another owner is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { commitMessageText, isOid, type ParsedCommit } from './gitobj.ts';
import {
  STORE,
  nowIso,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { VIEWER, userByLogin, type ScenarioUser } from './scenario.ts';
import {
  OAUTH_SCOPES,
  bearerToken,
  booleanField,
  intQuery,
  isObject,
  parseJsonBody,
  sendEmpty,
  sendError,
  sendJson,
  stringField,
} from './http.ts';

/** Everything a REST handler needs for one request. */
export interface RestRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  /** The decoded path segments after `/api/v3`. */
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly body: Buffer;
  readonly requestId: string;
  /** The request's Host header, for absolute Link URLs. */
  readonly host: string;
  /** The path part of the URL (for Link headers). */
  readonly pathname: string;
}

// ---------------------------------------------------------------- serializers

/** A user object, as the API shapes it. */
export function userJson(user: ScenarioUser): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    name: user.name,
    email: user.email,
    type: 'User',
    site_admin: false,
    avatar_url: `https://example.invalid/avatars/${user.login}`,
    html_url: `https://example.invalid/${user.login}`,
    url: `/api/v3/users/${user.login}`,
  };
}

/** A repository object. */
export function repoJson(repo: Repo): Record<string, unknown> {
  const owner = userByLogin(repo.owner) ?? VIEWER;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

/** A label object. */
export function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, default: false };
}

/** A comment object. */
export function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://example.invalid/comments/${comment.id}`,
    url: `/api/v3/comments/${comment.id}`,
  };
}

/** An issue object. */
export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: userJson(issue.user),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `https://example.invalid/issues/${issue.number}`,
    url: `/api/v3/issues/${issue.number}`,
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
  };
}

/** A pull request object. Head/base shas are the branches' live tips. */
export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = store.branchTip(repo, pull.head) ?? pull.headSha;
  const baseSha = store.branchTip(repo, pull.base) ?? pull.baseSha;
  const headRepo = repoJson(repo);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: {
      ref: pull.head,
      sha: headSha,
      label: `${repo.owner}:${pull.head}`,
      user: userJson(VIEWER),
      repo: headRepo,
    },
    base: {
      ref: pull.base,
      sha: baseSha,
      label: `${repo.owner}:${pull.base}`,
      user: userJson(VIEWER),
      repo: headRepo,
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? store.pullMergeable(repo, pull) === 'MERGEABLE' : null,
    user: userJson(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    comments: pull.comments.length,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
    locked: false,
  };
}

/** A commit object, as GET /commits shapes it. */
function commitJson(store: Store, repo: Repo, sha: string, commit: ParsedCommit): Record<string, unknown> {
  const author = identityParts(commit.author);
  const committer = identityParts(commit.committer);
  return {
    sha,
    commit: {
      message: commitMessageText(commit),
      author: { name: author.name, email: author.email, date: new Date(commit.authorTime * 1000).toISOString() },
      committer: { name: committer.name, email: committer.email, date: new Date(commit.committerTime * 1000).toISOString() },
    },
    author: author.email === VIEWER.email ? userJson(VIEWER) : null,
    committer: committer.email === VIEWER.email ? userJson(VIEWER) : null,
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

/** Split a `Name <email> ts tz` identity line into its name and email. */
function identityParts(identity: string): { name: string; email: string } {
  const match = /^(.*?) <([^>]*)>/.exec(identity.trim());
  if (match === null) return { name: identity.trim(), email: '' };
  return { name: (match[1] as string).trim(), email: (match[2] as string).trim() };
}

// ---------------------------------------------------------------- pagination

/** One page of a list, plus the Link header for it (null when a single page). */
function paginate(
  ctx: RestRequest,
  items: readonly unknown[],
): { page: unknown[]; link: string | null } {
  const perPage = intQuery(ctx.query, 'per_page', 30, 1, 100);
  const page = intQuery(ctx.query, 'page', 1, 1, 1_000_000);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `http://${ctx.host}${ctx.pathname}?${params.toString()}`;
  };
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page: pageItems, link: totalPages > 1 ? links.join(', ') : null };
}

// ---------------------------------------------------------------- the router

/** Handle one /api/v3 request. `token` is the expected bearer token ('' to skip auth). */
export function handleRest(ctx: RestRequest, token: string): void {
  const { res, requestId } = ctx;
  const scopes = { 'x-oauth-scopes': OAUTH_SCOPES };
  const ok = (status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void => {
    sendJson(res, status, body, requestId, { ...scopes, ...headers });
  };
  const err = (status: number, message: string): void => sendError(res, status, message, requestId);

  // The API root: the starter answers it without a token.
  if (ctx.segments.length === 0) {
    if (ctx.method !== 'GET') {
      err(404, 'Not Found');
      return;
    }
    ok(200, {
      current_user_url: '/api/v3/user',
      current_user_repos_url: '/api/v3/user/repos',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    });
    return;
  }

  // Everything else needs the bearer token.
  if (token !== '' && bearerToken(ctx.req) !== token) {
    err(401, 'Bad credentials');
    return;
  }

  const segments = ctx.segments;
  const store = STORE;

  // GET /api/v3/meta
  if (segments[0] === 'meta' && segments.length === 1) {
    if (ctx.method !== 'GET') {
      err(404, 'Not Found');
      return;
    }
    ok(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return;
  }

  // GET /api/v3/user
  if (segments[0] === 'user' && segments.length === 1) {
    if (ctx.method !== 'GET') {
      err(404, 'Not Found');
      return;
    }
    ok(200, userJson(VIEWER));
    return;
  }

  // /api/v3/user/repos
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (ctx.method === 'GET') {
      const repos = store.reposOf(VIEWER.login).map(repoJson);
      const { page, link } = paginate(ctx, repos);
      ok(200, page, link === null ? {} : { link });
      return;
    }
    if (ctx.method === 'POST') {
      const parsed = parseJsonBody(ctx.body);
      if (!parsed.ok) {
        err(400, 'Problems parsing JSON');
        return;
      }
      if (!isObject(parsed.value)) {
        err(400, 'Problems parsing JSON');
        return;
      }
      const name = stringField(parsed.value, 'name');
      if (name === '') {
        err(422, 'Validation Failed: name is required');
        return;
      }
      const repo = store.createRepo(
        VIEWER.login,
        name,
        stringField(parsed.value, 'description'),
        booleanField(parsed.value, 'private', false),
      );
      if (repo === null) {
        err(422, `Validation Failed: name already exists on this account`);
        return;
      }
      ok(201, repoJson(repo));
      return;
    }
    err(404, 'Not Found');
    return;
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = store.getRepo(owner, name);
    if (repo === undefined) {
      err(404, 'Not Found');
      return;
    }
    handleRepo(ctx, store, repo, segments.slice(3), ok, err);
    return;
  }

  err(404, 'Not Found');
}

type OkFn = (status: number, body: unknown, headers?: Readonly<Record<string, string>>) => void;
type ErrFn = (status: number, message: string) => void;

/** Handle a request under one repository. `rest` is the path after /repos/{o}/{r}. */
function handleRepo(
  ctx: RestRequest,
  store: Store,
  repo: Repo,
  rest: string[],
  ok: OkFn,
  err: ErrFn,
): void {
  const method = ctx.method;

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      ok(200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(ctx.body);
      if (!parsed.ok) {
        err(400, 'Problems parsing JSON');
        return;
      }
      if (isObject(parsed.value)) {
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
        repo.updatedAt = nowIso();
      }
      ok(200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      sendEmpty(ctx.res, 204, ctx.requestId);
      return;
    }
    err(404, 'Not Found');
    return;
  }

  const head = rest[0] as string;

  // Branches.
  if (head === 'branches') {
    if (method !== 'GET') {
      err(404, 'Not Found');
      return;
    }
    if (rest.length === 1) {
      ok(
        200,
        store.branches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha }, protected: false })),
      );
      return;
    }
    const branch = rest.slice(1).join('/');
    const tip = store.branchTip(repo, branch);
    if (tip === undefined) {
      err(404, 'Branch not found');
      return;
    }
    ok(200, { name: branch, commit: { sha: tip }, protected: false });
    return;
  }

  // Commits.
  if (head === 'commits') {
    if (method !== 'GET') {
      err(404, 'Not Found');
      return;
    }
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveToCommit(repo, ref);
    if (tip === null) {
      // An unborn repository has no commits at all; an unknown ref is a 404.
      if (repo.refs.size === 0) {
        ok(200, []);
        return;
      }
      err(404, 'No commit found for SHA: ' + ref);
      return;
    }
    ok(
      200,
      store.listCommits(repo, tip).map(({ sha, commit }) => commitJson(store, repo, sha, commit)),
    );
    return;
  }

  // Git refs.
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseJsonBody(ctx.body);
      if (!parsed.ok) {
        err(400, 'Problems parsing JSON');
        return;
      }
      if (!isObject(parsed.value)) {
        err(400, 'Problems parsing JSON');
        return;
      }
      const ref = stringField(parsed.value, 'ref');
      const sha = stringField(parsed.value, 'sha').toLowerCase();
      if (ref === '' || !isOid(sha)) {
        err(422, 'Validation Failed: ref and sha are required');
        return;
      }
      if (repo.refs.has(ref)) {
        err(422, 'Validation Failed: Reference already exists');
        return;
      }
      if (store.getObject(repo, sha) === undefined) {
        err(422, 'Validation Failed: Invalid SHA');
        return;
      }
      repo.refs.set(ref, sha);
      ok(201, { ref, object: { sha, type: store.getObject(repo, sha)?.type ?? 'commit' }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}` });
      return;
    }
    if (method === 'GET') {
      if (rest.length === 2) {
        const refs = [...repo.refs.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([ref, sha]) => ({ ref, object: { sha, type: store.getObject(repo, sha)?.type ?? 'commit' } }));
        ok(200, refs);
        return;
      }
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        err(404, 'Not Found');
        return;
      }
      ok(200, { ref, object: { sha, type: store.getObject(repo, sha)?.type ?? 'commit' } });
      return;
    }
    err(404, 'Not Found');
    return;
  }

  // Contents.
  if (head === 'contents') {
    handleContents(ctx, store, repo, rest.slice(1).join('/'), ok, err);
    return;
  }

  // Labels.
  if (head === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      ok(200, [...repo.labels.values()].map(labelJson));
      return;
    }
    if (method === 'POST' && rest.length === 1) {
      const parsed = parseJsonBody(ctx.body);
      if (!parsed.ok) {
        err(400, 'Problems parsing JSON');
        return;
      }
      if (!isObject(parsed.value)) {
        err(400, 'Problems parsing JSON');
        return;
      }
      const name = stringField(parsed.value, 'name');
      if (name === '') {
        err(422, 'Validation Failed: name is required');
        return;
      }
      const label = store.createLabel(repo, name, stringField(parsed.value, 'color', 'ededed'));
      ok(201, labelJson(label));
      return;
    }
    err(404, 'Not Found');
    return;
  }

  // Issues.
  if (head === 'issues') {
    handleIssues(ctx, store, repo, rest.slice(1), ok, err);
    return;
  }

  // Pull requests.
  if (head === 'pulls') {
    handlePulls(ctx, store, repo, rest.slice(1), ok, err);
    return;
  }

  err(404, 'Not Found');
}

// ---------------------------------------------------------------- contents

/** Handle GET/PUT/DELETE /contents/{path}. */
function handleContents(
  ctx: RestRequest,
  store: Store,
  repo: Repo,
  path: string,
  ok: OkFn,
  err: ErrFn,
): void {
  const method = ctx.method;
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    err(422, 'Validation Failed: invalid path');
    return;
  }

  if (method === 'GET') {
    const ref = ctx.query.get('ref') ?? repo.defaultBranch;
    const tip = store.resolveToCommit(repo, ref);
    if (tip === null) {
      err(404, 'Not Found');
      return;
    }
    if (segments.length === 0) {
      const entries = store.listDir(repo, tip, '');
      if (entries === null) {
        err(404, 'Not Found');
        return;
      }
      ok(200, entries.map((entry) => dirEntryJson(store, repo, entry, '')));
      return;
    }
    const found = store.readPath(repo, tip, path);
    if (found === null) {
      err(404, 'Not Found');
      return;
    }
    if (found.mode === '40000') {
      const entries = store.listDir(repo, tip, path);
      if (entries === null) {
        err(404, 'Not Found');
        return;
      }
      ok(200, entries.map((entry) => dirEntryJson(store, repo, entry, path)));
      return;
    }
    ok(200, {
      type: 'file',
      encoding: 'base64',
      size: found.data.length,
      name: segments[segments.length - 1],
      path,
      content: found.data.toString('base64'),
      sha: found.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/${ref}/${path}`,
      git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${found.oid}`,
      download_url: null,
    });
    return;
  }

  if (method === 'PUT') {
    const parsed = parseJsonBody(ctx.body);
    if (!parsed.ok) {
      err(400, 'Problems parsing JSON');
      return;
    }
    if (!isObject(parsed.value)) {
      err(400, 'Problems parsing JSON');
      return;
    }
    if (segments.length === 0) {
      err(422, 'Validation Failed: path is required');
      return;
    }
    const message = stringField(parsed.value, 'message');
    const contentB64 = stringField(parsed.value, 'content');
    if (message === '' || contentB64 === '') {
      err(422, 'Validation Failed: message and content are required');
      return;
    }
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      err(422, 'Validation Failed: content is not valid base64');
      return;
    }
    const branch = stringField(parsed.value, 'branch', repo.defaultBranch);
    const sha = stringField(parsed.value, 'sha');
    const tip = store.branchTip(repo, branch);
    const baseTree =
      tip === undefined
        ? store.putObject(repo, 'tree', Buffer.from([]))
        : (() => {
            const commit = store.parseCommitOf(repo, tip);
            return commit === null ? null : commit.tree;
          })();
    if (baseTree === null) {
      err(404, 'Branch not found');
      return;
    }
    if (tip === undefined && repo.refs.size > 0 && store.branchTip(repo, branch) === undefined) {
      // The branch does not exist on a repository that has commits.
      err(404, 'Branch not found');
      return;
    }
    const current = tip === undefined ? null : store.readPath(repo, tip, path);
    if (sha !== '') {
      if (current === null || current.oid.toLowerCase() !== sha.toLowerCase()) {
        err(409, 'Conflict: the file has changed since the given sha');
        return;
      }
    } else if (current !== null) {
      err(422, 'Validation Failed: file already exists; send its sha to update it');
      return;
    }
    const blobOid = store.putObject(repo, 'blob', content);
    const treeOid = store.writePath(repo, baseTree, segments, blobOid);
    const commitSha = store.createServerCommit(repo, treeOid, tip === undefined ? [] : [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.updatedAt = nowIso();
    ok(sha === '' ? 201 : 200, {
      content: {
        name: segments[segments.length - 1],
        path,
        sha: blobOid,
        size: content.length,
        encoding: 'base64',
        type: 'file',
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      },
      commit: {
        sha: commitSha,
        message,
        author: { name: VIEWER.name, email: VIEWER.email, date: nowIso() },
        committer: { name: VIEWER.name, email: VIEWER.email, date: nowIso() },
      },
    });
    return;
  }

  if (method === 'DELETE') {
    const parsed = parseJsonBody(ctx.body);
    if (!parsed.ok) {
      err(400, 'Problems parsing JSON');
      return;
    }
    if (!isObject(parsed.value)) {
      err(400, 'Problems parsing JSON');
      return;
    }
    const message = stringField(parsed.value, 'message');
    const sha = stringField(parsed.value, 'sha');
    const branch = stringField(parsed.value, 'branch', repo.defaultBranch);
    const tip = store.branchTip(repo, branch);
    if (tip === undefined) {
      err(404, 'Not Found');
      return;
    }
    const current = store.readPath(repo, tip, path);
    if (current === null || current.mode === '40000') {
      err(404, 'Not Found');
      return;
    }
    if (sha !== '' && current.oid.toLowerCase() !== sha.toLowerCase()) {
      err(409, 'Conflict: the file has changed since the given sha');
      return;
    }
    const commit = store.parseCommitOf(repo, tip);
    if (commit === null) {
      err(404, 'Not Found');
      return;
    }
    const treeOid = store.deletePath(repo, commit.tree, segments);
    if (treeOid === null) {
      err(404, 'Not Found');
      return;
    }
    const commitSha = store.createServerCommit(repo, treeOid, [tip], message === '' ? `Delete ${path}` : message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.updatedAt = nowIso();
    ok(200, {
      commit: {
        sha: commitSha,
        message: message === '' ? `Delete ${path}` : message,
        author: { name: VIEWER.name, email: VIEWER.email, date: nowIso() },
        committer: { name: VIEWER.name, email: VIEWER.email, date: nowIso() },
      },
    });
    return;
  }

  err(404, 'Not Found');
}

/** One entry of a directory listing. */
function dirEntryJson(store: Store, repo: Repo, entry: { mode: string; name: string; oid: string }, dir: string): Record<string, unknown> {
  const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
  const isDir = entry.mode === '40000';
  const size = isDir ? 0 : store.getObject(repo, entry.oid)?.data.length ?? 0;
  return {
    type: isDir ? 'dir' : 'file',
    size,
    name: entry.name,
    path,
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
    download_url: isDir ? null : `https://example.invalid/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
  };
}

// ---------------------------------------------------------------- issues

/** Handle the /issues routes. `rest` is the path after /issues. */
function handleIssues(
  ctx: RestRequest,
  store: Store,
  repo: Repo,
  rest: string[],
  ok: OkFn,
  err: ErrFn,
): void {
  const method = ctx.method;

  if (rest.length === 0) {
    if (method === 'GET') {
      const stateParam = ctx.query.get('state') ?? 'open';
      const state = stateParam === 'closed' ? 'closed' : stateParam === 'all' ? 'all' : 'open';
      const direction = ctx.query.get('direction') === 'asc' ? 'asc' : 'desc';
      const issues = store.listIssues(repo, state, direction).map(issueJson);
      const { page, link } = paginate(ctx, issues);
      ok(200, page, link === null ? {} : { link });
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx.body);
      if (!parsed.ok) {
        err(400, 'Problems parsing JSON');
        return;
      }
      if (!isObject(parsed.value)) {
        err(400, 'Problems parsing JSON');
        return;
      }
      const title = stringField(parsed.value, 'title');
      if (title === '') {
        err(422, 'Validation Failed: title is required');
        return;
      }
      const rawLabels = parsed.value.labels;
      const labelNames: string[] = [];
      if (Array.isArray(rawLabels)) {
        for (const entry of rawLabels) {
          if (typeof entry === 'string') labelNames.push(entry);
          else if (isObject(entry) && typeof entry.name === 'string') labelNames.push(entry.name);
        }
      }
      const issue = store.createIssue(repo, {
        title,
        body: stringField(parsed.value, 'body'),
        labelNames,
      });
      if (issue === null) {
        err(422, 'Validation Failed: one of the labels does not exist');
        return;
      }
      ok(201, issueJson(issue));
      return;
    }
    err(404, 'Not Found');
    return;
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isSafeInteger(number) || number < 1 || String(number) !== rest[0]) {
    err(404, 'Not Found');
    return;
  }
  const issue = store.getIssue(repo, number);

  if (rest.length === 1) {
    if (issue === undefined) {
      err(404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      ok(200, issueJson(issue));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(ctx.body);
      if (!parsed.ok) {
        err(400, 'Problems parsing JSON');
        return;
      }
      if (!isObject(parsed.value)) {
        err(400, 'Problems parsing JSON');
        return;
      }
      if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') {
        issue.state = parsed.value.state;
        issue.closedAt = issue.state === 'closed' ? nowIso() : null;
      }
      if (Array.isArray(parsed.value.labels)) {
        const labels: Label[] = [];
        for (const entry of parsed.value.labels as unknown[]) {
          const name = typeof entry === 'string' ? entry : isObject(entry) ? stringField(entry, 'name') : '';
          if (name === '') continue;
          const label = repo.labels.get(name.toLowerCase());
          if (label === undefined) {
            err(422, 'Validation Failed: one of the labels does not exist');
            return;
          }
          labels.push(label);
        }
        issue.labels = labels;
      }
      issue.updatedAt = nowIso();
      ok(200, issueJson(issue));
      return;
    }
    err(404, 'Not Found');
    return;
  }

  if (rest[1] === 'comments') {
    if (issue === undefined) {
      err(404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      ok(200, issue.comments.map(commentJson));
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx.body);
      if (!parsed.ok) {
        err(400, 'Problems parsing JSON');
        return;
      }
      if (!isObject(parsed.value)) {
        err(400, 'Problems parsing JSON');
        return;
      }
      const body = stringField(parsed.value, 'body');
      if (body === '') {
        err(422, 'Validation Failed: body is required');
        return;
      }
      ok(201, commentJson(store.addIssueComment(repo, issue, body)));
      return;
    }
    err(404, 'Not Found');
    return;
  }

  err(404, 'Not Found');
}

// ---------------------------------------------------------------- pull requests

/** Handle the /pulls routes. `rest` is the path after /pulls. */
function handlePulls(
  ctx: RestRequest,
  store: Store,
  repo: Repo,
  rest: string[],
  ok: OkFn,
  err: ErrFn,
): void {
  const method = ctx.method;

  if (rest.length === 0) {
    if (method === 'GET') {
      const stateParam = ctx.query.get('state') ?? 'open';
      const state = stateParam === 'closed' ? 'closed' : stateParam === 'all' ? 'all' : 'open';
      const pulls = store.listPulls(repo, state).map((pull) => pullJson(store, repo, pull));
      const { page, link } = paginate(ctx, pulls);
      ok(200, page, link === null ? {} : { link });
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx.body);
      if (!parsed.ok) {
        err(400, 'Problems parsing JSON');
        return;
      }
      if (!isObject(parsed.value)) {
        err(400, 'Problems parsing JSON');
        return;
      }
      const title = stringField(parsed.value, 'title');
      const head = stringField(parsed.value, 'head');
      const base = stringField(parsed.value, 'base', repo.defaultBranch);
      if (title === '' || head === '') {
        err(422, 'Validation Failed: title and head are required');
        return;
      }
      const pull = store.createPull(repo, { title, body: stringField(parsed.value, 'body'), head, base });
      if (pull === null) {
        err(422, 'Validation Failed: head or base branch does not exist');
        return;
      }
      ok(201, pullJson(store, repo, pull));
      return;
    }
    err(404, 'Not Found');
    return;
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isSafeInteger(number) || number < 1 || String(number) !== rest[0]) {
    err(404, 'Not Found');
    return;
  }
  const pull = store.getPull(repo, number);

  if (rest.length === 1) {
    if (pull === undefined) {
      err(404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      ok(200, pullJson(store, repo, pull));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(ctx.body);
      if (!parsed.ok) {
        err(400, 'Problems parsing JSON');
        return;
      }
      if (!isObject(parsed.value)) {
        err(400, 'Problems parsing JSON');
        return;
      }
      if (typeof parsed.value.title === 'string') pull.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') pull.body = parsed.value.body;
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') {
        pull.state = parsed.value.state;
        pull.closedAt = pull.state === 'closed' ? nowIso() : null;
      }
      pull.updatedAt = nowIso();
      ok(200, pullJson(store, repo, pull));
      return;
    }
    err(404, 'Not Found');
    return;
  }

  if (rest[1] === 'files' && rest.length === 2) {
    if (pull === undefined) {
      err(404, 'Not Found');
      return;
    }
    if (method !== 'GET') {
      err(404, 'Not Found');
      return;
    }
    const files = store.pullFiles(repo, pull) ?? [];
    ok(
      200,
      files.map((change) => ({
        sha: change.newOid ?? change.oldOid ?? '',
        filename: change.path,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.additions + change.deletions,
      })),
    );
    return;
  }

  if (rest[1] === 'merge' && rest.length === 2) {
    if (pull === undefined) {
      err(404, 'Not Found');
      return;
    }
    if (method !== 'PUT') {
      err(404, 'Not Found');
      return;
    }
    const parsed = parseJsonBody(ctx.body);
    if (!parsed.ok) {
      err(400, 'Problems parsing JSON');
      return;
    }
    const result = store.mergePull(repo, pull);
    if (!result.ok) {
      if (result.error === 'conflict') err(405, 'Merge conflict: the pull request cannot be merged cleanly');
      else if (result.error === 'not-open') err(405, 'Pull request is already merged or closed');
      else if (result.error === 'nothing-to-merge') err(405, 'Head branch is already merged into the base');
      else err(422, 'Validation Failed: head or base branch does not exist');
      return;
    }
    ok(200, { merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
    return;
  }

  if (rest[1] === 'comments') {
    if (pull === undefined) {
      err(404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      ok(200, pull.comments.map(commentJson));
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx.body);
      if (!parsed.ok) {
        err(400, 'Problems parsing JSON');
        return;
      }
      if (!isObject(parsed.value)) {
        err(400, 'Problems parsing JSON');
        return;
      }
      const body = stringField(parsed.value, 'body');
      if (body === '') {
        err(422, 'Validation Failed: body is required');
        return;
      }
      ok(201, commentJson(store.addPullComment(repo, pull, body)));
      return;
    }
    err(404, 'Not Found');
    return;
  }

  err(404, 'Not Found');
}
