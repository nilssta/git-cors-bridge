// SPDX-License-Identifier: MIT

// the options page: every enabled website, with its servers

const filter = /** @type {HTMLInputElement} */ (document.getElementById('filter'));
const summary = /** @type {HTMLElement} */ (document.getElementById('summary'));
const bulk = /** @type {HTMLElement} */ (document.getElementById('bulk'));
const list = /** @type {HTMLElement} */ (document.getElementById('sites'));

/** @type {Sites} */
let sites = {};
/** whether the bulk button waits for its confirmation */
let confirming = false;

/**
 * @typedef {{ site: string, entry: Site, servers: string[], pending: Pending[] }} Shown a website
 *   with the servers and waiting servers the filter lets through
 */

/** @param {string} text */
const matching = (text) => text.toLowerCase().includes(filter.value.trim().toLowerCase());

/** @returns {Shown[]} */
function shown() {
  return Object.entries(sites)
    .sort(([a], [b]) => new URL(a).host.localeCompare(new URL(b).host))
    .flatMap(([site, entry]) => {
      // a website that matches shows all of its servers
      if (matching(site)) return [{ site, entry, servers: entry.servers, pending: entry.pending }];
      const servers = entry.servers.filter(matching);
      const pending = entry.pending.filter(
        ({ server, repository }) => matching(server) || matching(repository ?? ''),
      );
      return servers.length + pending.length > 0 ? [{ site, entry, servers, pending }] : [];
    });
}

/** @param {Shown} item */
function card({ site, entry, servers, pending }) {
  const host = new URL(site).host;
  const counts = [plural(entry.servers.length, 'server') + ' allowed'];
  if (entry.pending.length > 0) counts.push(`${entry.pending.length} waiting`);
  const node = element('article', undefined, { className: 'card site-card' }, [
    row(
      site,
      counts.join(' · '),
      [
        button('Disable website', () => call('disableSite', { site }), {
          kind: 'danger',
          name: `Disable ${host}`,
          done: load,
        }),
      ],
      'div',
    ),
  ]);
  if (servers.length + pending.length === 0) {
    node.append(
      element('p', 'No servers yet. The website asks for them, and you allow each one.', {
        className: 'empty',
      }),
    );
    return node;
  }
  const items = element('ul', undefined, { ariaLabel: `Servers of ${host}` });
  for (const { server, repository } of pending) {
    const name = new URL(server).host;
    const item = row(server, repository, [
      element('span', 'Waiting', { className: 'pill wait' }),
      button(
        'Allow',
        async () => {
          if (await grant(server)) await call('approveServer', { site, server });
        },
        { kind: 'primary', name: `Allow ${name} for ${host}`, done: load },
      ),
      button('Dismiss', () => call('dismissServer', { site, server }), {
        name: `Dismiss ${name} for ${host}`,
        done: load,
      }),
    ]);
    item.classList.add('waiting');
    items.append(item);
  }
  for (const server of servers) {
    items.append(
      row(server, undefined, [
        button('Remove', () => call('revokeServer', { site, server }), {
          name: `Remove ${new URL(server).host} from ${host}`,
          done: load,
        }),
      ]),
    );
  }
  node.append(items);
  return node;
}

/** asks once more before it removes every allowed server shown */
function bulkActions(/** @type {Shown[]} */ items) {
  const connections = items.flatMap(({ site, servers }) => servers.map((server) => [site, server]));
  if (connections.length === 0) {
    confirming = false;
    return [];
  }
  const all = filter.value.trim() === '';
  if (!confirming) {
    const start = element(
      'button',
      all ? `Remove all (${connections.length})` : `Remove shown (${connections.length})`,
      { type: 'button', className: 'button danger' },
    );
    start.addEventListener('click', () => {
      confirming = true;
      render();
      /** @type {HTMLElement | null} */ (bulk.querySelector('.solid'))?.focus();
    });
    return [start];
  }
  const cancel = element('button', 'Cancel', { type: 'button', className: 'button quiet' });
  cancel.addEventListener('click', () => {
    confirming = false;
    render();
  });
  const confirm = button(
    `Remove ${plural(connections.length, 'connection')}`,
    () => call('revokeServers', { connections }),
    {
      kind: 'danger',
      done: () => {
        confirming = false;
        void load();
      },
    },
  );
  confirm.classList.add('solid');
  return [element('span', 'Sure?', { className: 'confirm' }), confirm, cancel];
}

function render() {
  const items = shown();
  const total = Object.values(sites).reduce((sum, entry) => sum + entry.servers.length, 0);
  const waiting = Object.values(sites).reduce((sum, entry) => sum + entry.pending.length, 0);
  const visible = items.reduce((sum, item) => sum + item.servers.length, 0);
  const websites = Object.keys(sites).length;

  if (filter.value.trim()) {
    summary.textContent = `Showing ${plural(items.length, 'website')} and ${visible} of ${plural(total, 'allowed server')}.`;
  } else {
    const parts = [plural(websites, 'website'), plural(total, 'allowed server')];
    if (waiting > 0) parts.push(`${waiting} waiting`);
    summary.textContent = parts.join(' · ');
  }
  summary.hidden = websites === 0;
  filter.disabled = websites === 0 && !filter.value;
  bulk.replaceChildren(...bulkActions(items));

  if (websites === 0) {
    list.replaceChildren(
      element('p', undefined, { className: 'blank' }, [
        'No websites enabled yet. Open a website, click the Git CORS Bridge button in the toolbar, and choose ',
        element('strong', 'Enable on this website'),
        '.',
      ]),
    );
  } else if (items.length === 0) {
    list.replaceChildren(
      element('p', `Nothing matches “${filter.value.trim()}”.`, { className: 'blank' }),
    );
  } else {
    list.replaceChildren(...items.map(card));
  }
}

async function load() {
  sites = await call('approvals');
  render();
}

filter.addEventListener('input', () => {
  confirming = false;
  render();
});
// the popup, a website asking for a server, or another copy of this page changed something
api.storage.onChanged.addListener((changes) => {
  if ('sites' in changes) void load().catch((error) => say(messageOf(error)));
});

load().catch((error) => say(messageOf(error)));
