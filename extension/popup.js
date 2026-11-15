// SPDX-License-Identifier: MIT

// the browser asks for a host's permission only from a click, so every grant starts here

const content = /** @type {HTMLElement} */ (document.getElementById('content'));
const footer = /** @type {HTMLElement} */ (document.querySelector('.bottom'));

/** the tab the popup stands for; the tests open the popup in a tab of its own and name it */
async function activeTab() {
  const named = new URLSearchParams(location.search).get('tab');
  if (named) return api.tabs.get(Number(named));
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * @param {string} site
 * @param {HTMLElement} state
 */
function header(site, state) {
  return element('div', undefined, { className: 'site' }, [avatar(site), describe(site), state]);
}

/**
 * @param {string} title
 * @param {number} count
 * @param {HTMLElement} body
 */
function section(title, count, body) {
  return element('section', undefined, {}, [
    element('h2', undefined, {}, [title, element('span', `· ${count}`, { className: 'count' })]),
    body,
  ]);
}

/**
 * @param {string} site
 * @param {Site} entry
 */
function enabled(site, entry) {
  /** @type {HTMLElement[]} */
  const nodes = [header(site, element('span', 'Enabled', { className: 'pill ok' }))];

  if (entry.pending.length > 0) {
    const list = element('ul', undefined, { className: 'card waiting' });
    for (const { server, repository } of entry.pending) {
      const host = new URL(server).host;
      list.append(
        row(server, repository, [
          button(
            'Allow',
            async () => {
              if (await grant(server)) await call('approveServer', { site, server });
            },
            { kind: 'primary', name: `Allow ${host}`, done: render },
          ),
          button('Dismiss', () => call('dismissServer', { site, server }), {
            name: `Dismiss ${host}`,
            done: render,
          }),
        ]),
      );
    }
    const asking = section('Asking to reach', entry.pending.length, list);
    asking.append(
      element('p', 'Allowing a server lets this website reach every repository on it.', {
        className: 'lead',
      }),
    );
    nodes.push(asking);
  }

  const servers =
    entry.servers.length === 0
      ? element('p', 'No servers yet. When this website asks for one, you can allow it here.', {
          className: 'card empty',
        })
      : element(
          'ul',
          undefined,
          { className: 'card scroll' },
          entry.servers.map((server) =>
            row(server, undefined, [
              button(icon('close'), () => call('revokeServer', { site, server }), {
                kind: 'icon',
                name: `Remove ${new URL(server).host}`,
                done: render,
              }),
            ]),
          ),
        );
  nodes.push(section('Allowed servers', entry.servers.length, servers));
  return nodes;
}

/** @param {string} site @param {number | undefined} tabId */
function disabled(site, tabId) {
  return [
    header(site, element('span', 'Off', { className: 'pill' })),
    element(
      'p',
      'Enable Git CORS Bridge to let this website ask for git servers. You approve each server separately.',
      { className: 'lead' },
    ),
    button(
      'Enable on this website',
      async () => {
        if (await grant(site)) await call('enableSite', { site, tabId });
      },
      { kind: 'primary', done: render },
    ),
  ];
}

/** @param {string} site */
function unsupported(site) {
  return [
    header(site, element('span', 'Plain HTTP', { className: 'pill' })),
    element(
      'p',
      'Git CORS Bridge works only on HTTPS websites, and on localhost for development: on plain HTTP, anyone on the way could change the page that holds your git token.',
      { className: 'lead' },
    ),
  ];
}

async function render() {
  const tab = await activeTab();
  /** @type {string | undefined} */
  let site;
  try {
    site = tab?.url ? new URL(tab.url).origin : undefined;
  } catch {
    site = undefined;
  }
  /** @type {Sites} */
  const sites = await call('approvals');
  const entry = site ? sites[site] : undefined;

  /** @type {HTMLElement[]} */
  let nodes;
  if (!site || !/^https?:/.test(site)) {
    nodes = [element('p', 'Open a website to use Git CORS Bridge on it.', { className: 'lead' })];
  } else if (entry) nodes = enabled(site, entry);
  else if (!allowedOrigin(site)) nodes = unsupported(site);
  else nodes = disabled(site, tab?.id);
  for (const node of nodes) if (node.matches('button')) node.classList.add('wide');
  content.replaceChildren(...nodes);

  const off = footer.querySelector('.danger');
  if (site && entry) {
    const enabledSite = site;
    const disable = button('Disable', () => call('disableSite', { site: enabledSite }), {
      kind: 'danger',
      name: 'Disable on this website',
      done: render,
    });
    disable.title = `Stop Git CORS Bridge on ${new URL(enabledSite).host}`;
    if (off) off.replaceWith(disable);
    else footer.append(disable);
  } else off?.remove();
}

document.getElementById('manage')?.addEventListener('click', () => {
  void api.runtime.openOptionsPage().then(() => window.close());
});

// a website asked for a server, or the manage page changed something, while the popup is open
api.storage.onChanged.addListener((changes) => {
  if ('sites' in changes) void render().catch((error) => say(messageOf(error)));
});

render().catch((error) => say(messageOf(error)));
