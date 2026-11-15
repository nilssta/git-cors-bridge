// SPDX-License-Identifier: MIT

const CHANNEL = 'git-cors-bridge';
// the bridge answers a ping with its own in `ready`
const VERSION = 1;
// the bridge answers a ping and acknowledges a request at once
const TIMEOUT = 1000;

export class BridgeError extends Error {
  /**
   * @param {string} message
   * @param {string} code 'not-enabled', 'not-approved', 'not-git', 'insecure', 'redirected',
   *   'network', 'disconnected' or 'unavailable'
   * @param {string} [server] the server's origin, for 'not-approved'
   */
  constructor(message, code, server) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.server = server;
  }
}

/** @param {object} message */
function toExtension(message) {
  window.postMessage({ channel: CHANNEL, from: 'page', ...message }, location.origin);
}

/** @param {(message: any) => void} handle */
function listen(handle) {
  /** @param {MessageEvent} event */
  const listener = (event) => {
    const message = event.data;
    if (event.source !== window || message?.channel !== CHANNEL || message.from !== 'extension') {
      return;
    }
    handle(message);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/**
 * @param {number} [timeout]
 * @returns {Promise<boolean>}
 */
export function available(timeout = TIMEOUT) {
  return new Promise((resolve) => {
    const stop = listen((message) => {
      if (message.kind !== 'ready') return;
      if (message.version !== VERSION) {
        console.warn(
          `Git CORS Bridge speaks protocol ${message.version}, this client.js ${VERSION}: update client.js`,
        );
      }
      stop();
      clearTimeout(timer);
      resolve(message.version === VERSION);
    });
    const timer = setTimeout(() => {
      stop();
      resolve(false);
    }, timeout);
    toExtension({ kind: 'ping' });
  });
}

/**
 * @param {(available: boolean) => void} listener
 * @returns {() => void}
 */
export function onAvailabilityChange(listener) {
  return listen((message) => {
    if (message.kind === 'enabled') listener(message.version === VERSION);
    else if (message.kind === 'disabled') listener(false);
  });
}

/**
 * @param {string} server the origin from the refusal's `server`
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<void>}
 */
export function waitForApproval(server, { signal } = {}) {
  return new Promise((resolve, reject) => {
    /** @param {BridgeError} [error] */
    const finish = (error) => {
      stop();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () =>
      finish(new BridgeError('Stopped waiting for approval', 'disconnected', server));
    const stop = listen((message) => {
      if (message.kind === 'disabled') {
        finish(new BridgeError('Git CORS Bridge was disabled on this website', 'not-enabled'));
      }
      if (message.server !== server) return;
      if (message.kind === 'approved') finish();
      else if (message.kind === 'dismissed') {
        finish(new BridgeError(`${server} was not approved`, 'not-approved', server));
      }
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort);
  });
}

/** @param {AsyncIterable<Uint8Array> | undefined} body */
async function collect(body) {
  if (!body) return undefined;
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** isomorphic-git's HttpClient */
export const http = {
  /**
   * @param {{ url: string, method?: string, headers?: Record<string, string>,
   *   body?: AsyncIterable<Uint8Array>, signal?: AbortSignal }} request
   */
  async request({ url, method = 'GET', headers = {}, body, signal }) {
    const id = crypto.randomUUID();
    const payload = await collect(body);
    /** @type {Uint8Array[]} */
    const chunks = [];
    /** @type {(() => void) | undefined} */
    let wake;
    let finished = false;
    /** @type {BridgeError | undefined} */
    let failure;
    return new Promise((resolve, reject) => {
      /**
       * stops listening; `error` also fails the request and its body
       * @param {BridgeError} [error]
       */
      const close = (error) => {
        clearTimeout(unanswered);
        stop();
        signal?.removeEventListener('abort', abort);
        failure = error;
        finished = true;
        wake?.();
        if (error) reject(error);
      };
      const abort = () => {
        toExtension({ kind: 'cancel', id });
        close(new BridgeError('The request was stopped', 'disconnected'));
      };
      const stop = listen((message) => {
        if (message.id !== id) return;
        if (message.kind === 'accepted') {
          clearTimeout(unanswered);
        } else if (message.kind === 'head') {
          resolve({
            url: message.url,
            method,
            statusCode: message.status,
            statusMessage: message.statusText,
            headers: message.headers,
            body: stream(),
          });
        } else if (message.kind === 'chunk') {
          chunks.push(message.data);
          wake?.();
        } else if (message.kind === 'end') {
          close();
        } else if (message.kind === 'error') {
          close(new BridgeError(message.message, message.code, message.server));
        }
      });
      /** @returns {AsyncGenerator<Uint8Array, void>} */
      async function* stream() {
        try {
          for (;;) {
            const chunk = chunks.shift();
            if (chunk) {
              yield chunk;
              continue;
            }
            if (failure) throw failure;
            if (finished) return;
            await new Promise((resolve) => (wake = () => resolve(undefined)));
          }
        } finally {
          // the reader stopped early: the rest of the download is not wanted
          if (!finished) {
            toExtension({ kind: 'cancel', id });
            close();
          }
        }
      }
      const unanswered = setTimeout(
        () =>
          close(
            new BridgeError(
              'Git CORS Bridge is not installed, or not enabled on this website',
              'unavailable',
            ),
          ),
        TIMEOUT,
      );
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort);
      toExtension({ kind: 'request', id, url, method, headers, body: payload });
    });
  },
};
