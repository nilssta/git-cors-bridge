// SPDX-License-Identifier: MIT

// the content script, after shared.js
// the background decides what may go out

(() => {
  const global = /** @type {{ __gitCorsBridge?: { recheck(): void } }} */ (
    /** @type {unknown} */ (globalThis)
  );
  // injected again when the user enables the open tab
  if (global.__gitCorsBridge) {
    global.__gitCorsBridge.recheck();
    return;
  }

  /** @type {Map<string, chrome.runtime.Port>} */
  const ports = new Map();

  // match patterns cannot name a port, so this also runs on the host's other ports, which the user
  // did not enable
  // silent there, as if not installed
  const status = () =>
    api.runtime.sendMessage({ action: 'status' }).then(
      (answer) => answer?.value?.enabled === true,
      () => false,
    );
  let enabled = status();

  /**
   * @param {object} message
   * @param {Transferable[]} [transfer]
   */
  const toPage = (message, transfer = []) =>
    window.postMessage(
      { channel: CHANNEL, from: 'extension', ...message },
      location.origin,
      transfer,
    );

  /**
   * firefox wraps the page's typed arrays: `instanceof` fails on them and their buffer cannot be
   * sliced, so the bytes are copied
   * @param {unknown} body
   */
  function bytesOf(body) {
    if (!ArrayBuffer.isView(body)) return new Uint8Array(0);
    const bytes = new Uint8Array(body.byteLength);
    bytes.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    return bytes;
  }

  /** @param {{ id: string, url: string, method?: string, headers?: Record<string, string>, body?: unknown }} message */
  function request({ id, url, method, headers, body }) {
    toPage({ id, kind: 'accepted' });
    const port = api.runtime.connect({ name: CHANNEL });
    ports.set(id, port);
    const finish = () => ports.delete(id);
    port.onMessage.addListener((message) => {
      if (message.kind === 'chunk') {
        const data = fromBase64(message.data);
        toPage({ id, kind: 'chunk', data }, [data.buffer]);
        return;
      }
      toPage({ id, ...message });
      if (message.kind === 'end' || message.kind === 'error') {
        finish();
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      if (!ports.has(id)) return;
      finish();
      toPage({
        id,
        kind: 'error',
        code: 'disconnected',
        message: 'Git CORS Bridge stopped the request',
      });
    });
    try {
      port.postMessage({ kind: 'head', url, method, headers });
      const bytes = bytesOf(body);
      for (let start = 0; start < bytes.length; start += CHUNK) {
        port.postMessage({ kind: 'chunk', data: toBase64(bytes.subarray(start, start + CHUNK)) });
      }
      port.postMessage({ kind: 'end' });
    } catch (error) {
      // rather than leave the page waiting for an answer that cannot come
      finish();
      port.disconnect();
      toPage({
        id,
        kind: 'error',
        code: 'disconnected',
        message: `Git CORS Bridge could not pass the request on: ${error}`,
      });
    }
  }

  /** @param {any} message */
  function handle(message) {
    if (message.kind === 'ping') toPage({ kind: 'ready', version: VERSION });
    else if (message.kind === 'request') request(message);
    else if (message.kind === 'cancel') {
      ports.get(message.id)?.disconnect();
      ports.delete(message.id);
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (event.source !== window || message?.channel !== CHANNEL || message.from !== 'page') return;
    // the answer is in before the first message in practice; waiting keeps the messages in order
    void enabled.then((yes) => yes && handle(message));
  });

  api.runtime.onMessage.addListener((message) => {
    // the user disabled the website: the bridge goes silent at once, not only from the next load
    if (message?.kind === 'disabled') {
      void enabled.then((yes) => yes && toPage({ kind: 'disabled' }));
      enabled = Promise.resolve(false);
    }
    if (message?.kind === 'approved' || message?.kind === 'dismissed') {
      void enabled.then(
        (yes) => yes && toPage({ kind: message.kind, server: String(message.server) }),
      );
    }
    return false;
  });

  // for a page that was open when the website was enabled; one that loads later pings
  const announce = () =>
    void enabled.then((yes) => yes && toPage({ kind: 'enabled', version: VERSION }));
  global.__gitCorsBridge = {
    recheck() {
      enabled = status();
      announce();
    },
  };
  announce();
})();
