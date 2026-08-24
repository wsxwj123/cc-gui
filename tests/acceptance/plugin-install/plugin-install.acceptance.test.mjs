import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANSI_SECRET_CANARIES,
  assertCliStageRecorded,
  assertSuccess,
  FAKE_SECRET_CANARIES,
  ROUTE_SECRET_CANARIES,
  runAcceptanceCase,
  TestInfraError,
  unusedLoopbackProxyUrl,
} from './public-host.mjs';

const OFFLINE_TIMEOUT = 90_000;
const SLOW_TIMEOUT = 130_000;
const NETWORK_TIMEOUT = 15 * 60_000;
const LONG_TIMEOUT = 150_000;

async function captureDefaultPayloadContract(host) {
  const observation = await host.captureGuiDefaultPayloads();
  assert.equal(observation.defaultCardCount, 12, `expected 12 GUI default cards, got ${observation.defaultCardCount}`);
  assert.ok(observation.totalInstallCardCount > 12, 'GUI did not expose the separately labelled third-party cards');
  const { payloads } = observation;
  assert.equal(payloads.length, 12, `expected 12 GUI payloads, got ${payloads.length}`);
  for (const payload of payloads) {
    assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
    assert.deepEqual(Object.keys(payload), ['name'], `default GUI payload changed: ${JSON.stringify(payload)}`);
    assert.equal(typeof payload.name, 'string');
    assert.ok(payload.name.trim().length > 0);
  }
  const ids = payloads.map(({ name }) => name);
  assert.equal(new Set(ids).size, 12, `default IDs are not unique: ${JSON.stringify(ids)}`);
  return payloads.map((payload) => ({
    id: payload.name,
    marketplace: 'claude-plugins-official',
    installPayload: payload,
  }));
}

async function assertDefaultAvailableContract(host) {
  const defaults = await captureDefaultPayloadContract(host);
  await host.prepareOfficialMarketplace();
  const cliAvailable = await host.cliAvailable();
  for (const expected of defaults) {
    const matches = (await host.availableByQuery(expected.id)).filter((entry) => entry.id === expected.id);
    assert.equal(matches.length, 1, `GUI name must uniquely match backend available items: ${expected.id}`);
    const plugin = matches[0];
    assert.equal(plugin.marketplace, 'claude-plugins-official');
    assert.ok(
      cliAvailable.some((entry) => entry.id === expected.id && entry.marketplace === 'claude-plugins-official'),
      `GUI name is absent from real CLI official available JSON: ${expected.id}`,
    );
  }
  return defaults;
}

function assertNoUnexpectedInstalls(before, after) {
  const added = after.filter((identity) => !before.includes(identity));
  assert.deepEqual(added, [], `unexpected plugin identities were installed: ${JSON.stringify(added)}`);
}

function collectPublicStrings(value, path = '$', output = []) {
  if (typeof value === 'string') output.push({ path, value });
  else if (Array.isArray(value)) value.forEach((entry, index) => collectPublicStrings(entry, `${path}[${index}]`, output));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) collectPublicStrings(entry, `${path}.${key}`, output);
  }
  return output;
}

function assertSanitizedFailure(host, result, expectedStage) {
  assert.equal(result.response.ok, false, `${expectedStage} secret failure unexpectedly succeeded`);
  const error = host.errorFrom(result.body);
  assert.equal(error.stage, expectedStage);
  assert.equal(error.code, 'CLI_EXIT_NONZERO');
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.trim().length > 0, `${expectedStage} lost all useful context`);

  const publicStrings = collectPublicStrings(result.body);
  assert.ok(publicStrings.length > 0, `${expectedStage} response has no public text`);
  const publicText = publicStrings.map(({ value }) => value).join('\n');
  FAKE_SECRET_CANARIES.forEach((secret, index) => {
    assert.equal(publicText.includes(secret), false, `${expectedStage} leaked secret canary #${index + 1}`);
  });
  assert.ok(publicText.includes('R33_SAFE_CONTEXT'), `${expectedStage} removed useful sanitized context`);
  assert.ok(publicText.includes(expectedStage), `${expectedStage} removed the operation label`);
  for (const { path, value } of publicStrings) {
    assert.ok(value.length <= 4_096, `${expectedStage} public field ${path} exceeds 4096 characters`);
  }
  assert.ok(publicText.length <= 16_384, `${expectedStage} public error exceeds 16384 characters`);
}

