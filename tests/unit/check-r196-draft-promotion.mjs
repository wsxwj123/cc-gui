// r196 T2:草稿拿到正式编号时的迁移(排队 + 留言 + 输入历史)抽成 client/src/utils/draftPromotion.promoteDraftArtifacts。
//   D1 与抽出前窗格里的写法(从 6751acc23 的 App.jsx startedAsDraft 块逐行誊写)在同一组起始状态上结果相同。
//   D2 各步的效果:排队并进正式编号(按 queuedAt 排)、草稿键删掉、落盘;留言改挂;输入历史改键;空的不动。
// node tests/unit/check-r196-draft-promotion.mjs
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  key: (i) => [...storage.keys()][i] ?? null,
  get length() { return storage.size; },
};

const { useStore } = await import('../../client/src/stores/sessionStore.js');
const { promoteDraftArtifacts } = await import('../../client/src/utils/draftPromotion.js');
const { migrateDraftQueue } = await import('../../client/src/utils/routing.js');
const { leaveSessionNotice, takeSessionNotice, migrateSessionNotice } = await import('../../client/src/utils/sessionNotice.js');

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

// 抽出前窗格里的三段(selectedSession 闭包的草稿键 = draftKey,event.session_id = sid;窗格提示条那句不在迁移函数里,不誊)
function oldInline(draftKey, sid) {
  try {
    const _dk = draftKey;
    const _next = migrateDraftQueue(useStore.getState().messageQueue, _dk, sid);
    if (_next) useStore.setState({ messageQueue: _next });
  } catch {}
  {
    const _nk = draftKey;
    migrateSessionNotice(_nk, sid);
  }
  try {
    const _hk = draftKey;
    const _hv = localStorage.getItem(`cgui-input-history:${_hk}`);
    if (_hv && _hv !== '[]') { localStorage.setItem(`cgui-input-history:${sid}`, _hv); localStorage.removeItem(`cgui-input-history:${_hk}`); }
  } catch {}
}

const DK = 'draft-h1-d100-1';
const SID = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'draft-h1-d200-2';
function seed({ draftItems, sidItems, notice, history } = {}) {
  useStore.setState({ messageQueue: {
    ...(draftItems ? { [DK]: draftItems } : {}),
    ...(sidItems ? { [SID]: sidItems } : {}),
    [OTHER]: [{ queueId: 'o1', text: 'other', queuedAt: 5 }],
  } });
  takeSessionNotice(DK); takeSessionNotice(SID);
  if (notice) leaveSessionNotice(DK, notice);
  storage.delete(`cgui-input-history:${DK}`); storage.delete(`cgui-input-history:${SID}`);
  if (history != null) storage.set(`cgui-input-history:${DK}`, history);
}
const snapshot = () => ({
  queue: useStore.getState().messageQueue,
  persisted: JSON.parse(storage.get('cgui-message-queue') || '{}'),
  noticeSid: takeSessionNotice(SID),
  noticeDk: takeSessionNotice(DK),
  histSid: storage.get(`cgui-input-history:${SID}`) ?? null,
  histDk: storage.get(`cgui-input-history:${DK}`) ?? null,
});

const SCENARIOS = [
  { name: '三样都有', s: { draftItems: [{ queueId: 'd1', text: 'd1', queuedAt: 3 }], sidItems: [{ queueId: 's1', text: 's1', queuedAt: 1 }, { queueId: 's2', text: 's2', queuedAt: 4 }], notice: '有 1 张图没能带上', history: '["first"]' } },
  { name: '只有排队', s: { draftItems: [{ queueId: 'd1', text: 'd1', queuedAt: 3 }] } },
  { name: '只有留言与历史', s: { notice: '留言', history: '["x"]' } },
  { name: '历史是空数组', s: { history: '[]' } },
  { name: '什么都没有', s: {} },
];

// ── D1 与抽出前的写法结果相同 ──────────────────────────────────────────────────────────
for (const { name, s } of SCENARIOS) {
  seed(s); oldInline(DK, SID); const before = snapshot();
  seed(s); promoteDraftArtifacts(DK, SID); const after = snapshot();
  eq(after, before, `D1 ${name}:与抽出前的写法结果相同`);
}

// ── D2 各步的效果 ───────────────────────────────────────────────────────────────────
{
  seed(SCENARIOS[0].s);
  promoteDraftArtifacts(DK, SID);
  const st = snapshot();
  eq(st.queue[SID].map((it) => it.queueId), ['s1', 'd1', 's2'], 'D2:草稿的排队并进正式编号,按 queuedAt 排');
  eq(DK in st.queue, false, 'D2:草稿键删掉');
  eq(st.queue[OTHER].map((it) => it.queueId), ['o1'], 'D2:别的草稿不动');
  eq(st.persisted[SID].map((it) => it.queueId), ['s1', 'd1', 's2'], 'D2:已落盘');
  eq([st.noticeSid, st.noticeDk], ['有 1 张图没能带上', null], 'D2:留言改挂到正式编号');
  eq([st.histSid, st.histDk], ['["first"]', null], 'D2:输入历史改键');
}
{
  seed({ history: '[]' });
  const q0 = useStore.getState().messageQueue;
  promoteDraftArtifacts(DK, SID);
  eq(useStore.getState().messageQueue === q0, true, 'D2:草稿下没有排队 → 不写状态库');
  eq([storage.get(`cgui-input-history:${DK}`), storage.get(`cgui-input-history:${SID}`) ?? null], ['[]', null], 'D2:空历史不改键');
}

console.log(`✓ check-r196-draft-promotion:${checks} 项断言全部通过`);
