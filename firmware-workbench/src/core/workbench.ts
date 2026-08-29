import type {
  Task,
  TaskDefinition,
  TaskFailureClass,
  TaskStatus,
  LeaseRequirement,
  TestRunRecord,
  Resource,
} from '../types.js'
import { isTerminal } from './dag.js'
import {
  assertTransition,
  computeCriticalPath,
  computeReadyQueue,
  evaluateRunnable,
  validateDag,
  type Blocker,
} from './dag.js'
import type { WorkbenchStore } from './store.js'
import { acquireLeases, getResource, listLeases, releaseTaskLeases, sweepExpiredLeases } from './resources.js'
import { listContracts, listGates } from './contract.js'

/**
 * Workbench 编排层:任务生命周期(方案 8.1/8.4/8.5)。
 * 把 DAG 判定、资源租约与状态机组装为统一入口,DSH 工具与 fwctl 都走这里。
 */

/** 模块级测试运行查询:acceptance 等模块复用 */
export function listTestRuns(store: WorkbenchStore): TestRunRecord[] {
  const rows = store.db.prepare('SELECT * FROM test_runs ORDER BY started_at DESC').all() as Array<
    Record<string, unknown>
  >
  return rows.map(row => ({
    id: row.id as string,
    caseId: row.case_id as string,
    taskId: (row.task_id as string) ?? undefined,
    level: row.level as TestRunRecord['level'],
    firmwareSha: (row.firmware_sha as string) ?? undefined,
    result: row.result as TestRunRecord['result'],
    message: (row.message as string) ?? undefined,
    evidenceId: (row.evidence_id as string) ?? undefined,
    startedAt: row.started_at as string,
    finishedAt: row.finished_at as string,
  }))
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    type: row.type as Task['type'],
    title: row.title as string,
    requirementRefs: JSON.parse(row.requirement_refs as string),
    acceptanceRefs: JSON.parse(row.acceptance_refs as string),
    dependencies: JSON.parse(row.dependencies as string),
    inputs: JSON.parse(row.inputs as string),
    outputs: JSON.parse(row.outputs as string),
    resources: JSON.parse(row.resources as string),
    actions: JSON.parse(row.actions as string),
    policy: JSON.parse(row.policy as string),
    evidence: JSON.parse(row.evidence as string),
    owner: (row.owner as string) ?? undefined,
    estimateMinutes: (row.estimate_minutes as number) ?? undefined,
    priority: (row.priority as Task['priority']) ?? undefined,
    note: (row.note as string) ?? undefined,
    status: row.status as TaskStatus,
    blockedReason: (row.blocked_reason as string) ?? undefined,
    staleReason: (row.stale_reason as string) ?? undefined,
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string) ?? undefined,
    finishedAt: (row.finished_at as string) ?? undefined,
    attempts: row.attempts as number,
    lastResult: (row.last_result as TaskFailureClass) ?? undefined,
  }
}

export class Workbench {
  constructor(readonly store: WorkbenchStore) {}

  // ---------- 任务创建与查询 ----------