function assertSafeRouteFailure(host, observation, canaries = ROUTE_SECRET_CANARIES) {
  const { label, result, structured } = observation;
  assert.notEqual(result.response.status, 404, `${label} public route is unavailable`);
  assert.equal(result.response.ok, false, `${label} returned success after its CLI command failed`);
  assert.ok(result.body && typeof result.body === 'object' && !Array.isArray(result.body), `${label} did not return JSON`);
  const error = result.body.error;
  if (structured) {
    const structuredError = host.errorFrom(result.body);
    assert.equal(structuredError.stage, 'plugin-install', `${label} lost plugin-install stage`);
    assert.equal(structuredError.code, 'CLI_EXIT_NONZERO', `${label} lost CLI exit code`);
  } else {
    assert.ok(
      typeof error === 'string' || (error && typeof error === 'object' && !Array.isArray(error)),
      `${label} has no compatible public error`,
    );
  }

  const publicStrings = collectPublicStrings(result.body);
  const publicText = publicStrings.map(({ value }) => value).join('\n');
  canaries.forEach((secret, index) => {
    assert.equal(publicText.includes(secret), false, `${label} leaked route secret canary #${index + 1}`);
  });
  assert.ok(publicText.includes('R33_SAFE_CONTEXT'), `${label} removed all understandable failure context`);
  for (const { path, value } of publicStrings) {
    assert.ok(value.length <= 4_096, `${label} public field ${path} exceeds 4096 characters`);
  }
  assert.ok(result.text.length <= 16_384, `${label} complete public response exceeds 16384 characters`);
}

async function observePluginRouteFailures(host) {
  const payload = await host.requireValidatedLocalPayload();
  const add = await host.cli(['plugin', 'marketplace', 'add', payload.repo]);
  assert.equal(add.code, 0, 'route security fixture marketplace was not prepared');
  const identity = `${payload.name}@${payload.marketplace}`;
  const routeCases = [
    {
      label: 'update',
      expectedCommand: 'update',
      invoke: () => host.submitPluginOperation('R33_UPDATE_URL', 'POST', identity),
    },
    {
      label: 'uninstall',
      expectedCommand: 'uninstall',
      invoke: () => host.submitPluginOperation('R33_UNINSTALL_URL', 'DELETE', identity),
    },
    {
      label: 'enable',
      expectedCommand: 'enable',
      invoke: () => host.submitPluginOperation('R33_ENABLE_URL', 'PUT', identity),
    },
    {
      label: 'disable',
      expectedCommand: 'disable',
      invoke: () => host.submitPluginOperation('R33_DISABLE_URL', 'PUT', identity),
    },
    {
      label: 'install',
      expectedCommand: 'install',
      structured: true,
      invoke: () => host.submitInstall({ name: payload.name, marketplace: payload.marketplace }),
    },
    {
      label: 'available',
      expectedCommand: null,
      invoke: () => host.requestAvailable(),
    },
  ];

  const observations = [];
  for (const routeCase of routeCases) {
    const before = (await host.cliRecords()).length;
    const result = await routeCase.invoke();
    const records = (await host.cliRecords()).slice(before);
    assert.ok(records.some((record) => record.args[0] === 'plugin'), `${routeCase.label} did not invoke the CLI wrapper`);
    if (routeCase.expectedCommand) {
      assert.ok(
        records.some((record) => record.args[1] === routeCase.expectedCommand),
        `${routeCase.label} did not invoke claude plugin ${routeCase.expectedCommand}`,
      );
    }
    observations.push({ ...routeCase, result });
  }
  return [...observations].sort((left, right) => Number(right.structured) - Number(left.structured));
}

test('PLUG-AVAIL-001 [network] GUI emits 12 unique default payloads present in backend and CLI available JSON', { timeout: NETWORK_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, { network: true }, async (host) => {
    await host.assertFreshConfig();
    await assertDefaultAvailableContract(host);
  });
});

test('PLUG-FRESH-001 [network] all 12 real default payloads install in a fresh isolated config', { timeout: NETWORK_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, { network: true }, async (host) => {
    await host.assertFreshConfig();
    const defaults = await captureDefaultPayloadContract(host);
    for (const [index, plugin] of defaults.entries()) {
      const result = await host.submitInstall(plugin.installPayload);
      assert.equal(
        result.response.ok,
        true,
        `default ${index + 1}/12 ${plugin.id}@${plugin.marketplace} failed: ${JSON.stringify(result.body)}`,
      );
      await host.assertInstalled(plugin);
    }
    await host.assertRecordedIsolation();
  });
});

