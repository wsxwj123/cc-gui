import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { watchBrandOptical } from './utils/brandMetrics.js';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { THEME_FAMILIES, resolveTheme, applyReadingFont } from './stores/sessionStore.js';
import { bootReplaySkin } from './utils/skins.js';
import { initInputUndo } from './utils/inputUndo.js';
import './index.css';
// genui 窄屏降级。放全局入口而不是随 GenuiFence 走:它按 data-genui-* 属性挂钩,
// 与围栏组件何时被加载无关,且 index.css 之后引入才排在同源同特异性规则的后面。
import './genui/genui-responsive.css';

// ── Theme bootstrap ──────────────────────────────────────────────
// Apply the chosen (family, tone) on <html> BEFORE React mounts so we never
// flash the wrong color. tone: 'auto' | 'light' | 'dark'; family maps to a
// data-cgui-theme variant via resolveTheme.
(function bootstrapTheme() {
  const root = document.documentElement;

  const family = (() => {
    const fam = localStorage.getItem('cgui-theme-family');
    if (fam) return fam;
    // Migrate from the legacy single preset id.
    const preset = localStorage.getItem('cgui-theme-preset') || '';
    if (!preset) return 'default';
    const m = THEME_FAMILIES.find((f) => f.light.id === preset || f.dark.id === preset);
    return m ? m.id : 'default';
  })();
  const tone = localStorage.getItem('cgui-theme') || 'auto';

  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    // CSS keys the default family's dark palette off data-theme-system.
    root.setAttribute('data-theme-system', mql.matches ? 'dark' : 'light');
    const { dataTheme, cguiTheme } = resolveTheme(family, tone);
    root.setAttribute('data-theme', dataTheme);
    if (cguiTheme) root.setAttribute('data-cgui-theme', cguiTheme);
    else root.removeAttribute('data-cgui-theme');
  };
  apply();
  // Keep data-theme-system fresh; the store's listener re-resolves the preset
  // variant when tone === 'auto'.
  mql.addEventListener('change', apply);

  // Persist the migrated family so subsequent loads skip derivation.
  try { localStorage.setItem('cgui-theme-family', family); } catch {}

  // Apply the saved reading font before mount so message prose doesn't flash
  // the default serif then swap.
  try { applyReadingFont(localStorage.getItem('cgui-reading-font') || 'newsreader'); } catch {}

  // 界面不透明度:启动前预置 --surface-alpha,避免面板先按 100% 画一帧再跳。
  try {
    const sa = parseInt(localStorage.getItem('cgui-surface-alpha') || '', 10);
    if (Number.isFinite(sa) && sa >= 55 && sa <= 100) {
      root.style.setProperty('--surface-alpha', sa + '%');
    }
  } catch {}

  // r11-③:皮肤 FOUC 防护——激活皮肤的展开值缓存同步重放(vars+背景+图标,不等网络);
  // App 挂载后 reconcileSkinOnBoot 拉列表校对(失效清/有变重应用)。
  bootReplaySkin();
})();

// CK-12: 全局输入框撤销/重做(Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z)。
initInputUndo();

// r29 取证:renderer 崩溃原来零记录(公开版"用一段时间窗口消失"拿不到证据)。
// window error / unhandledrejection → POST /api/client-log(server 追加落
// ~/.claude-gui/client.log,同消息 5s 限流,body 截 2KB)。纯 fire-and-forget,
// 任何失败静默吞掉 —— 上报通道绝不能反过来影响应用本身。
(function initClientErrorReporting() {
  const report = (kind, message, stack) => {
    try {
      fetch('/api/client-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          message: String(message || ''),
          stack: String(stack || ''),
          url: location.href,
        }),
      }).catch(() => {});
    } catch {}
  };
  window.addEventListener('error', (e) => {
    report('error', e.message,
      (e.error && e.error.stack) || `${e.filename || ''}:${e.lineno || 0}:${e.colno || 0}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    report('unhandledrejection', (r && r.message) || String(r), (r && r.stack) || '');
  });
})();

watchBrandOptical(); // r13-p2-15:字标光学补偿(按实际字体度量,见 brandMetrics.js)
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* 根边界:整棵树崩了也给错误块+重试,不再整页白屏 */}
    <ErrorBoundary label="应用">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
