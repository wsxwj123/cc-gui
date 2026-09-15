# quality8-20260914 —— 代码质量抽查 13 条「重要」项的复现测试

对应审查:`.devflow/CODE-REVIEW-20260914-highrisk.md`(R1–R10)+ `.devflow/CODE-REVIEW-20260914-core.md`(重要-1/2/3)。
人话清单:`.devflow/TEST-PLAN-20260914-quality8.md`;修前红证据:`.devflow/test-red-quality8.txt`。

## 跑法

```sh
tests/acceptance/quality8-20260914/run-all.sh          # 全部(约 1.5 分钟)
tests/acceptance/quality8-20260914/run-all.sh --fast   # 跳过三条慢用例
tests/acceptance/quality8-20260914/run-isolated.sh     # 只跑 Q8-13(真起隔离实例)
node tests/unit/check-q8-<主题>.mjs                     # 单跑某一条
```

## 隔离铁规
- 端口只用 6700–6999 的空闲口,硬拒 6677 / 6689(用户实例)与 6710(他项目)。
- HOME 一律指到 `.artifacts/` 下的临时目录(单测在 `tests/unit/q8-helpers/.artifacts/`),不碰 `~/.claude`、`~/.claude-gui`。
- computer-use 的 python3 被换成只记 argv 的桩(`tests/unit/q8-helpers/cu-stub.mjs`):不建 venv、不装包、不碰桌面。
- 所有起的进程按记录的 pid 收尾,不用 `pkill -f`。
