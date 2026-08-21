// 单一共享重建算法(BK-8a):气泡内清单(TurnBubble)与输入框上方清单(App currentTodos)
// 此前各有一份实现且有口径差异(跨-turn TaskUpdate、autoId vs 真 id 竞态),导致两处
// 勾选状态可能不一致。统一到这一个纯函数,两处复用;各自只负责传入不同范围的 toolCalls
// (TurnBubble=单 turn;App=全局所有 turn 摊平),算法本身完全一致。
//
// cc 2.1.x 把 TodoWrite 换成了 TaskCreate/TaskUpdate/TaskList 任务系统。
// 规则(老→新顺序回放):
//   - TodoWrite 是覆盖式整份快照,最新一份即全部 → 末尾向前找第一份直接返回。
//   - 否则回放 TaskCreate/TaskUpdate:TaskCreate 建项(id 从 result "Task #N created"
//     解析,失败用纯数字自增),TaskUpdate 按 taskId 改 status/subject,
//     status=deleted 移除。
// 返回 null 表示这批调用里没有任何任务清单。
//
// 入参 toolCalls 可包含非 task 工具(内部按工具名筛选,非 task 调用被忽略)。

export const TASK_TOOL_NAMES = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList']);

export function rebuildTodosFromTaskCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  // TodoWrite 覆盖式快照,最新一份即全部 → 末尾向前找第一份即可。
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i];
    if (tc?.name === 'TodoWrite' && Array.isArray(tc.input?.todos)) {
      return tc.input.todos;
    }
  }
  const tasks = new Map();
  // r32-plan-flood:TaskCreate 的 result 解析不出 "Task #N"(真 id)时,旧实现落 autoId
  // 自增 → Stop 钩子强制续跑每轮重提同一任务(same subject)会建出 N 条同内容条目。
  // 为无真 id 的 TaskCreate 按 subject 去重:同 subject 复用同一个 auto 键(保留最新状态),
  // 不同 subject 仍各得一个 auto 键;有真 id 的路径完全不动。
  const autoKeyBySubject = new Map();
  let autoId = 0;
  let sawTask = false;
  for (const tc of toolCalls) {
    if (tc?.name === 'TaskCreate' && tc.input?.subject) {
      sawTask = true;
      // result 在两条数据源里都是 {toolUseId,content,isError} 对象,只认字符串会让
      // "Task #N" 永远解析失败 → 全落 auto-key,TaskUpdate 的 taskId 对不上被静默丢。
      const raw = typeof tc.result === 'string' ? tc.result : (tc.result?.content || '');
      const rid = String(raw).match(/Task #(\d+)/)?.[1];
      if (rid) {
        // 有真 id:按真 id 建项(路径不动)
        tasks.set(String(rid), { content: tc.input.subject, status: 'pending', activeForm: tc.input.activeForm || '' });
      } else {
        // 无真 id:同 subject 去重(保留最新状态),否则同 subject 的 TaskCreate 落 autoId
        // 自增、同一件事建出 N 条。
        const subj = String(tc.input.subject);
        let key = autoKeyBySubject.get(subj);
        if (key == null) { key = String(++autoId); autoKeyBySubject.set(subj, key); }
        tasks.set(key, { content: subj, status: 'pending', activeForm: tc.input.activeForm || '' });
      }
    } else if (tc?.name === 'TaskUpdate' && tc.input?.taskId != null) {
      sawTask = true;
      const key = String(tc.input.taskId);
      const cur = tasks.get(key);
      if (tc.input.status === 'deleted') { tasks.delete(key); continue; }
      const next = { ...(cur || { content: '', status: 'pending', activeForm: '' }) };
      if (tc.input.status) next.status = tc.input.status;
      if (tc.input.subject) next.content = tc.input.subject;
      if (tc.input.activeForm) next.activeForm = tc.input.activeForm;
      if (next.content) tasks.set(key, next);
    }
  }
  if (sawTask && tasks.size > 0) return [...tasks.values()];
  return null;
}
