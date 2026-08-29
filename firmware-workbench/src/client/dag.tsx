/** 任务 DAG 可视化(设计文档 §5.2):拓扑分层 + 贝塞尔边 + 关键路径描边 + 详情侧栏。 */

import { useMemo, useState } from 'react'
import type { TaskView } from './model.js'
import { STATUS_LABELS, timeShort } from './model.js'
import { Icon, StatusChip, StatusDot, statusColor } from './ui.js'

interface LayoutNode {
  task: TaskView
  layer: number
  x: number
  y: number
}

const NODE_W = 150
const NODE_H = 44
const GAP_X = 24
const GAP_Y = 66

/** 简化 Sugiyama:层号 = 最长上游路径;同层按 id 排序均布 */
function layout(tasks: TaskView[]): Map<string, LayoutNode> {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const layerCache = new Map<string, number>()

  const layerOf = (id: string, visiting: Set<string>): number => {
    const cached = layerCache.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0
    visiting.add(id)
    const task = byId.get(id)
    let layer = 0
    if (task) {
      for (const dep of task.dependencies ?? []) {
        if ((dep.kind === 'hard_after' || dep.kind === 'soft_after') && byId.has(dep.ref)) {
          layer = Math.max(layer, layerOf(dep.ref, visiting) + 1)
        }
      }
    }
    visiting.delete(id)
    layerCache.set(id, layer)
    return layer
  }

  for (const task of tasks) layerOf(task.id, new Set())

  const nodes = new Map<string, LayoutNode>()
  const byLayer = new Map<number, TaskView[]>()
  for (const task of tasks) {
    const layer = layerCache.get(task.id) ?? 0
    if (!byLayer.has(layer)) byLayer.set(layer, [])
    byLayer.get(layer)!.push(task)
  }
  for (const [layer, members] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    members.sort((a, b) => a.id.localeCompare(b.id))
    members.forEach((task, index) => {
      nodes.set(task.id, {
        task,
        layer,
        x: index * (NODE_W + GAP_X),
        y: layer * (NODE_H + GAP_Y),
      })
    })
  }
  return nodes
}

