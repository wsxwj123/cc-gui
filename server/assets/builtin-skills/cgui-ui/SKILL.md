---
name: cgui-ui
description: "在回答正文里直接输出可交互界面组件：写一个 ```cgui-ui 围栏，围栏体是一段 JSON，Claude GUI 会把这一整块渲染成真实组件。不止图表——callout/badge 做强调、list/keyvalue 列要点、steps/timeline 讲流程、table 做对比、chart/echart 出数据图、mermaid/diagram 画结构、button/input/select/quiz 收用户输入。凡是「结构化呈现比大段文字更好扫、更好懂、更好操作」的内容都适用：要点、强调、对比、流程、步骤、状态、数据、演示、操作——用户没开口要界面时也可以用。"
---

# cgui-ui — 生成式界面输出规范

在回答正文中间输出一个语言标记为 `cgui-ui` 的围栏，围栏体是一段 JSON 规格，
Claude GUI 把这一整块替换成真实组件，围栏前后的文字照常渲染。
组件**是回答的一部分**，不是工具调用，不需要任何工具或前置声明。

````
```cgui-ui
{"title":"可选标题","gap":14,"items":[ ... ]}
```
````

- 主推标记是 **`cgui-ui`**。`dsh-ui` 同样被识别（兼容按上游规范写的例子），
  但你自己写的时候统一用 `cgui-ui`。
