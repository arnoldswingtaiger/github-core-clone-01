// Shared HTTP plumbing for the forge's surfaces: reading request bodies,
// answering JSON (always with a request id), and the bearer-token check.
// Every REST reply is application/json and carries a non-empty
// X-GitHub-Request-Id; an error body is {"message": string}.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';
export const OAUTH_SCOPES = 'repo, read:org';

let requestCounter = 0;

/** A fresh request id: unique per request, non-empty, cheap. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${process.pid}-${requestCounter}`;
}

/** Read a request's whole body as a buffer (uncapped: packs are the big ones). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Answer with a JSON body and the forge's standard headers. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

/** Answer with no body (204), still carrying the request id. */
export function sendEmpty(res: ServerResponse, status: number, requestId: string): void {
  res.writeHead(status, { 'x-github-request-id': requestId });
  res.end();
}

/** Answer with a JSON {"message"} error body. */
export function sendError(res: ServerResponse, status: number, message: string, requestId: string): void {
  sendJson(res, status, { message }, requestId);
}

/** Parse a JSON request body: an empty body is {}, malformed JSON is an error. */
export function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  const text = body.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** The bearer token a request presents, or null when it presents none. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match === null ? null : (match[1] as string);
}

/** Whether a value is a plain JSON object (not an array, not null). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string field of a JSON object, or a default when it is absent or not a string. */
export function stringField(body: Record<string, unknown>, field: string, fallback = ''): string {
  const value = body[field];
  return typeof value === 'string' ? value : fallback;
}

/** A boolean field of a JSON object, or a default when it is absent or not a boolean. */
export function booleanField(body: Record<string, unknown>, field: string, fallback = false): boolean {
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

/** The path segments of a request URL, percent-decoded, without empty pieces. */
export function pathSegments(url: URL): string[] {
  return url.pathname
    .split('/')
    .filter((piece) => piece !== '')
    .map((piece) => {
      try {
        return decodeURIComponent(piece);
      } catch {
        return piece;
      }
    });
}

/** An integer query value, clamped to a range, or a default when absent/invalid. */
export function intQuery(query: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
