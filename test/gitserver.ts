// SPDX-License-Identifier: MIT

import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

interface SeenRequest {
  method: string;
  host: string | undefined;
  url: string;
  cookie: string | undefined;
  authorization: string | undefined;
}

/**
 * real git over HTTP, as a git server answers it: `git http-backend` behind a small CGI host, with
 * basic authentication and no CORS headers
 * `/secret` answers anyone, for checking what a client refuses to fetch
 * `/moved.git/…` redirects to the same repository on `localhost`, which is the same server under
 * another origin
 */
export async function gitServer(
  root: string,
  credentials: { username: string; password: string },
): Promise<{ origin: string; seen: SeenRequest[]; close(): Promise<void> }> {
  const seen: SeenRequest[] = [];
  const expected = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  let port = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      seen.push({
        method: request.method ?? 'GET',
        host: request.headers.host,
        url: url.pathname + url.search,
        cookie: request.headers.cookie,
        authorization: request.headers.authorization,
      });
      if (url.pathname === '/secret') {
        response.end('secret');
        return;
      }
      if (url.pathname.startsWith('/moved.git/')) {
        const target = `http://localhost:${port}${url.pathname.replace('/moved.git/', '/upstream.git/')}${url.search}`;
        response.writeHead(request.method === 'POST' ? 307 : 302, { location: target }).end();
        return;
      }
      if (request.headers.authorization !== expected) {
        response.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end();
        return;
      }
      const { status, headers, body } = await backend(root, url, request, credentials.username);
      response.writeHead(status, headers).end(body);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function backend(root: string, url: URL, request: IncomingMessage, user: string) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const child = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method ?? 'GET',
      CONTENT_TYPE: request.headers['content-type'] ?? '',
      HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
      HTTP_GIT_PROTOCOL: (request.headers['git-protocol'] as string | undefined) ?? '',
      // http-backend allows pushing only to an authenticated user
      REMOTE_USER: user,
      REMOTE_ADDR: '127.0.0.1',
    },
  });
  child.stdin.end(Buffer.concat(chunks));
  const output: Buffer[] = [];
  for await (const chunk of child.stdout) output.push(chunk as Buffer);
  const all = Buffer.concat(output);
  const split = all.indexOf('\r\n\r\n');
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of all.subarray(0, split).toString().split('\r\n')) {
    const colon = line.indexOf(':');
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === 'status') status = Number.parseInt(value, 10);
    else headers[name] = value;
  }
  return { status, headers, body: all.subarray(split + 4) };
}
