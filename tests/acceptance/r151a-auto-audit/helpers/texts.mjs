// r151a:INTERFACE-r151.md 第一部分(Y)里的取值、错误码与文案,逐字照抄(含半角标点)。
// 所有断言都从这里取,改一处即可;不要在 spec 里另写一份。
export const ERR = {
  PREF_INVALID: { status: 400, code: 'INVALID_INPUT', error: 'enabled 必须是布尔值' },
  STORAGE: { status: 500, code: 'STORAGE_WRITE_FAILED', error: '保存失败,请重试' },
  MODEL_INVALID: { status: 400, code: 'INVALID_INPUT', error: 'providerId 与 model 必须是字符串' },
  PROVIDER_NOT_FOUND: { status: 404, code: 'PROVIDER_NOT_FOUND', error: 'provider 不存在' },
  OFFICIAL_PROVIDER: { status: 400, code: 'OFFICIAL_PROVIDER', error: '官方端点不使用此设置' },
  MODELS_UNAVAILABLE: { status: 409, code: 'PROVIDER_MODELS_UNAVAILABLE', error: '取不到该 provider 的模型列表' },
  MODEL_NOT_IN_PROVIDER: { status: 400, code: 'MODEL_NOT_IN_PROVIDER', error: '该模型不在此 provider 的模型列表里' },
  MODEL_UNUSABLE: { status: 400, code: 'MODEL_UNUSABLE_AS_AUDITOR', error: '该型号不能用作审核模型(CLI 限制)' },
  TP_AUTO_DISABLED: { status: 409, code: 'THIRD_PARTY_AUTO_DISABLED', error: '第三方 provider 的「自动」档未开启' },
};

export const DOWNGRADE = { requested: 'auto', effective: 'default', reason: 'third-party-auto-disabled' };
export const APPLY_FAILED = 'APPLY_FAILED';

export const UI = {
  AUTO_DESC: '由审核模型逐动作判定,通过即执行,判定有风险则拒绝。每次审核额外消耗约 3 万输入 token;审核模型判错可能放行危险操作。',
  auditModelLine: (name) => `审核模型:${name}`,
  AUDIT_MODEL_UNKNOWN: '审核模型:未知',
  auditModelDefaultLine: (name) => `审核模型:${name}(未单独设置)`,
  SEND_DOWNGRADE_BANNER: '「自动」权限档在第三方 provider 下默认关闭,本会话已切回「逐步确认」。可在 设置 → 权限 中开启。',
  denialBlocked: (tool, reason) => `已拒绝 ${tool}(自动档审核):${reason}`,
  denialUnavailable: (tool, reason) => `未执行 ${tool}:审核模型没有给出结论(${reason})。这不是对该操作安全性的判定。`,
  checking: (tool) => `正在审核 ${tool}…`,
  CHECKING_UNKNOWN: '正在审核操作…',
  STREAK: '自动审核已连续拦下多次操作,这一次由你决定。',
  NOTICE_LINES: [
    '审核由你设置的模型完成,判错会放行危险操作;较弱的模型判错更多。',
    '每个需要审核的操作会向当前 provider 额外发 1–2 次请求,每次约 3 万输入 token(2026-10 实测,随对话变长而增加)。',
    '审核请求包含待执行的命令、文件路径和部分对话内容,会发给当前 provider。',
  ],
  FOLLOW_DEFAULT: '跟随默认模型',
  UNUSABLE_MARK: '不可用作审核模型',
  ALIAS_NOTE: '审核模型与 sonnet 档共用同一设置:以 sonnet 别名发起的调用(例如指定 sonnet 的子代理)也使用它。',
  modelUnset: (name) => `尚未选择审核模型,当前使用该 provider 的默认模型 ${name}。`,
  MODEL_HINT: '审核请求限定了很短的输出长度。把推理型模型设为审核模型时,它可能在限定长度内给不出结论,导致重复请求并拒绝操作。',
  RESET_BTN: '清除不可用标记',
  OFFICIAL_NOTE: '当前是官方端点:自动档不受此开关影响。',
  UNKNOWN_PROVIDER_NOTE: '未识别当前 provider,无法设置审核模型。',
  APPLY_FAILED_TEXT: '已保存,但未能写入当前配置;重新切换一次该 provider 后生效',
  SEARCH_TITLE: '第三方 provider 的自动档',
};

/** CLI 的四句「auto 不可用」原文(Y.3.4 发送时)。 */
export const AUTO_UNAVAILABLE_PHRASES = [
  'auto mode disabled by settings',
  'auto mode is unavailable for your plan',
  'auto mode unavailable while fast mode is on',
  'auto mode unavailable for this model',
];

/** 改动前(0.2.421)官方 provider 下权限档选择器的选项,2026-10-14 在未改动的工作树上实测记录(顺序与标题)。 */
export const OFFICIAL_OPTION_TITLES_BEFORE = ['逐步确认', '接受编辑', '规划', '自动', '不打扰', '放任'];
/** 档位值(GUI 档 → data-mode)。 */
export const MODE_OF_TITLE = { 逐步确认: 'default', 接受编辑: 'acceptEdits', 规划: 'plan', 自动: 'auto', 不打扰: 'dontAsk', 放任: 'bypassPermissions' };
