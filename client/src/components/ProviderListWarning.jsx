// r126:provider 列表区的配置警告行(INTERFACE-r126 §B2 锚点 data-testid="provider-list-warning")。
// 三处列表(顶栏切换浮层 / Provider 管理页 / 手机 Provider 页)共用,数据来自 GET /api/providers 的 warnings[]。
// 只显示 config-corrupt(某份 GUI 配置 json 损坏:哪个文件、备份在哪、怎么处理)与 ccswitch-error(cc-switch 库
// 读取出错 / 损坏);ccswitch-missing(未安装)不算警告,不渲染。筛选与文案在 utils/providerListFetch.js(可单测)。
import { visibleProviderWarnings, providerWarningText } from '../utils/providerListFetch.js';

export default function ProviderListWarning({ warnings, className = '', textClass = 'text-[10px]' }) {
  const list = visibleProviderWarnings({ warnings });
  if (!list.length) return null;
  return (
    <>
      {list.map((w, i) => (
        <div key={`${w.kind}:${w.file || i}`} data-testid="provider-list-warning" role="alert"
          className={`px-2 py-1.5 rounded border border-warning/30 bg-warning/10 ${textClass} text-warning font-body leading-snug break-all ${className}`}>
          {providerWarningText(w)}
        </div>
      ))}
    </>
  );
}
