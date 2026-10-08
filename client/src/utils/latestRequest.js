// r146 R7/R8:同一个取数入口的多次请求"只认最新那一次"。
//
// 场景:面板 / 下拉跟随会话取数(文件审查面板跟随活动窗格、检查点下拉跟随本窗格会话),会话一换
// 就重新取。网络先后不保证:先发的 A 会话请求可能比后发的 B 会话请求晚回来,直接 setState 就把
// A 的结果画在 B 上(还拿 B 的会话 id 去做撤销等动作)。
//
// 用法:每次发起取数先 const isLatest = gate.begin();每个 await 之后、setState 之前
// if (!isLatest()) return;。cancel() 让所有在飞的请求作废(卸载 / 会话清空时用)。
// 纯逻辑、零依赖(组件里放 useRef 持有一个实例),单测直接 import。
export function createLatestGate() {
  let seq = 0;
  return {
    begin() {
      seq += 1;
      const mine = seq;
      return () => mine === seq;
    },
    cancel() { seq += 1; },
  };
}
