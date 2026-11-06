// r154:加载动画偏好(样式 + 转速)的默认值与 localStorage 读取(纯函数,storage 由调用方传入)。

export const LOADING_SPEEDS = Object.freeze(['slow', 'normal', 'fast']);
export const DEFAULT_LOADING_SPEED = 'slow';
// 只影响 localStorage 里还没有 cgui-loading-style 的人;选过任何样式(包括 cli)的人保持原值
export const DEFAULT_LOADING_STYLE = 'orbit3';
export const LOADING_SPEED_KEY = 'cgui-loading-speed';
export const LOADING_STYLE_KEY = 'cgui-loading-style';

export function normalizeLoadingSpeed(v) {
  return LOADING_SPEEDS.includes(v) ? v : DEFAULT_LOADING_SPEED;
}

export function readLoadingSpeed(storage) {
  try {
    return normalizeLoadingSpeed(storage ? storage.getItem(LOADING_SPEED_KEY) : null);
  } catch {
    return DEFAULT_LOADING_SPEED;
  }
}

export function readLoadingStyle(storage) {
  try {
    const v = storage ? storage.getItem(LOADING_STYLE_KEY) : null;
    return typeof v === 'string' && v ? v : DEFAULT_LOADING_STYLE;
  } catch {
    return DEFAULT_LOADING_STYLE;
  }
}
