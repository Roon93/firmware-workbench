import type { Dependency, Task, TaskStatus } from '../types.js'
import { TASK_TERMINAL_STATUSES } from '../types.js'

/**
 * 任务 DAG:依赖校验、可运行判定、关键路径与 Ready 队列(方案 8.3-8.6)。
 * 本模块是纯函数集合,不直接访问数据库;由 workbench 层组装上下文后调用。
 */

export interface DagContext {
  /** 全部任务(含终态) */
  tasks: Task[]
  /** 已冻结的契约引用,形如 "IF-JOB-MANAGER-v2" */
  frozenContracts: ReadonlySet<string>
  /** 已批准的门禁 id */
  approvedGates: ReadonlySet<string>
  /** 已产生的产物名(由已完成任务的 outputs 提供) */
  producedArtifacts: ReadonlySet<string>
  /** 可用数据(样本、Golden 数据等) */
  availableData: ReadonlySet<string>
  /** 资源可得性回调:返回 null 表示全部可得,否则给出阻塞原因 */
  resourceBlocker?: (task: Task) => string | null
}

export interface Blocker {
  kind: 'dependency' | 'gate' | 'contract' | 'artifact' | 'data' | 'resource'
  reason: string
}

export interface RunnableVerdict {
  runnable: boolean
  blockers: Blocker[]
}

/** 任务是否处于终态(方案 8.5) */
export function isTerminal(status: TaskStatus): boolean {
  return TASK_TERMINAL_STATUSES.includes(status)
}

/** 依赖中引用的前置任务 id */
export function predecessorIds(task: Task): string[] {
  return (task.dependencies ?? [])
    .filter(dep => dep.kind === 'hard_after' || dep.kind === 'soft_after')
    .map(dep => dep.ref)
}

/** 校验依赖图:引用存在、无循环。返回错误列表;空数组表示通过 */
export function validateDag(tasks: Task[]): string[] {
  const errors: string[] = []
  const byId = new Map(tasks.map(task => [task.id, task]))

  for (const task of tasks) {
    for (const dep of task.dependencies ?? []) {
      if (dep.kind === 'hard_after' || dep.kind === 'soft_after') {
        if (!byId.has(dep.ref)) {
          errors.push(`${task.id}: ${dep.kind} 引用了不存在的任务 ${dep.ref}`)
        }
      } else if (dep.kind === 'contract_requires') {
        if (!dep.ref.includes('@')) {
          errors.push(`${task.id}: contract_requires 引用必须形如 名称@版本,收到 ${dep.ref}`)
        }
      } else if (!dep.ref) {
        errors.push(`${task.id}: ${dep.kind} 依赖缺少引用`)
      }
    }
  }

  // 循环检测:从每个节点出发沿 hard/soft 边做 DFS 染色
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>(tasks.map(task => [task.id, WHITE]))

  const visit = (id: string, stack: string[]): void => {
    color.set(id, GRAY)
    const task = byId.get(id)
    for (const next of task ? predecessorIds(task) : []) {
      if (!byId.has(next)) continue
      const state = color.get(next)
      if (state === GRAY) {
        errors.push(`依赖循环: ${[...stack, id, next].join(' -> ')}`)
      } else if (state === WHITE) {
        visit(next, [...stack, id])
      }
    }
    color.set(id, BLACK)
  }
  for (const task of tasks) {
    if (color.get(task.id) === WHITE) visit(task.id, [])
  }

  return errors
}

/**
 * 可运行判定(方案 8.4):
 * 所有 hard_after 已成功 AND 产物存在 AND 契约已冻结 AND 门禁已批准
 * AND 资源能够获得 AND 任务未被取消或隔离。
 */
export function evaluateRunnable(task: Task, ctx: DagContext): RunnableVerdict {
  const blockers: Blocker[] = []
  const byId = new Map(ctx.tasks.map(item => [item.id, item]))

  for (const dep of task.dependencies ?? []) {
    switch (dep.kind) {
      case 'hard_after': {
        const predecessor = byId.get(dep.ref)
        if (!predecessor || predecessor.status !== 'succeeded') {
          blockers.push({
            kind: 'dependency',
            reason: `前置任务 ${dep.ref} 未完成(当前 ${predecessor?.status ?? '缺失'})`,
          })
        }
        break
      }
      case 'artifact_requires': {
        if (!ctx.producedArtifacts.has(dep.ref)) {
          blockers.push({ kind: 'artifact', reason: `产物 ${dep.ref} 尚未产生` })
        }
        break
      }
      case 'contract_requires': {
        if (!ctx.frozenContracts.has(dep.ref)) {
          blockers.push({ kind: 'contract', reason: `契约 ${dep.ref} 未冻结` })
        }
        break
      }
      case 'gate_requires': {
        if (!ctx.approvedGates.has(dep.ref)) {
          blockers.push({ kind: 'gate', reason: `门禁 ${dep.ref} 未批准` })
        }
        break
      }
      case 'data_requires': {
        if (!ctx.availableData.has(dep.ref)) {
          blockers.push({ kind: 'data', reason: `数据 ${dep.ref} 不可用` })
        }
        break
      }
      case 'soft_after': {
        // 推荐顺序,不阻塞(方案 8.3)
        break
      }
    }
  }

  if (ctx.resourceBlocker) {
    const reason = ctx.resourceBlocker(task)
    if (reason) blockers.push({ kind: 'resource', reason })
  }

  return { runnable: blockers.length === 0, blockers }
}

