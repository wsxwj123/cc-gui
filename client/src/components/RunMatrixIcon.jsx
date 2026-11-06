import { RUN_MATRIX_CELLS, runCellDelayMs } from '../utils/sessionDots.js';

// r154:「运行中」九宫格(3×3 去掉中心、8 格顺时针追逐),与侧栏会话行同一套坐标 / 时序 /
// 动画类(session-dot-run → cguiDotChase,减弱动画下静止)。子代理卡运行中的图标位用它。
export function RunMatrixIcon({ size = 13, className = '' }) {
  return (
    <svg
      viewBox="0 0 10 10"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={`session-dot-run text-accent shrink-0 ${className}`}
      data-agent-icon="matrix"
      aria-hidden="true"
    >
      {RUN_MATRIX_CELLS.map(([x, y], i) => (
        <rect key={i} x={x} y={y} width="2" height="2" fill="currentColor" style={{ animationDelay: `${runCellDelayMs(i)}ms` }} />
      ))}
    </svg>
  );
}
