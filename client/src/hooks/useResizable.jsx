import { useState, useEffect, useCallback } from 'react';

/**
 * Drag-to-resize hook. Drag along `axis` updates a numeric size bounded to
 * [min, max] and persisted to localStorage if `storageKey` is provided.
 * Returns [size, onMouseDownHandler].
 *
 * `invert: true` flips the delta sign — use for right-edge dividers where
 * dragging RIGHT should SHRINK the right panel.
 */
export function useResizable({ initial, min, max, axis = 'x', storageKey, invert = false }) {
  const [size, setSize] = useState(() => {
    if (storageKey) {
      try {
        const v = parseFloat(localStorage.getItem(storageKey));
        if (Number.isFinite(v)) return Math.max(min, Math.min(max, v));
      } catch {}
    }
    return initial;
  });
  useEffect(() => {
    if (!storageKey) return;
    try { localStorage.setItem(storageKey, String(size)); } catch {}
  }, [size, storageKey]);
  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    const startCoord = axis === 'x' ? e.clientX : e.clientY;
    const startSize = size;
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev) => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - startCoord;
      const next = Math.max(min, Math.min(max, startSize + (invert ? -delta : delta)));
      setSize(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [size, axis, min, max, invert]);
  return [size, onMouseDown];
}

export function Splitter({ onMouseDown, axis = 'x' }) {
  const isVert = axis === 'x';
  return (
    <div
      onMouseDown={onMouseDown}
      className={`shrink-0 ${isVert ? 'w-1 cursor-col-resize hover:w-1.5' : 'h-1 cursor-row-resize hover:h-1.5'} bg-transparent hover:bg-accent/30 transition-all relative z-10`}
      title={isVert ? '拖动调节宽度' : '拖动调节高度'}
    />
  );
}
