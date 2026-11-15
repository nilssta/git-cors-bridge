// SPDX-License-Identifier: MIT

// can be injected twice into the same page, so only `var`s and functions

/**
 * @typedef {{ server: string, repository?: string }} Pending a server a website asked for, by
 *   origin, with the repository path of its first request, for the user to judge it by
 * @typedef {{ servers: string[], pending: Pending[] }} Site
 * @typedef {Record<string, Site>} Sites the enabled websites, by origin
 */

/** the webextension API: `browser` in firefox, `chrome` in chrome and edge */
var api = /** @type {typeof chrome} */ (
  /** @type {any} */ (globalThis).browser ?? globalThis.chrome
);

var CHANNEL = 'git-cors-bridge';

/** the protocol between `client.js` and the bridge; raised by a change that breaks a copy of it */
var VERSION = 1;

/**
 * body chunk size between the bridge and the background: under chrome's 64 MiB per message, after
 * base64
 */
var CHUNK = 1 << 20;

/**
 * a match pattern for an origin's host
 * patterns cannot name a port, so every port of the host shares it: the background still compares
 * whole origins
 * @param {string} origin
 */
function pattern(origin) {
  const { protocol, hostname } = new URL(origin);
  return `${protocol}//${hostname}/*`;
}

/**
 * plain HTTP only on this machine, where there is nobody to read it on the way
 * @param {string} origin
 */
function allowedOrigin(origin) {
  const { protocol, hostname } = new URL(origin);
  return protocol === 'https:' || hostname === 'localhost' || hostname === '127.0.0.1';
}

/**
 * runtime messages carry JSON in chrome, so bytes travel as base64
 * @param {Uint8Array} bytes
 */
function toBase64(bytes) {
  const native = /** @type {any} */ (bytes).toBase64;
  if (typeof native === 'function') return /** @type {string} */ (native.call(bytes));
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/** @param {string} text */
function fromBase64(text) {
  const native = /** @type {any} */ (Uint8Array).fromBase64;
  if (typeof native === 'function')
    return /** @type {Uint8Array} */ (native.call(Uint8Array, text));
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
