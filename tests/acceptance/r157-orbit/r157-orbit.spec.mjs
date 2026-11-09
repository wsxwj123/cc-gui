// r157-orbit：生成中的旋转指示器（默认「三体旋转」）——轨道上下点头 + 圆点在 WebKit 里不被压扁。
// 判据全部来自 .devflow/r157-orbit-接口.md 第 3 节的 R1–R4，只看页面上看得见的东西
// （[data-live-line] / [data-live-indicator] 与它的三个 <i>、getBoundingClientRect、截图像素）；不读源码、不读 React state。
// 命名：Rn 对应行为清单第 n 条。
import { test, expect } from '@playwright/test';
import { openAllGates, startRound } from './helpers/live.mjs';
import { bash, waitLine } from './helpers/wg.mjs';

// 用例失败时直播回合会停在半路（假命令行在等放行文件）：把所有闸门都放了，让它自己收尾，别拖累下一条。
test.afterEach(async () => { try { openAllGates(); } catch { /* 忽略 */ } });

const IND = '[data-live-line] [data-live-indicator]';
// r161 整体放大 + 收窄远近差:动画以 14px 指示器为基准(最前 2.3px / 最远 1.8px;r161 之前是 2.5 / 1.6),状态行指示器宽 LIVE_PX 时整体乘 K = LIVE_PX / 14。
const LIVE_PX = 20; // 须与应用里 LIVE_INDICATOR_PX 一致
const K = LIVE_PX / 14;

/** 造一个生成中的回合：一个带 description、一直不返回结果的 Bash 工具调用 → 状态行与指示器一直在。 */
async function liveOrbit(page, key, desc) {
  await startRound(page, { key, scenario: { events: [bash(desc, { pending: 'd1' })] } });
  await waitLine(page, 'tool', desc); // 前置自证：生成中的状态行在
  const ind = page.locator(IND).first();
  await expect(ind, '前置自证：状态行里应有指示器').toBeVisible({ timeout: 15_000 });
  await expect(ind, '前置自证：默认样式应为三体旋转').toHaveAttribute('data-style', 'orbit3');
  await expect.poll(async () => await ind.locator('i').count(), { message: '前置自证：指示器里应有 3 个点' }).toBe(3);
  await page.waitForTimeout(400); // 让入场淡入走完、轮转起来
  return ind;
}

/**
 * 界面缩放设成 1.0：像用户一样打开「主题与外观」→「界面字体大小」点「中」，再关掉面板。
 * （默认档是「大」= 根元素 zoom 1.2；接口文件 R2 / R3 的口径是界面缩放 1.0。）
 */
async function setUiZoomOne(page) {
  const rootZoom = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom').trim());
  await page.locator('[data-cgui="theme-btn"]').click();
  const row = page.locator('div:has(> div > span:text-is("界面字体大小"))');
  await expect(row, '前置自证：外观面板里应有「界面字体大小」').toBeVisible({ timeout: 10_000 });
  await row.getByRole('button', { name: '中', exact: true }).click();
  await expect.poll(rootZoom, { message: '前置自证：选「中」后界面缩放应为 1' }).toBe('1');
  await page.keyboard.press('Escape');
  if (await row.isVisible().catch(() => false)) await page.locator('[data-cgui="theme-btn"]').click();
  await expect(row, '前置自证：外观面板应已关掉（不挡指示器截图）').toBeHidden({ timeout: 5_000 });
  await page.waitForTimeout(300);
}

/** 页内读一次三个点的矩形（视口坐标，含 transform）。 */
async function dotRects(page) {
  return await page.evaluate((sel) => {
    const ind = document.querySelector(sel);
    return ind ? [...ind.querySelectorAll('i')].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }) : [];
  }, IND);
}

