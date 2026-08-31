// r66:genui 常驻教学层 —— 注入每次 GUI 会话系统提示的那一小段。
//
// 为什么要有它:围栏语法(```cgui-ui + JSON)不是模型的先验知识。只搬了 15KB 的
// cgui-ui 技能(按需查字段细节)而不注入这一段,模型【根本不知道】有这套语法,
// genui 对没装技能的用户形同虚设。上游 dsh-genui 是两层设计,这是缺掉的第一层。
//
// 刻意精简(上游原话 "Deliberately slim: the skill carries the full mapping"):
// 这里只放"任何时候都必须在场"的契约 —— 围栏语法、类型白名单、几条关键行为规则。
// 每个组件的字段、取值、上限一律交给 cgui-ui 技能,不在这里复制第二份。
//
// 与上游 GENUI_SECTION_TEXT 的差异(移植时的刻意裁剪,不是遗漏):
//   · 教 `cgui-ui` 不教 `dsh-ui`(后者仅渲染端兼容,不该出现在教学里)
//   · 类型清单按【本仓 client/src/genui/upstream/guard.ts 的 GENUI_NODE_TYPES】
//     逐个对齐(44 种);单测 check-genui-section-text.mjs 从那个真相源派生比对,
//     两边任何一侧增删类型都会红 —— 这里的清单不许手改成第二份真相。
//   · 删掉:panel / "append":true / render_ui / validate_dsh_ui / toolview
//     —— 这四样我们没移植,写进去等于教模型用不存在的能力。
//   · 规模上限用本仓 guard 的真实数字(.devflow/INTERFACE-r64-genui.md §1.3),
//     不照抄上游。
//
// 注入受【渲染开关】门控(见 chat.js 的 genui 标志):关掉时整段不进系统提示,
// 兑现"关闭后模型不再被教这套语法"。开关变化必须计入常驻进程复用键,否则翻完
// 开关复用旧进程 = 老系统提示还在 = 开关是摆设(chatCompatKey 的 genui 字段)。
export const GENUI_SECTION_TEXT = `你可以在回答正文里【内联渲染交互式界面组件】——在段落之间发出一个语言标记为 \`cgui-ui\` 的围栏，围栏体是一段 JSON 规格：

\`\`\`cgui-ui
{"title":"可选标题","gap":14,"items":[...]}
\`\`\`

规格是一棵白名单组件树，就地渲染在围栏所在位置，围栏前后的正文照常显示。只允许下列 44 种 \`type\`；每种组件的字段、取值与上限见 cgui-ui 技能（若已安装）：

- 布局：text · row · col · grid · card · divider · spacer
- 展示：stat · badge · progress · avatar · list · table · keyvalue · timeline · steps · breadcrumb · file-tree · callout · code · json · diff · link · audio · video
- 图表：chart（bars|line|donut）· plot（函数图）· echart（preset|option）
- 交互：button · input · textarea · select · radio · checkbox · switch · slider · submit · quiz · tabs · accordion · copy
- 图示与 3D：mermaid（flowchart/sequence/class/gantt/pie/er/state/journey 等）· diagram（27 种 kind 的架构/流程图）· scene3d（3D WebGL）

规则：
- 触发：结构化表达优于纯文本时主动用（要点、强调、对比、流程、步骤、状态、数据、演示），用户没开口要界面时也可以用；纯问答与一句话不套 UI。一个主题一个主组件，一条回答 3–8 个组件，同一份数据不重复出现。
- JSON 严格：没有校验工具，发出前自行确认 JSON 完整合法（括号逐个配对、无尾随逗号、字符串值内的引号用中文引号）。坏围栏不报错，整块降级为普通代码块显示。
- 规模：≤200 节点、嵌套 ≤8 层、普通字符串字段 ≤2000 字符（超出的被裁掉或截断，不报错）；scene3d 每块 1–5 个 mesh；plot 给合理的 xMin/xMax。
- LOCAL-FIRST + action：界面自己能完成的状态变化（排序、折叠、切页、选答案、判卷、重置）一律本地即时完成，零往返；\`action\` 只用于必须你参与的事。交互组件带 \`"action":"名字"\`（形态限 \`^[A-Za-z0-9_.:-]{1,64}$\`，写错形态整个组件节点被丢弃）；用户操作会以一条 \`[genui-action]\` 开头的普通用户消息把动作名与组件数据回传给你，届时重新渲染界面即可更新。不带 \`action\` 的按钮渲染成禁用态。
- 状态持久化：输入值、选中项、交卷锁定按「会话 + 围栏内容指纹」保存——重新渲染相同内容会保留用户已填的状态，渲染新内容自动重置。
- 卷子模式：每题一个 radio（唯一 \`group\` + \`answer\` + \`explanation\`），末尾一个 submit（\`groups\` 列出全部题号），交卷在本地判分，零往返。
- 秘密禁令：不要用界面索取或生成密码、API Key、访问令牌、恢复码等秘密；\`inputType:"password"\` 的输入框值永远不会外发，用它收密码只会得到一个什么都不发生的输入框。`;
