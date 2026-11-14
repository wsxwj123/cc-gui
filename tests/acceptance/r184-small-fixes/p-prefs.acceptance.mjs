// r184 · P 组:偏好文件开头带 UTF-8 BOM 时,各读取接口仍能读出内容(起一个共用的真后端;每条用例开头自己写偏好文件)。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpRoot, buildHome, writePrefs, projectDir, writeSession, userLine, assistantLine, startBackend, getJson } from './helpers/common.mjs';

const root = tmpRoot('p');
const home = buildHome(root);
let backend = null;

// 搜索用的两组夹具:P1(带 BOM)与 P6(不带 BOM)各用一个独有标记词、各两个工作区,互不干扰
const M1 = 'zqxr184alphamarker';
const M6 = 'zqxr184betamarker';
const WS = { p1Shown: '-r184-ws-a', p1Hidden: '-r184-ws-b', p6Shown: '-r184-ws-c', p6Hidden: '-r184-ws-d' };

function seedWorkspace(dirName, marker) {
  const sid = `sess-${dirName.replace(/[^a-z0-9]/gi, '')}`;
  writeSession(`${projectDir(home, dirName)}/${sid}.jsonl`, [
    userLine(sid, `请帮我看看 ${marker} 这个问题`),
    assistantLine(sid, `msg_${sid}`, 5),
  ]);
}

before(async () => {
  seedWorkspace(WS.p1Shown, M1);
  seedWorkspace(WS.p1Hidden, M1);
  seedWorkspace(WS.p6Shown, M6);
  seedWorkspace(WS.p6Hidden, M6);
  backend = await startBackend({ root, home, label: 'p-backend' });
});

after(async () => { if (backend) await backend.stop(); });

async function ok(url, timeoutMs) {
  const r = await getJson(backend.base, url, timeoutMs);
  assert.equal(r.status, 200, `GET ${url} 应返回 200,实际 ${r.status}:${r.text.slice(0, 300)}`);
  assert.ok(r.json && typeof r.json === 'object', `GET ${url} 应返回 JSON 对象,实际:${r.text.slice(0, 300)}`);
  return r.json;
}

async function checkSearchHides(marker, shown, hidden) {
  const body = await ok(`/api/search?q=${encodeURIComponent(marker)}`);
  assert.equal(body.q, marker, `返回的 q 应等于搜索词,实际:${JSON.stringify(body.q)}`);
  assert.ok(Array.isArray(body.hits), `hits 应是数组,实际:${JSON.stringify(body).slice(0, 300)}`);
  const hashes = body.hits.map((h) => h.projectHash);
  assert.ok(hashes.includes(shown), `命中里应有没被隐藏的工作区 ${shown},实际 projectHash 列表:${JSON.stringify(hashes)}`);
  assert.ok(!hashes.includes(hidden), `命中里不应有被隐藏的工作区 ${hidden},实际 projectHash 列表:${JSON.stringify(hashes)}`);
}

test('P1【复现】偏好文件带 BOM:hiddenProjects 里的工作区在搜索结果里被过滤掉,另一个工作区的命中还在', async () => {
  writePrefs(home, { hiddenProjects: [WS.p1Hidden] }, { bom: true });
  await checkSearchHides(M1, WS.p1Shown, WS.p1Hidden);
});

test('P2【复现】偏好文件带 BOM:GET /api/prefs/hidden-projects 的 hidden 数组含被隐藏的目录名', async () => {
  writePrefs(home, { hiddenProjects: [WS.p1Hidden] }, { bom: true });
  const body = await ok('/api/prefs/hidden-projects');
  assert.ok(Array.isArray(body.hidden), `hidden 应是数组,实际:${JSON.stringify(body)}`);
  assert.ok(body.hidden.includes(WS.p1Hidden), `hidden 应含 ${WS.p1Hidden},实际:${JSON.stringify(body.hidden)}`);
});

