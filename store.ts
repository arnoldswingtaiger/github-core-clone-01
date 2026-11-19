// The forge store: repositories, git objects and refs, issues, labels,
// comments and pull requests, all in memory. One Store serves every surface
// (git smart HTTP, REST v3, GraphQL v4, MCP), so a push, a contents PUT and a
// merge all read and write the same objects and the same refs.

import {
  buildCommit,
  buildTree,
  commitMessageText,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type ParsedCommit,
  type TreeEntry,
} from './gitobj.ts';
import { VIEWER, type ScenarioUser } from './scenario.ts';

/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';
/** The ref HEAD points at. */
export const HEAD_REF = `refs/heads/${DEFAULT_BRANCH}`;
/** The identity server-created commits carry (the token owner's). */
export const SERVER_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

/** One label on a repository. */
export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

/** One comment on an issue or pull request. */
export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly user: ScenarioUser;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One issue. */
export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly comments: Comment[];
  readonly user: ScenarioUser;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Monotonic creation order: the sort key for created asc/desc. */
  readonly createdSeq: number;
}

/** One pull request. */
export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  /** Branch names (short, e.g. `feature/x` and `main`). */
  readonly head: string;
  readonly base: string;
  /** The branch tips at creation, kept as a fallback if a branch is deleted. */
  readonly headSha: string;
  readonly baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly comments: Comment[];
  readonly user: ScenarioUser;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly createdSeq: number;
}

/** One repository: its git object database, its refs, and its forge state. */
export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** The object database: oid -> object. */
  readonly objects: Map<string, GitObject>;
  /** Full ref name (refs/heads/..., refs/tags/...) -> oid. */
  readonly refs: Map<string, string>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  /** Labels by lowercase name. */
  readonly labels: Map<string, Label>;
  /** The next issue/PR number (GitHub shares the number space). */
  nextNumber: number;
  nextCommentId: number;
  nextLabelId: number;
}

/** A file change between two trees. */
export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly oldOid: string | null;
  readonly newOid: string | null;
  readonly additions: number;
  readonly deletions: number;
}

/** A path read out of a tree: the blob (or subtree) it names. */
export interface TreePath {
  readonly oid: string;
  readonly mode: string;
  readonly data: Buffer;
}

let globalSeq = 0;
let globalRepoId = 5000;

/** The current time as an ISO string (the clock the forge's own records use). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** The current time as unix seconds (for commit timestamps). */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Count the lines of a text blob (a trailing newline does not add a line). */
function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** A fresh, empty repository. */
function newRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const now = nowIso();
  return {
    id: globalRepoId,
    owner,
    name,
    description,
    private: isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    createdAt: now,
    updatedAt: now,
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    nextLabelId: 1,
  };
}

