// SPDX-License-Identifier: MIT

// chrome runs this as a service worker, which loads shared.js here; firefox as an event page, whose
// manifest lists shared.js first

/** @type {any} */ (globalThis).importScripts?.('shared.js');

const SERVICES = ['git-upload-pack', 'git-receive-pack'];
const HEADERS = ['accept', 'authorization', 'content-type', 'git-protocol'];
// further servers are refused unlisted, so a website cannot fill the popup
const MAX_PENDING = 5;
// requests at once per website; each holds its request body in memory
const MAX_RUNNING = 8;

/** requests in flight, by website */
const running = new Map();

/** @typedef {{ code: string, message: string, server?: string }} Refusal */

async function approvals() {
  const { sites = {} } = /** @type {{ sites?: Sites }} */ (await api.storage.local.get('sites'));
  return sites;
}

let queue = Promise.resolve();

/**
 * every change to the approvals and the content script goes through here, so none writes back a
 * stale copy
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function serially(task) {
  const run = queue.then(task);
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

/**
 * @param {(sites: Sites) => void | Promise<void>} change
 */
function update(change) {
  return serially(async () => {
    const sites = await approvals();
    await change(sites);
    await api.storage.local.set({ sites });
  });
}

/**
 * undefined unless the sender is a website's top frame
 * @param {chrome.runtime.MessageSender | undefined} sender
 */
function siteOf(sender) {
  if (!sender?.tab || sender.frameId !== 0) return undefined;
  // chrome tells the origin itself; firefox only the URL
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined);
  return origin && origin !== 'null' ? origin : undefined;
}

/**
 * undefined for anything but git's smart HTTP requests
 * @param {URL} url
 * @param {string} method
 */
function gitService(url, method) {
  if (method === 'GET' && url.pathname.endsWith('/info/refs')) {
    const service = url.searchParams.get('service');
    return service && SERVICES.includes(service) ? service : undefined;
  }
  if (method === 'POST') return SERVICES.find((service) => url.pathname.endsWith(`/${service}`));
  return undefined;
}

/**
 * shown in the popup, for the user to judge a server by
 * @param {URL} url
 */
function repositoryOf(url) {
  return url.pathname.replace(/\/(info\/refs|git-upload-pack|git-receive-pack)$/, '') || '/';
}

/** @param {string} origin */
function granted(origin) {
  return api.permissions.contains({ origins: [pattern(origin)] });
}

function registerBridges() {
  return serially(async () => {
    const sites = Object.keys(await approvals());
    const registered = await api.scripting.getRegisteredContentScripts();
    if (registered.length > 0) {
      await api.scripting.unregisterContentScripts({
        ids: registered.map(({ id }) => id),
      });
    }
    if (sites.length === 0) return;
    await api.scripting.registerContentScripts([
      {
        id: 'bridge',
        matches: [...new Set(sites.map(pattern))],
        js: ['shared.js', 'bridge.js'],
        runAt: 'document_start',
      },
    ]);
  });
}

/**
 * their URLs are visible through the host permission the website was enabled with
 * @param {string} site
 */
async function tabsOf(site) {
  const tabs = await api.tabs.query({ url: pattern(site) });
  return tabs.filter((tab) => tab.id !== undefined && tab.url && new URL(tab.url).origin === site);
}

/**
 * @param {number} tabId
 * @param {string} site
 */
async function showBadge(tabId, site) {
  const count = (await approvals())[site]?.pending.length ?? 0;
  try {
    await api.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
  } catch {
    // the tab closed meanwhile
  }
}

/** @param {string} site */
async function refreshBadges(site) {
  for (const tab of await tabsOf(site)) await showBadge(/** @type {number} */ (tab.id), site);
}

/**
 * @param {string} site
 * @param {{ kind: 'approved' | 'dismissed', server: string } | { kind: 'disabled' }} message
 */
async function tell(site, message) {
  for (const tab of await tabsOf(site)) {
    api.tabs.sendMessage(/** @type {number} */ (tab.id), message).catch(() => {
      // a tab without a bridge, such as one loaded before the website was enabled
    });
  }
}

/** host permissions are given back once nothing uses them */
async function releasePermissions() {
  const sites = await approvals();
  const used = new Set(
    Object.entries(sites).flatMap(([site, entry]) => [site, ...entry.servers].map(pattern)),
  );
  const { origins = [] } = await api.permissions.getAll();
  for (const origin of origins) {
    if (used.has(origin)) continue;
    try {
      await api.permissions.remove({ origins: [origin] });
    } catch {
      // granted at install, which only the manifest can take back
    }
  }
}

