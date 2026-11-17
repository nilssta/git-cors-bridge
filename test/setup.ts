// SPDX-License-Identifier: MIT

// what the chromium and the firefox tests share: a bare repository behind `git http-backend`, the
// harness bundled as a website would bundle it, and websites that serve it

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { build } from 'vite';

import { gitServer } from './gitserver';

export const CREDENTIALS = { username: 'tester', password: 'glpat-bridge-test' };

/** runs git in `cwd` without the user's configuration */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
    .toString()
    .trim();
}

/** the test page's script, bundled as a website would bundle isomorphic-git and the client */
async function bundle(): Promise<string> {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    root: resolve(import.meta.dirname, '..'),
    build: {
      write: false,
      lib: { entry: resolve(import.meta.dirname, 'harness.ts'), formats: ['es'] },
    },
  });
  const [result] = Array.isArray(output) ? output : [output];
  if (!result || !('output' in result)) throw new Error('vite returned no bundle');
  const [chunk] = result.output;
  if (chunk?.type !== 'chunk') throw new Error('vite returned no script');
  return chunk.code;
}

/** a website serving the harness, on a port of its own */
async function website(script: string): Promise<{ origin: string; server: Server }> {
  const server = createServer((request, response) => {
    if (request.url === '/harness.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(script);
    } else {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><script type="module" src="/harness.js"></script>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

export interface World {
  scratch: string;
  bare: string;
  server: Awaited<ReturnType<typeof gitServer>>;
  repository: string;
  /** the website the tests enable, and one on another port of the same host */
  site: string;
  neighbour: string;
  /**
   * a copy of the browser's package with host permissions granted at install, so no permission
   * prompt waits for a click nobody makes
   * the approvals the extension keeps per website and server are still its own, and still start
   * empty
   */
  extension(browser: 'chrome' | 'firefox'): string;
  close(): Promise<void>;
}

/** a git server with one commit on `main`, and two websites serving the harness */
export async function world(): Promise<World> {
  const scratch = mkdtempSync(join(tmpdir(), 'gws-bridge-'));
  const bare = join(scratch, 'upstream.git');
  git(scratch, 'init', '--bare', '--initial-branch=main', bare);
  git(bare, 'config', 'http.receivepack', 'true');
  const seed = join(scratch, 'seed');
  git(scratch, 'init', '--initial-branch=main', seed);
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.org', 'commit', '-m', 'Seed');
  git(seed, 'push', '--quiet', bare, 'main');

  const server = await gitServer(scratch, CREDENTIALS);
  const script = await bundle();
  const site = await website(script);
  const neighbour = await website(script);
  return {
    scratch,
    bare,
    server,
    repository: `${server.origin}/upstream.git`,
    site: site.origin,
    neighbour: neighbour.origin,
    extension(browser) {
      const copy = join(scratch, `extension-${browser}`);
      // as `pnpm package` writes it
      cpSync(resolve(import.meta.dirname, '../dist', browser), copy, { recursive: true });
      const manifest = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8')) as object;
      writeFileSync(
        join(copy, 'manifest.json'),
        JSON.stringify({
          ...manifest,
          host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'],
        }),
      );
      return copy;
    },
    async close() {
      for (const http of [site.server, neighbour.server]) {
        await new Promise((resolve) => http.close(resolve));
      }
      await server.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
