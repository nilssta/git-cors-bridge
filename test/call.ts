// SPDX-License-Identifier: MIT

import type { Harness } from './harness';

/** a page as playwright and puppeteer both drive it */
interface Evaluating {
  evaluate(run: (arg: [string, unknown[]]) => unknown, arg: [string, unknown[]]): Promise<unknown>;
}

/** runs one of the harness's functions in the page */
export function call<K extends keyof Harness>(
  page: Evaluating,
  name: K,
  ...args: Parameters<Harness[K]>
): Promise<Awaited<ReturnType<Harness[K]>>> {
  return page.evaluate(
    ([name, args]: [string, unknown[]]) => {
      const run = (
        globalThis as unknown as { harness: Record<string, (...a: unknown[]) => unknown> }
      ).harness[name];
      return run?.(...args);
    },
    [name, args] as [string, unknown[]],
  ) as Promise<Awaited<ReturnType<Harness[K]>>>;
}
