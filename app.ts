// The forge's dispatcher: one server, four surfaces, one store.
//
//   GET  /healthz             the env's boot probe: 200 {"ok":true}, no token
//   *    /api/v3/*            the REST v3 API (rest.ts), token required past the root
//   POST /api/graphql         the GraphQL v4 API (graphql.ts), token required
//   POST /mcp                 the MCP endpoint (mcp.ts), token required
//   *    /{owner}/{repo}.git  git smart HTTP (gitproto.ts), token required
//   *    anything else        a JSON 404 with a request id, never HTML
//
// The bearer token is MAKEFUN_SHOP_TOKEN, read once at startup; every surface
// compares against it (an empty token skips auth, for local smoke tests).
// A handler that throws answers 500 JSON and the server stays up: the suite
// drives the forge as a client, and a crashed server fails every check after.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleMcp } from './mcp.ts';
import { handleGraphQL } from './graphql.ts';
import { nextRequestId, pathSegments, readBody, sendJson } from './http.ts';

/** The token the suite presents; '' when the env did not set one. */
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Parse a request URL, or null when it does not parse (never a throw). */
function urlOf(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return null;
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = nextRequestId();
    const method = req.method ?? 'GET';
    const url = urlOf(req);
    const path = url === null ? '/' : url.pathname;
    const segments = url === null ? [] : pathSegments(url);

    // The env's boot check calls this twice: 200 {"ok":true}, no token, no body.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true }, requestId);
      return;
    }

    // Everything else reads the body first; the handlers take the buffer.
    readBody(req)
      .then((body) => {
        try {
          // REST v3: /api/v3 and everything under it.
          if (segments[0] === 'api' && segments[1] === 'v3') {
            handleRest(
              {
                req,
                res,
                method,
                segments: segments.slice(2),
                query: url === null ? new URLSearchParams() : url.searchParams,
                body,
                requestId,
                host: req.headers.host ?? 'entry',
                pathname: path,
              },
              TOKEN,
            );
            return;
          }

          // GraphQL v4: POST /api/graphql.
          if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
            handleGraphQL({ req, res, method, body, requestId }, TOKEN);
            return;
          }

          // MCP: POST /mcp.
          if (segments[0] === 'mcp' && segments.length === 1) {
            handleMcp({ req, res, method, body, requestId }, TOKEN);
            return;
          }

          // Git smart HTTP: /{owner}/{repo}.git/... — the second segment ends in .git.
          if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
            handleGit(
              {
                req,
                res,
                method,
                segments,
                query: url === null ? new URLSearchParams() : url.searchParams,
                body,
                requestId,
              },
              TOKEN,
            );
            return;
          }

          // Everything else, every method: GitHub's 404 body, as JSON.
          sendJson(res, 404, { message: 'Not Found' }, requestId);
        } catch (err) {
          if (!res.writableEnded) {
            sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, requestId);
          }
        }
      })
      .catch(() => {
        if (!res.writableEnded) {
          sendJson(res, 400, { message: 'Bad Request' }, requestId);
        }
      });
  });
}
