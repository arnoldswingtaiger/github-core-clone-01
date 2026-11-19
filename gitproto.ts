// Git smart HTTP: the `info/refs` advertisements (protocol v0 and v2),
// `git-upload-pack` (v2 ls-refs and fetch, v0 fetch) and `git-receive-pack`
// (v0 push with report-status). The server speaks the wire the suite's
// client speaks: pkt-lines, sideband framing, shallow and incremental
// fetches, fast-forward-only ref updates.
//
// Protocol notes (from the wire the client implements):
//   - upload-pack is v2 when the request carries `Git-Protocol: version=2`;
//     otherwise it is v0. receive-pack is always v0.
//   - A v2 advertisement lists `fetch`, `ls-refs` and `object-format=sha1`.
//   - A v0 advertisement starts with `# service=...` and carries the
//     capabilities on the first ref line (or on a `capabilities^{}` line
//     when the repository is empty).
//   - A push's report-status travels inside sideband band 1 as pkt-lines.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { PackError, ZERO_OID, readPack, writePack, type GitObject } from './gitobj.ts';
import { HEAD_REF, STORE, type Repo, type Store } from './store.ts';
import { bearerToken } from './http.ts';

/** Everything a git handler needs for one request. */
export interface GitRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  /** The decoded path segments (owner, `repo.git`, ...). */
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly body: Buffer;
  readonly requestId: string;
}

const UPLOAD_PACK = 'git-upload-pack';
const RECEIVE_PACK = 'git-receive-pack';
const AGENT = 'github-core-clone/1.0';

/** The capabilities the v0 upload-pack advertisement carries. */
const V0_UPLOAD_CAPS = `side-band-64k thin-pack ofs-delta shallow multi_ack_detailed symref=HEAD:${HEAD_REF} agent=${AGENT}`;
/** The capabilities the v0 receive-pack advertisement carries. */
const V0_RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta symref=HEAD:${HEAD_REF} agent=${AGENT}`;

// ---------------------------------------------------------------- pkt-lines

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

/** One pkt-line carrying `text` (a trailing newline is the caller's). */
function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  return pktLineRaw(payload);
}

/** One pkt-line carrying raw bytes. */
function pktLineRaw(payload: Buffer): Buffer {
  if (payload.length > 65516) throw new Error('a pkt-line holds at most 65516 payload bytes');
  const header = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

/** A parsed pkt-line: data, a flush, a delim, or a response-end. */
type Pkt =
  | { readonly kind: 'data'; readonly data: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/** Parse pkt-lines from the start of `buf`; answers the packets and the bytes consumed. */
function parsePktLines(buf: Buffer): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = Number.parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (!Number.isSafeInteger(length) || length < 0 || length > 65520) break;
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) break;
    packets.push({ kind: 'data', data: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** The text of a data packet, without its trailing newline. */
function pktText(packet: Pkt): string {
  if (packet.kind !== 'data') return '';
  return packet.data.toString('utf8').replace(/\n$/, '');
}

/** Wrap bytes in sideband packets on `band` (1 = data, 2 = progress, 3 = error). */
function sideband(data: Buffer, band: 1 | 2 | 3): Buffer {
  const parts: Buffer[] = [];
  const maxChunk = 65515;
  if (data.length === 0) return Buffer.concat(parts);
  for (let offset = 0; offset < data.length; offset += maxChunk) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxChunk));
    parts.push(pktLineRaw(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- the router

/** Handle one git smart-HTTP request. `token` is the expected bearer token ('' to skip auth). */
export function handleGit(ctx: GitRequest, token: string): void {
  const { res, requestId } = ctx;
  const segments = ctx.segments;
  if (segments.length < 3 || !(segments[1] as string).endsWith('.git')) {
    sendGitJson(res, 404, 'Not Found', requestId);
    return;
  }
  const owner = segments[0] as string;
  const repoName = (segments[1] as string).slice(0, -'.git'.length);
  const tail = segments.slice(2);

  // Git requests carry the same bearer token as the API.
  if (token !== '' && bearerToken(ctx.req) !== token) {
    sendGitJson(res, 401, 'Bad credentials', requestId);
    return;
  }

  const repo = STORE.getRepo(owner, repoName);
  if (repo === undefined) {
    sendGitJson(res, 404, 'Not Found', requestId);
    return;
  }

  if (ctx.method === 'GET' && tail[0] === 'info' && tail[1] === 'refs') {
    handleInfoRefs(ctx, repo);
    return;
  }
  if (ctx.method === 'POST' && tail[0] === 'git-upload-pack') {
    handleUploadPack(ctx, repo);
    return;
  }
  if (ctx.method === 'POST' && tail[0] === 'git-receive-pack') {
    handleReceivePack(ctx, repo);
    return;
  }
  sendGitJson(res, 404, 'Not Found', requestId);
}

/** A JSON error body for a git route (the status is what the client reads). */
function sendGitJson(res: ServerResponse, status: number, message: string, requestId: string): void {
  const text = `${JSON.stringify({ message })}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
  });
  res.end(text);
}

