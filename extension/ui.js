// SPDX-License-Identifier: MIT

// shared by the popup and the manage page, after shared.js

/**
 * @param {string} action
 * @param {object} [details]
 */
async function call(action, details = {}) {
  const { value, error } = await api.runtime.sendMessage({ action, ...details });
  if (error) throw new Error(error);
  return value;
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string | undefined} [text]
 * @param {Partial<HTMLElementTagNameMap[K]>} [attributes]
 * @param {(Node | string)[]} [children]
 */
function element(tag, text, attributes = {}, children = []) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  Object.assign(node, attributes);
  node.append(...children);
  return node;
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** empty text hides the status line */
function say(/** @type {string} */ text = '') {
  const line = /** @type {HTMLElement} */ (document.getElementById('status'));
  line.textContent = text;
  line.hidden = !text;
}

/**
 * asks the browser for a host's permission
 * must be the first thing a click does: the browser grants only during the click
 * @param {string} origin
 */
async function grant(origin) {
  if (await api.permissions.request({ origins: [pattern(origin)] })) return true;
  say(`The browser did not grant access to ${new URL(origin).host}.`);
  return false;
}

const ICONS = {
  close: 'M4 4l8 8M12 4l-8 8',
};

/** @param {keyof typeof ICONS} name */
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

/**
 * disabled while `run` runs; a failure goes to the status line
 * @param {string | Node} label
 * @param {() => Promise<unknown>} run
 * @param {{ kind?: 'primary' | 'quiet' | 'danger' | 'icon', name?: string, done?: () => unknown }} [options]
 *   `name` is the accessible name
 */
function button(label, run, { kind = 'quiet', name, done } = {}) {
  const node = element('button', undefined, { type: 'button', className: `button ${kind}` }, [
    label,
  ]);
  if (name) node.setAttribute('aria-label', name);
  if (name && kind === 'icon') node.title = name;
  node.addEventListener('click', () => {
    say();
    node.disabled = true;
    run().then(
      () => done?.(),
      (error) => {
        node.disabled = false;
        say(messageOf(error));
      },
    );
  });
  return node;
}

/**
 * coloured by the host, so a server looks the same everywhere
 * @param {string} origin
 */
function avatar(origin) {
  const { hostname } = new URL(origin);
  let hash = 0;
  for (const character of hostname) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const node = element(
    'span',
    hostname
      .replace(/^www\./, '')
      .charAt(0)
      .toUpperCase(),
    {
      className: 'avatar',
    },
  );
  node.style.setProperty('--hue', String(hash % 360));
  node.setAttribute('aria-hidden', 'true');
  return node;
}

/**
 * @param {string} origin
 * @param {string} [detail]
 */
function describe(origin, detail) {
  const url = new URL(origin);
  const name = element('span', undefined, { className: 'name' }, [
    element('span', url.host, { className: 'host' }),
  ]);
  if (url.protocol !== 'https:') name.append(element('span', 'HTTP', { className: 'tag' }));
  const node = element('span', undefined, { className: 'who', title: origin + (detail ?? '') }, [
    name,
  ]);
  if (detail && detail !== '/') node.append(element('span', detail, { className: 'detail' }));
  return node;
}

/**
 * @param {string} origin
 * @param {string | undefined} detail
 * @param {HTMLElement[]} actions
 * @param {'li' | 'div'} [tag]
 */
function row(origin, detail, actions, tag = 'li') {
  return element(tag, undefined, { className: 'row' }, [
    avatar(origin),
    describe(origin, detail),
    element('span', undefined, { className: 'actions' }, actions),
  ]);
}

/** @param {number} count @param {string} one @param {string} [many] */
function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}
