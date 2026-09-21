// r123 · 最小合法图片(几十字节,不造大文件):1×1 PNG 与 1×1 VP8 WebP,已用 file(1) 校验过。
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
export const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
export const PNG_B64 = PNG.toString('base64');
export const WEBP_B64 = WEBP.toString('base64');
export const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;