/** A raw (non-JSON) git response. */
function sendGitRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

// ---------------------------------------------------------------- advertisements

/** All refs of a repository, sorted: heads first, then tags, by name. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The commit an annotated tag peels to, or null when the ref is not a tag. */
function peelTarget(store: Store, repo: Repo, oid: string): string | null {
  const object = store.getObject(repo, oid);
  if (object === undefined || object.type !== 'tag') return null;
  return store.peel(repo, oid);
}

/** GET info/refs: the v2 or v0 advertisement for the requested service. */
function handleInfoRefs(ctx: GitRequest, repo: Repo): void {
  const service = ctx.query.get('service');
  if (service !== UPLOAD_PACK && service !== RECEIVE_PACK) {
    sendGitJson(ctx.res, 400, 'a service query parameter is required', ctx.requestId);
    return;
  }
  const wantsV2 = service === UPLOAD_PACK && ctx.req.headers['git-protocol'] === 'version=2';
  const contentType =
    service === UPLOAD_PACK ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  if (wantsV2) {
    parts.push(
      pktLine('version 2\n'),
      pktLine('fetch=shallow thin-pack ofs-delta\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('object-format=sha1\n'),
      pktLine(`agent=${AGENT}\n`),
      FLUSH,
    );
  } else {
    const caps = service === UPLOAD_PACK ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
    const refs = sortedRefs(repo);
    const headTip = repo.refs.get(HEAD_REF);
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      let first = true;
      if (headTip !== undefined) {
        parts.push(pktLine(`${headTip} HEAD\0${caps}\n`));
        first = false;
      }
      for (const ref of refs) {
        const line = first ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
        parts.push(pktLine(line));
        first = false;
        const peeled = peelTarget(STORE, repo, ref.oid);
        if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
    parts.push(FLUSH);
  }
  sendGitRaw(ctx.res, 200, contentType, Buffer.concat(parts));
}

// ---------------------------------------------------------------- upload-pack

/** POST git-upload-pack: v2 (ls-refs / fetch) or v0 (fetch). */
function handleUploadPack(ctx: GitRequest, repo: Repo): void {
  const isV2 = ctx.req.headers['git-protocol'] === 'version=2';
  if (!isV2) {
    handleFetchV0(ctx, repo);
    return;
  }
  const { packets } = parsePktLines(ctx.body);
  const commandLine = packets.find((packet) => packet.kind === 'data');
  if (commandLine === undefined) {
    sendGitRaw(ctx.res, 200, 'application/x-git-upload-pack-result', Buffer.concat([pktLine('ERR no command\n'), FLUSH]));
    return;
  }
  const command = pktText(commandLine);
  if (command === 'command=ls-refs') {
    handleLsRefs(ctx, repo, packets);
    return;
  }
  if (command === 'command=fetch') {
    handleFetchV2(ctx, repo, packets);
    return;
  }
  sendGitRaw(ctx.res, 200, 'application/x-git-upload-pack-result', Buffer.concat([pktLine(`ERR unknown command ${command}\n`), FLUSH]));
}

/** The v2 ls-refs command: refs, with peel/symrefs/unborn/ref-prefix. */
function handleLsRefs(ctx: GitRequest, repo: Repo, packets: readonly Pkt[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const text = pktText(packet);
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const lines: string[] = [];
  const headTip = repo.refs.get(HEAD_REF);
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      lines.push(`${headTip} HEAD${symrefs ? ` symref-target:${HEAD_REF}` : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${HEAD_REF}` : ''}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peelTarget(STORE, repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  const parts = lines.map((line) => pktLine(line));
  parts.push(FLUSH);
  sendGitRaw(ctx.res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}


// ---------------------------------------------------------------- fetch

/** A fetch request, v2 or v0: what the client wants, holds, and how deep. */
interface FetchRequest {
  readonly wants: readonly string[];
  readonly haves: readonly string[];
  /** The client's shallow boundary: commits whose parents it does not hold. */
  readonly shallow: readonly string[];
  /** The depth limit, or null for the whole history. */
  readonly depth: number | null;
}

/** What a fetch sends: the objects, the shallow boundary, the acknowledgments. */
interface FetchPlan {
  readonly objects: readonly GitObject[];
  readonly shallow: readonly string[];
  readonly unshallow: readonly string[];
  readonly acks: readonly string[];
}

/**
 * Plan a fetch: the commits to send are the depth-limited traversal from the
 * wants minus everything reachable from the haves (stopping at the client's
 * shallow boundary); the objects are that closure plus wanted tags, minus the
 * objects the haves' closure already holds. The shallow boundary is the
 * depth limit's edge: sent commits at generation depth-1 that have parents.
 */
function planFetch(store: Store, repo: Repo, request: FetchRequest): FetchPlan {
  const wantCommits: string[] = [];
  const wantTags: string[] = [];
  for (const want of request.wants) {
    const object = store.getObject(repo, want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      wantTags.push(want);
      const peeled = store.peel(repo, want);
      if (store.parseCommitOf(repo, peeled) !== null) wantCommits.push(peeled);
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    }
  }

  // 1. The depth-limited traversal from the wants, with generations.
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = wantCommits.map((oid) => ({ oid, gen: 0 }));
  for (let head = 0; head < queue.length; head += 1) {
    const { oid, gen } = queue[head] as { oid: string; gen: number };
    if (generations.has(oid)) continue;
    generations.set(oid, gen);
    if (request.depth !== null && gen + 1 >= request.depth) continue;
    const commit = store.parseCommitOf(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
  }

  // 2. The exclusion set: everything reachable from the haves, stopping at
  //    the client's shallow boundary (those parents are not held).
  const shallowSet = new Set(request.shallow);
  const haveSet = new Set<string>();
  const haveQueue = [...request.haves];
  while (haveQueue.length > 0) {
    const oid = haveQueue.pop() as string;
    if (haveSet.has(oid)) continue;
    haveSet.add(oid);
    if (shallowSet.has(oid)) continue;
    const commit = store.parseCommitOf(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) haveQueue.push(parent);
  }

  // 3. The commits to send, and their objects minus what the client holds.
  const sendCommits = [...generations.keys()].filter((oid) => !haveSet.has(oid));
  const sendSet = new Set(sendCommits);
  const heldObjects = store.reachableObjects(repo, [...haveSet]);
  const sendObjects = store.reachableObjects(repo, [...sendCommits, ...wantTags]);
  const objects: GitObject[] = [];
  for (const [oid, object] of sendObjects) {
    if (!heldObjects.has(oid)) objects.push(object);
  }

  // 4. The shallow boundary: sent commits at the depth limit's edge.
  const shallow: string[] = [];
  if (request.depth !== null) {
    for (const oid of sendCommits) {
      if (generations.get(oid) !== request.depth - 1) continue;
      const commit = store.parseCommitOf(repo, oid);
      if (commit !== null && commit.parents.length > 0) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const oid of request.shallow) {
    const commit = store.parseCommitOf(repo, oid);
    if (commit !== null && commit.parents.some((parent) => sendSet.has(parent))) unshallow.push(oid);
  }

  // 5. The acknowledgments: the haves the server holds.
  const acks = request.haves.filter((oid) => store.getObject(repo, oid) !== undefined);
  return { objects, shallow, unshallow, acks };
}

/** The v2 fetch command: acknowledgments, shallow-info, then the packfile. */
function handleFetchV2(ctx: GitRequest, repo: Repo, packets: readonly Pkt[]): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const text = pktText(packet);
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const value = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isSafeInteger(value) && value > 0) depth = value;
    }
  }
  for (const want of wants) {
    if (STORE.getObject(repo, want) === undefined) {
      sendGitRaw(
        ctx.res,
        200,
        'application/x-git-upload-pack-result',
        Buffer.concat([pktLine(`ERR upload-pack: not our ref ${want}\n`), FLUSH]),
      );
      return;
    }
  }
  const plan = planFetch(STORE, repo, { wants, haves, shallow, depth });
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  if (plan.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(FLUSH);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(writePack(plan.objects), 1));
  parts.push(FLUSH);
  sendGitRaw(ctx.res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** The v0 fetch: want/have lines, then NAK/ACK and the sideband pack. */
function handleFetchV0(ctx: GitRequest, repo: Repo): void {
  const { packets } = parsePktLines(ctx.body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = pktText(packet);
    const line = text.split('\0')[0] as string;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isSafeInteger(value) && value > 0) depth = value;
    }
  }
  const plan = planFetch(STORE, repo, { wants, haves, shallow, depth });
  const parts: Buffer[] = [];
  if (plan.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sideband(writePack(plan.objects), 1));
  parts.push(FLUSH);
  sendGitRaw(ctx.res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- receive-pack

/** One push command: the old tip, the new tip, and the ref to move. */
interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** POST git-receive-pack: unpack the pack, then apply each ref update. */
function handleReceivePack(ctx: GitRequest, repo: Repo): void {
  const { packets, consumed } = parsePktLines(ctx.body);
  const commands: PushCommand[] = [];
  let clientCaps = '';
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    const text = pktText(packet);
    const nul = text.indexOf('\0');
    const line = nul === -1 ? text : text.slice(0, nul);
    if (nul !== -1 && commands.length === 0) clientCaps = text.slice(nul + 1);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/i.exec(line.trim());
    if (match !== null) {
      commands.push({ oldOid: (match[1] as string).toLowerCase(), newOid: (match[2] as string).toLowerCase(), ref: match[3] as string });
    }
  }
  if (!sawFlush && commands.length === 0) {
    sendPushReport(ctx, false, 'the push carried no commands', [], false);
    return;
  }
  const sidebandRequested = clientCaps.split(' ').includes('side-band-64k');
  const reportRequested = clientCaps.split(' ').includes('report-status') || clientCaps.split(' ').includes('report-status-v2');

  // Unpack the pack that follows the command list (a delete-only push has none).
  const packBytes = ctx.body.subarray(consumed);
  let unpackOk = true;
  let unpackDetail = '';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => STORE.getObject(repo, oid));
      STORE.putObjects(repo, objects);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof PackError ? err.message : 'the pack could not be unpacked';
    }
  }

  // Apply each command independently: an ok ref moves, an ng ref does not.
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    results.push(applyPushCommand(repo, command));
  }
  if (results.some((result) => result.ok)) repo.updatedAt = new Date().toISOString();
  sendPushReport(ctx, unpackOk, unpackDetail, results, sidebandRequested && reportRequested);
}