test('PLUG-CACHE-001 [network] a cached plugin installs offline without marketplace add or update', { timeout: NETWORK_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, { network: true }, async (host) => {
    const defaults = await captureDefaultPayloadContract(host);
    const requestedId = process.env.R33_CACHE_PLUGIN_ID;
    const plugin = requestedId ? defaults.find((entry) => entry.id === requestedId) : defaults[0];
    if (!plugin) throw new TestInfraError(`R33_CACHE_PLUGIN_ID not found: ${requestedId}`);

    assertSuccess(await host.submitInstall(plugin.installPayload));
    await host.assertInstalled(plugin);
    const uninstall = await host.cli(['plugin', 'uninstall', `${plugin.id}@${plugin.marketplace}`, '--scope', 'user'], { timeoutMs: 60_000 });
    assert.equal(uninstall.code, 0);

    const proxy = await host.createRejectingProxy();
    await host.restartBackend(Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].map((key) => [key, proxy.url])));
    const recordsBefore = (await host.cliRecords()).length;
    const proxyRequestsBefore = proxy.requests();
    assertSuccess(await host.submitInstall(plugin.installPayload));
    await host.assertInstalled(plugin);
    const newRecords = (await host.cliRecords()).slice(recordsBefore);
    assert.equal(
      newRecords.some((record) => record.args[0] === 'plugin' && record.args[1] === 'marketplace' && ['add', 'update'].includes(record.args[2])),
      false,
      'cached install unexpectedly invoked marketplace add/update',
    );
    assert.equal(proxy.requests(), proxyRequestsBefore, 'cached install attempted network through the rejecting proxy');
  });
});

test('PLUG-SLOW-ADD-001 [offline] marketplace add may take 35 seconds without a 30-second kill', { timeout: SLOW_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, { wrapperMode: 'slow-add' }, async (host) => {
    const payload = await host.requireValidatedLocalPayload('R33_SLOW_ADD_PAYLOAD_JSON');
    const startedAt = Date.now();
    assertSuccess(await host.submitInstall(payload));
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 35_000, `operation did not exercise the slow boundary: ${elapsed}ms`);
    assert.ok(elapsed < 120_000, `operation exceeded CLI budget: ${elapsed}ms`);
    assertCliStageRecorded(await host.cliRecords(), 'marketplace-add');
  });
});

test('PLUG-SLOW-UPDATE-001 [offline] marketplace update may take 35 seconds without a 30-second kill', { timeout: SLOW_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, { wrapperMode: 'slow-update' }, async (host) => {
    const payload = await host.prepareStaleMarketplace();
    const startedAt = Date.now();
    assertSuccess(await host.submitInstall(payload));
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 35_000, `operation did not exercise the slow boundary: ${elapsed}ms`);
    assert.ok(elapsed < 120_000, `operation exceeded CLI budget: ${elapsed}ms`);
    assertCliStageRecorded(await host.cliRecords(), 'marketplace-update');
  });
});

async function assertDeadProxyIsRemoved(t, proxyKey) {
  let deadProxy;
  try {
    deadProxy = await unusedLoopbackProxyUrl();
  } catch (error) {
    if (error instanceof TestInfraError) {
      t.diagnostic(error.message);
      t.skip(error.message);
      return;
    }
    throw error;
  }
  await runAcceptanceCase(t, { backendEnv: { [proxyKey]: deadProxy } }, async (host) => {
    const payload = await host.requireValidatedLocalPayload();
    assertSuccess(await host.submitInstall(payload));
    const records = await host.cliRecords();
    assert.ok(records.length > 0, 'backend did not invoke Claude CLI');
    assert.ok(
      records.every((record) => !Object.values(record.env).includes(deadProxy)),
      `${proxyKey} dead value reached Claude CLI`,
    );
    await host.assertRecordedIsolation();
  });
}

test('PLUG-PROXY-001 [offline] unreachable HTTP_PROXY is not inherited by Claude CLI', { timeout: OFFLINE_TIMEOUT }, async (t) => {
  await assertDeadProxyIsRemoved(t, 'HTTP_PROXY');
});