  createTask(def: TaskDefinition, actor = 'planner'): Task {
    const probe = { ...def, id: def.id ?? 'PROBE', status: 'planned' as TaskStatus, createdAt: this.store.now(), attempts: 0 }
    const all = [...this.listTasks(), probe]
    const errors = validateDag(all)
    if (errors.length > 0) throw new Error(`任务定义未通过 DAG 校验: ${errors.join('; ')}`)

    const now = this.store.now()
    let id = def.id
    if (!id) {
      const seq = Number(this.store.getMeta('task.seq') ?? '0') + 1
      this.store.setMeta('task.seq', String(seq))
      const prefix = def.requirementRefs?.[0]?.replace(/^REQ-/, 'TASK-') ?? 'TASK'
      id = `${prefix}-${String(seq).padStart(4, '0')}`
    }

    this.store.db
      .prepare(
        `INSERT INTO tasks (id, type, title, requirement_refs, acceptance_refs, dependencies, inputs, outputs,
           resources, actions, policy, evidence, owner, estimate_minutes, priority, note, status, created_at, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, 0)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, dependencies = excluded.dependencies,
           resources = excluded.resources, actions = excluded.actions, note = excluded.note`,
      )
      .run(
        id,
        def.type,
        def.title,
        JSON.stringify(def.requirementRefs ?? []),
        JSON.stringify(def.acceptanceRefs ?? []),
        JSON.stringify(def.dependencies ?? []),
        JSON.stringify(def.inputs ?? []),
        JSON.stringify(def.outputs ?? []),
        JSON.stringify(def.resources ?? []),
        JSON.stringify(def.actions ?? {}),
        JSON.stringify(def.policy ?? {}),
        JSON.stringify(def.evidence ?? []),
        def.owner ?? null,
        def.estimateMinutes ?? null,
        def.priority ?? null,
        def.note ?? null,
        now,
      )
    this.store.appendEvent(actor, 'task.create', { id, type: def.type, title: def.title })
    return this.getTask(id) as Task
  }

  getTask(id: string): Task | undefined {
    const row = this.store.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToTask(row) : undefined
  }

  listTasks(): Task[] {
    const rows = this.store.db.prepare('SELECT * FROM tasks ORDER BY created_at, id').all() as Array<
      Record<string, unknown>
    >
    return rows.map(rowToTask)
  }

  // ---------- 上下文组装 ----------

  private producedArtifacts(): Set<string> {
    const rows = this.store.db.prepare('SELECT name FROM artifacts').all() as Array<{ name: string }>
    return new Set(rows.map(row => row.name))
  }

  private frozenContracts(): Set<string> {
    return new Set(
      listContracts(this.store)
        .filter(contract => contract.status === 'frozen')
        .map(contract => `${contract.name}@${contract.version}`),
    )
  }

  private approvedGates(): Set<string> {
    return new Set(
      listGates(this.store)
        .filter(gate => gate.decision === 'approved')
        .map(gate => gate.id),
    )
  }

  /** 只读检查:任务声明的资源当前是否全部可得(不建立租约) */
  private resourceBlocker(): (task: Task) => string | null {
    return task => {
      for (const req of task.resources ?? []) {
        const res = getResource(this.store, req.id)
        if (!res) return `资源 ${req.id} 不存在`
        if (res.state === 'quarantined') return `资源 ${req.id} 已隔离: ${res.quarantineReason ?? ''}`
        if (res.state === 'maintenance') return `资源 ${req.id} 维护中`
        if (res.mode === 'capacity') {
          if (res.busyUnits + (req.units ?? 1) > res.units) return `资源 ${req.id} 容量不足`
        } else if (res.busyUnits > 0) {
          return `资源 ${req.id} 被其他租约占用`
        }
      }
      return null
    }
  }

  private dagContext(tasks: Task[]) {
    return {
      tasks,
      frozenContracts: this.frozenContracts(),
      approvedGates: this.approvedGates(),
      producedArtifacts: this.producedArtifacts(),
      availableData: new Set<string>(),
      resourceBlocker: this.resourceBlocker(),
    }
  }

  // ---------- 状态刷新(方案 8.5:区分依赖/门禁/资源阻塞) ----------

