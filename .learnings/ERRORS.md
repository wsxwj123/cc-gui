# Errors

Command failures and integration errors.

---

## [ERR-20260814-008] worktree_symlink_cleanup

**Logged**: 2026-08-14T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: cleanup

### Summary
构建完成后，沙箱拒绝移除本轮创建的两个 worktree 依赖软链。

### Error
```
unlink: node_modules: Operation not permitted
unlink: client/node_modules: Operation not permitted
```

### Context
- 两个目标均是本轮创建、未被 Git 跟踪的依赖软链，不是依赖目录本体。
- 包产物已经生成，不再需要软链。

### Suggested Fix
确认 `ls -l` 的目标为预期主仓依赖目录后，以受限升级权限对两个精确路径执行 `unlink`。

### Metadata
- Reproducible: yes
- Related Files: node_modules, client/node_modules

---

## [ERR-20260814-007] worktree_git_index_lock

**Logged**: 2026-08-14T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: git

### Summary
隔离 worktree 暂存时，沙箱禁止在主仓共享 `.git/worktrees/...` 创建 `index.lock`。

### Error
```
fatal: Unable to create .../.git/worktrees/codex-fix-session-interactions/index.lock: Operation not permitted
```

### Context
- 功能文件全部位于可写 worktree，但 Git 索引元数据位于主仓 `.git`。
- 这是 worktree 的标准共享元数据布局。

### Suggested Fix
对明确 worktree 的 `git add` / `git commit` 使用受限升级权限，并在暂存后复核文件清单。

### Metadata
- Reproducible: yes
- Related Files: .git/worktrees/codex-fix-session-interactions

---

## [ERR-20260814-006] unit_suite_loopback_listener

**Logged**: 2026-08-14T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
全量单测运行到需要监听环回地址的用例时被沙箱拒绝。

### Error
```
listen EPERM: operation not permitted 127.0.0.1
```

### Context
- 此前 12 个测试已通过，失败来自测试进程的本地监听权限，不是断言。
- 测试集合包含真实 HTTP/代理行为验证。

### Suggested Fix
以受限升级权限重跑同一全量测试循环，保留真实监听行为而不改成 mock。

### Metadata
- Reproducible: yes
- Related Files: tests/unit

---

## [ERR-20260814-005] sandbox_preview_ports

**Logged**: 2026-08-14T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: ui-test

### Summary
沙箱禁止独立预览服务监听本机 6699/5199 端口。

### Error
```
listen EPERM: operation not permitted 0.0.0.0:6699
listen EPERM: operation not permitted 127.0.0.1:5199
```

### Context
- 使用独立端口是为了不占用打包版正在使用的 6677。
- 两个进程均在一次性 worktree 中运行。

### Suggested Fix
以受限升级权限启动明确端口的临时后端与 Vite 预览；验收后关闭进程。

### Metadata
- Reproducible: yes
- Related Files: server/index.js, client/vite.preview.config.js

---

## [ERR-20260814-004] worktree_vite_dist_cleanup

**Logged**: 2026-08-14T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: build

### Summary
worktree 内二次执行 Vite 构建时，沙箱拒绝清空该 worktree 自己的旧 `client/dist/assets`。

### Error
```
EPERM, Operation not permitted: .../client/dist/assets
```

### Context
- 目录属主、属组和写权限均正常。
- 单测与 ESLint 已通过，失败发生在 Vite `prepareOutDir` 清理旧产物阶段。

### Suggested Fix
确认目标严格位于一次性 worktree 后，以受限升级权限重跑同一构建命令；不要手工递归删除未知目录。

### Metadata
- Reproducible: yes
- Related Files: client/dist

---

## [ERR-20260814-003] worktree_private_release_docs

**Logged**: 2026-08-14T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release

### Summary
一次从隔离 worktree 读取 gitignored 的 `CLAUDE.local.md` 失败。

### Error
```
sed: CLAUDE.local.md: No such file or directory
```

### Context
- 一次性 worktree 按设计不携带主仓的私有 `.local.*` 文件。
- 发版说明仍需在打包前只读核对。

### Suggested Fix
在 worktree 开发时，从主仓绝对路径只读私有发版说明；不要复制或链接 `.local.*` 到功能分支。

### Metadata
- Reproducible: yes
- Related Files: CLAUDE.local.md

---

## [ERR-20260814-002] worktree_dependency_symlink

**Logged**: 2026-08-14T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
沙箱内无法为外置 worktree 创建指向主仓 node_modules 的符号链接。

### Error
```
ln: node_modules: Operation not permitted
```

### Context
- 目的：复用现有依赖运行 lint/Vite build，不安装或修改依赖
- worktree 位于主仓旁的独立目录

### Suggested Fix
对明确的 worktree 与依赖目标申请受限升级权限后重试；构建完成前确认符号链接未被 Git 跟踪。

### Metadata
- Reproducible: yes
- Related Files: package.json, client/package.json

---

## [ERR-20260814-001] fetch-everything

**Logged**: 2026-08-14T00:00:00+08:00
**Priority**: low
**Status**: pending
**Area**: docs

### Summary
统一抓取器未能提取 Claude Code 官方交互模式文档。

### Error
```
status=failed, reason=no_candidate
```

### Context
- 目标：核对运行中输入、队列和快捷键的原生 CLI 语义
- URL：https://code.claude.com/docs/en/interactive-mode
- 自动路线全部无候选结果；页面是公开技术文档，无登录墙

### Suggested Fix
按 fetch-everything 的技术文档回退规则，使用直接 WebFetch 读取同一官方页面。

### Metadata
- Reproducible: unknown
- Related Files: client/src/components/ChatInput.jsx, client/src/App.jsx

---