test('PLUG-PROXY-002 [offline] unreachable HTTPS_PROXY is not inherited by Claude CLI', { timeout: OFFLINE_TIMEOUT }, async (t) => {
  await assertDeadProxyIsRemoved(t, 'HTTPS_PROXY');
});

test('PLUG-PROXY-003 [offline] unreachable http_proxy is not inherited by Claude CLI', { timeout: OFFLINE_TIMEOUT }, async (t) => {
  await assertDeadProxyIsRemoved(t, 'http_proxy');
});

test('PLUG-PROXY-004 [offline] unreachable https_proxy is not inherited by Claude CLI', { timeout: OFFLINE_TIMEOUT }, async (t) => {
  await assertDeadProxyIsRemoved(t, 'https_proxy');
});

test('PLUG-PROXY-LIVE-001 [offline] a reachable proxy is preserved and used', { timeout: OFFLINE_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, {}, async (host) => {
    const proxy = await host.createForwardingProxy();
    const beforeConnections = proxy.connections();
    await host.restartBackend({ HTTP_PROXY: proxy.url });
    const payload = await host.requireValidatedLocalPayload();
    assertSuccess(await host.submitInstall(payload));
    const records = await host.cliRecords();
    assert.ok(records.some((record) => record.env.HTTP_PROXY === proxy.url), 'live HTTP_PROXY was cleared');
    assert.ok(proxy.connections() > beforeConnections, 'live proxy did not observe a reachability connection');
  });
});

test('PLUG-PROXY-IPV6-001 [offline] a reachable IPv6 proxy is probed and preserved for real CLI', { timeout: OFFLINE_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, {}, async (host) => {
    const proxy = await host.createIpv6ForwardingProxy();
    const beforeConnections = proxy.connections();
    await host.restartBackend({ HTTP_PROXY: proxy.url });
    const payload = await host.requireValidatedLocalPayload();
    assertSuccess(await host.submitInstall(payload));
    const records = await host.cliRecords();
    assert.ok(records.some((record) => record.env.HTTP_PROXY === proxy.url), 'live IPv6 HTTP_PROXY was cleared');
    assert.ok(proxy.connections() > beforeConnections, 'live IPv6 proxy did not observe a reachability connection');
  });
});

test('PLUG-ERR-ADD-001 [offline] marketplace add failure has a complete structured error', { timeout: OFFLINE_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, {}, async (host) => {
    const before = await host.installedIdentities();
    const result = await host.submitInstall(host.payloadFromEnv('R33_ADD_FAILURE_PAYLOAD_JSON'));
    assert.equal(result.response.ok, false, 'invalid marketplace unexpectedly succeeded');
    host.assertStructuredError(host.errorFrom(result.body), {
      stage: 'marketplace-add',
      code: 'CLI_EXIT_NONZERO',
      retryable: false,
      timeoutMs: 120_000,
    });
    assertNoUnexpectedInstalls(before, await host.installedIdentities());
  });
});

test('PLUG-ERR-INSTALL-001 [offline] plugin install failure has a complete structured error', { timeout: OFFLINE_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, {}, async (host) => {
    const before = await host.installedIdentities();
    const result = await host.submitInstall(host.payloadFromEnv('R33_INSTALL_FAILURE_PAYLOAD_JSON'));
    assert.equal(result.response.ok, false, 'missing plugin unexpectedly succeeded');
    host.assertStructuredError(host.errorFrom(result.body), {
      stage: 'plugin-install',
      code: 'CLI_EXIT_NONZERO',
      retryable: false,
      timeoutMs: 120_000,
    });
    assertNoUnexpectedInstalls(before, await host.installedIdentities());
  });
});

test('PLUG-SEC-001 [offline] add and install failures redact secrets and bound public errors', { timeout: OFFLINE_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, { wrapperMode: 'secret-add' }, async (host) => {
    const before = await host.installedIdentities();
    const payload = await host.requireValidatedLocalPayload();

    const addFailure = await host.submitInstall(payload);
    assertSanitizedFailure(host, addFailure, 'marketplace-add');
    assertNoUnexpectedInstalls(before, await host.installedIdentities());

    await host.restartBackend({ R33_CLI_WRAPPER_MODE: 'secret-install' });
    const installFailure = await host.submitInstall(payload);
    assertSanitizedFailure(host, installFailure, 'plugin-install');
    assertNoUnexpectedInstalls(before, await host.installedIdentities());
  });
});

