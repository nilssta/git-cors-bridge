// SPDX-License-Identifier: MIT

import { defineConfig } from '@playwright/test';

// each spec launches its own browser with the extension loaded: chromium through playwright, firefox
// through puppeteer
export default defineConfig({
  testDir: 'test',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['html', { open: 'never' }]] : 'list',
});
