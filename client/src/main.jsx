import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { THEME_FAMILIES, resolveTheme, applyReadingFont } from './stores/sessionStore.js';
import './index.css';

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
})();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
