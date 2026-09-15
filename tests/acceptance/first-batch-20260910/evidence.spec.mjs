import { test, expect } from '@playwright/test';
import { getRuntime } from './helpers/runtime.mjs';

test('FB-T38 R29/R30 evidence: run provenance identifies the isolated build, platform, port, and data root', async ({}, testInfo) => {
  const { baseURL, worktree, manifest } = getRuntime({ requireManifest: true });
  expect(manifest.buildLabel).toMatch(/\S/);
  expect(['chromium', 'tauri-macos', 'windows']).toContain(manifest.platform);
  expect(manifest.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:/);
  const evidence = {
    buildLabel: manifest.buildLabel,
    platform: manifest.platform,
    observedAt: manifest.observedAt,
    baseURL,
    worktree,
    dataRoot: manifest.dataRoot,
  };
  await testInfo.attach('first-batch-environment.json', {
    body: Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
    contentType: 'application/json',
  });
});
