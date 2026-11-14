// r184:偏好文件(~/.claude-gui/prefs.json)的纯解析,各处读取共用。
// 开头的 UTF-8 BOM 先剥掉再解析:Windows 上用记事本 / PowerShell 存过的合法文件开头带 BOM,
// 直接 JSON.parse 会抛错,调用方就各自悄悄回到默认值。
// 只做解析、不读文件、不规范化:内容不是合法 JSON 时照旧抛错,由调用方按各自原有的
// 「读不出回默认」口径处理。不引用 routes 下任何模块(避免循环引用)。
export function parsePrefsJson(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}