/** 关键路径:按 hard/soft 依赖边求最长加权路径(权重 = estimateMinutes,缺省 30) */
export function computeCriticalPath(tasks: Task[]): { ids: string[]; totalMinutes: number } {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const duration = (task: Task): number => task.estimateMinutes ?? 30

  // 只统计未完成任务;已完成任务视作 0 成本,使关键路径反映剩余工作
  const memo = new Map<string, { ids: string[]; total: number }>()

  const best = (id: string, visiting: Set<string>): { ids: string[]; total: number } => {
    const cached = memo.get(id)
    if (cached) return cached
    if (visiting.has(id)) return { ids: [id], total: 0 }
    visiting.add(id)

    const task = byId.get(id)
    let bestTail: { ids: string[]; total: number } = { ids: [], total: 0 }
    if (task && !isTerminal(task.status)) {
      for (const depId of predecessorIds(task)) {
        if (!byId.has(depId)) continue
        const tail = best(depId, visiting)
        if (tail.total > bestTail.total) bestTail = tail
      }
    }
    const result = {
      ids: task && !isTerminal(task.status) ? [...bestTail.ids, id] : bestTail.ids,
      total: bestTail.total + (task && !isTerminal(task.status) ? duration(task) : 0),
    }
    visiting.delete(id)
    memo.set(id, result)
    return result
  }

  let winner: { ids: string[]; total: number } = { ids: [], total: 0 }
  for (const task of tasks) {
    const candidate = best(task.id, new Set())
    if (candidate.total > winner.total) winner = candidate
  }
  return { ids: winner.ids, totalMinutes: winner.total }
}

/** 拓扑深度:越浅(被依赖越多)越优先解锁下游 */
export function downstreamCount(taskId: string, tasks: Task[]): number {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const seen = new Set<string>([taskId])
  const queue = [taskId]
  let count = 0
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const task of byId.values()) {
      if (seen.has(task.id)) continue
      if (predecessorIds(task).includes(current)) {
        seen.add(task.id)
        queue.push(task.id)
        count += 1
      }
    }
  }
  return count
}

export interface ReadyEntry {
  task: Task
  score: number
  onCriticalPath: boolean
}

/**
 * Ready 队列与调度优先级(方案 8.6):
 * 1) 发布阻塞与安全缺陷(通过 priority 字段与 note 表达,high 权重最高)
 * 2) 位于关键路径
 * 3) 能解锁更多下游任务
 * 4) aging:等待越久分数越高
 * 5) 批量执行与普通功能在同类内按创建时间排序
 */
export function computeReadyQueue(ctx: DagContext, now: string): ReadyEntry[] {
  const critical = new Set(computeCriticalPath(ctx.tasks).ids)
  const entries: ReadyEntry[] = []

  for (const task of ctx.tasks) {
    if (isTerminal(task.status)) continue
    if (task.status === 'reserved' || task.status === 'running' || task.status === 'verifying') continue
    // Runnable 判定包含资源可得性(方案 8.4):资源阻塞的任务留在队列外等待调度
    const verdict = evaluateRunnable(task, ctx)
    if (!verdict.runnable) continue

    const downstream = downstreamCount(task.id, ctx.tasks)
    const waitingMs = Math.max(0, Date.parse(now) - Date.parse(task.createdAt))
    const waitingHours = waitingMs / 3_600_000
    const score =
      (task.priority === 'high' ? 1000 : task.priority === 'medium' ? 500 : 100) +
      (critical.has(task.id) ? 400 : 0) +
      downstream * 20 +
      Math.min(waitingHours * 2, 200)

    entries.push({ task, score, onCriticalPath: critical.has(task.id) })
  }

  entries.sort((a, b) => b.score - a.score || a.task.createdAt.localeCompare(b.task.createdAt))
  return entries
}

/** 任务状态机合法迁移(方案 8.5):非法迁移抛错,防止状态被随意改写 */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ['planned', 'cancelled'],
  planned: ['blocked_dependency', 'blocked_gate', 'blocked_resource', 'ready', 'reserved', 'cancelled', 'quarantined'],
  blocked_dependency: ['planned', 'blocked_gate', 'blocked_resource', 'ready', 'reserved', 'cancelled'],
  blocked_gate: ['planned', 'blocked_dependency', 'blocked_resource', 'ready', 'reserved', 'cancelled'],
  blocked_resource: ['planned', 'blocked_dependency', 'blocked_gate', 'ready', 'reserved', 'cancelled'],
  ready: ['reserved', 'blocked_resource', 'cancelled', 'quarantined'],
  reserved: ['running', 'ready', 'cancelled'],
  running: ['verifying', 'failed_product', 'failed_test', 'failed_infra', 'cancelled'],
  verifying: ['succeeded', 'failed_product', 'failed_test', 'failed_infra'],
  // 返工例外(提案 §3.2 变更传导):需求变更把已完成任务标 stale 回 planned,由变更记录留痕
  succeeded: ['planned'],
  failed_product: ['planned', 'quarantined'],
  failed_test: ['planned', 'quarantined'],
  failed_infra: ['planned', 'quarantined'],
  invalid: ['planned', 'cancelled'],
  cancelled: [],
  quarantined: ['planned'],
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  const allowed = TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new Error(`非法任务状态迁移: ${from} -> ${to}(允许: ${allowed.join(', ') || '无'})`)
  }
}

export function hasDependency(task: Task, kind: Dependency['kind'], ref: string): boolean {
  return (task.dependencies ?? []).some(dep => dep.kind === kind && dep.ref === ref)
}