- 围栏一闭合就立即渲染，不必等整条回答写完，所以可以边写文字边出组件。
- **不要嵌套围栏**：`cgui-ui` 围栏体里不能再出现 ``` 代码围栏。

## 根对象

| 字段 | 必填 | 说明 |
|---|---|---|
| `items` | 是 | 组件节点数组 |
| `title` | 否 | 整块标题 |
| `gap` | 否 | 根级组件间距 px，缺省 16 |

根对象直接写成一个组件也合法（`{"type":"text","content":"hi"}` 等价于 `{"items":[…]}`）。

## 组件词汇（只允许这 44 种 `type`）

白名单之外的 `type` 不渲染，会被静默丢弃并在块底部计入「N 个不支持的组件已忽略」。

布局：`text` `row` `col` `grid` `card` `divider` `spacer`
展示：`stat` `badge` `progress` `avatar` `list` `table` `keyvalue` `timeline` `steps` `breadcrumb` `file-tree` `callout` `code` `json` `diff` `link` `audio` `video`
图表：`chart` `plot` `echart`
交互：`button` `input` `textarea` `select` `radio` `checkbox` `switch` `slider` `submit` `quiz` `tabs` `accordion` `copy`
图示与 3D：`mermaid` `diagram` `scene3d`

### 布局

- text：`{"type":"text","size":"h1|h2|h3|body|muted|caption","content":"…","center":true?}`
- row / col：`{"type":"row"|"col","items":[…],"wrap":true?,"spacer":true?,"gap":n?}`
- grid：`{"type":"grid","cols":1-12,"items":[…]}`
- card：`{"type":"card","title":"…"?,"items":[…]}`
- divider：`{"type":"divider"}`；spacer：`{"type":"spacer"}`

### 展示

- stat：`{"type":"stat","label":"…","value":"…","delta":"+12.4%|-3%"?}` — `delta` 以 `-` 开头显红、`+` 显绿
- badge：`{"type":"badge","label":"…","tone":"success|warn|danger|accent"?,"icon":"emoji"?}`
- progress：`{"type":"progress","label":"…","value":0-100,"valueLabel":"70%"?}`
- avatar：`{"type":"avatar","name":"…","color":"#hex"?}`
- list：`{"type":"list","items":[…]}` — 元素可以是字符串、`{"title":"…","desc":"…"}`、或嵌套组件节点；≤50 项
- table：`{"type":"table","columns":["…"],"rows":[["…","…"]]}` — ≤50 行 × ≤12 列；表头点击本地排序（升/降/还原，零往返），数值列自动右对齐
- keyvalue：`{"type":"keyvalue","pairs":[{"key":"…","value":"…"}]}` — ≤24 对
- timeline：`{"type":"timeline","items":[{"title":"…","desc":"…"?,"time":"…"?}]}` — ≤24 项
- steps：`{"type":"steps","current":n?,"steps":[{"title":"…","desc":"…"?}]}` — ≤24 项
- breadcrumb：`{"type":"breadcrumb","items":["首页","设置"]}` — ≤12 项
- file-tree：`{"type":"file-tree","items":[{"name":"…","type":"file|dir","children":[…]?}]}` — 嵌套 ≤6 层；目录行本地折叠
- callout：`{"type":"callout","tone":"info|success|warning|error"?,"title":"…"?,"content":"…"}`
- code：`{"type":"code","lang":"ts"?,"code":"…"}` — 代码体 ≤12000 字符
- json：`{"type":"json","value":任意 JSON}`
- diff：`{"type":"diff","diffs":[{"path":"…","oldText":"…"|null,"newText":"…"}]}` — `oldText` 为 `null` 表示新增文件
- link：`{"type":"link","label":"…","href":"https://…"?}` — 仅 `http(s)` / `mailto`；无 `href` 时渲染成纯文本，不假装可点
- audio：`{"type":"audio","src":"…","alt":"…"?,"loop":true?}` — 原生控制条，不自动播放
- video：`{"type":"video","src":"…","alt":"…"?,"poster":"…"?,"loop":true?,"muted":true?,"aspectRatio":"16:9|4:3|1:1|9:16"?}` — 不自动播放

`audio` / `video` / `poster` 的地址只接受 `http(s)` 与同源相对路径，其它协议（`file:` `data:` 等）整个节点被丢弃。

### 图表

- chart：`{"type":"chart","kind":"bars|line|donut"?,"data":[{"label":"…","value":n,"color":"#hex"?}],"series":[…]?}`
  缺省 `bars`；`series` = 分组柱状图；每序列 ≤60 点。
- plot：`{"type":"plot","series":[{"expr":"a*sin(b*x)","label":"…"?,"kind":"line|area|scatter"?,"color":"#hex"?,"params":[{"name":"a","value":1,"min":0,"max":5,"animateTo":3?,"durationMs":4000?,"loop":true?}]}],"xMin":-6.28?,"xMax":6.28?,"title":"…"?}`
  数学函数图：≤8 序列、每序列 ≤6 个 `params`、`expr` ≤512 字符。
  `params` 渲染成实时滑块（拖动即时重绘），带 `animateTo` 的参数会出现播放按钮。
  表达式语法：变量 `x`，其余单个小写字母是参数；函数 `sin cos tan asin acos atan sqrt cbrt exp log ln abs floor ceil round min max pow`；常量 `pi e tau`；运算符 `+ - * / ^ ( )`。
  **不支持**属性访问（`a.b`）、赋值、任意标识符。非法表达式只让该条曲线不画，其余照常。
- echart：`{"type":"echart","title":"…"?,"height":300?,"preset":"bar|line|area|pie|scatter"?,"data":[…],"series":[…]?}`
  或 full option 模式 `{"type":"echart","option":{…}}` 直接写 ECharts 原生配置。
  preset 模式用与 `chart` 相同的 `data`/`series` 格式，配色自动跟随宿主主题。
  full option 里的函数、外链地址会被过滤掉，只接受数据。视觉要求高时优先用 `echart`。

### 交互

**本地优先**：界面自己能完成的状态变化——排序、折叠、切页、选答案、判卷、重置——
一律本地即时完成，**零模型往返**。`action` 只用于必须你参与的事：生成新内容、执行工具、给下一步建议。

- button：`{"type":"button","label":"…","tone":"primary|danger|success|ghost"?,"full":true?,"small":true?,"icon":"emoji"?,"action":"refresh"?}` — **不带 `action` 的按钮渲染成禁用态，用户点不了**
- input：`{"type":"input","label":"…","placeholder":"…"?,"inputType":"text|email|password"?,"value":"…"?,"action":"名字"?,"id":"字段id"?}` — 失焦（值有变化时）和回车触发，回车带 `submit:true`
- textarea：`{"type":"textarea","label":"…","placeholder":"…"?,"rows":n?,"value":"…"?,"action":"…"?,"id":"…"?}` — 失焦和 Ctrl/Cmd+Enter 触发
- select：`{"type":"select","options":["…"],"label":"…"?,"selected":下标?,"action":"…"?,"id":"…"?}` — ≤50 项；不给 `selected` 时显示占位，不会静默预选第一项
- radio：`{"type":"radio","options":["…"],"label":"…"?,"selected":n?,"action":"…"?,"group":"题号"?,"answer":正确下标或标签?,"explanation":"解析"?}` — 带 `group` 进入聚合模式：选择只本地记录、不发往返
- checkbox / switch：`{"type":"checkbox"|"switch","label":"…","checked":true?,"action":"…"?}`
- slider：`{"type":"slider","label":"…","min":0?,"max":100?,"step":1?,"value":n?,"action":"…"?,"id":"…"?}` — 拖动经防抖合并成一次 action
- submit：`{"type":"submit","label":"交卷","action":"grade"?,"groups":["q1","q2"]?,"resetAction":"redo"?}`
- quiz：`{"type":"quiz","question":"…","options":[{"label":"…","correct":true?,"feedback":"…"?}],"explanation":"…"?,"id":"…"?,"action":"…"?}` — ≤8 选项；点选即本地判题、可重试
- tabs：`{"type":"tabs","tabs":[{"label":"…","items":[…]}]}` — ≤12 个
- accordion：`{"type":"accordion","items":[{"title":"…","items":[…]}]}` — ≤24 个
- copy：`{"type":"copy","text":"…","label":"复制"?}` — `text` ≤4000

**卷子模式**（多道选择题）：每题一个 radio（唯一 `group` + `answer` + `explanation`），
最后放一个 submit（`groups` 列出全部题号）。只要有任一题带 `answer`，交卷就**在本地判卷**：
得分、每题 ✓/✗、解析当场出现并锁定题目，零往返；点「重新作答」本地重置。
**所有题都不带 `answer` 时**，交卷才聚合成一次 action 发给你。不要每题单独发 action（会刷屏）。

**状态持久化**：输入值、选中项、交卷锁定按「会话 + 围栏内容指纹」保存。
你重新渲染**相同内容**会保留用户已填的状态；渲染**新内容**（换题等）自动从头开始。

### 图示与 3D

- mermaid：`{"type":"mermaid","code":"graph TD\\nA-->B"}` — ≤8000 字符；flowchart / sequence / class / gantt / pie / er / state / journey 等；主题自动跟随宿主明暗
- diagram：`{"type":"diagram","kind":"architecture","title":"…"?,"variant":"light|dark|editorial"?,"nodes":[…],"edges":[…]?}`
  节点：`{"id":"a","label":"Web","type":"focal|backend|store|external|input|optional|security","x":40,"y":40,"w":128,"h":48,"sub":"技术子标签"?,"tag":"角标"?}`；
  边：`{"from":"a","to":"b","label":"WRITE"?,"kind":"solid|dashed|accent|link"?}`。
  预算由渲染器强制：≤9 节点 / ≤12 边 / ≤3 分区 / ≤2 焦点色，节点标签 ≤14 字符。
  `kind` 取 27 种图种之一：architecture / it-state / flowchart / sequence / state / er / timeline / swimlane / quadrant / radar / loop / nested / tree / org-chart / layers / venn / pyramid / bar / line / gantt / scatter / high-level / process / medallion / data-flow / dp-integration / dp-security-matrix。
  坐标类图种（architecture / it-state / high-level / process / medallion / data-flow / dp-integration）用 x/y/w/h 精确定位，其余只给数据自动排版。
  结构图优先用 `diagram`，需要自动布局时用 `mermaid`。
- scene3d：`{"type":"scene3d","title":"…"?,"meshes":[{"shape":"box|sphere|cone|cylinder|torus","color":"#hex"?,"size":n|[w,h,d]?,"position":[x,y,z]?,"rotation":[rx,ry,rz]?,"scale":n?}],"ambient":0-2?,"background":"#hex"?}`
  可拖拽旋转、滚轮缩放；**1–5 个 mesh**，一个围栏内最多 2 个 `scene3d`。

## 什么时候用：内容类型 → 组件

判断口诀：这段内容换成结构化组件，会不会更好扫、更好懂、更好操作？会 → 就用，不必等用户开口。

| 要呈现的内容 | 用这些 |
|---|---|
| 关键结论 / 要点罗列（≥2 条） | `list` `keyvalue` `callout` |
| 强调 / 警告 / 注意事项 | `callout` `badge` `stat` |
| 数据对比 / 趋势 / 占比 | `echart` `chart` `table` |
| 关键指标 / 进度状态 | `stat` `progress` `badge` |
| 流程 / 步骤 / 阶段 / 时间线 | `steps` `timeline` `mermaid` |
| 架构 / 拓扑 / 数据流 | `diagram`（自动布局需求才用 `mermaid`） |
| 目录 / 文件结构 / 层级 | `file-tree` `accordion` |
| 状态一览 / 检查结果 | `badge` + `table` + `progress` |
| 代码 / 配置 / 改动对比 | `code` `diff` `json` |
| 音视频结果 | `audio` `video` |
| 两个方案对比 | `table` `tabs` `diff` |
| 教学 / 自测 / 判断题 | `quiz`、或 radio + submit 卷子模式 |
| 数学函数 / 曲线关系 | `plot` |
| 需要用户操作 / 筛选 / 反馈 | `button` `input` `select` `radio` `switch` `tabs` |
| 3D 物体 / 空间布局 | `scene3d` |

**不该用的时候**：一句话能说清、纯闲聊、用户明确说不要界面、为了炫技硬塞。
组件服务内容，不是内容服务组件。

## 硬规则

1. **JSON 必须严格合法**。渲染器只修标点级小错（字符串内的半角引号、尾随逗号）；
   **缺括号/错括号等结构错误一律不修**，整块退回代码块并显示一条红色说明。发出前自检 4 条：
   ① `{` 与 `}`、`[` 与 `]` 数量相等，**收尾序列逐个核对**（长表格最易在最后几行把 `]]}]}` 写成 `]}]}]}`）
   ② 无尾随逗号 ③ 字符串值内的引号用中文引号 `“”` 或 `「」`，不要用半角 `"` ④ 最后一个字符是 `}`。
