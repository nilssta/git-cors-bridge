// SPDX-License-Identifier: MIT

// uses the client as a website would: when a server is refused, it waits for the user's approval

import '../test/buffer';

import * as git from 'isomorphic-git';

import {
  available,
  BridgeError,
  http,
  onAvailabilityChange,
  waitForApproval,
} from '../client/client.js';
import { MemoryFs } from '../test/memory-fs';

const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const bridge = element('bridge');
const bridgeTitle = element('bridge-title');
const bridgeHelp = element('bridge-help');
const waiting = element('waiting');
const form = element<HTMLFormElement>('form');
const url = element<HTMLInputElement>('url');
const username = element<HTMLInputElement>('username');
const password = element<HTMLInputElement>('password');
const cloneButton = element<HTMLButtonElement>('clone');
const pushButton = element<HTMLButtonElement>('push');
const message = element('message');
const result = element('result');

const dir = '/repo';
let fs: MemoryFs | undefined;
let busy = false;
/** stops the current wait for approval */
let stopWaiting: AbortController | undefined;

function say(text: string, kind: 'ok' | 'problem' | 'info' = 'info'): void {
  message.textContent = text;
  message.dataset.kind = kind;
}

function showBridge(ready: boolean): void {
  bridge.dataset.state = ready ? 'ready' : 'missing';
  bridgeTitle.textContent = ready
    ? 'Git CORS Bridge is enabled on this website'
    : 'Git CORS Bridge is not available';
  bridgeHelp.hidden = ready;
}

let checking: Promise<void> | undefined;

function check(): Promise<void> {
  checking ??= available().then((ready) => {
    showBridge(ready);
    checking = undefined;
  });
  return checking;
}

element('recheck').addEventListener('click', () => void check());
window.addEventListener('focus', () => {
  if (bridge.dataset.state !== 'ready') void check();
});
onAvailabilityChange(showBridge);
void check();

/** isomorphic-git wraps the bridge's refusal */
function bridgeError(error: unknown): BridgeError | undefined {
  const cause = (error as { data?: { cause?: unknown } }).data?.cause ?? error;
  return cause instanceof BridgeError ? cause : undefined;
}

async function approval(server: string): Promise<void> {
  const host = new URL(server).host;
  element('waiting-host').textContent = host;
  element('waiting-host-again').textContent = host;
  waiting.hidden = false;
  say('');
  stopWaiting = new AbortController();
  try {
    await waitForApproval(server, { signal: stopWaiting.signal });
  } finally {
    waiting.hidden = true;
    stopWaiting = undefined;
  }
}

element('stop').addEventListener('click', () => stopWaiting?.abort());

/** runs `operation`, and runs it again once the user allows a server it was refused */
async function approved<T>(operation: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      const refusal = bridgeError(error);
      if (refusal?.code !== 'not-approved' || !refusal.server) throw error;
      await approval(refusal.server);
    }
  }
}

function explain(error: unknown): string {
  const refusal = bridgeError(error);
  switch (refusal?.code) {
    case undefined:
      break;
    case 'not-approved':
      return refusal.server
        ? `You dismissed ${new URL(refusal.server).host}. Try again to ask once more.`
        : refusal.message;
    case 'disconnected':
      return 'Stopped.';
    case 'unavailable':
    case 'not-enabled':
      void check();
      return 'Git CORS Bridge is not installed, or not enabled on this website.';
    case 'insecure':
      return 'Only HTTPS servers are allowed, apart from localhost.';
    case 'not-git':
      return 'That URL is not a git repository the bridge carries requests for.';
    default:
      return refusal?.message ?? '';
  }
  const text = error instanceof Error ? error.message : String(error);
  if (/\b401\b|\b403\b/.test(text)) {
    return `${text}. Check the username and the token, and that the token may read (or, for a push, write) the repository.`;
  }
  return text;
}

function credentials() {
  return username.value || password.value
    ? { username: username.value, password: password.value }
    : { cancel: true };
}

async function run(label: string, operation: () => Promise<string>): Promise<void> {
  if (busy) return;
  busy = true;
  cloneButton.disabled = pushButton.disabled = true;
  say(`${label}…`);
  try {
    say(await approved(operation), 'ok');
  } catch (error) {
    say(explain(error), 'problem');
  } finally {
    busy = false;
    cloneButton.disabled = false;
    pushButton.disabled = !fs;
  }
}

async function show(files: MemoryFs): Promise<void> {
  const branch = (await git.currentBranch({ fs: files, dir })) ?? '(detached)';
  element('branch').textContent = branch;
  element('head').textContent = (await git.resolveRef({ fs: files, dir, ref: 'HEAD' })).slice(
    0,
    12,
  );
  element('files').replaceChildren(
    ...(await git.listFiles({ fs: files, dir })).map((name) => {
      const item = document.createElement('li');
      item.textContent = name;
      return item;
    }),
  );
  result.hidden = false;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void run('Cloning', async () => {
    const files = new MemoryFs();
    await git.clone({
      fs: files,
      http,
      dir,
      url: url.value,
      singleBranch: true,
      onAuth: credentials,
    });
    fs = files;
    await show(files);
    const count = (await git.listFiles({ fs: files, dir })).length;
    return `Cloned ${count} ${count === 1 ? 'file' : 'files'}.`;
  });
});

pushButton.addEventListener('click', () => {
  const files = fs;
  if (!files) return;
  void run('Pushing', async () => {
    const stamp = new Date().toISOString();
    await files.promises.writeFile(
      `${dir}/bridge-demo.txt`,
      `Pushed through Git CORS Bridge at ${stamp}\n`,
    );
    await git.add({ fs: files, dir, filepath: 'bridge-demo.txt' });
    await git.commit({
      fs: files,
      dir,
      author: { name: username.value || 'Git CORS Bridge demo', email: 'demo@example.org' },
      message: `Git CORS Bridge demo, ${stamp}\n`,
    });
    const pushed = await git.push({ fs: files, http, dir, onAuth: credentials });
    if (!pushed.ok) throw new Error(`The server refused the push: ${pushed.error ?? 'unknown'}`);
    await show(files);
    return 'Committed and pushed.';
  });
});
