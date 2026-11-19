// The git object layer: SHA-1 object ids, commit/tree/tag parsing and building,
// and packfile reading (with delta resolution) and writing (plain objects only).
// Everything here works on raw bytes: an object the server stores is the exact
// bytes the client sent, so a clone returns byte-identical objects.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The four object types, by their packfile type numbers. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const TYPE_NUMBERS: Readonly<Record<GitObjectType, number>> = Object.freeze({
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
});
const NUMBERS_TYPE: Readonly<Record<number, GitObjectType>> = Object.freeze({
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
});

/** One git object: its type and its exact bytes. */
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** The all-zero object id: "no object", used for creates and deletes. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Whether `value` is a 40-hex object id. */
export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

/** The SHA-1 object id of `<type> <size>\0<data>`, lowercase hex. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** A parsed commit header: the tree, the parents, the identities, the message. */
export interface ParsedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly authorTime: number;
  readonly committerTime: number;
  readonly message: string;
}

/** Parse a commit's bytes. Continuation lines (a leading space) belong to the previous header. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let authorTime = 0;
  let committerTime = 0;
  let current = '';
  const flush = (): void => {
    if (current.startsWith('tree ')) tree = current.slice(5).trim();
    else if (current.startsWith('parent ')) parents.push(current.slice(7).trim());
    else if (current.startsWith('author ')) {
      author = current.slice(7);
      authorTime = timeOf(author);
    } else if (current.startsWith('committer ')) {
      committer = current.slice(10);
      committerTime = timeOf(committer);
    }
  };
  for (const line of headerText.split('\n')) {
    if (line.startsWith(' ') && current !== '') {
      current += `\n${line}`;
      continue;
    }
    flush();
    current = line;
  }
  flush();
  return { tree, parents, author, committer, authorTime, committerTime, message };
}

/** The unix timestamp inside an `author`/`committer` line (`Name <mail> 1234567890 +0000`). */
function timeOf(identity: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(identity.trim());
  return match === null ? 0 : Number(match[1]);
}

/** The commit's message with trailing newlines removed, as the REST API reports it. */
export function commitMessageText(commit: ParsedCommit): string {
  return commit.message.replace(/\n+$/, '');
}

/** The fields a new commit is built from. */
export interface CommitInput {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly author: string;
  readonly committer: string;
  readonly timestamp: number;
}

/** Build a commit's bytes: headers, a blank line, the message (newline-terminated). */
export function buildCommit(input: CommitInput): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author} ${input.timestamp} +0000`);
  lines.push(`committer ${input.committer} ${input.timestamp} +0000`);
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

/** One tree entry: mode, name, and the object id it points at. */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree's bytes into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** The sort key git orders tree entries by: a directory's name plus '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree's bytes from its entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** A parsed annotated tag. */
export interface ParsedTag {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag's bytes. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) {
      const t = line.slice(5).trim();
      if (t === 'commit' || t === 'tree' || t === 'blob' || t === 'tag') type = t;
    } else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7).trim();
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- packfiles

/** Thrown when a packfile cannot be parsed. */
export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackError';
  }
}

/** Apply a git delta to its base bytes, producing the target bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new PackError('a delta ends mid-varint');
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new PackError(`a delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      // Copy from the base: offset and size follow, one byte per set bit.
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (offset >= delta.length) throw new PackError('a delta copy ends early');
          copyOffset |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          if (offset >= delta.length) throw new PackError('a delta copy ends early');
          copySize |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || written + copySize > targetSize) {
        throw new PackError('a delta copy runs past its base or target');
      }
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      // Insert literal bytes.
      if (offset + op > delta.length || written + op > targetSize) {
        throw new PackError('a delta insert runs past its input or target');
      }
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new PackError('a delta holds a zero opcode');
    }
  }
  if (written !== targetSize) throw new PackError(`a delta produced ${written} bytes, expected ${targetSize}`);
  return out;
}