2. **资源预算**：整棵树 ≤200 节点、≤8 层嵌套，普通字符串字段 ≤2000 字符，
   围栏原文 ≤128 KB。超出的部分被裁掉或截断，不报错。规格要紧凑，超长表格/列表拆成多个组件分开发。
3. **`action` / `id` / `group` 是标识符不是文本**，只允许 `^[A-Za-z0-9_.:-]{1,64}$`
   （字母、数字、下划线、点、冒号、连字符；**不能有空格、引号、换行、中文**）。
   写错形态的，**整个组件节点被丢弃**，不渲染也点不了。
4. **界面回传给你的只有标识符**。用户在带 `action` 的组件上操作时，
   会以一条普通用户消息把 `{"action":"…","component":{…}}` 发回来。
   `label` `title` `question` `placeholder` `explanation` 这些**你写的自然语言不会出现在回传消息里**，
   所以动作名要自解释（`retry-build` 而不是 `a1`），别指望靠标签认出上下文。
   `select` / `radio` 回传的是用户在屏幕上亲自选中的那条选项文本。
5. **秘密禁令**：不要用界面索取或生成密码、API Key、访问令牌、恢复码等秘密。
   `inputType:"password"` 的输入框**值永远不会外发**（没有任何出口），
   用它收密码只会得到一个什么都不发生的输入框。
6. **颜色字段**只接受四种形态：hex（`#3ecf8e`）、`rgb()/rgba()`、`hsl()/hsla()`、
   宿主主题变量 `var(--color-accent)` / `var(--color-ink)` 等。
   其余（`url(…)`、CSS 表达式、非 `--color-` 前缀的变量、超过 64 字符）降级为组件默认色。
   **优先不写颜色**：不写就跟随宿主主题，明暗主题都好看；写死的 hex 在另一套主题下往往对比度不够。
7. **字符串按纯文本渲染**：HTML 标签不会被解释，Markdown 不会被解析，写 `<b>x</b>` 就显示 `<b>x</b>`。
8. **一个主题选一个主组件**：同一批数据别又画 bars 又画 donut。
9. **数量纪律**：一条回答 3–8 个组件为宜，宁缺毋滥。
   反例：该用 `table` 对比却写三段 `text`；一个 `stat` 能说清的事套 `card`+`grid`；与内容无关的 `scene3d`。
