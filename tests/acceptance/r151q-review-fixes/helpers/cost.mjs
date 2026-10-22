// r151q 费用用例的种子会话与界面读数。
import fs from 'node:fs';
import path from 'node:path';
import { homeDir, claudeDir, makeWorkspace, encodeProjectDir, newSid } from '../../r151b-xsession-p1/helpers/fixtures.mjs';

/** replies = [{ input, output, cacheRead?, cacheCreate? }, …];每个来回 = 1 条 user + 1 条 assistant(带该用量)。 */
export function seedCostSession({ tag, replies, model = 'claude-sonnet-4-5', home = homeDir() }) {
  const sid = newSid();
  const cwd = makeWorkspace(`r151q-${tag}`);
  const proj = path.join(claudeDir(home), 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(proj, { recursive: true });
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.296', gitBranch: '' };
  const t0 = Date.parse('2026-10-01T08:00:00.000Z');
  const lines = [{ type: 'summary', summary: `R151Q ${tag}`, leafUuid: `${sid}-a${replies.length - 1}` }];
  const texts = [];
  replies.forEach((u, i) => {
    const userText = `R151Q-${tag}-U${String(i).padStart(3, '0')}`;
    const replyText = `R151Q-${tag}-A${String(i).padStart(3, '0')}`;
    texts.push(userText, replyText);
    lines.push({ ...base, type: 'user', uuid: `${sid}-u${i}`, parentUuid: i ? `${sid}-a${i - 1}` : null, timestamp: new Date(t0 + i * 2000).toISOString(), message: { role: 'user', content: userText } });
    lines.push({ ...base, type: 'assistant', uuid: `${sid}-a${i}`, parentUuid: `${sid}-u${i}`, timestamp: new Date(t0 + i * 2000 + 1000).toISOString(), requestId: `req_${sid.slice(0, 8)}_${i}`,
      message: { id: `msg_${sid.slice(0, 8)}_${i}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: replyText }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead || 0, cache_creation_input_tokens: u.cacheCreate || 0 } } });
  });
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { sid, cwd, firstText: texts[0], lastText: texts[texts.length - 1], count: texts.length };
}

/** 页面上所有带金额的节点(排除侧栏);inList = 在消息区里(= 回复气泡上的费用)。 */
export function costFacts(page) {
  return page.evaluate(() => {
    const re = /[$¥￥]\s?\d[\d,]*(?:\.\d+)?/;
    const rows = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('[data-cgui="sidebar"]')) continue;
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
      const attr = [el.getAttribute('title'), el.getAttribute('aria-label')].filter(Boolean).join(' | ');
      const hit = [own, attr].find((t) => t && re.test(t));
      if (!hit) continue;
      const r = el.getBoundingClientRect();
      rows.push({ text: own || null, attr: attr || null, amount: Number(hit.match(/[$¥￥]\s?(\d[\d,]*(?:\.\d+)?)/)[1].replace(/,/g, '')), tag: el.tagName.toLowerCase(),
        cgui: el.closest('[data-cgui]')?.getAttribute('data-cgui') || null, testid: el.closest('[data-testid]')?.getAttribute('data-testid') || null,
        inList: !!el.closest('[data-cgui="message-list"]'), top: Math.round(r.top), visible: r.width > 0 && r.height > 0 });
    }
    return { rows, estimateNote: document.documentElement.innerHTML.includes('按当前价目表估算'), bodyHead: document.body.innerText.slice(0, 1500) };
  });
}
