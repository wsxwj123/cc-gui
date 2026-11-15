// 给定提交「自己改了」的条目,供「验收不许和产品代码混改」的守卫(check-r94-panel §7.9、
// check-r95-image-nav 3.4/E9)逐提交检查。
//
// git:调用方传入的函数,接收若干字符串参数,返回去掉首尾空白的标准输出。
// 返回:[{ kind, paths }],kind = 状态首字母,paths = 路径数组(R/C 带两个路径)。
//
// 普通提交:与唯一父提交的差(等价于 git diff --name-status <父> <sha>)。
// 合并提交:只留「相对每一个父提交都出现在差里」的路径,条目以相对第一父的那份为准。
// 这样「从某个父提交原样带进来的改动」(例如把主分支并进任务分支时主分支那一侧的改动)
// 不算在合并提交头上;合并时夹带的改动、冲突解决的结果相对每个父提交都不同,仍然算。

function parseNameStatus(out) {
  const entries = [];
  // --name-status 一行 = 状态 \t 路径[\t 新路径]
  for (const line of out.split('\n').filter(Boolean)) {
    const [status, ...paths] = line.split('\t');
    entries.push({ kind: status[0], paths });
  }
  return entries;
}

export function commitOwnChanges(git, sha) {
  const parents = git('rev-list', '--parents', '-n', '1', sha).split(' ').filter(Boolean).slice(1);
  // 根提交没有父提交:这类提交不会出现在 merge-base..HEAD 里,按「无条目」处理
  if (parents.length === 0) return [];
  const diffs = parents.map((p) => parseNameStatus(git('diff', '--name-status', p, sha)));
  if (parents.length === 1) return diffs[0];
  const pathSets = diffs.map((entries) => new Set(entries.flatMap((e) => e.paths)));
  const inEveryParent = (p) => pathSets.every((s) => s.has(p));
  return diffs[0].filter((e) => e.paths.some(inEveryParent));
}
