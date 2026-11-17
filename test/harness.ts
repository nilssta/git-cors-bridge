// SPDX-License-Identifier: MIT

// the page side of the tests: isomorphic-git over an in-memory file system, talking to a git server
// only through the extension's client

import './buffer';

import * as git from 'isomorphic-git';

import {
  available,
  BridgeError,
  http,
  onAvailabilityChange,
  waitForApproval,
} from '../client/client.js';
import { MemoryFs } from './memory-fs';

const fs = new MemoryFs();
const dir = '/repo';
const author = { name: 'Bridge Tester', email: 'bridge@example.org' };
let auth = { username: '', password: '' };

async function write(path: string, text: string): Promise<void> {
  await fs.promises.writeFile(`${dir}/${path}`, text);
  await git.add({ fs, dir, filepath: path });
}

async function attempt<T>(
  run: () => Promise<T>,
): Promise<{ value?: T; code?: string; message?: string }> {
  try {
    return { value: await run() };
  } catch (error) {
    const cause = (error as { data?: { cause?: unknown } }).data?.cause ?? error;
    return {
      code: cause instanceof BridgeError ? cause.code : 'other',
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** what `onAvailabilityChange` reported since the page loaded */
const changes: boolean[] = [];
onAvailabilityChange((available) => changes.push(available));

const harness = {
  available: () => available(),

  changes: () => changes,

  /** `available()` against a stand-in that answers the ping with another protocol version */
  availableAgainst: async (version: number) => {
    const answer = (event: MessageEvent) => {
      const message = event.data as { channel?: string; from?: string; kind?: string };
      if (message?.channel !== 'git-cors-bridge' || message.from !== 'page') return;
      if (message.kind !== 'ping') return;
      window.postMessage({ channel: 'git-cors-bridge', from: 'extension', kind: 'ready', version });
    };
    window.addEventListener('message', answer);
    try {
      return await available();
    } finally {
      window.removeEventListener('message', answer);
    }
  },

  waitForApproval: (server: string) => attempt(() => waitForApproval(server)),

  /** a request aborted right after it was sent */
  abort: (url: string) =>
    attempt(async () => {
      const controller = new AbortController();
      const response = http.request({ url, signal: controller.signal });
      controller.abort();
      return (await response).statusCode;
    }),

  /** a raw request, for checking what the extension refuses */
  request: (url: string, method = 'GET') =>
    attempt(async () => (await http.request({ url, method })).statusCode),

  clone: (url: string, credentials: { username: string; password: string }) =>
    attempt(async () => {
      auth = credentials;
      await git.clone({ fs, http, dir, url, onAuth: () => auth });
      return {
        head: await git.resolveRef({ fs, dir, ref: 'HEAD' }),
        files: await git.listFiles({ fs, dir }),
      };
    }),

  /** a branch and main each get a commit, main merges the branch, and both are pushed */
  mergeAndPush: () =>
    attempt(async () => {
      await git.branch({ fs, dir, ref: 'feature', checkout: true });
      await write('feature.txt', 'from the branch\n');
      await git.commit({ fs, dir, author, message: 'Work on the branch\n' });
      await git.checkout({ fs, dir, ref: 'main' });
      await write('main.txt', 'from main\n');
      await git.commit({ fs, dir, author, message: 'Work on main\n' });
      const merged = await git.merge({
        fs,
        dir,
        ours: 'main',
        theirs: 'feature',
        author,
        message: 'Merge branch feature\n',
      });
      await git.checkout({ fs, dir, ref: 'main' });
      for (const ref of ['feature', 'main']) {
        const pushed = await git.push({ fs, http, dir, ref, onAuth: () => auth });
        if (!pushed.ok) throw new Error(`push of ${ref} failed: ${JSON.stringify(pushed.refs)}`);
      }
      return { merge: merged.oid };
    }),
};

export type Harness = typeof harness;

(globalThis as { harness?: Harness }).harness = harness;