test('P3【复现】偏好文件带 BOM:{"updateChannel": X} 之后 GET /api/claude-update-channel 的 explicit 等于 X', async () => {
  writePrefs(home, '{}', { bom: false });
  const first = await ok('/api/claude-update-channel', 30_000);
  assert.ok(Array.isArray(first.channels) && first.channels.length > 0, `channels 应是非空数组,实际:${JSON.stringify(first)}`);
  const x = first.channels[0];
  assert.equal(typeof x, 'string', `channels 里的值应是字符串,实际:${JSON.stringify(x)}`);
  writePrefs(home, { updateChannel: x }, { bom: true });
  const second = await ok('/api/claude-update-channel', 30_000);
  assert.equal(second.explicit, x, `explicit 应等于 ${JSON.stringify(x)},实际:${JSON.stringify(second.explicit)}`);
});

test('P4【复现】偏好文件带 BOM:{"thirdPartyAuto": true} 之后 GET /api/prefs/third-party-auto 返回 enabled: true', async () => {
  writePrefs(home, { thirdPartyAuto: true }, { bom: true });
  const body = await ok('/api/prefs/third-party-auto');
  assert.deepEqual(body, { enabled: true });
});

test('P5【复现】偏好文件带 BOM:{"xsEnabled": true} 之后 GET /api/xsession/config 的 enabled 为 true', async () => {
  writePrefs(home, { xsEnabled: true }, { bom: true });
  const body = await ok('/api/xsession/config');
  assert.equal(body.enabled, true, `enabled 应为 true,实际:${JSON.stringify(body)}`);
});

test('P6【守卫】偏好内容不带 BOM 时,P1–P5 的五个接口结果与带 BOM 时相同', async () => {
  // 搜索(P1)
  writePrefs(home, { hiddenProjects: [WS.p6Hidden] }, { bom: false });
  await checkSearchHides(M6, WS.p6Shown, WS.p6Hidden);
  // 隐藏列表(P2)
  const hiddenBody = await ok('/api/prefs/hidden-projects');
  assert.ok(Array.isArray(hiddenBody.hidden) && hiddenBody.hidden.includes(WS.p6Hidden), `hidden 应含 ${WS.p6Hidden},实际:${JSON.stringify(hiddenBody)}`);
  // 更新渠道(P3)
  writePrefs(home, '{}', { bom: false });
  const channels = (await ok('/api/claude-update-channel', 30_000)).channels;
  assert.ok(Array.isArray(channels) && channels.length > 0, `channels 应是非空数组,实际:${JSON.stringify(channels)}`);
  writePrefs(home, { updateChannel: channels[0] }, { bom: false });
  const channelBody = await ok('/api/claude-update-channel', 30_000);
  assert.equal(channelBody.explicit, channels[0], `explicit 应等于 ${JSON.stringify(channels[0])},实际:${JSON.stringify(channelBody.explicit)}`);
  // 第三方自动(P4)
  writePrefs(home, { thirdPartyAuto: true }, { bom: false });
  assert.deepEqual(await ok('/api/prefs/third-party-auto'), { enabled: true });
  // 跨会话消息总开关(P5)
  writePrefs(home, { xsEnabled: true }, { bom: false });
  const xsBody = await ok('/api/xsession/config');
  assert.equal(xsBody.enabled, true, `enabled 应为 true,实际:${JSON.stringify(xsBody)}`);
});

test('P7【守卫】偏好文件是坏 JSON(带 BOM、不带 BOM 各一次):四个接口都返回 200 与默认值', async () => {
  for (const bom of [true, false]) {
    const tag = bom ? '带 BOM' : '不带 BOM';
    writePrefs(home, '{"xsEnabled": tru', { bom });
    const hidden = await ok('/api/prefs/hidden-projects');
    assert.deepEqual(hidden.hidden, [], `[${tag}] hidden 应是空数组,实际:${JSON.stringify(hidden)}`);
    const channel = await ok('/api/claude-update-channel', 30_000);
    assert.equal(channel.explicit, null, `[${tag}] explicit 应为 null,实际:${JSON.stringify(channel.explicit)}`);
    const third = await ok('/api/prefs/third-party-auto');
    assert.equal(third.enabled, false, `[${tag}] third-party-auto 的 enabled 应为 false,实际:${JSON.stringify(third)}`);
    const xs = await ok('/api/xsession/config');
    assert.equal(xs.enabled, false, `[${tag}] xsession 的 enabled 应为 false,实际:${JSON.stringify(xs)}`);
  }
});
