// r151l 补验收(B4b/B5/B6)专用操作层。只新增,不改既有的 ui.mjs / history.mjs:
// 点一次「加载更早」并等到这一次请求真的落地(响应 + loading 结束),供连续翻页用例使用。
// 不 import 产品代码,定位口径仍是界面上可观察的 data-history-load-older 与请求 URL。
import { expect } from '@playwright/test';
import { loadOlderCandidates, messageList } from './ui.mjs';
import { waitFor } from './history.mjs';

export const messagesPath = (sid) => `/api/sessions/${encodeURIComponent(sid)}/messages`;

/** 按 sid 过滤"加载更早"请求(带 before 参数的那些)。 */
export const olderRequests = (reqs, sid) =>
  reqs.filter((r) => r.sid === sid && r.params.before !== undefined);

/**
 * 点一次「加载更早」,并等到**这一次**请求的 200 应答落地、入口退出 loading。
 * 返回 { request, body, status }:request 是 watchHistoryRequests 记下的那条(含 params),
 * body 是响应 JSON(解析失败为 null)。调用前入口必须存在(由调用方断言)。
 */
export async function clickLoadOlder(page, reqs, sid, { timeout = 60_000 } = {}) {
  const seen = olderRequests(reqs, sid).length;
  const responsePromise = page.waitForResponse((res) => {
    try {
      const u = new URL(res.url());
      return u.pathname === messagesPath(sid) && u.searchParams.has('before');
    } catch {
      return false;
    }
  }, { timeout });
  const entry = loadOlderCandidates(page).first();
  await expect(entry, '点之前「加载更早」入口应可见').toBeVisible({ timeout: 20_000 });
  await entry.dispatchEvent('click');
  const response = await responsePromise;
  const status = response.status();
  const body = await response.json().catch(() => null);
  const request = await waitFor(() => olderRequests(reqs, sid)[seen] ?? null, 10_000, 50);
  // loading 结束的判据:入口还在时必须恢复可点;入口消失 = 已经到最早(hasMore=false)。
  const btn = page.locator('[data-history-load-older] button');
  if (await btn.count()) await expect(btn).toBeEnabled({ timeout: 20_000 });
  return { request, body, status };
}

/** 消息区里含指定正文的消息行数量(正文都由夹具唯一 tag 生成,不会多会话撞词)。 */
export const textHits = (page, text) => messageList(page).getByText(text).count();

/** 一次取完所有断言需要的 DOM 计数,失败信息里一起打印。 */
export async function pagingFacts(page, { sid, reqs, texts = [] } = {}) {
  const rows = page.locator('[data-cgui="message-list"] [data-turn-uuid]');
  const count = await rows.count();
  const entry = await loadOlderCandidates(page).count();
  const placeholder = page.locator('[data-turn-placeholder]');
  const placeholderCount = await placeholder.count();
  const placeholderText = placeholderCount ? (await placeholder.first().innerText()).trim() : null;
  const cap = await page.locator('[data-history-cap]').count();
  const hits = {};
  for (const t of texts) hits[t] = await textHits(page, t);
  return {
    count,
    entry,
    placeholderCount,
    placeholderText,
    cap,
    hits,
    requests: sid ? reqs.filter((r) => r.sid === sid).map((r) => r.url) : [],
  };
}