/**
 * Parse a packfile's bytes into its objects, resolving deltas. `resolveBase`
 * answers a base object id from the store when a ref-delta's base is not in
 * this pack (a thin pack); it may be omitted when no such base is expected.
 * The trailer checksum is verified.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): GitObject[] {
  if (pack.length < 32) throw new PackError('a pack is at least a 12-byte header and a 20-byte trailer');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new PackError('a pack starts with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new PackError(`a pack is version 2, got ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const checksum = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!checksum.equals(trailer)) throw new PackError('a pack trailer does not match its contents');

  // The objects as they resolve, keyed by their offset in the pack (for ofs-delta).
  const byOffset = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  const objects: GitObject[] = [];
  let offset = 12;
  const end = pack.length - 20;

  // First pass: read every entry's header and inflated body, in pack order.
  interface RawEntry {
    readonly offset: number;
    readonly type: number;
    readonly size: number;
    readonly baseOffset?: number;
    readonly baseOid?: string;
    readonly body: Buffer;
  }
  const raw: RawEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offset >= end) throw new PackError('a pack ends before its declared object count');
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= end) throw new PackError('a pack object header ends early');
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === 6) {
      // ofs-delta: a negative offset from this entry, variable-length.
      if (offset >= end) throw new PackError('an ofs-delta has no base offset');
      byte = pack[offset] as number;
      offset += 1;
      let value = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= end) throw new PackError('an ofs-delta offset ends early');
        byte = pack[offset] as number;
        offset += 1;
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (type === 7) {
      // ref-delta: the base's 20-byte object id.
      if (offset + 20 > end) throw new PackError('a ref-delta has no base id');
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (NUMBERS_TYPE[type] === undefined) {
      throw new PackError(`a pack holds an unknown object type ${type}`);
    }
    // Inflate from the current offset. inflateSync with `info: true` reports
    // how many input bytes the stream consumed, which is the next entry's
    // start — one inflate per entry, no scanning.
    const body = inflateEntry(pack, offset, end, size);
    offset = body.nextOffset;
    raw.push({ offset: entryOffset, type, size, baseOffset, baseOid, body: body.data });
  }

  // Second pass: resolve deltas (a delta's base always precedes it in a pack
  // git writes, but resolve recursively to be safe about order).
  const resolve = (entry: RawEntry, seen: Set<number>): GitObject => {
    const cached = byOffset.get(entry.offset);
    if (cached !== undefined) return cached;
    if (seen.has(entry.offset)) throw new PackError('a pack holds a delta cycle');
    seen.add(entry.offset);
    let resolved: GitObject;
    if (entry.type === 6) {
      const baseEntry = raw.find((candidate) => candidate.offset === entry.baseOffset);
      if (baseEntry === undefined) throw new PackError('an ofs-delta names a base outside its pack');
      const base = resolve(baseEntry, seen);
      resolved = { type: base.type, data: applyDelta(base.data, entry.body) };
    } else if (entry.type === 7) {
      const baseOid = entry.baseOid as string;
      let base = byOid.get(baseOid);
      if (base === undefined && resolveBase !== undefined) base = resolveBase(baseOid);
      if (base === undefined) {
        // The base may be a later entry of this pack (unusual but legal).
        const baseEntry = raw.find((candidate) => {
          if (candidate.type === 6 || candidate.type === 7) return false;
          return hashObject(NUMBERS_TYPE[candidate.type] as GitObjectType, candidate.body) === baseOid;
        });
        if (baseEntry !== undefined) base = resolve(baseEntry, seen);
      }
      if (base === undefined) throw new PackError(`a ref-delta names an unknown base ${baseOid}`);
      resolved = { type: base.type, data: applyDelta(base.data, entry.body) };
    } else {
      resolved = { type: NUMBERS_TYPE[entry.type] as GitObjectType, data: entry.body };
    }
    // No size check here: for a delta entry the header's size is the delta
    // data's size, not the resolved object's (inflateEntry already checked
    // the inflated body against the header, and applyDelta checked the
    // target size).
    byOffset.set(entry.offset, resolved);
    byOid.set(hashObject(resolved.type, resolved.data), resolved);
    objects.push(resolved);
    return resolved;
  };
  for (const entry of raw) resolve(entry, new Set<number>());
  return objects;
}

/**
 * Inflate one pack entry starting at `offset`, returning its bytes and the
 * offset just past the zlib stream. inflateSync with `info: true` reports
 * the input bytes the stream consumed (engine.bytesWritten), so one call
 * finds both the data and the next entry's start.
 */
function inflateEntry(pack: Buffer, offset: number, end: number, expectedSize: number): { data: Buffer; nextOffset: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(pack.subarray(offset, end), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch {
    throw new PackError('a pack entry does not inflate');
  }
  const data = result.buffer;
  const consumed = result.engine.bytesWritten;
  if (!Number.isSafeInteger(consumed) || consumed <= 0 || offset + consumed > end) {
    throw new PackError('a pack entry reports no usable stream length');
  }
  if (data.length !== expectedSize) {
    throw new PackError(`a pack entry inflates to ${data.length} bytes, its header says ${expectedSize}`);
  }
  return { data, nextOffset: offset + consumed };
}

/** Write a packfile (version 2) of plain objects, with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeNumber = TYPE_NUMBERS[object.type];
    const size = object.data.length;
    // The type/size varint: 4 size bits in the first byte, 7 per later byte.
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeNumber << 4) | (remaining & 0x0f);
    remaining >>>= 4;
    while (remaining > 0) {
      headerBytes.push(first | 0x80);
      first = remaining & 0x7f;
      remaining >>>= 7;
    }
    headerBytes.push(first);
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Verify a packfile's trailer checksum without parsing its objects. */
export function packChecksumOk(pack: Buffer): boolean {
  if (pack.length < 32) return false;
  const trailer = pack.subarray(pack.length - 20);
  const checksum = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  return checksum.equals(trailer);
}