/** Apply one push command: create, fast-forward update, or delete a ref. */
function applyPushCommand(repo: Repo, command: PushCommand): { ref: string; ok: boolean; reason: string } {
  const current = repo.refs.get(command.ref);
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined) return { ref: command.ref, ok: false, reason: 'already exists' };
  } else if (current === undefined) {
    return { ref: command.ref, ok: false, reason: 'the ref does not exist' };
  } else if (current.toLowerCase() !== command.oldOid) {
    return { ref: command.ref, ok: false, reason: 'old oid mismatch' };
  }
  if (command.newOid === ZERO_OID) {
    repo.refs.delete(command.ref);
    return { ref: command.ref, ok: true, reason: '' };
  }
  const target = STORE.getObject(repo, command.newOid);
  if (target === undefined) return { ref: command.ref, ok: false, reason: 'object not found' };
  if (target.type !== 'commit' && target.type !== 'tag') {
    return { ref: command.ref, ok: false, reason: 'the new tip is not a commit or tag' };
  }
  if (command.oldOid !== ZERO_OID && command.newOid !== command.oldOid) {
    const oldCommit = STORE.peel(repo, command.oldOid);
    const newCommit = STORE.peel(repo, command.newOid);
    if (!STORE.isAncestor(repo, oldCommit, newCommit)) {
      return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(command.ref, command.newOid);
  return { ref: command.ref, ok: true, reason: '' };
}

/** Answer a push with its report-status, inside sideband band 1 when asked. */
function sendPushReport(
  ctx: GitRequest,
  unpackOk: boolean,
  unpackDetail: string,
  results: ReadonlyArray<{ ref: string; ok: boolean; reason: string }>,
  useSideband: boolean,
): void {
  const lines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail === '' ? 'failed' : unpackDetail}\n`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = Buffer.concat(lines.map((line) => pktLine(line)));
  const body = useSideband ? Buffer.concat([sideband(report, 1), FLUSH]) : Buffer.concat([report, FLUSH]);
  sendGitRaw(ctx.res, 200, 'application/x-git-receive-pack-result', body);
}
