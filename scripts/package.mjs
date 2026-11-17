// SPDX-License-Identifier: MIT

// writes dist/chrome/ and dist/firefox/, each with its browser's manifest, and a zip of each
// chrome warns about firefox's keys and firefox about chrome's, so each gets only its own
// with a version argument, as the release workflow passes from its tag, it must match the manifest

import { execFileSync } from 'node:child_process';
import { cpSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
const expected = process.argv[2];
if (expected !== undefined && expected !== manifest.version) {
  console.error(`The tag says ${expected}, extension/manifest.json says ${manifest.version}.`);
  process.exit(1);
}

// zip stores local times from 1980 on; it runs in UTC below, so every machine stores the same
const STAMP = new Date('2000-01-01T12:00:00Z');

const targets = {
  chrome: ({ browser_specific_settings, background: { scripts, ...background }, ...rest }) => ({
    ...rest,
    background,
  }),
  firefox: ({
    minimum_chrome_version,
    background: { service_worker, ...background },
    ...rest
  }) => ({
    ...rest,
    background,
  }),
};

rmSync('dist', { recursive: true, force: true });
for (const [browser, adapt] of Object.entries(targets)) {
  const dir = join('dist', browser);
  cpSync('extension', dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(adapt(manifest), null, 2)}\n`);
  // fixed times, sorted names, no directory entries (-D) and no extra attributes (-X): the same
  // sources give the same archive
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();
  for (const file of ['.', ...files]) utimesSync(join(dir, file), STAMP, STAMP);
  execFileSync(
    'zip',
    ['-X', '-q', '-D', `../git-cors-bridge-${manifest.version}-${browser}.zip`, ...files],
    { cwd: dir, env: { ...process.env, TZ: 'UTC' } },
  );
  console.log(`dist/git-cors-bridge-${manifest.version}-${browser}.zip`);
}