/** 现场事实（只进断言信息，方便红的时候看出环境）：设备像素比、根元素 zoom、点的计算宽高、指示器矩形。 */
async function sceneFacts(page) {
  return await page.evaluate((sel) => {
    const ind = document.querySelector(sel);
    const dot = ind && ind.querySelector('i');
    const cs = dot ? getComputedStyle(dot) : null;
    const r = ind ? ind.getBoundingClientRect() : null;
    return `dpr=${window.devicePixelRatio} rootZoom=${getComputedStyle(document.documentElement).zoom || '-'}`
      + ` bodyZoom=${getComputedStyle(document.body).zoom || '-'} dot=${cs ? `${cs.width}×${cs.height}` : '-'}`
      + ` ind=${r ? `${r.width.toFixed(1)}×${r.height.toFixed(1)}` : '-'}`;
  }, IND);
}

const quantile = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));

test('R1 默认三体旋转上下点头：纵横比最小 ≤ 0.20（排成一线）、最大 ≥ 0.45（纵向展开）', async ({ page }) => {
  test.setTimeout(150_000);
  await liveOrbit(page, 'b1', 'R1 一直没返回的命令');
  // 页内每 100 毫秒采一次三个点的中心，连续 6.6 秒（覆盖一个完整的点头周期）。
  const run = await page.evaluate(async ({ sel, dur, gap }) => {
    const read = () => {
      const ind = document.querySelector(sel);
      return ind ? [...ind.querySelectorAll('i')].map((el) => {
        const r = el.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
      }) : [];
    };
    const samples = [];
    const t0 = performance.now();
    for (;;) {
      samples.push({ t: performance.now() - t0, c: read() });
      if (performance.now() - t0 >= dur) break;
      await new Promise((r) => setTimeout(r, gap));
    }
    return samples;
  }, { sel: IND, dur: 6600, gap: 100 });

  const span = run.length ? run[run.length - 1].t : 0;
  expect(span, `R1 采样时长 ${Math.round(span)}ms 应 ≥ 6500ms`).toBeGreaterThanOrEqual(6500);
  const withThree = run.filter((s) => s.c.length === 3);
  expect(withThree.length, `R1 每次采样都应读到 3 个点（读到 3 点的样本 ${withThree.length}/${run.length}）`).toBe(run.length);

  const ratios = [];
  let dropped = 0;
  for (const s of withThree) {
    const xs = s.c.map((p) => p[0]); const ys = s.c.map((p) => p[1]);
    const xr = Math.max(...xs) - Math.min(...xs);
    const yr = Math.max(...ys) - Math.min(...ys);
    if (xr < 1) { dropped += 1; continue; }
    ratios.push(yr / xr);
  }
  expect(ratios.length, `R1 有效样本（横向范围 ≥ 1px）${ratios.length} 个，丢弃 ${dropped} 个，应 ≥ 40`).toBeGreaterThanOrEqual(40);
  const minR = Math.min(...ratios); const maxR = Math.max(...ratios);
  const summary = `样本 ${ratios.length}，纵横比最小 ${f2(minR)} / 最大 ${f2(maxR)}`;
  console.log(`[R1] ${summary}`);
  expect(minR, `R1 纵横比最小值 ${f2(minR)} > 0.20（过水平线时应几乎排成一条线；${summary}）`).toBeLessThanOrEqual(0.20);
  // 阈值 0.45:旧公式(0.2.447)实算,默认转速下 6.6 秒窗口里、在所有起始相位下纵横比最大值都 ≥ 0.527(典型 0.54),最小值 ≤ 0.101;留余量取 0.45 / 0.20。
  expect(maxR, `R1 纵横比最大值 ${f2(maxR)} < 0.45（点头到最高 / 最低时应纵向展开；${summary}）`).toBeGreaterThanOrEqual(0.45);
});

/**
 * 页内跑：对每帧 PNG 算每个点的椭圆度（接口文件 R2 的口径）。
 * 背景色 = 四角的中位颜色；覆盖度 = 与背景色的距离 ÷ 该帧最大距离；覆盖度 > 0.15 的像素按 8 邻域连块，
 * 块的加权像素数（Σ覆盖度）< 3 的忽略；按覆盖度加权算二阶矩，椭圆度 = √(λ大 / λ小)。
 * 只统计「恰好 3 个块、且没有块贴图边（被裁）」的帧——点与点相叠 / 相切会连成一块，这样的帧不算。
 */
