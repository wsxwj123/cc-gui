/**
 * The recursive render dispatcher: maps the white-listed GenuiNode union to
 * concrete components. Leaf cases render inline; compound families live in
 * the sibling block modules. Depth-guarded against pathological specs.
 * @module @changfenhuang/dsh-genui/client/blocks/render-node
 */
import { Fragment, type ReactNode } from 'react'
import { ActionFeedback } from '../action-feedback.tsx'
import css from '../GenuiBlock.module.css'
import { GENUI_LIMITS } from '../guard.ts'
import type { GenuiList, GenuiNode } from '../spec.ts'
import type { AnswersState, GenuiBlockProps } from './state.ts'
import { AudioNode, avatarColor, ClickFeedbackButton, VideoNode } from './basic.tsx'
import { ChartNode, TableNode } from './charts.tsx'
import {
  InputNode, RadioNode, SelectNode, SliderNode, SubmitNode, SwitchNode, TextareaNode,
} from './forms.tsx'
import {
  AccordionNode, BreadcrumbNode, CalloutNode, CodeNode, CopyNode, DiffNode, FileTreeNode, JsonNode, KeyValueNode,
  MermaidNode, PlotNode, QuizNode, Scene3DNode, StepsNode, TabsNode, TimelineNode,
} from './advanced.tsx'
import { DiagramNode } from './diagram/index.tsx'

import { EChartNode } from '../EChartNode.tsx'

function isListItemNode(item: GenuiList['items'][number]): item is GenuiNode {
  return typeof item === 'object' && item !== null && 'type' in item
}

/**
 * CGUI-PATCH(INTERFACE §9.2):发送态反馈挂在**分发点**,不逐个组件改。
 * 13 种可触发组件全从这里过,一处包一层就全覆盖;组件自己不需要知道反馈的存在。
 * 没有 `action` 或没有能力对象(只读面)时原样返回 —— 那两种情况徽章根本不进 DOM。
 */
export function renderNode(
  node: GenuiNode,
  key: number,
  onAction: GenuiBlockProps['onAction'] | undefined,
  depth = 0,
  answers?: AnswersState,
  path = '',
): ReactNode {
  const el = renderNodeInner(node, key, onAction, depth, answers, path)
  const action = (node as { action?: unknown }).action
  if (el === null || onAction === undefined || typeof action !== 'string') return el
  return (
    <Fragment key={key}>
      {el}
      <ActionFeedback action={action} />
    </Fragment>
  )
}