test('PLUG-SEC-ROUTES-001 [offline] every public plugin route redacts and bounds CLI failures', { timeout: OFFLINE_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, { wrapperMode: 'route-secrets' }, async (host) => {
    const observations = await observePluginRouteFailures(host);
    observations.forEach((observation) => assertSafeRouteFailure(host, observation));
  });
});

test('PLUG-SEC-ANSI-001 [offline] ANSI-obfuscated and derived secret keys are redacted on every plugin route', { timeout: OFFLINE_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, { wrapperMode: 'ansi-route-secrets' }, async (host) => {
    const observations = await observePluginRouteFailures(host);
    observations.forEach((observation) => assertSafeRouteFailure(host, observation, ANSI_SECRET_CANARIES));
  });
});

test('PLUG-ERR-RETRY-001 [offline] update network reset is retryable but permission denial is not', { timeout: OFFLINE_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, { wrapperMode: 'network-reset-update' }, async (host) => {
    const payload = await host.prepareStaleMarketplace();
    const startedAt = Date.now();
    const networkFailure = await host.submitInstall(payload);
    assert.equal(networkFailure.response.ok, false, 'connection reset update unexpectedly succeeded');
    host.assertStructuredError(host.errorFrom(networkFailure.body), {
      stage: 'marketplace-update',
      code: 'CLI_EXIT_NONZERO',
      retryable: true,
      timeoutMs: 120_000,
    });
    assert.ok(Date.now() - startedAt < 30_000, 'connection reset was misclassified through the timeout path');

    await host.restartBackend({ R33_CLI_WRAPPER_MODE: 'permission-update' });
    const permissionFailure = await host.submitInstall(payload);
    assert.equal(permissionFailure.response.ok, false, 'permission-denied update unexpectedly succeeded');
    host.assertStructuredError(host.errorFrom(permissionFailure.body), {
      stage: 'marketplace-update',
      code: 'CLI_EXIT_NONZERO',
      retryable: false,
      timeoutMs: 120_000,
    });
  });
});

test('PLUG-ERR-TERMINAL-001 [offline] terminal update errors outrank mixed transient hints', { timeout: OFFLINE_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, { wrapperMode: 'terminal-permission-update' }, async (host) => {
    const payload = await host.prepareStaleMarketplace();
    const cases = [
      ['transient-update', true, 'pure transient network'],
      ['terminal-permission-update', false, 'permission/EACCES/EPERM'],
      ['terminal-auth-update', false, '401/403'],
      ['terminal-argument-update', false, 'invalid argument'],
      ['terminal-plugin-not-found-update', false, 'plugin not found'],
      ['terminal-marketplace-not-found-update', false, 'marketplace not found'],
    ];
    const observations = [];
    for (const [mode, retryable, label] of cases) {
      await host.restartBackend({ R33_CLI_WRAPPER_MODE: mode });
      observations.push({ label, retryable, result: await host.submitInstall(payload) });
    }
    for (const { label, retryable, result } of observations) {
      assert.equal(result.response.ok, false, `${label} update unexpectedly succeeded`);
      host.assertStructuredError(host.errorFrom(result.body), {
        stage: 'marketplace-update',
        code: 'CLI_EXIT_NONZERO',
        retryable,
        timeoutMs: 120_000,
      });
    }
  });
});

test('PLUG-ERR-NAMED-TERMINAL-001 [offline] named terminal update errors outrank network wording', { timeout: OFFLINE_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, { wrapperMode: 'named-plugin-not-found-update' }, async (host) => {
    const payload = await host.prepareStaleMarketplace();
    const cases = [
      ['transient-update', true, 'pure transient network'],
      ['named-plugin-not-found-update', false, 'quoted plugin not found in marketplace'],
      ['named-marketplace-not-found-update', false, 'quoted marketplace not found'],
      ['invalid-marketplace-name-update', false, 'invalid marketplace name'],
      ['unknown-option-update', false, 'unknown option'],
    ];
    const observations = [];
    for (const [mode, retryable, label] of cases) {
      await host.restartBackend({ R33_CLI_WRAPPER_MODE: mode });
      observations.push({ label, retryable, result: await host.submitInstall(payload) });
    }
    for (const { label, retryable, result } of observations) {
      assert.equal(result.response.ok, false, `${label} update unexpectedly succeeded`);
      host.assertStructuredError(host.errorFrom(result.body), {
        stage: 'marketplace-update',
        code: 'CLI_EXIT_NONZERO',
        retryable,
        timeoutMs: 120_000,
      });
    }
  });
});

