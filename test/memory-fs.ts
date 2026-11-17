// SPDX-License-Identifier: MIT

// an in-memory file system with the parts of node's fs.promises that isomorphic-git uses

type Entry =
  | { kind: 'file'; data: Uint8Array; mode: number; time: number }
  | { kind: 'dir'; time: number }
  | { kind: 'link'; target: string; time: number };

function failure(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

/** isomorphic-git asks for paths such as `.` and `/repo/.`; one spelling per entry */
function normal(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '' && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export class MemoryFs {
  #entries = new Map<string, Entry>([['/', { kind: 'dir', time: Date.now() }]]);
  #inodes = new Map<string, number>();

  #get(path: string): Entry {
    const entry = this.#entries.get(path);
    if (!entry) throw failure('ENOENT', path);
    return entry;
  }

  #parent(path: string): void {
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    if (this.#entries.get(parent)?.kind !== 'dir') throw failure('ENOENT', parent);
  }

  #stat(path: string, entry: Entry) {
    const ino = this.#inodes.get(path) ?? this.#inodes.size + 1;
    this.#inodes.set(path, ino);
    const mode = entry.kind === 'dir' ? 0o40000 : entry.kind === 'link' ? 0o120000 : entry.mode;
    const size =
      entry.kind === 'file' ? entry.data.length : entry.kind === 'link' ? entry.target.length : 0;
    return {
      type: entry.kind === 'dir' ? 'dir' : entry.kind === 'link' ? 'symlink' : 'file',
      mode,
      size,
      ino,
      mtimeMs: entry.time,
      ctimeMs: entry.time,
      uid: 1,
      gid: 1,
      dev: 1,
      isFile: () => entry.kind === 'file',
      isDirectory: () => entry.kind === 'dir',
      isSymbolicLink: () => entry.kind === 'link',
    };
  }

  promises = {
    readFile: async (path: string, options?: string | { encoding?: string }) => {
      path = normal(path);
      const entry = this.#get(path);
      if (entry.kind !== 'file') throw failure('EISDIR', path);
      const encoding = typeof options === 'string' ? options : options?.encoding;
      return encoding === 'utf8' ? new TextDecoder().decode(entry.data) : entry.data;
    },
    writeFile: async (path: string, data: string | Uint8Array, options?: { mode?: number }) => {
      path = normal(path);
      this.#parent(path);
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      this.#entries.set(path, {
        kind: 'file',
        data: new Uint8Array(bytes),
        mode: options?.mode ?? 0o100644,
        time: Date.now(),
      });
    },
    unlink: async (path: string) => {
      path = normal(path);
      if (this.#get(path).kind === 'dir') throw failure('EISDIR', path);
      this.#entries.delete(path);
    },
    readdir: async (path: string) => {
      path = normal(path);
      if (this.#get(path).kind !== 'dir') throw failure('ENOTDIR', path);
      const prefix = path === '/' ? '/' : `${path}/`;
      return [...this.#entries.keys()]
        .filter(
          (key) =>
            key !== path && key.startsWith(prefix) && !key.slice(prefix.length).includes('/'),
        )
        .map((key) => key.slice(prefix.length));
    },
    mkdir: async (path: string) => {
      path = normal(path);
      if (this.#entries.has(path)) throw failure('EEXIST', path);
      this.#parent(path);
      this.#entries.set(path, { kind: 'dir', time: Date.now() });
    },
    rmdir: async (path: string) => {
      path = normal(path);
      if ((await this.promises.readdir(path)).length > 0) throw failure('ENOTEMPTY', path);
      this.#entries.delete(path);
    },
    stat: async (path: string) => {
      path = normal(path);
      const entry = this.#get(path);
      return this.#stat(path, entry.kind === 'link' ? this.#get(normal(entry.target)) : entry);
    },
    lstat: async (path: string) => {
      path = normal(path);
      return this.#stat(path, this.#get(path));
    },
    readlink: async (path: string) => {
      path = normal(path);
      const entry = this.#get(path);
      if (entry.kind !== 'link') throw failure('EINVAL', path);
      return entry.target;
    },
    symlink: async (target: string, path: string) => {
      path = normal(path);
      this.#parent(path);
      this.#entries.set(path, { kind: 'link', target, time: Date.now() });
    },
    chmod: async (path: string, mode: number) => {
      path = normal(path);
      const entry = this.#get(path);
      if (entry.kind === 'file') entry.mode = mode;
    },
  };
}