/** for permissions the user took back in the browser's settings */
async function forgetUngranted() {
  await update(async (sites) => {
    for (const [site, entry] of Object.entries(sites)) {
      if (!(await granted(site))) {
        delete sites[site];
        continue;
      }
      const kept = [];
      for (const server of entry.servers) if (await granted(server)) kept.push(server);
      entry.servers = kept;
    }
  });
  await registerBridges();
}

// firefox forgets registered scripts on restart; registering again is harmless where it does not
api.runtime.onStartup.addListener(() => void registerBridges());
api.runtime.onInstalled.addListener(() => void registerBridges());
api.permissions.onRemoved.addListener(() => void forgetUngranted());
void api.action.setBadgeBackgroundColor({ color: '#b45309' });

/**
 * after the browser granted the website's host, from the popup
 * @param {string} site
 * @param {number} [tabId]
 */
async function enableSite(site, tabId) {
  if (!allowedOrigin(site)) throw new Error(`${site} is not reached over HTTPS`);
  await update((sites) => {
    sites[site] ??= { servers: [], pending: [] };
  });
  await registerBridges();
  if (tabId !== undefined) {
    await api.scripting.executeScript({
      target: { tabId },
      files: ['shared.js', 'bridge.js'],
    });
  }
}

/** @param {string} site */
async function disableSite(site) {
  await update((sites) => {
    delete sites[site];
  });
  await registerBridges();
  // before the website's permission goes, while its tabs can still be found
  await tell(site, { kind: 'disabled' });
  await refreshBadges(site);
  await releasePermissions();
}

/**
 * after the browser granted the server's host, from the popup
 * @param {string} site
 * @param {string} server
 */
async function approveServer(site, server) {
  await update((sites) => {
    const entry = sites[site];
    if (!entry) throw new Error(`${site} is not enabled`);
    entry.pending = entry.pending.filter((item) => item.server !== server);
    if (!entry.servers.includes(server)) entry.servers.push(server);
  });
  await refreshBadges(site);
  await tell(site, { kind: 'approved', server });
}

/**
 * the website may ask for it again
 * @param {string} site
 * @param {string} server
 */
async function dismissServer(site, server) {
  await update((sites) => {
    const entry = sites[site];
    if (entry) entry.pending = entry.pending.filter((item) => item.server !== server);
  });
  await refreshBadges(site);
  await tell(site, { kind: 'dismissed', server });
}

/**
 * @param {string} site
 * @param {string} server
 */
async function revokeServer(site, server) {
  await update((sites) => {
    const entry = sites[site];
    if (entry) entry.servers = entry.servers.filter((origin) => origin !== server);
  });
  await releasePermissions();
}

/**
 * @param {[string, string][]} connections each a website and a server
 */
async function revokeServers(connections) {
  await update((sites) => {
    for (const [site, server] of connections) {
      const entry = sites[site];
      if (entry) entry.servers = entry.servers.filter((origin) => origin !== server);
    }
  });
  await releasePermissions();
}

/**
 * @param {string} site
 * @param {URL} url
 * @param {string} method
 * @returns {Promise<Refusal | undefined>}
 */
async function refusal(site, url, method) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { code: 'not-git', message: `${url.protocol} is not a git transport` };
  }
  if (!allowedOrigin(url.origin)) {
    return { code: 'insecure', message: `${url.origin} is not reached over plain HTTP` };
  }
  if (!gitService(url, method)) {
    return { code: 'not-git', message: `${method} ${url.pathname} is not a git request` };
  }
  const entry = (await approvals())[site];
  if (!entry) {
    return { code: 'not-enabled', message: `Git CORS Bridge is not enabled on ${site}` };
  }
  const server = url.origin;
  const allowed = await granted(server);
  if (allowed && entry.servers.includes(server)) return undefined;
  let listed = false;
  await update((sites) => {
    const current = sites[site];
    if (!current) return;
    // the browser's permission was taken back since, so it has to be allowed again
    if (!allowed) current.servers = current.servers.filter((origin) => origin !== server);
    listed = current.pending.some((item) => item.server === server);
    if (listed || current.servers.includes(server) || current.pending.length >= MAX_PENDING) return;
    current.pending.push({ server, repository: repositoryOf(url) });
    listed = true;
  });
  await refreshBadges(site);
  return {
    code: 'not-approved',
    server,
    message: listed
      ? `${server} is not approved for ${site}: open Git CORS Bridge from the toolbar to allow it`
      : `${server} is not approved for ${site}, and too many servers already wait for approval`,
  };
}

/**
 * one port per request
 * the bridge sends the request's head, its body in chunks and an end; this answers with the
 * response's head, its body in chunks and an end, or an error at any point
 * anything out of that order ends the request
 */
