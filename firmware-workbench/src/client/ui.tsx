/** 通用 UI 组件(设计文档 §7):图标、芯片、KPI、卡片、空状态、终端、Toast。 */

import { useEffect, useRef, useState } from 'react'
import { STATUS_LABELS, timeShort, type DemoLogLine, type EventView } from './model.js'

// ---------- 图标(Feather 风格内联 SVG) ----------

const ICON_PATHS: Record<string, string> = {
  play: 'M6 4l14 8-14 8z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  gauge: 'M12 13l4-6M4.5 18a9 9 0 1115 0',
  'git-branch': 'M6 3v12M6 21a3 3 0 100-6 3 3 0 000 6zM18 9a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9',
  'shield-check': 'M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6zM9 12l2 2 4-4',
  flask: 'M9 3h6M10 3v5l-5.5 9A2 2 0 006.2 20h11.6a2 2 0 001.7-3L14 8V3M7.5 14h9',
  box: 'M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5zM3.5 7.5L12 12l8.5-4.5M12 12v9',
  printer: 'M7 8V3h10v5M5 8h14a1 1 0 011 1v6a1 1 0 01-1 1h-2M5 8a1 1 0 00-1 1v6a1 1 0 001 1h2M7 13h10v8H7zM17 11h.01',
  refresh: 'M21 12a9 9 0 11-2.6-6.4M21 3v6h-6',
  chevron: 'M9 5l7 7-7 7',
  x: 'M5 5l14 14M19 5L5 19',
  alert: 'M12 3l10 18H2zM12 10v4M12 17.5h.01',
  'file-text': 'M6 2h9l5 5v15H6zM14 2v6h6M9 12h6M9 16h6',
  download: 'M12 3v12M7 11l5 5 5-5M4 21h16',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 3',
  check: 'M4 12l6 6L20 6',
  'skip-forward': 'M5 4l10 8-10 8zM19 4v16',
  'rotate-ccw': 'M3 12a9 9 0 102.6-6.4M3 3v6h6',
  zap: 'M13 2L4 14h6l-1 8 9-12h-6z',
}

export function Icon(props: { name: string; size?: number }): React.JSX.Element {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: 'none' }}
      aria-hidden
    >
      <path d={ICON_PATHS[props.name] ?? ICON_PATHS.alert} />
    </svg>
  )
}

// ---------- 状态着色 ----------

const KNOWN_STATUSES = new Set([
  'succeeded', 'running', 'verifying', 'ready', 'reserved', 'blocked_dependency', 'blocked_gate',
  'blocked_resource', 'quarantined', 'failed_product', 'failed_test', 'failed_infra', 'invalid',
  'cancelled', 'planned', 'draft', 'maintenance', 'available', 'busy', 'reserved_state',
  'PASS', 'PRODUCT_FAIL', 'TEST_FAIL', 'INFRA_FAIL', 'BLOCKED_RESOURCE', 'INVALID', 'FLAKY', 'WAIVED',
  'L1', 'L4',
])

function statusVar(status: string): string {
  return KNOWN_STATUSES.has(status) ? `var(--wb-st-${status})` : 'var(--wb-st-planned)'
}

export function statusColor(status: string): string {
  return statusVar(status)
}

export function StatusChip(props: { status: string; label?: string }): React.JSX.Element {
  const label = props.label ?? STATUS_LABELS[props.status] ?? props.status
  const style = { '--wb-st-c': statusVar(props.status) } as React.CSSProperties
  return (
    <span className="wb-chip" style={style}>
      {label}
    </span>
  )
}

export function StatusDot(props: { status: string; size?: number }): React.JSX.Element {
  const style = { background: statusVar(props.status), width: props.size ?? 8, height: props.size ?? 8 } as React.CSSProperties
  return <span className="wb-dot" style={style} />
}

// ---------- 卡片与布局 ----------

export function Card(props: { title?: string; sub?: string; actions?: React.ReactNode; flush?: boolean; children: React.ReactNode; style?: React.CSSProperties }): React.JSX.Element {
  return (
    <div className="wb-card" style={props.style}>
      {props.title && (
        <div className="wb-card__head">
          {props.title}
          {props.sub && <span className="wb-card__head-sub">{props.sub}</span>}
          <span style={{ flex: 1 }} />
          {props.actions}
        </div>
      )}
      <div className={props.flush ? 'wb-card__body wb-card__body--flush' : 'wb-card__body'}>{props.children}</div>
    </div>
  )
}