/** The whole forge: every repository, keyed by `owner/name`. */
export class Store {
  readonly repos = new Map<string, Repo>();

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** Create a repository; null when one with that name already exists. */
  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    globalRepoId += 1;
    const repo = newRepo(owner, name, description, isPrivate);
    this.repos.set(key, repo);
    return repo;
  }

  /** A repository by owner and name, or undefined. */
  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** Delete a repository; true when one was there. */
  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Every repository one owner holds, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  // ---------------------------------------------------------- git objects

  /** An object by id, or undefined. */
  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid.toLowerCase());
  }

  /** Store an object (deduplicated by id) and answer its id. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Store objects parsed from a pack; answers how many were new. */
  putObjects(repo: Repo, objects: readonly GitObject[]): number {
    let added = 0;
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, object);
        added += 1;
      }
    }
    return added;
  }

  /** Parse a commit object, or null when the id is not a commit. */
  parseCommitOf(repo: Repo, oid: string): ParsedCommit | null {
    const object = this.getObject(repo, oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  /** Peel a tag to its target, repeatedly, until a non-tag object id. */
  peel(repo: Repo, oid: string): string {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = this.getObject(repo, current);
      if (object === undefined || object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return current;
  }

  /**
   * Resolve a ref-ish to a commit id: a full ref name, a branch name, a tag
   * name, or a bare object id (a tag peels to its commit). Null when it
   * resolves to nothing or to a non-commit.
   */
  resolveToCommit(repo: Repo, ref: string): string | null {
    const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
    for (const candidate of candidates) {
      const oid = repo.refs.get(candidate);
      if (oid !== undefined) {
        const peeled = this.peel(repo, oid);
        return this.parseCommitOf(repo, peeled) === null ? null : peeled;
      }
    }
    const peeled = this.peel(repo, ref);
    return this.parseCommitOf(repo, peeled) === null ? null : peeled;
  }

  /** The tip of a branch (short name), or undefined when it has no tip. */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** Every branch: short name -> tip, sorted by name. */
  branches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Whether `ancestor` is reachable from `descendant` (or is the same commit). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === ancestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.parseCommitOf(repo, current);
      if (commit === null) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
    return false;
  }

  /** The first common ancestor of two commits (best by recency), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsOfB = new Set<string>();
    const stackB = [b];
    while (stackB.length > 0) {
      const current = stackB.pop() as string;
      if (ancestorsOfB.has(current)) continue;
      ancestorsOfB.add(current);
      const commit = this.parseCommitOf(repo, current);
      if (commit === null) continue;
      for (const parent of commit.parents) stackB.push(parent);
    }
    // Walk a's ancestors newest-first (by committer time, then discovery).
    const seen = new Set<string>();
    const queue: string[] = [a];
    while (queue.length > 0) {
      // Pop the newest commit in the queue.
      let best = 0;
      let bestTime = -1;
      for (let i = 0; i < queue.length; i += 1) {
        const commit = this.parseCommitOf(repo, queue[i] as string);
        const time = commit === null ? -1 : commit.committerTime;
        if (time > bestTime) {
          bestTime = time;
          best = i;
        }
      }
      const current = queue.splice(best, 1)[0] as string;
      if (ancestorsOfB.has(current)) return current;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.parseCommitOf(repo, current);
      if (commit === null) continue;
      for (const parent of commit.parents) if (!seen.has(parent)) queue.push(parent);
    }
    return null;
  }

  /** Every commit reachable from `tip`, newest first (by committer time). */
  listCommits(repo: Repo, tip: string): Array<{ sha: string; commit: ParsedCommit }> {
    const found = new Map<string, ParsedCommit>();
    const stack = [tip];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (found.has(current)) continue;
      const commit = this.parseCommitOf(repo, current);
      if (commit === null) continue;
      found.set(current, commit);
      for (const parent of commit.parents) stack.push(parent);
    }
    const out = [...found.entries()].map(([sha, commit]) => ({ sha, commit }));
    out.sort((a, b) => b.commit.committerTime - a.commit.committerTime || (a.sha < b.sha ? -1 : 1));
    return out;
  }

  /** Every object reachable from a set of tips (commits, trees, blobs, tags). */
  reachableObjects(repo: Repo, tips: readonly string[]): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const queue = [...tips];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (out.has(oid)) continue;
      const object = this.getObject(repo, oid);
      if (object === undefined) continue;
      out.set(oid, object);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      }
    }
    return out;
  }

  // ---------------------------------------------------------- trees

  /** Read a path out of a commit's tree: the blob (or subtree) it names. */
  readPath(repo: Repo, commitOid: string, path: string): TreePath | null {
    const commit = this.parseCommitOf(repo, commitOid);
    if (commit === null) return null;
    const segments = path.split('/').filter((segment) => segment !== '');
    let treeOid = commit.tree;
    for (let i = 0; i < segments.length; i += 1) {
      const tree = this.getObject(repo, treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) {
        const object = this.getObject(repo, entry.oid);
        if (object === undefined) return null;
        return { oid: entry.oid, mode: entry.mode, data: object.data };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return null;
  }

  /** List a directory out of a commit's tree ('' is the root); null when absent. */
  listDir(repo: Repo, commitOid: string, path: string): TreeEntry[] | null {
    const commit = this.parseCommitOf(repo, commitOid);
    if (commit === null) return null;
    if (path === '' || path === '/') {
      const tree = this.getObject(repo, commit.tree);
      return tree === undefined || tree.type !== 'tree' ? null : parseTree(tree.data);
    }
    const found = this.readPath(repo, commitOid, path);
    if (found === null || found.mode !== '40000') return null;
    const tree = this.getObject(repo, found.oid);
    return tree === undefined || tree.type !== 'tree' ? null : parseTree(tree.data);
  }

  /** A tree with `segments` set to `blobOid` (at `mode`), every other entry kept. */
  writePath(repo: Repo, treeOid: string, segments: readonly string[], blobOid: string, mode = '100644'): string {
    const head = segments[0] as string;
    const tree = this.getObject(repo, treeOid);
    const entries = tree !== undefined && tree.type === 'tree' ? parseTree(tree.data) : [];
    const kept = entries.filter((entry) => entry.name !== head);
    if (segments.length === 1) {
      kept.push({ mode, name: head, oid: blobOid });
    } else {
      const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
      const childOid = existing === undefined ? this.putObject(repo, 'tree', buildTree([])) : existing.oid;
      kept.push({ mode: '40000', name: head, oid: this.writePath(repo, childOid, segments.slice(1), blobOid) });
    }
    return this.putObject(repo, 'tree', buildTree(kept));
  }

  /** A tree with `segments` removed; null when the path does not exist. */
  deletePath(repo: Repo, treeOid: string, segments: readonly string[]): string | null {
    const head = segments[0] as string;
    const tree = this.getObject(repo, treeOid);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entries = parseTree(tree.data);
    const existing = entries.find((entry) => entry.name === head);
    if (existing === undefined) return null;
    const kept = entries.filter((entry) => entry.name !== head);
    if (segments.length > 1) {
      if (existing.mode !== '40000') return null;
      const child = this.deletePath(repo, existing.oid, segments.slice(1));
      if (child === null) return null;
      const childTree = this.getObject(repo, child);
      if (childTree !== undefined && childTree.type === 'tree' && parseTree(childTree.data).length > 0) {
        kept.push({ mode: '40000', name: head, oid: child });
      }
    }
    return this.putObject(repo, 'tree', buildTree(kept));
  }

  /** Flatten a tree into path -> entry (files only; gitlinks skipped). */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, TreeEntry> {
    const out = new Map<string, TreeEntry>();
    const tree = this.getObject(repo, treeOid);
    if (tree === undefined || tree.type !== 'tree') return out;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        for (const [childPath, child] of this.flattenTree(repo, entry.oid, path)) out.set(childPath, child);
      } else if (entry.mode !== '160000') {
        out.set(path, entry);
      }
    }
    return out;
  }

  /** The file changes between two trees (base -> head), by path. */
  diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): FileChange[] {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const changes: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const oldEntry = base.get(path);
      const newEntry = head.get(path);
      if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
      if (oldEntry === undefined && newEntry !== undefined) {
        const text = this.getObject(repo, newEntry.oid)?.data.toString('utf8') ?? '';
        changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid, additions: Math.max(1, lineCount(text)), deletions: 0 });
      } else if (oldEntry !== undefined && newEntry === undefined) {
        const text = this.getObject(repo, oldEntry.oid)?.data.toString('utf8') ?? '';
        changes.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null, additions: 0, deletions: lineCount(text) });
      } else if (oldEntry !== undefined && newEntry !== undefined) {
        const oldText = this.getObject(repo, oldEntry.oid)?.data.toString('utf8') ?? '';
        const newText = this.getObject(repo, newEntry.oid)?.data.toString('utf8') ?? '';
        changes.push({
          path,
          status: 'modified',
          oldOid: oldEntry.oid,
          newOid: newEntry.oid,
          additions: Math.max(1, lineCount(newText)),
          deletions: lineCount(oldText),
        });
      }
    }
    return changes;
  }

  /** Create a commit the server authors (contents PUTs, merges). */
  createServerCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    const data = buildCommit({
      tree,
      parents,
      message,
      author: SERVER_IDENTITY,
      committer: SERVER_IDENTITY,
      timestamp: nowSec(),
    });
    return this.putObject(repo, 'commit', data);
  }

  // ---------------------------------------------------------- issues

  /** Create an issue; null when a label does not exist. */
  createIssue(
    repo: Repo,
    input: { title: string; body: string; labelNames: readonly string[] },
  ): Issue | null {
    const labels: Label[] = [];
    for (const name of input.labelNames) {
      const label = repo.labels.get(name.toLowerCase());
      if (label === undefined) return null;
      labels.push(label);
    }
    const now = nowIso();
    globalSeq += 1;
    const issue: Issue = {
      id: repo.id * 100000 + repo.nextNumber,
      number: repo.nextNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      labels,
      comments: [],
      user: VIEWER,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      createdSeq: globalSeq,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  /** An issue by number, or undefined. */
  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  /** Issues filtered by state and ordered by creation (asc or desc). */
  listIssues(repo: Repo, state: 'open' | 'closed' | 'all', direction: 'asc' | 'desc'): Issue[] {
    const out = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
    out.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    return out;
  }

  /** Add a comment to an issue. */
  addIssueComment(repo: Repo, issue: Issue, body: string): Comment {
    const now = nowIso();
    const comment: Comment = { id: repo.nextCommentId, body, user: VIEWER, createdAt: now, updatedAt: now };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  /** Create a label (upsert by name: re-creating one returns the existing). */
  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name.toLowerCase());
    if (existing !== undefined) return existing;
    const label: Label = { id: repo.nextLabelId, name, color, description: '' };
    repo.nextLabelId += 1;
    repo.labels.set(name.toLowerCase(), label);
    return label;
  }

  // ---------------------------------------------------------- pull requests

  /** Create a pull request; null when a branch does not exist. */
  createPull(repo: Repo, input: { title: string; body: string; head: string; base: string }): Pull | null {
    const headTip = this.branchTip(repo, input.head);
    const baseTip = this.branchTip(repo, input.base);
    if (headTip === undefined || baseTip === undefined) return null;
    const now = nowIso();
    globalSeq += 1;
    const pull: Pull = {
      id: repo.id * 100000 + repo.nextNumber,
      number: repo.nextNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      head: input.head,
      base: input.base,
      headSha: headTip,
      baseSha: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      comments: [],
      user: VIEWER,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      createdSeq: globalSeq,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** A pull request by number, or undefined. */
  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.get(number);
  }

  /** Pull requests filtered by state, newest first. */
  listPulls(repo: Repo, state: 'open' | 'closed' | 'all'): Pull[] {
    const out = [...repo.pulls.values()].filter((pull) => state === 'all' || pull.state === state);
    out.sort((a, b) => b.createdSeq - a.createdSeq);
    return out;
  }

  /** Add a comment to a pull request. */
  addPullComment(repo: Repo, pull: Pull, body: string): Comment {
    const now = nowIso();
    const comment: Comment = { id: repo.nextCommentId, body, user: VIEWER, createdAt: now, updatedAt: now };
    repo.nextCommentId += 1;
    pull.comments.push(comment);
    return comment;
  }

  /** The files a pull request changes (merge-base tree -> head tree). */
  pullFiles(repo: Repo, pull: Pull): FileChange[] | null {
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return null;
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseCommit = base === null ? null : this.parseCommitOf(repo, base);
    const headCommit = this.parseCommitOf(repo, headTip);
    if (headCommit === null) return null;
    const baseTree = baseCommit === null ? this.putObject(repo, 'tree', buildTree([])) : baseCommit.tree;
    return this.diffTrees(repo, baseTree, headCommit.tree);
  }

  /**
   * Whether a pull request merges cleanly: a three-way merge at file level.
   * A path both sides changed differently is a conflict.
   */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    if (headTip === baseTip) return 'UNKNOWN';
    if (this.isAncestor(repo, headTip, baseTip)) return 'UNKNOWN';
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseCommit = base === null ? null : this.parseCommitOf(repo, base);
    const headCommit = this.parseCommitOf(repo, headTip);
    const baseTipCommit = this.parseCommitOf(repo, baseTip);
    if (headCommit === null || baseTipCommit === null) return 'UNKNOWN';
    const baseTree = baseCommit === null ? this.putObject(repo, 'tree', buildTree([])) : baseCommit.tree;
    const baseFiles = this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headCommit.tree);
    const tipFiles = this.flattenTree(repo, baseTipCommit.tree);
    const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path)?.oid;
      const h = headFiles.get(path)?.oid;
      const t = tipFiles.get(path)?.oid;
      if (h === b) continue;
      if (t === b) continue;
      if (h === t) continue;
      return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request. Returns the merge commit's sha, or an error
   * code: 'not-open' (already closed/merged), 'unknown-branch', 'conflict',
   * 'nothing-to-merge' (the head is already in the base).
   */
  mergePull(
    repo: Repo,
    pull: Pull,
  ): { ok: true; sha: string } | { ok: false; error: 'not-open' | 'unknown-branch' | 'conflict' | 'nothing-to-merge' } {
    if (pull.state !== 'open') return { ok: false, error: 'not-open' };
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return { ok: false, error: 'unknown-branch' };
    if (headTip === baseTip || this.isAncestor(repo, headTip, baseTip)) return { ok: false, error: 'nothing-to-merge' };
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseCommit = base === null ? null : this.parseCommitOf(repo, base);
    const headCommit = this.parseCommitOf(repo, headTip);
    const baseTipCommit = this.parseCommitOf(repo, baseTip);
    if (headCommit === null || baseTipCommit === null) return { ok: false, error: 'conflict' };
    const baseTree = baseCommit === null ? this.putObject(repo, 'tree', buildTree([])) : baseCommit.tree;
    const baseFiles = this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headCommit.tree);
    const tipFiles = this.flattenTree(repo, baseTipCommit.tree);
    const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
    // The merged tree: the base tip's tree, with the head's changes applied.
    const merged = new Map<string, TreeEntry>();
    for (const [path, entry] of tipFiles) merged.set(path, entry);
    for (const path of paths) {
      const b = baseFiles.get(path)?.oid;
      const h = headFiles.get(path)?.oid;
      const t = tipFiles.get(path)?.oid;
      if (h === b) continue;
      if (t === b) {
        // Only the head changed it: take the head's version (or its deletion).
        if (h === undefined) merged.delete(path);
        else merged.set(path, headFiles.get(path) as TreeEntry);
        continue;
      }
      if (h === t) continue;
      return { ok: false, error: 'conflict' };
    }
    const treeOid = this.treeFromPaths(repo, merged);
    const sha = this.createServerCommit(repo, treeOid, [baseTip], `${pull.title} (#${pull.number})`);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    const now = nowIso();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = now;
    pull.mergeCommitSha = sha;
    pull.closedAt = now;
    pull.updatedAt = now;
    return { ok: true, sha };
  }

  /** Build a tree from a flat path -> entry map (creating subtrees). */
  treeFromPaths(repo: Repo, files: ReadonlyMap<string, TreeEntry>): string {
    const emptyTree = this.putObject(repo, 'tree', buildTree([]));
    let root = emptyTree;
    for (const [path, entry] of files) {
      root = this.writePath(repo, root, path.split('/'), entry.oid, entry.mode);
    }
    return root;
  }

  /** The message of a commit, as the REST API reports it. */
  commitMessage(repo: Repo, oid: string): string {
    const commit = this.parseCommitOf(repo, oid);
    return commit === null ? '' : commitMessageText(commit);
  }
}

/** The one store the server runs on. */
export const STORE = new Store();

/** The zero id, re-exported for callers that compare ref targets. */
export { ZERO_OID };
