import React, { useState } from 'react';
import { ImageLightbox } from '../ImageLightbox.jsx';

/**
 * 工具结果里的图片统一渲染:base64 → data URL,点一下开共享灯箱(与 MCP 卡、聊天图片同一组件)。
 * 为什么抽出来:r132 之前只有 MCP 工具卡挂了这个能力 —— 内置 Read 的卡片与通用兜底卡把
 * `result.images` 整个丢掉,用户读图时卡片里只有"1 行"、必须去文件浏览器看(用户实报)。
 * 哑组件:只认 [{mime,data}],放大层的开关自己持有(与 McpToolCard 原来的写法一致)。
 */
export function ToolResultImages({ images, name = '结果', className = '' }) {
  const [zoomIndex, setZoomIndex] = useState(null);
  const list = (Array.isArray(images) ? images : []).filter((i) => i && i.data);
  if (!list.length) return null;
  const srcOf = (i) => (/^data:/.test(i.data) ? i.data : `data:${i.mime || 'image/png'};base64,${i.data}`);
  return (
    <div className={`space-y-2 ${className}`} data-testid="tool-result-images">
      {list.map((img, i) => (
        <img
          key={i}
          data-testid="tool-result-image"
          src={srcOf(img)}
          alt={`${name} ${i + 1}`}
          loading="lazy"
          onClick={(e) => { e.stopPropagation(); setZoomIndex(i); }}
          className="max-w-full h-auto rounded border border-canvas-deep cursor-zoom-in"
        />
      ))}
      <ImageLightbox
        src={zoomIndex != null ? srcOf(list[zoomIndex]) : null}
        name={zoomIndex != null ? `${name} ${zoomIndex + 1}` : undefined}
        onClose={() => setZoomIndex(null)}
      />
    </div>
  );
}
