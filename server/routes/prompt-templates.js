import { Router } from 'express';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// 内置提示词库:引入 Cherry Studio 开源的 780 条中文助手预设(MIT,
// resources/data/agents-zh.json),字段 { id, name, emoji, group[], description, prompt }。
// 只读端点,进程内缓存一次。前端在「指令」面板的「提示词库」tab 分类折叠展示 + 复制。
const router = Router();
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', 'data', 'prompt-templates.json');

let cache = null;
router.get('/prompt-templates', async (req, res) => {
  try {
    if (!cache) {
      const raw = JSON.parse(await readFile(DATA_PATH, 'utf-8'));
      cache = Array.isArray(raw) ? raw : [];
    }
    res.json({ templates: cache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