async function analyzeFramesInPage(pngs) {
  const out = { frames: pngs.length, valid: 0, ratios: [], blockHist: {}, edgeFrames: 0, sizes: [] };
  for (const b64 of pngs) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const w = bmp.width; const h = bmp.height;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d'); ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, w, h).data;
    out.sizes.push(`${w}x${h}`);
    const at = (x, y) => (y * w + x) * 4;
    const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
    const med = (c) => { const v = corners.map((o) => px[o + c]).sort((a, b) => a - b); return (v[1] + v[2]) / 2; };
    const bg = [med(0), med(1), med(2)];
    const dist = new Float32Array(w * h);
    let maxD = 0;
    for (let i = 0; i < w * h; i += 1) {
      const d = Math.hypot(px[i * 4] - bg[0], px[i * 4 + 1] - bg[1], px[i * 4 + 2] - bg[2]);
      dist[i] = d; if (d > maxD) maxD = d;
    }
    if (maxD <= 0) { out.blockHist[0] = (out.blockHist[0] || 0) + 1; continue; }
    const cov = dist.map((d) => d / maxD);
    const seen = new Uint8Array(w * h);
    const blocks = [];
    for (let s = 0; s < w * h; s += 1) {
      if (seen[s] || cov[s] <= 0.15) continue;
      const stack = [s]; seen[s] = 1;
      let W = 0; let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0; let edge = false;
      while (stack.length) {
        const p = stack.pop(); const x = p % w; const y = (p - x) / w; const c = cov[p];
        W += c; sx += c * x; sy += c * y; sxx += c * x * x; syy += c * y * y; sxy += c * x * y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx; const ny = y + dy;
            if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h) {
              const q = ny * w + nx;
              if (!seen[q] && cov[q] > 0.15) { seen[q] = 1; stack.push(q); }
            }
          }
        }
      }
      if (W < 3) continue;
      const mx = sx / W; const my = sy / W;
      const a = sxx / W - mx * mx; const d = syy / W - my * my; const b = sxy / W - mx * my;
      const tr = (a + d) / 2; const disc = Math.sqrt(Math.max(0, ((a - d) / 2) ** 2 + b * b));
      const l1 = tr + disc; const l2 = tr - disc;
      blocks.push({ ratio: l2 > 0 ? Math.sqrt(l1 / l2) : Infinity, edge });
    }
    out.blockHist[blocks.length] = (out.blockHist[blocks.length] || 0) + 1;
    if (blocks.length !== 3) continue;
    if (blocks.some((k) => k.edge)) { out.edgeFrames += 1; continue; }
    out.valid += 1;
    for (const k of blocks) out.ratios.push(k.ratio);
  }
  out.sizes = [...new Set(out.sizes)];
  return out;
}

