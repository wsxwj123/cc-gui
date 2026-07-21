// System font enumeration for the reading-font picker.
//
// Fonts live on the *rendering* device — a Mac webview shows Mac fonts, a phone
// on the LAN shows its own — so the list MUST be detected client-side per device,
// never pushed from the host that runs the backend. Two strategies, best-effort
// with graceful fallback:
//   1) queryLocalFonts() (Local Font Access API): full local family list, but
//      only Chromium *desktop* (WebView2 / Chrome / Edge) and only after a
//      user-gesture permission grant. Safari / macOS WKWebView and all mobile
//      browsers (iOS Safari, Android Chrome) do NOT ship it. So it's an optional
//      enhancement behind a button, not the default path.
//   2) Canvas measurement probe against a per-platform whitelist: works
//      everywhere including WKWebView and mobile. This is the workhorse.
//
// Value model: built-in presets are keyed by their `id` (backward compatible with
// the old picker's stored 'newsreader' etc.); enumerated system fonts are keyed by
// their raw family name. readingFontCss() resolves either.

// ── Built-in presets (curated stacks, always shown, never deduped away) ──
// `css` is written to the --font-reading custom property. `family` is the
// primary face, used to dedup a same-named system font out of the enumerated group.
export const FONT_OPTIONS = [
  { id: 'newsreader', name: '默认衬线 (Newsreader)', family: 'Newsreader',       css: "'Newsreader', Georgia, serif" },
  { id: 'times',      name: 'Times New Roman',       family: 'Times New Roman', css: "'Times New Roman', Times, serif" },
  { id: 'georgia',    name: 'Georgia',               family: 'Georgia',         css: "Georgia, 'Times New Roman', serif" },
  { id: 'sans',       name: '无衬线 (DM Sans)',      family: 'DM Sans',         css: "'DM Sans', -apple-system, system-ui, sans-serif" },
  { id: 'mono',       name: '等宽 (JetBrains Mono)', family: 'JetBrains Mono',  css: "'JetBrains Mono', ui-monospace, monospace" },
];

// Resolve a stored reading-font value to a CSS font stack. A preset id wins;
// anything else is treated as a raw system family name (with a neutral fallback
// so text never vanishes if the font is later uninstalled).
export function readingFontCss(id) {
  const opt = FONT_OPTIONS.find((f) => f.id === id);
  return opt ? opt.css : `"${id}", system-ui, sans-serif`;
}

// ── Per-platform candidate families for the measurement probe ──
// Concrete installed families only (no CSS generics — those are covered by the
// built-in presets and would measure identically to a baseline anyway).
export const FONT_CANDIDATES = {
  mac: [
    'PingFang SC', 'PingFang TC', 'Hiragino Sans GB', 'Hiragino Sans',
    'Songti SC', 'STSong', 'STHeiti', 'Heiti SC', 'Kaiti SC', 'Yuanti SC',
    'Helvetica Neue', 'Helvetica', 'Avenir', 'Avenir Next', 'Optima',
    'Palatino', 'Baskerville', 'Menlo', 'Monaco', 'Courier',
    'SF Pro Text', 'SF Mono', 'Apple SD Gothic Neo', 'American Typewriter',
  ],
  win: [
    'Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi', 'FangSong',
    'Microsoft JhengHei', 'DengXian', 'Segoe UI', 'Tahoma', 'Verdana',
    'Arial', 'Calibri', 'Cambria', 'Consolas', 'Courier New',
    'Georgia', 'Times New Roman', 'Trebuchet MS', 'Lucida Console',
  ],
  common: [
    'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Courier New',
    'Verdana', 'Trebuchet MS', 'Comic Sans MS', 'Impact',
  ],
};

