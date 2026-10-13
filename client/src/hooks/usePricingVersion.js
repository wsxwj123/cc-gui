import { useSyncExternalStore } from 'react';
import { subscribePricingVersion, getPricingVersion } from '../utils/pricingCatalog.js';

/**
 * 订阅"查价数据的版本"(r148):官方价目 / 用户单价 / 官方计费方式任一变了,调用它的组件重渲染一次。
 * 算金额的组件都该调一下 —— 查价只读缓存,而这三样是异步到达的(见 utils/pricingCatalog.js「查价输入的版本号」)。
 */
export function usePricingVersion() {
  return useSyncExternalStore(subscribePricingVersion, getPricingVersion, getPricingVersion);
}
