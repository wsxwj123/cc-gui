import { useEffect, useRef } from 'react';
import { useStore } from '../stores/sessionStore.js';

export function useWebSocket() {
  const wsRef = useRef(null);
  const reconnectRef = useRef(null);
  const setCurrentModel = useStore((s) => s.setCurrentModel);

  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (reconnectRef.current) {
          clearTimeout(reconnectRef.current);
          reconnectRef.current = null;
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          switch (data.type) {
            case 'model':
              setCurrentModel(data.model);
              break;
            case 'provider-change':
              // ~/.claude/settings.json changed (e.g. `cc switch`). Tell any
              // component that cares to refetch — handled via a window event so
              // we don't have to thread refetch callbacks through state.
              window.dispatchEvent(new CustomEvent('cgui:provider-change'));
              break;
            case 'file-change':
              // When a .jsonl session log changes/appears under ~/.claude/projects/,
              // tell the sidebar to silent-refresh the project's session list.
              // This is what makes a newly-spawned session appear in history
              // immediately (instead of waiting for the post-chat setTimeout).
              if (typeof data.path === 'string' && data.path.includes('/projects/') && data.path.endsWith('.jsonl')) {
                window.dispatchEvent(new CustomEvent('cgui:sessions-changed', { detail: { path: data.path } }));
              }
              break;
            case 'permission:request': {
              const req = data.request;
              // Mid-stream permission-mode override: even though chat.js
              // spawned the CLI with a fixed mode, the user can flip the
              // dropdown mid-stream and we honor it client-side. Order:
              //   1. bypassPermissions → auto-allow EVERYTHING immediately
              //   2. acceptEdits + tool in read-class list → auto-allow
              //   3. per-session "永远允许 X" whitelist → auto-allow
              //   4. otherwise → render popup
              // Use the mode of the SESSION THIS REQUEST belongs to — NOT the
              // global/active mirror. Otherwise a request for session B gets
              // auto-allowed because session A happens to be in bypass/accept
              // (the "授权串号" bug). Falls back to 'default' (prompt) when the
              // session has no stored mode.
              const modeMap = useStore.getState().permissionModeBySession || {};
              const mode = modeMap[req.sessionId] || 'default';
              const READ_CLASS = ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'NotebookRead', 'Skill'];
              if (mode === 'bypassPermissions') {
                fetch(`/api/permissions/respond/${req.id}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ decision: 'allow' }),
                }).catch(() => {});
                break;
              }
              if (mode === 'acceptEdits' && READ_CLASS.includes(req.toolName)) {
                fetch(`/api/permissions/respond/${req.id}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ decision: 'allow' }),
                }).catch(() => {});
                break;
              }
              const wl = JSON.parse(localStorage.getItem(`cgui-perm-wl-${req.sessionId || 'none'}`) || '[]');
              if (wl.includes(req.toolName)) {
                fetch(`/api/permissions/respond/${req.id}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ decision: 'allow' }),
                }).catch(() => {});
                break;
              }
              useStore.getState().addPendingPermission(req);
              break;
            }
            case 'permission:resolved':
              useStore.getState().removePendingPermission(data.id);
              break;
          }
        } catch {}
      };

      ws.onclose = () => {
        if (cancelled) return;
        reconnectRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        try { ws.close(); } catch {}
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect after unmount
        try { wsRef.current.close(); } catch {}
      }
    };
  }, [setCurrentModel]);

  return wsRef;
}