export function ViewHead(props: { title: string; sub?: string; actions?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="wb-view__head">
      <h2 className="wb-view__title">{props.title}</h2>
      {props.sub && <span className="wb-view__sub">{props.sub}</span>}
      <span className="wb-view__spacer" />
      {props.actions}
    </div>
  )
}

export function KpiCard(props: { label: string; value: React.ReactNode; sub?: string; tone?: 'ok' | 'warn' | 'run'; onClick?: () => void }): React.JSX.Element {
  return (
    <div className={`wb-kpi${props.tone ? ` wb-kpi--${props.tone}` : ''}`} onClick={props.onClick} style={props.onClick ? { cursor: 'pointer' } : undefined}>
      <div className="wb-kpi__label">{props.label}</div>
      <div className="wb-kpi__value">{props.value}</div>
      {props.sub && <div className="wb-kpi__sub">{props.sub}</div>}
    </div>
  )
}

export function EmptyState(props: { icon?: string; title: string; hint?: string; actionLabel?: string; onAction?: () => void }): React.JSX.Element {
  return (
    <div className="wb-empty">
      <div className="wb-empty__icon">
        <Icon name={props.icon ?? 'box'} size={28} />
      </div>
      <div className="wb-empty__title">{props.title}</div>
      {props.hint && <div className="wb-empty__hint">{props.hint}</div>}
      {props.actionLabel && props.onAction && (
        <button className="wb-btn wb-btn--primary" onClick={props.onAction}>
          {props.actionLabel}
        </button>
      )}
    </div>
  )
}

// ---------- 终端日志 ----------

export function Terminal(props: { lines: DemoLogLine[]; height?: number; autoScroll?: boolean }): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  useEffect(() => {
    const box = boxRef.current
    if (box && stickRef.current) box.scrollTop = box.scrollHeight
  }, [props.lines])
  return (
    <div
      className="wb-term"
      ref={boxRef}
      style={{ height: props.height ?? 200 }}
      onScroll={event => {
        const el = event.currentTarget
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      {props.lines.length === 0 && <div className="wb-term__line wb-faint">等待输出…</div>}
      {props.lines.map((line, index) => (
        <div key={index} className={`wb-term__line wb-term__line--${line.level}`}>
          <span className="wb-term__ts">{timeShort(line.ts)}</span>
          <span className="wb-term__lv">{line.level === 'error' ? '✗' : line.level === 'warn' ? '!' : '›'}</span>
          <span>{line.text}</span>
        </div>
      ))}
    </div>
  )
}

// ---------- 事件时间线 ----------

export function ActivityFeed(props: { events: EventView[]; limit?: number }): React.JSX.Element {
  const items = props.events.slice(-(props.limit ?? 30)).reverse()
  if (items.length === 0) return <div className="wb-faint" style={{ fontSize: 12 }}>暂无活动</div>
  return (
    <div className="wb-tl">
      {items.map(event => {
        const kind = event.kind ?? ''
        const tone =
          kind.includes('error') || kind.includes('fail')
            ? 'var(--wb-st-failed_product)'
            : kind.includes('succeeded') || kind.includes('complete') || kind.includes('done')
              ? 'var(--wb-st-succeeded)'
              : kind.startsWith('sim.') || kind.startsWith('demo')
                ? 'var(--wb-st-running)'
                : 'var(--wb-text-3)'
        return (
          <div key={event.id} className="wb-tl__item">
            <span className="wb-tl__dot wb-dot" style={{ background: tone }} />
            <span className="wb-tl__time">{timeShort(event.ts)}</span>
            <span className="wb-tl__kind">{event.kind}</span>
            <span className="wb-muted" style={{ fontSize: 12 }}>
              {summarizeEvent(event)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function summarizeEvent(event: EventView): string {
  const payload = event.payload ?? {}
  if (typeof payload.taskId === 'string') return payload.taskId
  if (typeof payload.id === 'string' && payload.title) return `${payload.id} ${payload.title}`
  if (typeof payload.requirement === 'string') return payload.requirement
  const text = JSON.stringify(payload)
  return text.length > 90 ? `${text.slice(0, 90)}…` : text
}

// ---------- Toast ----------

export function useToast(): { toast: string | null; show: (text: string) => void } {
  const [toast, setToast] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const show = (text: string): void => {
    setToast(text)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(null), 2600)
  }
  return { toast, show }
}

export function Toast(props: { text: string | null }): React.JSX.Element | null {
  if (!props.text) return null
  return <div className="wb-toast">{props.text}</div>
}