test('PLUG-ERR-TIMEOUT-001 [long] marketplace update timeout is structured and kills its child', { timeout: LONG_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, { long: true, wrapperMode: 'timeout-update' }, async (host) => {
    const payload = await host.prepareStaleMarketplace();
    const startedAt = Date.now();
    const result = await host.submitInstall(payload);
    const elapsed = Date.now() - startedAt;
    assert.equal(result.response.ok, false, '125-second marketplace update unexpectedly succeeded');
    host.assertStructuredError(host.errorFrom(result.body), {
      stage: 'marketplace-update',
      code: 'CLI_TIMEOUT',
      retryable: true,
      timeoutMs: 120_000,
    });
    assert.ok(elapsed >= 115_000 && elapsed < 130_000, `timeout occurred outside the 120-second boundary: ${elapsed}ms`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const records = await host.cliRecords();
    assertCliStageRecorded(records, 'marketplace-update');
    const updateRecords = records.filter((record) => record.args[0] === 'plugin' && record.args[1] === 'marketplace' && record.args[2] === 'update');
    assert.ok(updateRecords.length > 0);
    for (const record of updateRecords) {
      assert.throws(
        () => process.kill(record.pid, 0),
        (error) => error?.code === 'ESRCH',
        `timed-out CLI wrapper is still alive: pid ${record.pid}`,
      );
    }
  });
});

test('PLUG-THIRD-001 [offline] third-party install preserves name, marketplace, and repo payload', { timeout: OFFLINE_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, {}, async (host) => {
    const payload = await host.requireValidatedLocalPayload();
    assert.deepEqual(Object.keys(payload).sort(), ['marketplace', 'name', 'repo']);
    const plugin = { id: payload.name, marketplace: payload.marketplace };
    assertSuccess(await host.submitInstall(payload));
    await host.assertInstalled(plugin);
    const records = await host.cliRecords();
    const expectedIdentity = `${plugin.id}@${plugin.marketplace}`;
    assert.ok(
      records.some((record) => record.args[0] === 'plugin'
        && record.args[1] === 'marketplace'
        && record.args[2] === 'add'
        && record.args.includes(payload.repo)),
      `CLI did not receive the third-party repo ${payload.repo}`,
    );
    assert.ok(
      records.some((record) => record.args[0] === 'plugin' && record.args[1] === 'install' && record.args.includes(expectedIdentity)),
      `CLI did not receive the third-party identity ${expectedIdentity}`,
    );
  });
});

test('PLUG-THIRD-STALE-001 [offline] no-repo third-party stale install updates only its marketplace', { timeout: OFFLINE_TIMEOUT }, async (t) => {
  await runAcceptanceCase(t, {}, async (host) => {
    const payload = await host.prepareStaleMarketplace();
    assert.deepEqual(Object.keys(payload).sort(), ['marketplace', 'name']);
    assertSuccess(await host.submitInstall(payload));
    await host.assertInstalled({ id: payload.name, marketplace: payload.marketplace });

    const records = await host.cliRecords();
    const marketplaceAdds = records.filter((record) => record.args[0] === 'plugin'
      && record.args[1] === 'marketplace'
      && record.args[2] === 'add');
    assert.equal(marketplaceAdds.length, 0, 'no-repo third-party fallback invoked marketplace add');

    const marketplaceUpdates = records.filter((record) => record.args[0] === 'plugin'
      && record.args[1] === 'marketplace'
      && record.args[2] === 'update');
    assert.equal(marketplaceUpdates.length, 1, 'stale third-party install must update exactly one marketplace');
    assert.equal(marketplaceUpdates[0].args[3], payload.marketplace, 'stale fallback updated the wrong marketplace');
    assert.ok(
      records.every((record) => !record.args.includes('claude-plugins-official')),
      'third-party stale fallback invoked the official marketplace',
    );

    const expectedIdentity = `${payload.name}@${payload.marketplace}`;
    const installAttempts = records.filter((record) => record.args[0] === 'plugin'
      && record.args[1] === 'install'
      && record.args.includes(expectedIdentity));
    assert.equal(installAttempts.length, 2, 'stale third-party install was not retried exactly once');
  });
});
