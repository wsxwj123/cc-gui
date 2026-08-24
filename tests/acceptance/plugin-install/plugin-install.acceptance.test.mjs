import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCliStageRecorded,
  assertSuccess,
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