// Pick the candidate set for the current device. Unknown platform → probe both
// desktop lists; the measurement filter drops whatever isn't installed anyway.
export function platformCandidates() {
  const s = (typeof navigator !== 'undefined'
    ? `${navigator.platform || ''} ${navigator.userAgent || ''}` : '');
  const isWin = /Win/i.test(s);
  const isApple = /Mac|iPhone|iPad|iPod/i.test(s);
  const set = new Set(FONT_CANDIDATES.common);
  if (isWin) FONT_CANDIDATES.win.forEach((f) => set.add(f));
  else if (isApple) FONT_CANDIDATES.mac.forEach((f) => set.add(f));
  else { FONT_CANDIDATES.mac.forEach((f) => set.add(f)); FONT_CANDIDATES.win.forEach((f) => set.add(f)); }
  return [...set];
}

// ── Canvas measurement probe (classic, cross-browser reliable) ──
// A family is "present" if rendering the test string in it produces a width
// different from at least one generic baseline. document.fonts.check() is NOT
// used: WKWebView returns true even for absent families (it silently falls back),
// so it can't filter. Measurement can.
const PROBE_BASELINES = ['monospace', 'serif', 'sans-serif'];
const PROBE_TEXT = 'mmmmmmmmmmlliWQ 汉字测试样张 0123';
const PROBE_SIZE = '72px';

export function detectFonts(families) {
  if (typeof document === 'undefined') return [];
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return [];
  const base = {};
  for (const b of PROBE_BASELINES) { ctx.font = `${PROBE_SIZE} ${b}`; base[b] = ctx.measureText(PROBE_TEXT).width; }
  const out = [];
  for (const fam of families) {
    for (const b of PROBE_BASELINES) {
      ctx.font = `${PROBE_SIZE} "${fam}", ${b}`;
      if (Math.abs(ctx.measureText(PROBE_TEXT).width - base[b]) > 0.5) { out.push(fam); break; }
    }
  }
  return out;
}

// Optional full enumeration via Local Font Access API. Returns a sorted family
// list, or null when unsupported / permission denied / no user gesture (caller
// then keeps the whitelist-probed list). MUST be called from a user gesture.
export async function queryLocalFontFamilies() {
  if (typeof window === 'undefined' || typeof window.queryLocalFonts !== 'function') return null;
  try {
    const fonts = await window.queryLocalFonts();
    return [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  } catch {
    return null; // SecurityError (no gesture), NotAllowedError (denied), etc.
  }
}

// ── Group + filter for the picker (pure, testable) ──
// entries: [{ key, name, css, group: 'builtin' | 'system' }]
// favorites: ordered array of keys. Returns three ordered buckets after applying
// the search query. Favorites preserve their add order and win over group.
export function groupFonts(entries, favorites, query) {
  const favSet = new Set(favorites);
  const q = (query || '').trim().toLowerCase();
  const match = (e) => !q || e.name.toLowerCase().includes(q) || e.key.toLowerCase().includes(q);
  const filtered = entries.filter(match);
  const byKey = new Map(filtered.map((e) => [e.key, e]));
  const favs = favorites.map((k) => byKey.get(k)).filter(Boolean);
  const rest = filtered.filter((e) => !favSet.has(e.key));
  return {
    favorites: favs,
    builtins: rest.filter((e) => e.group === 'builtin'),
    systems: rest.filter((e) => e.group === 'system'),
  };
}

// Build the full entry list from presets + detected system families. System
// families whose name collides with a built-in primary family are dropped
// (dedup), so nothing is listed twice.
export function buildFontEntries(systemFamilies) {
  const builtinFamilies = new Set(FONT_OPTIONS.map((f) => f.family));
  const builtins = FONT_OPTIONS.map((f) => ({ key: f.id, name: f.name, css: f.css, group: 'builtin' }));
  const systems = [...new Set(systemFamilies)]
    .filter((fam) => fam && !builtinFamilies.has(fam))
    .sort((a, b) => a.localeCompare(b))
    .map((fam) => ({ key: fam, name: fam, css: `"${fam}", system-ui, sans-serif`, group: 'system' }));
  return [...builtins, ...systems];
}