  refreshStates(actor = 'system'): Array<{ id: string; from: TaskStatus; to: TaskStatus; blockers: Blocker[] }> {
    const tasks = this.listTasks()
    const ctx = this.dagContext(tasks)
    const changes: Array<{ id: string; from: TaskStatus; to: TaskStatus; blockers: Blocker[] }> = []

    for (const task of tasks) {
      if (isTerminal(task.status)) continue
      if (task.status === 'reserved' || task.status === 'running' || task.status === 'verifying') continue

      const verdict = evaluateRunnable(task, ctx)
      let target: TaskStatus
      if (verdict.runnable) {
        target = 'ready'
      } else {
        const kinds = new Set(verdict.blockers.map(blocker => blocker.kind))
        if (kinds.has('gate')) target = 'blocked_gate'
        else if (kinds.has('resource')) target = 'blocked_resource'
        else target = 'blocked_dependency'
      }

      if (target !== task.status) {
        assertTransition(task.status, target)
        this.store.db
          .prepare('UPDATE tasks SET status = ?, blocked_reason = ? WHERE id = ?')
          .run(target, verdict.runnable ? null : verdict.blockers.map(blocker => blocker.reason).join('; '), task.id)
        changes.push({ id: task.id, from: task.status, to: target, blockers: verdict.blockers })
      }
    }

    if (changes.length > 0) {
      this.store.appendEvent(actor, 'task.refresh_states', {
        changes: changes.map(change => ({ id: change.id, to: change.to })),
      })
    }
    return changes
  }

  // ---------- 任务生命周期 ----------

  /** 原子预约资源(方案 9.4):成功 -> reserved;失败 -> blocked_resource */
  acquireTask(id: string, owner = 'operator', ttlMinutes = 60): { task: Task; ok: boolean; blockers: string[] } {
    const task = this.mustGet(id)
    assertTransition(task.status, 'reserved')

    const outcome = acquireLeases(this.store, {
      taskId: id,
      owner,
      purpose: task.title,
      requirements: task.resources ?? [],
      ttlMinutes,
      actor: owner,
    })
    if (!outcome.ok) {
      const reason = outcome.blockers.map(blocker => `${blocker.resourceId}: ${blocker.reason}`).join('; ')
      if (task.status !== 'blocked_resource') {
        assertTransition(task.status, 'blocked_resource')
      }
      this.store.db
        .prepare('UPDATE tasks SET status = ?, blocked_reason = ? WHERE id = ?')
        .run('blocked_resource', reason, id)
      this.store.appendEvent(owner, 'task.acquire_block', { id, reason })
      return { task: this.getTask(id) as Task, ok: false, blockers: outcome.blockers.map(blocker => `${blocker.resourceId}: ${blocker.reason}`) }
    }

    this.store.db
      .prepare("UPDATE tasks SET status = 'reserved', blocked_reason = NULL WHERE id = ?")
      .run(id)
    this.store.appendEvent(owner, 'task.acquire', { id, leases: outcome.leases.map(lease => lease.id) })
    return { task: this.getTask(id) as Task, ok: true, blockers: [] }
  }

  startTask(id: string, actor = 'runner'): Task {
    const task = this.mustGet(id)
    assertTransition(task.status, 'running')
    this.store.db
      .prepare("UPDATE tasks SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ?")
      .run(this.store.now(), id)
    this.store.appendEvent(actor, 'task.start', { id })
    return this.getTask(id) as Task
  }

  beginVerify(id: string, actor = 'runner'): Task {
    const task = this.mustGet(id)
    assertTransition(task.status, 'verifying')
    this.store.db.prepare("UPDATE tasks SET status = 'verifying' WHERE id = ?").run(id)
    this.store.appendEvent(actor, 'task.verify_begin', { id })
    return this.getTask(id) as Task
  }

  /** 完成任务并登记产物(方案 8.3 artifact_requires 的数据源) */
  completeTask(id: string, actor = 'runner'): Task {
    const task = this.mustGet(id)
    assertTransition(task.status, 'succeeded')
    const now = this.store.now()
    this.store.db
      .prepare("UPDATE tasks SET status = 'succeeded', finished_at = ?, blocked_reason = NULL WHERE id = ?")
      .run(now, id)

    const insertArtifact = this.store.db.prepare(
      'INSERT OR REPLACE INTO artifacts (name, version, produced_by, created_at) VALUES (?, ?, ?, ?)',
    )
    for (const output of task.outputs ?? []) {
      insertArtifact.run(output, '1', id, now)
    }
    releaseTaskLeases(this.store, id, actor)
    this.store.appendEvent(actor, 'task.complete', { id, outputs: task.outputs ?? [] })
    return this.getTask(id) as Task
  }

