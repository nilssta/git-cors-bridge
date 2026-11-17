// SPDX-License-Identifier: MIT

// playwright cannot load extensions into firefox, so puppeteer installs the package over bidi
// playwright still runs the test

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import puppeteer, { type Browser, type Page } from 'puppeteer';

import { call } from './call';
import { CREDENTIALS, git, world, type World } from './setup';

const { browser_specific_settings: settings } = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../extension/manifest.json'), 'utf8'),
) as { browser_specific_settings: { gecko: { id: string } } };
// firefox gives each install a random moz-extension:// host unless this preference names it
const UUID = '6f0d4c55-3c8e-4a8b-9a3e-1d2b7c9e0f11';

test.describe.configure({ mode: 'serial' });

let w: World;
let browser: Browser;
let page: Page;

async function open(target: Page, url: string): Promise<void> {
  await target.goto(url);
  await expect.poll(() => target.evaluate(() => 'harness' in globalThis)).toBe(true);
}

/**
 * opens an extension page
 * puppeteer never sees such a navigation finish, though the page loads, so wait for the page
 * instead
 */
async function visit(view: Page, url: string): Promise<void> {
  view.goto(url).catch(() => {});
  // the page's realm changes during the navigation, which a pending evaluation does not survive
  await expect
    .poll(() => view.evaluate(() => `${location.href} ${document.readyState}`).catch(() => ''))
    .toBe(`${url} complete`);
}

/** the popup, opened in a tab of its own and standing for the page's tab */
async function popup(): Promise<Page> {
  const view = await browser.newPage();
  const base = `moz-extension://${UUID}/popup.html`;
  await visit(view, base);
  const tab = await view.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id,
    page.url(),
  );
  await visit(view, `${base}?tab=${tab}`);
  return view;
}

/** clicks a popup button by its accessible name, and waits for the button the result shows */
async function click(view: Page, name: string, then: string): Promise<void> {
  await view.locator(`::-p-aria(${name})`).click();
  await view.waitForSelector(`::-p-aria(${then})`);
}

test.beforeAll(async () => {
  w = await world();
  browser = await puppeteer.launch({
    browser: 'firefox',
    headless: true,
    // lets the test script the popup, an extension page
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    extraPrefsFirefox: {
      'extensions.webextensions.uuids': JSON.stringify({ [settings.gecko.id]: UUID }),
    },
  });
  await browser.installExtension(w.extension('firefox'));
  page = await browser.newPage();
});

test.afterAll(async () => {
  await browser?.close();
  await w?.close();
});

test('Firefox: enable, approve, clone, merge and push, as in Chromium', async () => {
  await open(page, w.site);
  expect(await call(page, 'available')).toBe(false);

  let view = await popup();
  await click(view, 'Enable on this website', 'Disable on this website');
  await view.close();
  expect(await call(page, 'available')).toBe(true);

  expect(await call(page, 'clone', w.repository, CREDENTIALS)).toMatchObject({
    code: 'not-approved',
  });
  const waiting = call(page, 'waitForApproval', w.server.origin);
  view = await popup();
  const host = new URL(w.server.origin).host;
  await click(view, `Allow ${host}`, `Remove ${host}`);
  await view.close();
  expect(await waiting).toEqual({});

  const cloned = await call(page, 'clone', w.repository, CREDENTIALS);
  expect(cloned).toMatchObject({ value: { files: ['README.md'] } });
  expect(cloned.value?.head).toBe(git(w.bare, 'rev-parse', 'main'));

  // a push carries a request body, which reaches the bridge through firefox's content script
  // wrapper
  const pushed = await call(page, 'mergeAndPush');
  expect(pushed.message).toBeUndefined();
  expect(git(w.bare, 'rev-parse', 'main')).toBe(pushed.value?.merge);
  expect(w.server.seen.filter(({ cookie }) => cookie !== undefined)).toEqual([]);
});
