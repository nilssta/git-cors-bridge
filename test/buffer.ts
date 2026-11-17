// SPDX-License-Identifier: MIT

import { Buffer } from 'buffer';

// isomorphic-git uses node's Buffer as a global
// imported before it, so the global is there first
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