function renderNodeInner(
  node: GenuiNode,
  key: number,
  onAction: GenuiBlockProps['onAction'] | undefined,
  depth = 0,
  answers?: AnswersState,
  // CGUI-PATCH: 祖先路径。`key` 只是**兄弟序号**(每层从 0 重来),单独拿它当身份会
  // 让不同容器里的同序号节点撞在一起。路径 = 节点在规格树里的位置,重挂前后不变、
  // 流式期节点内容还在长的时候也不变 —— 无天然键的界面态就按它存(§3.6)。
  path = '',
): ReactNode {
  // Depth guard: a pathological spec must never recurse past the limit
  // (stack overflow / DOM explosion). The fence path already repairs specs
  // against the same limit; this is the belt-and-suspenders for direct
  // GenuiBlock use and plugin-registered custom renderers.
  if (depth > GENUI_LIMITS.maxDepth) return null
  const uiKey = path === '' ? String(key) : `${path}.${key}`
  switch (node.type) {
    case 'text': {
      const size = node.size ?? 'body'
      return (
        <div key={key} className={`${css.text} ${css[size]}` + (node.center ? ` ${css.center}` : '')}>
          {node.content}
        </div>
      )
    }
    case 'row': {
      return (
        <div key={key} className={css.row + (node.wrap ? ` ${css.wrap}` : '')}>
          {node.items.map((c, i) => renderNode(c, i, onAction, depth + 1, answers, uiKey))}
          {node.spacer && <div className={css.spacer} />}
        </div>
      )
    }
    case 'col': {
      return (
        <div key={key} className={css.col} style={node.gap !== undefined ? { gap: `${node.gap}px` } : undefined}>
          {node.items.map((c, i) => renderNode(c, i, onAction, depth + 1, answers, uiKey))}
        </div>
      )
    }
    case 'grid': {
      return (
        <div key={key} className={css.grid} style={{ gridTemplateColumns: `repeat(${Math.max(1, node.cols)}, minmax(0, 1fr))` }}>
          {node.items.map((c, i) => renderNode(c, i, onAction, depth + 1, answers, uiKey))}
        </div>
      )
    }
    case 'card': {
      return (
        <div key={key} className={css.card}>
          {node.title !== undefined && <div className={css.cardTitle}>{node.title}</div>}
          {node.items.map((c, i) => renderNode(c, i, onAction, depth + 1, answers, uiKey))}
        </div>
      )
    }
    case 'button': {
      const tone = node.tone ?? ''
      const cls = `${css.button} ${css[tone] || ''}` + (node.full ? ` ${css.full}` : '') + (node.small ? ` ${css.small}` : '')
      const action = node.action
      // A button without an action (or without an action provider) is a
      // display-only control: render it DISABLED so the affordance is honest
      // — clickable-looking dead buttons were the top complaint in the field.
      const interactive = action !== undefined && onAction !== undefined
      return (
        <ClickFeedbackButton
          key={key}
          className={cls}
          disabled={!interactive}
          onClick={interactive ? () => onAction(action, { type: 'button', label: node.label }) : undefined}
        >
          {node.icon !== undefined && <span aria-hidden>{node.icon} </span>}
          {node.label}
        </ClickFeedbackButton>
      )
    }
    case 'input': return <InputNode key={key} uiKey={uiKey} node={node} onAction={onAction} answers={answers} />
    case 'select': return <SelectNode key={key} uiKey={uiKey} node={node} onAction={onAction} answers={answers} />
    case 'checkbox': {
      const action = node.action
      return (
        <label key={key} className={css.checkbox}>
          <input
            type="checkbox"
            defaultChecked={node.checked === true}
            onChange={action !== undefined && onAction !== undefined
              ? e => onAction(action, { type: 'checkbox', checked: e.currentTarget.checked })
              : undefined}
          />
          <span>{node.label}</span>
        </label>
      )
    }
    case 'link': {
      // Honest affordance: with a whitelisted href this is a REAL anchor;
      // without one it is plain styled text (a dead clickable-looking button
      // was the same complaint class as the disabled-button fix).
      const href = node.href
      return href !== undefined
        ? <a key={key} className={css.link} href={href} target="_blank" rel="noopener noreferrer">{node.label}</a>
        : <span key={key} className={css.linkText}>{node.label}</span>
    }
    case 'audio': return <AudioNode key={`${key}:${node.src}`} node={node} />
    case 'video': return <VideoNode key={`${key}:${node.src}`} node={node} />
    case 'badge': {
      const tone = node.tone ?? ''
      return (
        <span key={key} className={`${css.badge} ${css[tone] || ''}`}>
          {node.icon !== undefined && <span aria-hidden>{node.icon} </span>}
          {node.label}
        </span>
      )
    }
    case 'stat': {
      const down = node.delta !== undefined && node.delta.startsWith('-')
      return (
        <div key={key} className={css.stat}>
          <span className={css.statLabel}>{node.label}</span>
          <span className={css.statValue}>{node.value}</span>
          {node.delta !== undefined && <span className={`${css.statDelta} ${down ? css.down : css.up}`}>{node.delta}</span>}
        </div>
      )
    }
    case 'progress': {
      const v = Math.max(0, Math.min(100, Number(node.value) || 0))
      return (
        <div
          key={key}
          className={css.progress}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={v}
          aria-label={node.label ?? node.valueLabel ?? undefined}
        >
          {(node.label !== undefined || node.valueLabel !== undefined) && (
            <div className={css.progressRow}>
              <span>{node.label}</span>
              {node.valueLabel !== undefined && <span>{node.valueLabel}</span>}
            </div>
          )}
          <div className={css.track}><div className={css.fill} style={{ width: `${v}%` }} /></div>
        </div>
      )
    }
    case 'divider': return <hr key={key} className={css.divider} />
    case 'list': {
      const items = node.items.slice(0, GENUI_LIMITS.maxListItems)
      return (
        <div key={key} className={css.list}>
          {items.map((item, i) => (
            <div key={i} className={css.li}>
              {isListItemNode(item)
                ? renderNode(item, i, onAction, depth + 1, answers, uiKey)
                : <><span className={css.liTitle}>{typeof item === 'string' ? item : item.title}</span>{typeof item !== 'string' && item.desc !== undefined && <span className={css.liDesc}>{item.desc}</span>}</>}
            </div>
          ))}
        </div>
      )
    }
    case 'table': return <TableNode key={key} uiKey={uiKey} node={node} answers={answers} />
    case 'chart': return <ChartNode key={key} chart={node} />
    case 'tabs': return <TabsNode key={key} uiKey={uiKey} tabs={node} onAction={onAction} depth={depth + 1} answers={answers} />
    case 'avatar': {
      return (
        <div key={key} className={css.avatar} style={{ background: node.color ?? avatarColor(node.name) }}>
          {node.name.slice(0, 1).toUpperCase()}
        </div>
      )
    }
    case 'spacer': return <div key={key} className={css.spacer} />
    case 'plot': return <PlotNode key={key} plot={node} />
    case 'callout': return <CalloutNode key={key} node={node} />
    case 'steps': return <StepsNode key={key} steps={node} />
    case 'keyvalue': return <KeyValueNode key={key} node={node} />
    case 'diff': return <DiffNode key={key} node={node} />
    case 'json': return <JsonNode key={key} node={node} />
    case 'code': return <CodeNode key={key} node={node} />
    case 'radio': return <RadioNode key={`${key}:r${answers?.round ?? 0}`} node={node} onAction={onAction} answers={answers} />
    case 'submit': return <SubmitNode key={key} node={node} onAction={onAction} answers={answers} />
    case 'switch': return <SwitchNode key={key} uiKey={uiKey} node={node} onAction={onAction} answers={answers} />
    case 'slider': return <SliderNode key={key} uiKey={uiKey} node={node} onAction={onAction} answers={answers} />
    case 'textarea': return <TextareaNode key={key} uiKey={uiKey} node={node} onAction={onAction} answers={answers} />
    case 'accordion': return <AccordionNode key={key} uiKey={uiKey} node={node} onAction={onAction} depth={depth + 1} answers={answers} />
    case 'copy': return <CopyNode key={key} node={node} />
    case 'mermaid': return <MermaidNode key={key} node={node} />
    case 'scene3d': return <Scene3DNode key={key} node={node} />
    case 'timeline': return <TimelineNode key={key} node={node} />
    case 'file-tree': return <FileTreeNode key={key} uiKey={uiKey} node={node} answers={answers} />
    case 'breadcrumb': return <BreadcrumbNode key={key} node={node} />
    case 'quiz': return <QuizNode key={key} uiKey={uiKey} node={node} onAction={onAction} answers={answers} />
    case 'diagram': return <DiagramNode key={key} node={node} />

    case 'echart': return <EChartNode key={key} node={node} />
    // CGUI-PATCH: 删掉插件自定义组件注册表(上游经宿主 primitives 的
    // getGenuiComponent 查表)。CC-GUI 无插件层,白名单外的 type 一律不渲染
    // (INTERFACE §5.2:被丢弃、兄弟照常、底部计入"已忽略")。
    // 立场:**本地不新增组件类型** —— 要新类型先往上游提,或明确接受本文件转 fork。
    default: return null
  }
}

/* ---------------- v1.1 nodes ---------------- */