function bezier(from: LayoutNode, to: LayoutNode): string {
  const x1 = from.x + NODE_W / 2
  const y1 = from.y + NODE_H
  const x2 = to.x + NODE_W / 2
  const y2 = to.y
  const mid = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`
}

export function TaskDag(props: {
  tasks: TaskView[]
  criticalIds: string[]
  selectedId?: string
  onSelect?: (id: string) => void
  onRun?: (id: string) => void
  onRelease?: (id: string) => void
  mini?: boolean
  height?: number
}): React.JSX.Element {
  const nodes = useMemo(() => layout(props.tasks), [props.tasks])
  const [hoverId, setHoverId] = useState<string | null>(null)

  const critical = new Set(props.criticalIds)
  const taskById = new Map(props.tasks.map(task => [task.id, task]))

  const width = Math.max(...[...nodes.values()].map(node => node.x), 0) + NODE_W + 32
  const height = Math.max(...[...nodes.values()].map(node => node.y), 0) + NODE_H + 24
  const scale = props.mini ? Math.min(1, 760 / width) : 1

  const edges: Array<{ key: string; d: string; critical: boolean; from: string; to: string }> = []
  for (const node of nodes.values()) {
    for (const dep of node.task.dependencies ?? []) {
      if (dep.kind !== 'hard_after' && dep.kind !== 'soft_after') continue
      const from = nodes.get(dep.ref)
      if (!from) continue
      edges.push({
        key: `${dep.ref}->${node.task.id}`,
        d: bezier(from, node),
        critical: critical.has(dep.ref) && critical.has(node.task.id),
        from: dep.ref,
        to: node.task.id,
      })
    }
  }

  const dimmed = (id: string): boolean => hoverId !== null && hoverId !== id && !isNeighbor(id, hoverId)

  function isNeighbor(id: string, hover: string): boolean {
    const task = taskById.get(hover)
    if (!task) return false
    if ((task.dependencies ?? []).some(dep => dep.ref === id)) return true
    const self = taskById.get(id)
    return !!self?.dependencies?.some(dep => dep.ref === hover)
  }

  const empty = props.tasks.length === 0
  const svgWidth = props.mini ? Math.max(width * scale, 320) : width

  return (
    <div className="wb-dag-canvas" style={{ height: props.height ?? 560 }}>
      {empty ? (
        <div className="wb-empty" style={{ paddingTop: 80 }}>
          <div className="wb-empty__title">还没有任务</div>
          <div className="wb-empty__hint">到演示中心点击"开始完整演示",或用 fwctl demo-seed 装载 MVP 种子</div>
        </div>
      ) : (
        <svg width="100%" height={props.mini ? height * scale : undefined} viewBox={`0 0 ${svgWidth} ${height * scale}`} style={{ display: 'block' }}>
          <g transform={props.mini ? `scale(${scale})` : undefined}>
            {edges.map(edge => (
              <path
                key={edge.key}
                className={`wb-dag__edge${edge.critical ? ' wb-dag__edge--critical' : ''}`}
                d={edge.d}
                opacity={hoverId && !(edge.from === hoverId || edge.to === hoverId) ? 0.35 : 1}
              />
            ))}
            {[...nodes.values()].map(node => {
              const status = node.task.status
              const isBlocked = status.startsWith('blocked_')
              const dim = dimmed(node.task.id)
              return (
                <g
                  key={node.task.id}
                  className={`wb-dag__node${critical.has(node.task.id) ? ' wb-dag__node--critical' : ''}${
                    props.selectedId === node.task.id ? ' wb-dag__node--selected' : ''
                  }`}
                  transform={`translate(${node.x + 16}, ${node.y + 12})`}
                  opacity={dim ? 0.35 : 1}
                  onClick={() => props.onSelect?.(node.task.id)}
                  onMouseEnter={() => setHoverId(node.task.id)}
                  onMouseLeave={() => setHoverId(null)}
                >
                  <rect className="body" width={NODE_W} height={NODE_H} rx={8} />
                  <rect width={3} height={NODE_H} rx={1.5} fill={statusColor(status)} />
                  <text x={12} y={17} fontFamily="var(--wb-font-mono)" fontSize={10} fill="var(--wb-text-2)">
                    {node.task.id.replace('TASK-COPY-', 'TC-')}
                  </text>
                  <text x={12} y={32} fontSize={11} fill="var(--wb-text-1)">
                    {node.task.title.length > 14 ? `${node.task.title.slice(0, 14)}…` : node.task.title}
                  </text>
                  {isBlocked && (
                    <text x={NODE_W - 16} y={15} fontSize={10} fill={statusColor(status)}>
                      ⚠
                    </text>
                  )}
                  <text x={NODE_W - 12} y={32} textAnchor="end" fontFamily="var(--wb-font-mono)" fontSize={9} fill="var(--wb-text-3)">
                    {status === 'succeeded' ? '✓' : `${node.task.estimateMinutes ?? 30}m`}
                  </text>
                </g>
              )
            })}
          </g>
        </svg>
      )}
    </div>
  )
}

export function DagLegend(): React.JSX.Element {
  const items = ['succeeded', 'running', 'ready', 'blocked_dependency', 'blocked_gate', 'blocked_resource', 'planned']
  return (
    <div className="wb-dag__legend">
      {items.map(status => (
        <span key={status} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <StatusDot status={status} />
          {STATUS_LABELS[status] ?? status}
        </span>
      ))}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--wb-accent)' }}>
        <Icon name="zap" size={12} /> 关键路径
      </span>
    </div>
  )
}

export function TaskDetailPanel(props: {
  task: TaskView | null
  taskById: Map<string, TaskView>
  events: Array<{ ts: string; kind: string; payload: Record<string, unknown> }>
  onRun: (id: string) => void
  onRelease: (id: string) => void
  running: boolean
}): React.JSX.Element | null {
  if (!props.task) {
    return (
      <div className="wb-side">
        <Empty title="点击节点查看详情" hint="依赖、资源、阻塞原因与最近日志" />
      </div>
    )
  }
  const task = props.task
  const runnable = ['ready', 'planned', 'blocked_dependency', 'blocked_gate', 'blocked_resource'].includes(task.status)
  const active = ['reserved', 'running', 'verifying'].includes(task.status)
  const taskEvents = props.events
    .filter(event => JSON.stringify(event.payload ?? {}).includes(task.id))
    .slice(-8)
    .reverse()
  return (
    <div className="wb-side">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span className="wb-mono" style={{ fontWeight: 600 }}>{task.id}</span>
        <StatusChip status={task.status} />
      </div>
      <div style={{ fontSize: 13, marginBottom: 12 }}>{task.title}</div>

      {task.blockedReason && <div className="wb-banner" style={{ marginBottom: 12 }}>{task.blockedReason}</div>}
      {task.note && <div className="wb-faint" style={{ fontSize: 11, marginBottom: 12 }}>{task.note}</div>}

      <div className="wb-side__section">
        <div className="wb-side__title">依赖</div>
        {(task.dependencies ?? []).length === 0 && <div className="wb-faint" style={{ fontSize: 12 }}>无</div>}
        {(task.dependencies ?? []).map((dep, index) => {
          const depTask = props.taskById.get(dep.ref)
          return (
            <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 2 }}>
              {depTask && <StatusDot status={depTask.status} />}
              <span className="wb-mono">{dep.ref}</span>
              <span className="wb-faint">{dep.kind}</span>
            </div>
          )
        })}
      </div>

      <div className="wb-side__section">
        <div className="wb-side__title">资源需求</div>
        {(task.resources ?? []).length === 0 && <div className="wb-faint" style={{ fontSize: 12 }}>无</div>}
        {(task.resources ?? []).map((res, index) => (
          <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 2 }}>
            <span className="wb-mono">{res.id}</span>
            <span className="wb-faint">{res.mode ?? ''} {res.units ? `×${res.units}` : ''} {res.action ?? ''}</span>
          </div>
        ))}
      </div>

      <div className="wb-side__section">
        <div className="wb-side__title">执行信息</div>
        <div className="wb-faint" style={{ fontSize: 11, lineHeight: 1.8 }}>
          类型 {task.type} · 估值 {task.estimateMinutes ?? 30}m · 尝试 {task.attempts} 次
          <br />
          创建 {timeShort(task.createdAt)}
          {task.startedAt ? ` · 开始 ${timeShort(task.startedAt)}` : ''}
          {task.finishedAt ? ` · 结束 ${timeShort(task.finishedAt)}` : ''}
        </div>
      </div>

      {taskEvents.length > 0 && (
        <div className="wb-side__section">
          <div className="wb-side__title">最近日志</div>
          {taskEvents.map((event, index) => (
            <div key={index} className="wb-faint" style={{ fontSize: 11, marginBottom: 2 }}>
              <span className="wb-mono">{timeShort(event.ts)}</span> {event.kind}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {runnable && (
          <button className="wb-btn wb-btn--primary" disabled={props.running} onClick={() => props.onRun(task.id)}>
            <Icon name="play" size={12} /> 运行此任务
          </button>
        )}
        {active && (
          <button className="wb-btn" disabled={props.running} onClick={() => props.onRelease(task.id)}>
            释放租约
          </button>
        )}
      </div>
    </div>
  )
}

function Empty(props: { title: string; hint: string }): React.JSX.Element {
  return (
    <div className="wb-empty" style={{ padding: '60px 12px' }}>
      <div className="wb-empty__title">{props.title}</div>
      <div className="wb-empty__hint">{props.hint}</div>
    </div>
  )
}
