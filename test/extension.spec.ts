// SPDX-License-Identifier: MIT

import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
  type Worker,
} from '@playwright/test';

import { call } from './call';
import { CREDENTIALS, git, world, type World } from './setup';

type Sites = Record<
  string,
  { servers: string[]; pending: { server: string; repository?: string }[] }
>;

/** the extension's background, whose functions are globals of its service worker */
type Background = {
  enableSite(site: string): Promise<void>;
  approveServer(site: string, server: string): Promise<void>;
  dismissServer(site: string, server: string): Promise<void>;
  approvals(): Promise<Sites>;
};

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect.poll(() => page.evaluate(() => 'harness' in globalThis)).toBe(true);
}

test.describe.configure({ mode: 'serial' });

let w: World;
let context: BrowserContext;
let worker: Worker;
let page: Page;

const approvals = () => worker.evaluate(() => (globalThis as unknown as Background).approvals());

async function tabId(): Promise<number> {
  const url = page.url();
  return worker.evaluate(
    async (url) =>
      (await chrome.tabs.query({ url: 'http://127.0.0.1/*' })).find((tab) => tab.url === url)?.id ??
      -1,
    url,
  );
}

const badge = async () => {
  const tab = await tabId();
  return worker.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tab);
};

/** the popup, opened in a tab of its own and standing for the page's tab */
async function popup(): Promise<Page> {
  const id = new URL(worker.url()).host;
  const view = await context.newPage();
  await view.goto(`chrome-extension://${id}/popup.html?tab=${await tabId()}`);
  return view;
}