  /** 失败三分类(方案 8.5):product / test / infra 分开,项目数据不失真 */
  failTask(id: string, failureClass: TaskFailureClass, message: string, actor = 'runner'): Task {
    const task = this.mustGet(id)
    const target: TaskStatus =
      failureClass === 'product' ? 'failed_product' : failureClass === 'test' ? 'failed_test' : 'failed_infra'
    assertTransition(task.status, target)
    this.store.db
      .prepare('UPDATE tasks SET status = ?, last_result = ?, blocked_reason = ?, finished_at = ? WHERE id = ?')
      .run(target, failureClass, message, this.store.now(), id)
    releaseTaskLeases(this.store, id, actor)
    this.store.appendEvent(actor, 'task.fail', { id, failureClass, message })
    return this.getTask(id) as Task
  }

  cancelTask(id: string, reason: string, actor = 'operator'): Task {
    const task = this.mustGet(id)
    assertTransition(task.status, 'cancelled')
    this.store.db
      .prepare("UPDATE tasks SET status = 'cancelled', blocked_reason = ?, finished_at = ? WHERE id = ?")
      .run(reason, this.store.now(), id)
    releaseTaskLeases(this.store, id, actor)
    this.store.appendEvent(actor, 'task.cancel', { id, reason })
    return this.getTask(id) as Task
  }

  // ---------- 视图 ----------

  readyQueue(): Array<{ id: string; title: string; score: number; onCriticalPath: boolean }> {
    const ctx = this.dagContext(this.listTasks())
    return computeReadyQueue(ctx, this.store.now()).map(entry => ({
      id: entry.task.id,
      title: entry.task.title,
      score: entry.score,
      onCriticalPath: entry.onCriticalPath,
    }))
  }

  criticalPath(): { ids: string[]; totalMinutes: number } {
    return computeCriticalPath(this.listTasks())
  }

  /** 每日巡检:清理过期租约并刷新状态 */
  sweep(actor = 'system'): void {
    const expired = sweepExpiredLeases(this.store)
    for (const { taskId, lease } of expired) {
      const task = this.getTask(taskId)
      if (task && !isTerminal(task.status) && task.status !== 'running' && task.status !== 'verifying') {
        this.store.db
          .prepare('UPDATE tasks SET status = ?, blocked_reason = ? WHERE id = ?')
          .run('blocked_resource', `租约 ${lease.id} 过期,资源已隔离`, taskId)
      }
    }
    this.refreshStates(actor)
  }

  /** 总览快照:DSH 工具与座舱 UI 的统一数据源 */
  statusSnapshot() {
    const tasks = this.listTasks()
    const resources = this.listAllResources()
    return {
      now: this.store.now(),
      tasks: {
        total: tasks.length,
        byStatus: tasks.reduce<Record<string, number>>((acc, task) => {
          acc[task.status] = (acc[task.status] ?? 0) + 1
          return acc
        }, {}),
        blocked: tasks
          .filter(task => task.status.startsWith('blocked_'))
          .map(task => ({ id: task.id, status: task.status, reason: task.blockedReason ?? '' })),
      },
      ready: this.readyQueue(),
      criticalPath: this.criticalPath(),
      resources: {
        total: resources.length,
        quarantined: resources.filter(res => res.state === 'quarantined').map(res => res.id),
        busy: resources.filter(res => res.busyUnits > 0).length,
      },
      activeLeases: listLeases(this.store, { activeOnly: true }).length,
    }
  }

  listAllResources(): Resource[] {
    const rows = this.store.db.prepare('SELECT * FROM resources ORDER BY id').all() as Array<
      Record<string, unknown>
    >
    return rows.map(row => row as unknown as Resource)
  }

  listTestRuns(): TestRunRecord[] {
    return listTestRuns(this.store)
  }

  mustGet(id: string): Task {
    const task = this.getTask(id)
    if (!task) throw new Error(`任务不存在: ${id}`)
    return task
  }
}

export type { LeaseRequirement }
