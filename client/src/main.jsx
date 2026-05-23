import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// ── Theme bootstrap ──────────────────────────────────────────────
// Apply the chosen theme on <html> BEFORE React mounts so we never
// flash the wrong color. Stores: 'auto' | 'light' | 'dark'.
(function bootstrapTheme() {
  const root = document.documentElement;
  const saved = localStorage.getItem('cgui-theme') || 'auto';
  root.setAttribute('data-theme', saved);

  // Mirror system preference into a separate attr the CSS keys off of
  // when data-theme === 'auto'.
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const syncSystem = () => root.setAttribute('data-theme-system', mql.matches ? 'dark' : 'light');
  syncSystem();
  mql.addEventListener('change', syncSystem);
})();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