test.beforeAll(async () => {
  w = await world();
  const extension = w.extension('chrome');
  context = await chromium.launchPersistentContext(`${w.scratch}/profile`, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  await w?.close();
});

test('stays out of a website until the user enables it', async () => {
  await open(page, w.site);
  expect(await call(page, 'available')).toBe(false);
  // without the extension the browser holds the server's answer back from the page
  const direct = await page.evaluate(
    (url) =>
      fetch(url).then(
        () => 'read',
        () => 'blocked',
      ),
    `${w.repository}/info/refs?service=git-upload-pack`,
  );
  expect(direct).toBe('blocked');
});

test('a client uses only a bridge that speaks its protocol version', async () => {
  expect(await call(page, 'availableAgainst', 2)).toBe(false);
  expect(await call(page, 'availableAgainst', 1)).toBe(true);
});

test('enabling the website opens it to the bridge, on its own port only', async () => {
  const view = await popup();
  await view.getByRole('button', { name: 'Enable on this website' }).click();
  await expect(view.getByText('Enabled', { exact: true })).toBeVisible();
  await view.close();
  expect(Object.keys(await approvals())).toEqual([w.site]);
  // the open tab got the bridge at once, and the page heard of it
  expect(await call(page, 'available')).toBe(true);
  expect(await call(page, 'changes')).toEqual([true]);

  const other = await context.newPage();
  await open(other, w.neighbour);
  expect(await call(other, 'available')).toBe(false);
  await other.close();
});

test('only git requests go out', async () => {
  expect(await call(page, 'request', `${w.server.origin}/secret`)).toMatchObject({
    code: 'not-git',
  });
  expect(w.server.seen.some(({ url }) => url === '/secret')).toBe(false);
  expect(
    await call(page, 'request', 'http://example.com/repo.git/info/refs?service=git-upload-pack'),
  ).toMatchObject({ code: 'insecure' });
});

test('an unapproved server is refused, waits in the popup, and can be dismissed', async () => {
  const before = w.server.seen.length;
  expect(await call(page, 'clone', w.repository, CREDENTIALS)).toMatchObject({
    code: 'not-approved',
  });
  expect(w.server.seen).toHaveLength(before);
  expect((await approvals())[w.site]?.pending).toEqual([
    { server: w.server.origin, repository: '/upstream.git' },
  ]);
  expect(await badge()).toBe('1');

  const waiting = call(page, 'waitForApproval', w.server.origin);
  const view = await popup();
  await expect(view.getByText('/upstream.git')).toBeVisible();
  await view.getByRole('button', { name: `Dismiss ${new URL(w.server.origin).host}` }).click();
  expect(await waiting).toMatchObject({ code: 'not-approved' });
  await view.close();
  expect((await approvals())[w.site]?.pending).toEqual([]);
  expect(await badge()).toBe('');
});

test('a website cannot fill the popup with servers', async () => {
  for (let index = 0; index < 8; index++) {
    await call(
      page,
      'request',
      `https://s${index}.invalid/repo.git/info/refs?service=git-upload-pack`,
    );
  }
  const pending = (await approvals())[w.site]?.pending ?? [];
  expect(pending).toHaveLength(5);
  for (const { server } of pending) {
    await worker.evaluate(
      ([site, server]) => (globalThis as unknown as Background).dismissServer(site, server),
      [w.site, server] as const,
    );
  }
});

test('allowing the server lets the waiting page clone, with its own credentials only', async () => {
  expect(await call(page, 'clone', w.repository, CREDENTIALS)).toMatchObject({
    code: 'not-approved',
  });
  const waiting = call(page, 'waitForApproval', w.server.origin);
  const view = await popup();
  await view.getByRole('button', { name: `Allow ${new URL(w.server.origin).host}` }).click();
  expect(await waiting).toEqual({ value: undefined });
  await expect(
    view.getByRole('button', { name: `Remove ${new URL(w.server.origin).host}` }),
  ).toBeVisible();
  await view.close();
  expect((await approvals())[w.site]).toEqual({ servers: [w.server.origin], pending: [] });

  await context.addCookies([{ name: 'session', value: 'browser-login', url: w.server.origin }]);
  const cloned = await call(page, 'clone', w.repository, CREDENTIALS);
  expect(cloned).toMatchObject({ value: { files: ['README.md'] } });
  expect(cloned.value?.head).toBe(git(w.bare, 'rev-parse', 'main'));
  expect(w.server.seen.some(({ authorization }) => authorization !== undefined)).toBe(true);
  expect(w.server.seen.filter(({ cookie }) => cookie !== undefined)).toEqual([]);
});

test('a merge commit pushed through it keeps its id on the server', async () => {
  const pushed = await call(page, 'mergeAndPush');
  expect(pushed.message).toBeUndefined();
  expect(git(w.bare, 'rev-parse', 'main')).toBe(pushed.value?.merge);
  expect(git(w.bare, 'log', '-1', '--format=%P', 'main').split(' ')).toHaveLength(2);
  expect(git(w.bare, 'ls-tree', '--name-only', 'main').split('\n')).toEqual([
    'README.md',
    'feature.txt',
    'main.txt',
  ]);
});

test('a redirect is refused before it is followed', async () => {
  const moved = `${w.server.origin}/moved.git`;
  expect(await call(page, 'request', `${moved}/info/refs?service=git-upload-pack`)).toMatchObject({
    code: 'redirected',
  });
  expect(await call(page, 'request', `${moved}/git-upload-pack`, 'POST')).toMatchObject({
    code: 'redirected',
  });
  expect(w.server.seen.filter(({ host }) => host?.startsWith('localhost'))).toEqual([]);
});

test('a request can be cancelled', async () => {
  expect(
    await call(page, 'abort', `${w.repository}/info/refs?service=git-upload-pack`),
  ).toMatchObject({ code: 'disconnected' });
});

test('the manage page lists every connection, filters them, and removes one or all shown', async () => {
  const site = new URL(w.site).host;
  const neighbour = new URL(w.neighbour).host;
  const other = 'https://git.example.org';
  await worker.evaluate(
    async ([site, neighbour, server, other]) => {
      const background = globalThis as unknown as Background;
      await background.enableSite(neighbour);
      await background.approveServer(neighbour, server);
      await background.approveServer(neighbour, other);
      await background.approveServer(site, other);
    },
    [w.site, w.neighbour, w.server.origin, other] as const,
  );

  // the popup shows only the open website, and leads to the rest
  const view = await popup();
  await expect(view.getByText(neighbour)).toHaveCount(0);
  const [manage] = await Promise.all([
    context.waitForEvent('page'),
    view.getByRole('button', { name: 'Manage all connections' }).click(),
  ]);
  await expect(manage).toHaveURL(/\/manage\.html$/);
  await expect(manage.getByText('2 websites · 4 allowed servers')).toBeVisible();

  await manage.getByRole('searchbox').fill('example');
  await expect(manage.getByText('Showing 2 websites and 2 of 4 allowed servers.')).toBeVisible();
  await manage.getByRole('button', { name: `Remove git.example.org from ${site}` }).click();
  await expect(manage.getByText('Showing 1 website and 1 of 3 allowed servers.')).toBeVisible();

  await manage.getByRole('button', { name: 'Remove shown (1)' }).click();
  await manage.getByRole('button', { name: 'Remove 1 connection' }).click();
  await expect(manage.getByText('Nothing matches “example”.')).toBeVisible();
  expect(await approvals()).toEqual({
    [w.site]: { servers: [w.server.origin], pending: [] },
    [w.neighbour]: { servers: [w.server.origin], pending: [] },
  });

  await manage.getByRole('searchbox').fill('');
  await manage.getByRole('button', { name: `Disable ${neighbour}` }).click();
  await expect(manage.getByText('1 website · 1 allowed server')).toBeVisible();
  await manage.close();
  expect(Object.keys(await approvals())).toEqual([w.site]);
});

test('removing the server and disabling the website take effect at once, in the open page too', async () => {
  let view = await popup();
  await view.getByRole('button', { name: `Remove ${new URL(w.server.origin).host}` }).click();
  await expect(view.getByText('No servers yet.')).toBeVisible();
  await view.close();
  expect(
    await call(page, 'request', `${w.repository}/info/refs?service=git-upload-pack`),
  ).toMatchObject({ code: 'not-approved' });

  view = await popup();
  await view.getByRole('button', { name: 'Disable on this website' }).click();
  await expect(view.getByRole('button', { name: 'Enable on this website' })).toBeVisible();
  await view.close();
  expect(await approvals()).toEqual({});
  // the open page heard of it, and the bridge in it went silent without a reload
  expect(await call(page, 'changes')).toEqual([true, false]);
  expect(await call(page, 'available')).toBe(false);
  expect(
    await call(page, 'request', `${w.repository}/info/refs?service=git-upload-pack`),
  ).toMatchObject({ code: 'unavailable' });

  // enabled again in the same tab, the bridge already in it comes back
  view = await popup();
  await view.getByRole('button', { name: 'Enable on this website' }).click();
  await expect(view.getByText('Enabled', { exact: true })).toBeVisible();
  await view.close();
  expect(await call(page, 'changes')).toEqual([true, false, true]);
  expect(await call(page, 'available')).toBe(true);
});