api.runtime.onConnect.addListener((port) => {
  if (port.name !== CHANNEL) return;
  const site = siteOf(port.sender);
  if (!site) {
    port.disconnect();
    return;
  }
  const abort = new AbortController();
  /** @type {Uint8Array[]} */
  const body = [];
  /** @type {{ url: string, method?: string, headers?: Record<string, string> } | undefined} */
  let head;
  /** @type {'head' | 'body' | 'sent'} */
  let expecting = 'head';
  port.onDisconnect.addListener(() => abort.abort());
  port.onMessage.addListener((message) => {
    const kind = message?.kind;
    if (expecting === 'head' && kind === 'head' && typeof message.url === 'string') {
      head = message;
      expecting = 'body';
    } else if (expecting === 'body' && kind === 'chunk' && typeof message.data === 'string') {
      body.push(fromBase64(message.data));
    } else if (expecting === 'body' && kind === 'end' && head) {
      expecting = 'sent';
      void send(site, head, body, port, abort.signal);
    } else {
      abort.abort();
      port.disconnect();
    }
  });
});

/**
 * @param {string} site
 * @param {{ url: string, method?: string, headers?: Record<string, string> }} request
 * @param {Uint8Array[]} chunks
 * @param {chrome.runtime.Port} port
 * @param {AbortSignal} signal
 */
async function send(site, request, chunks, port, signal) {
  /** @param {object} message */
  const reply = (message) => {
    try {
      port.postMessage(message);
    } catch {
      // the page went away; the abort signal ends the fetch
    }
  };
  const count = running.get(site) ?? 0;
  if (count >= MAX_RUNNING) {
    reply({
      kind: 'error',
      code: 'busy',
      message: `${site} has ${count} requests running through Git CORS Bridge already`,
    });
    return;
  }
  running.set(site, count + 1);
  try {
    const url = new URL(request.url);
    const method = (request.method ?? 'GET').toUpperCase();
    const refused = await refusal(site, url, method);
    if (refused) {
      reply({ kind: 'error', ...refused });
      return;
    }
    const headers = Object.fromEntries(
      Object.entries(request.headers ?? {}).filter(([name]) =>
        HEADERS.includes(name.toLowerCase()),
      ),
    );
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const payload = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      payload.set(chunk, offset);
      offset += chunk.length;
    }
    // the user's cookies for the server stay out: only what the page itself sends authenticates
    // no redirect is followed, since a followed one has reached its target before it can be checked
    // an extension does not get to see the target, so same-origin ones are refused too
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'POST' ? payload : undefined,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'manual',
      signal,
    });
    if (response.type === 'opaqueredirect') {
      reply({
        kind: 'error',
        code: 'redirected',
        message: `${url.origin} redirected ${url.pathname}, which is not followed: use the repository's current address`,
      });
      return;
    }
    reply({
      kind: 'head',
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
    });
    const reader = response.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let start = 0; start < value.length; start += CHUNK) {
        reply({ kind: 'chunk', data: toBase64(value.subarray(start, start + CHUNK)) });
      }
    }
    reply({ kind: 'end' });
  } catch (error) {
    if (signal.aborted) return;
    reply({
      kind: 'error',
      code: 'network',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    const left = (running.get(site) ?? 1) - 1;
    if (left > 0) running.set(site, left);
    else running.delete(site);
  }
}

/** @type {Record<string, (message: any, sender: chrome.runtime.MessageSender) => Promise<unknown>>} */
const pageActions = {
  approvals: () => approvals(),
  enableSite: ({ site, tabId }) => enableSite(site, tabId),
  disableSite: ({ site }) => disableSite(site),
  approveServer: ({ site, server }) => approveServer(site, server),
  dismissServer: ({ site, server }) => dismissServer(site, server),
  revokeServer: ({ site, server }) => revokeServer(site, server),
  revokeServers: ({ connections }) => revokeServers(connections),
};

/** @type {Record<string, (message: any, sender: chrome.runtime.MessageSender) => Promise<unknown>>} */
const bridgeActions = {
  // asked once per page, since the content script also runs on the host's other ports
  // a page load resets the tab's badge
  status: async (_message, sender) => {
    const site = siteOf(sender);
    if (!site) return { enabled: false };
    await showBadge(/** @type {number} */ (sender.tab?.id), site);
    return { enabled: site in (await approvals()) };
  },
};

// a website's bridge may only ask about itself
// the extension's own pages are told apart by URL, since the tests open the popup in a tab
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== api.runtime.id) return false;
  const fromPage = sender.url?.startsWith(api.runtime.getURL('')) ?? false;
  const actions = fromPage ? pageActions : bridgeActions;
  const name = message?.action;
  if (typeof name !== 'string' || !Object.hasOwn(actions, name)) return false;
  const action = /** @type {(typeof actions)[string]} */ (actions[name]);
  action(message, sender).then(
    (value) => respond({ value }),
    (error) => respond({ error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});
