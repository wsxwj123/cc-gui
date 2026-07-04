// 常驻悬停注解:任意状态下(无需打开导引),鼠标悬停任意功能按钮(带 data-tour)超过
// 2 秒,就在它旁边弹出详细说明(含二级菜单)。文案复用 GuideTour 的 STEP_INFO。
// 事件用容器级委托(mouseover/mouseout 冒泡),不用给每个按钮单独挂监听。
import { useState, useEffect, useRef } from 'react';
import { STEP_INFO } from './GuideTour.jsx';

const HOVER_DELAY = 2000; // 悬停满 2 秒才显示
const TW = 280;

export function GlobalTooltip() {
  const [tip, setTip] = useState(null); // { info, box }(box 为逻辑 px)
  const timerRef = useRef(0);
  const curElRef = useRef(null);

  useEffect(() => {
    const clear = () => { clearTimeout(timerRef.current); };

    const onOver = (e) => {
      const el = e.target.closest('[data-tour]');
      if (!el || el === curElRef.current) return;
      curElRef.current = el;
      clear();
      const info = STEP_INFO.get(el.getAttribute('data-tour'));
      if (!info) { setTip(null); return; }
      timerRef.current = setTimeout(() => {
        // 元素可能已滚走/卸载;重新量位置。zoom 直读 <html>.style.zoom(÷zoom 还原逻辑 px)。
        const zoom = parseFloat(document.documentElement.style.zoom) || 1;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        setTip({ info, box: { top: r.top / zoom, left: r.left / zoom, width: r.width / zoom, height: r.height / zoom } });
      }, HOVER_DELAY);
    };

    const onOut = (e) => {
      const el = e.target.closest('[data-tour]');
      if (!el) return;
      // 移到该元素外(relatedTarget 不在同一 data-tour 内)才隐藏,避免子元素间抖动。
      const to = e.relatedTarget;
      if (to && el.contains(to)) return;
      curElRef.current = null;
      clear();
      setTip(null);
    };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    // 滚动/切换时也收起,避免注解停在旧位置
    const hide = () => { clear(); curElRef.current = null; setTip(null); };
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      clear();
    };
  }, []);

  if (!tip) return null;
  const { info, box } = tip;
  const zoom = parseFloat(document.documentElement.style.zoom) || 1;
  const vw = window.innerWidth / zoom, vh = window.innerHeight / zoom;
  const estH = 46 + info.desc.split('\n').length * 17;
  let top = box.top + box.height + 8;
  if (top + estH > vh - 8) top = Math.max(8, box.top - estH - 8); // 下方放不下→上方
  const left = Math.max(8, Math.min(box.left, vw - TW - 8));

  return (
    <div style={{ position: 'fixed', top, left, width: TW, zIndex: 500 }}
      className="bg-canvas border border-canvas-deep rounded-xl shadow-2xl p-3 pointer-events-none animate-fade-in">
      <div className="text-[12px] font-body font-semibold text-ink mb-1">{info.title}</div>
      <div className="text-[11px] text-ink-muted font-body leading-relaxed whitespace-pre-line">{info.desc}</div>
    </div>
  );
}