test.describe('2 倍屏', () => {
  test.use({ deviceScaleFactor: 2 });

  test('R2 圆度：三个点分开的帧里，每个点椭圆度中位数 ≤ 1.06、90 分位 ≤ 1.14', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', 'R2 只在 WebKit 下判（问题所在引擎）');
    test.setTimeout(180_000);
    const ind = await liveOrbit(page, 'b2', 'R2 一直没返回的命令');
    await setUiZoomOne(page);
    const zoom = await page.evaluate(() => ({ dpr: window.devicePixelRatio }));
    expect(zoom.dpr, '前置自证：devicePixelRatio 应为 2').toBe(2);
    // 逐帧截图（page.screenshot 的原生像素），每 120 毫秒一帧，44 帧。截图范围 = 指示器矩形四周各放 3px：
    // 点会转出指示器自己的盒子，只截盒子会把点切掉（切掉的点圆度不可测）。
    const box = await ind.boundingBox();
    expect(box, "前置自证：指示器应有矩形").not.toBeNull();
    const PAD = 3;
    const clip = { x: box.x - PAD, y: box.y - PAD, width: box.width + PAD * 2, height: box.height + PAD * 2 };
    const pngs = [];
    for (let i = 0; i < 44; i += 1) {
      const t = Date.now();
      pngs.push((await page.screenshot({ clip, animations: "allow" })).toString('base64'));
      const rest = 120 - (Date.now() - t);
      if (rest > 0) await page.waitForTimeout(rest);
    }
    expect(pngs.length, 'R2 截图帧数应 ≥ 40').toBeGreaterThanOrEqual(40);
    const res = await page.evaluate(analyzeFramesInPage, pngs);
    const median = quantile(res.ratios, 0.5); const p90 = quantile(res.ratios, 0.9);
    const summary = `帧 ${res.frames}，有效帧 ${res.valid}，点 ${res.ratios.length}，中位数 ${f2(median)}，90 分位 ${f2(p90)}，`
      + `块数分布 ${JSON.stringify(res.blockHist)}，贴边帧 ${res.edgeFrames}，截图尺寸 ${res.sizes.join('/')}` + `，现场 ${await sceneFacts(page)}`;
    console.log(`[R2] ${summary}`);
    expect(res.valid, `R2 三点分开的有效帧 ${res.valid} < 10（${summary}）`).toBeGreaterThanOrEqual(10);
    expect(median, `R2 圆度中位数 ${f2(median)} > 1.06（${summary}）`).toBeLessThanOrEqual(1.06);
    expect(p90, `R2 圆度 90 分位 ${f2(p90)} > 1.14（${summary}）`).toBeLessThanOrEqual(1.14);
  });

  test('R3 视觉大小：每个点的宽、高始终在 [1.8K − 0.15, 2.3K + 0.15]px（r161 整体放大：K = 指示器宽 20 / 基准 14，即 2.42–3.44px；基准上最前 2.3px / 最远 1.8px，±0.15 取整误差）', async ({ page }) => {
    test.setTimeout(150_000);
    await liveOrbit(page, 'b3', 'R3 一直没返回的命令');
    await setUiZoomOne(page);
    const indW = await page.locator(IND).first().evaluate((el) => el.getBoundingClientRect().width);
    expect(Math.abs(indW - LIVE_PX), `R3 前置自证：状态行指示器宽应为 ${LIVE_PX}px（界面缩放 1.0；实际 ${f2(indW)}px）——圆点大小的判据按这个宽折算`).toBeLessThanOrEqual(0.5);
    const ws = []; const hs = []; let frames = 0;
    for (let i = 0; i < 44; i += 1) {
      const t = Date.now();
      const rects = await dotRects(page);
      expect(rects.length, `R3 第 ${i} 帧应读到 3 个点`).toBe(3);
      for (const r of rects) { ws.push(r.w); hs.push(r.h); }
      frames += 1;
      const rest = 120 - (Date.now() - t);
      if (rest > 0) await page.waitForTimeout(rest);
    }
    const summary = `帧 ${frames}，宽 ${f2(Math.min(...ws))}–${f2(Math.max(...ws))}px，高 ${f2(Math.min(...hs))}–${f2(Math.max(...hs))}px` + `，现场 ${await sceneFacts(page)}`;
    console.log(`[R3] ${summary}`);
    expect(frames, 'R3 采样帧数应 ≥ 40').toBeGreaterThanOrEqual(40);
    expect(Math.min(...ws, ...hs), `R3 最小宽 / 高 < ${f2(1.8 * K - 0.15)}px（${summary}）`).toBeGreaterThanOrEqual(1.8 * K - 0.15);
    expect(Math.max(...ws, ...hs), `R3 最大宽 / 高 > ${f2(2.3 * K + 0.15)}px（${summary}）`).toBeLessThanOrEqual(2.3 * K + 0.15);
  });
});

test('R4 减弱动画的静止帧：三个点中心两两距离都 ≥ 3px × 整体放大倍数 K', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await liveOrbit(page, 'b4', 'R4 一直没返回的命令');
  const rects = await dotRects(page);
  expect(rects.length, 'R4 应读到 3 个点').toBe(3);
  const d = [[0, 1], [0, 2], [1, 2]].map(([a, b]) => Math.hypot(rects[a].x - rects[b].x, rects[a].y - rects[b].y));
  const summary = `两两距离 ${d.map(f2).join(' / ')}px`;
  console.log(`[R4] ${summary}`);
  expect(Math.min(...d), `R4 最小两两距离 < ${f2(3 * K)}px（3px × K = ${f2(K)}；${summary}）`).toBeGreaterThanOrEqual(3 * K);
});
