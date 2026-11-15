// SPDX-License-Identifier: MIT

export type BridgeErrorCode =
  | 'not-enabled'
  | 'not-approved'
  | 'not-git'
  | 'insecure'
  | 'redirected'
  | 'busy'
  | 'network'
  | 'disconnected'
  | 'unavailable';

export class BridgeError extends Error {
  constructor(message: string, code: BridgeErrorCode, server?: string);
  readonly code: BridgeErrorCode;
  /** the server's origin, for 'not-approved' */
  readonly server: string | undefined;
}

/**
 * whether the extension is installed, enabled for this website, and speaks this copy's protocol
 * a page cannot tell "not installed" from "not enabled here"
 */
export function available(timeout?: number): Promise<boolean>;

/** called when the user enables or disables this website; returns a function that stops it */
export function onAvailabilityChange(listener: (available: boolean) => void): () => void;

/**
 * resolves once the user allows `server` in the popup
 * rejects with 'not-approved' when the user dismisses it, 'not-enabled' when the user disables the
 * website, and 'disconnected' on `signal`
 */
export function waitForApproval(server: string, options?: { signal?: AbortSignal }): Promise<void>;

export interface BridgeRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
}

export interface BridgeResponse {
  url: string;
  method: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: AsyncIterableIterator<Uint8Array>;
}

/** isomorphic-git's HttpClient */
export const http: { request(request: BridgeRequest): Promise<BridgeResponse> };
