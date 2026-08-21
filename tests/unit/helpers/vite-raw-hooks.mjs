// node module customization hooks:让 node 能加载 vite 的 `?raw` import(仅单测用)。
// 用法(测试文件顶部,必须先注册再动态 import 目标模块):
//   import { register } from 'node:module';
//   register('./helpers/vite-raw-hooks.mjs', import.meta.url);
//   const mod = await import('../../client/src/builtin-skins/registry.js');
// 口径与 vite ?raw 一致:模块默认导出 = 文件全文 utf8 字符串。
import { readFile } from 'node:fs/promises';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('?raw')) {
    const resolved = await nextResolve(specifier.slice(0, -'?raw'.length), context);
    return { url: `${resolved.url}?raw`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('?raw')) {
    const text = await readFile(new URL(url.slice(0, -'?raw'.length)), 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
