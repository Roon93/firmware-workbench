import type { Lease, LeaseRequirement, LockMode, Resource, ResourceSpec } from '../types.js'
import type { WorkbenchStore } from './store.js'

/**
 * 单机资源租约(方案 9.2-9.6)。
 * 即使只有一台真实设备,串口、VNC、刷机、整机和人工操作也从第一天按资源建模,
 * 多资源任务必须原子获取,防止刷机、测试和交互调试互相争用。
 */

function camel(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = value
  }
  return out
}

function parseLease(row: Record<string, unknown>): Lease {
  return camel(row) as unknown as Lease
}

function parseResource(row: Record<string, unknown>): Resource {
  return camel(row) as unknown as Resource
}

/** 方案 9.2 资源目录:MVP 单台设备的全部资源(真实硬件未接入时同样建模) */
export function defaultResourceCatalog(): ResourceSpec[] {
  return [
    { id: 'build/rk3588', kind: 'build', mode: 'capacity', units: 1, description: 'RK3588 构建容器容量' },
    { id: 'sim/scanner', kind: 'simulator', mode: 'capacity', units: 4, description: '虚拟扫描器实例' },
    { id: 'sim/engine', kind: 'simulator', mode: 'capacity', units: 4, description: '虚拟打印引擎实例' },
    { id: 'device/printer-01', kind: 'device', mode: 'exclusive', units: 1, description: 'Printer-01 真实整机(独占)' },
    { id: 'device/printer-01/serial', kind: 'serial', mode: 'shared-read', units: 1, description: '串口:日志共享读,命令独占写' },
    { id: 'device/printer-01/vnc-view', kind: 'vnc-view', mode: 'shared-read', units: 1, description: '面板显示(多人查看)' },
    { id: 'device/printer-01/vnc-input', kind: 'vnc-input', mode: 'exclusive', units: 1, description: '面板输入(唯一操作者)' },
    { id: 'device/printer-01/scanner', kind: 'subsystem', mode: 'exclusive', units: 1, description: '真实扫描器子系统' },
    { id: 'device/printer-01/engine', kind: 'subsystem', mode: 'exclusive', units: 1, description: '打印引擎与纸路子系统' },
    { id: 'fixture/power-relay-01', kind: 'fixture', mode: 'exclusive', units: 1, description: '可控断电工装' },
    { id: 'instrument/image-meter', kind: 'instrument', mode: 'exclusive', units: 1, description: '图像质量测量仪器' },
    { id: 'consumable/a4-paper', kind: 'consumable', mode: 'capacity', units: 250, description: 'A4 纸张库存(张)' },
    { id: 'human/operator', kind: 'human', mode: 'exclusive', units: 1, description: '人工操作位:放原稿、装纸、目视确认' },
  ]
}

export function seedResources(store: WorkbenchStore): void {
  const insert = store.db.prepare(
    `INSERT INTO resources (id, kind, mode, units, description, state, health, busy_units)
     VALUES (?, ?, ?, ?, ?, 'available', 'unknown', 0)
     ON CONFLICT(id) DO NOTHING`,
  )
  for (const spec of defaultResourceCatalog()) {
    insert.run(spec.id, spec.kind, spec.mode, spec.units, spec.description ?? null)
  }
  store.appendEvent('system', 'resource.seed', { count: defaultResourceCatalog().length })
}

export function listResources(store: WorkbenchStore): Resource[] {
  const rows = store.db.prepare('SELECT * FROM resources ORDER BY id').all() as Array<Record<string, unknown>>
  return rows.map(parseResource)
}

export function getResource(store: WorkbenchStore, resourceId: string): Resource | undefined {
  const row = store.db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId) as
    | Record<string, unknown>
    | undefined
  return row ? parseResource(row) : undefined
}

/** 同一资源上,新模式与既有 active 租约是否兼容(方案 9.2 锁模式) */
function modesCompatible(existing: LockMode | undefined, incoming: LockMode): boolean {
  if (!existing) return true
  // 独占与任何模式互斥;shared-read 之间共存;capacity 按计数
  if (existing === 'exclusive' || incoming === 'exclusive') return false
  return true
}

export interface AcquireInput {
  taskId: string
  owner: string
  purpose: string
  requirements: LeaseRequirement[]
  ttlMinutes?: number
  actor?: string
}

export interface AcquireOutcome {
  ok: boolean
  leases: Lease[]
  blockers: Array<{ resourceId: string; reason: string }>
}

/** 单资源可得性检查(方案 9.3 状态机 + 9.2 锁模式);返回 null 表示可得 */
function resourceAvailableFor(res: Resource, req: LeaseRequirement): string | null {
  const incoming: LockMode = req.mode ?? res.mode
  const wantedUnits = req.units ?? 1

  if (res.state === 'quarantined') return `资源已隔离: ${res.quarantineReason ?? '未知原因'}`
  if (res.state === 'maintenance') return '资源维护中'
  if (res.state !== 'available' && res.state !== 'reserved') return `资源状态为 ${res.state},不可租用`

  if (res.mode === 'capacity') {
    if (res.busyUnits + wantedUnits > res.units) {
      return `容量不足: ${res.busyUnits}/${res.units} 已占用,请求 ${wantedUnits}`
    }
    return null
  }
  if (incoming === 'shared-read' && res.mode === 'shared-read') return null
  if (res.busyUnits > 0) return '资源被其他租约占用'
  return null
}

/**
 * 原子获取任务声明的全部资源(方案 9.4/9.5):
 * 只有所有资源均可获得时才建立租约,否则不留半套租约。
 */
export function acquireLeases(store: WorkbenchStore, input: AcquireInput): AcquireOutcome {
  const blockers: Array<{ resourceId: string; reason: string }> = []
  const now = store.now()
  const ttlMs = (input.ttlMinutes ?? 60) * 60_000

  // 第一阶段:全部检查(读)
  const resolved: Array<{ res: Resource; req: LeaseRequirement; mode: LockMode; units: number }> = []
  for (const req of input.requirements) {
    const res = getResource(store, req.id)
    if (!res) {
      blockers.push({ resourceId: req.id, reason: '资源不存在于资源目录' })
      continue
    }
    const mode = req.mode ?? res.mode
    const units = req.units ?? 1

    const stateBlock = resourceAvailableFor(res, req)
    if (stateBlock) {
      blockers.push({ resourceId: req.id, reason: stateBlock })
      continue
    }

    if (res.mode !== 'capacity') {
      const active = store.db
        .prepare("SELECT mode FROM leases WHERE resource_id = ? AND state = 'active'")
        .all(res.id) as Array<{ mode: string }>
      const conflicting = active.some(row => !modesCompatible(row.mode as LockMode, mode))
      if (conflicting) {
        blockers.push({ resourceId: req.id, reason: `存在不兼容的 active 租约(请求 ${mode})` })
        continue
      }
    }
    resolved.push({ res, req, mode, units })
  }

  if (blockers.length > 0) {
    return { ok: false, leases: [], blockers }
  }

  // 第二阶段:单事务写入全部租约
  const leases: Lease[] = []
  store.db.exec('BEGIN IMMEDIATE')
  try {
    const insertLease = store.db.prepare(
      `INSERT INTO leases (id, resource_id, task_id, owner, purpose, mode, units, state, acquired_at, expires_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    const updateResource = store.db.prepare(
      'UPDATE resources SET busy_units = busy_units + ?, state = ? WHERE id = ?',
    )

    for (const { res, mode, units } of resolved) {
      const leaseId = `LEASE-${res.id.replace(/[^A-Za-z0-9]+/g, '-').toUpperCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
      insertLease.run(
        leaseId,
        res.id,
        input.taskId,
        input.owner,
        input.purpose,
        mode,
        units,
        now,
        new Date(Date.parse(now) + ttlMs).toISOString(),
        now,
      )
      const nextState = res.state === 'available' ? 'reserved' : res.state
      updateResource.run(units, nextState, res.id)
      leases.push({
        id: leaseId,
        resourceId: res.id,
        taskId: input.taskId,
        owner: input.owner,
        purpose: input.purpose,
        mode,
        units,
        state: 'active',
        acquiredAt: now,
        expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
        heartbeatAt: now,
      })
    }
    store.db.exec('COMMIT')
  } catch (error) {
    store.db.exec('ROLLBACK')
    throw error
  }

  store.appendEvent(input.actor ?? input.owner, 'resource.acquire', {
    taskId: input.taskId,
    leases: leases.map(lease => lease.id),
    purpose: input.purpose,
  })
  return { ok: true, leases, blockers: [] }
}

export function listLeases(store: WorkbenchStore, opts: { activeOnly?: boolean; taskId?: string } = {}): Lease[] {
  const conditions: string[] = []
  const params: Array<string | number | bigint | null> = []
  if (opts.activeOnly) conditions.push("state = 'active'")
  if (opts.taskId) {
    conditions.push('task_id = ?')
    params.push(opts.taskId)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = store.db
    .prepare(`SELECT * FROM leases ${where} ORDER BY acquired_at DESC`)
    .all(...params) as Array<Record<string, unknown>>
  return rows.map(parseLease)
}

/** 心跳与续租(方案 9.4:租约包含 TTL、心跳) */
export function heartbeat(store: WorkbenchStore, leaseId: string, extendMinutes = 0): Lease {
  const now = store.now()
  const row = store.db.prepare('SELECT * FROM leases WHERE id = ? AND state = ?').get(leaseId, 'active') as
    | Record<string, unknown>
    | undefined
  if (!row) throw new Error(`租约不存在或已释放: ${leaseId}`)
  const lease = parseLease(row)
  const expiresAt =
    extendMinutes > 0 ? new Date(Date.parse(now) + extendMinutes * 60_000).toISOString() : lease.expiresAt
  store.db
    .prepare('UPDATE leases SET heartbeat_at = ?, expires_at = ? WHERE id = ?')
    .run(now, expiresAt, leaseId)
  store.appendEvent(lease.owner, 'resource.heartbeat', { leaseId, extendMinutes })
  return { ...lease, heartbeatAt: now, expiresAt }
}

/** 扫描过期租约(方案 9.4:超时不简单释放,资源标记隔离等待清理确认) */
export function sweepExpiredLeases(store: WorkbenchStore): Array<{ lease: Lease; taskId: string }> {
  const now = store.now()
  const rows = store.db
    .prepare("SELECT * FROM leases WHERE state = 'active' AND expires_at < ?")
    .all(now) as Array<Record<string, unknown>>
  const expired: Array<{ lease: Lease; taskId: string }> = []
  for (const row of rows) {
    const lease = parseLease(row)
    store.db.prepare("UPDATE leases SET state = 'expired' WHERE id = ?").run(lease.id)
    store.db
      .prepare("UPDATE resources SET state = 'quarantined', quarantine_reason = ? WHERE id = ?")
      .run('租约过期,状态不明,需清理确认', lease.resourceId)
    expired.push({ lease, taskId: lease.taskId })
  }
  if (expired.length > 0) {
    store.appendEvent('system', 'resource.sweep_expired', {
      leases: expired.map(item => item.lease.id),
    })
  }
  return expired
}

/** 释放任务全部租约,资源恢复健康可用(方案 9.6:会话结束恢复已知状态) */
export function releaseTaskLeases(store: WorkbenchStore, taskId: string, actor = 'system'): Lease[] {
  const now = store.now()
  const rows = store.db
    .prepare("SELECT * FROM leases WHERE task_id = ? AND state = 'active'")
    .all(taskId) as Array<Record<string, unknown>>
  const released: Lease[] = []
  for (const row of rows) {
    const lease = parseLease(row)
    store.db.prepare("UPDATE leases SET state = 'released' WHERE id = ?").run(lease.id)
    store.db
      .prepare(`
        UPDATE resources
        SET busy_units = MAX(0, busy_units - ?),
            state = CASE WHEN busy_units - ? <= 0 THEN 'available' ELSE state END,
            quarantine_reason = NULL
        WHERE id = ?
      `)
      .run(lease.units, lease.units, lease.resourceId)
    released.push(lease)
  }
  if (released.length > 0) {
    store.appendEvent(actor, 'resource.release', { taskId, leases: released.map(lease => lease.id) })
  }
  void now
  return released
}

/** 隔离资源(方案 9.3/9.4:状态不明、刷机失败、测试进程失联时自动隔离) */
export function quarantineResource(store: WorkbenchStore, resourceId: string, reason: string, actor = 'system'): void {
  store.db
    .prepare("UPDATE resources SET state = 'quarantined', quarantine_reason = ? WHERE id = ?")
    .run(reason, resourceId)
  store.appendEvent(actor, 'resource.quarantine', { resourceId, reason })
}

/** 维护完成,恢复健康检查并通过后回到可用(方案 9.3 状态机) */
export function completeMaintenance(store: WorkbenchStore, resourceId: string, actor = 'system'): void {
  store.db
    .prepare("UPDATE resources SET state = 'available', health = 'healthy', quarantine_reason = NULL WHERE id = ?")
    .run(resourceId)
  store.appendEvent(actor, 'resource.maintenance_done', { resourceId })
}

/** 更新资源当前固件(刷机后记录,方案 14.4) */
export function setResourceFirmware(store: WorkbenchStore, resourceId: string, firmwareSha: string): void {
  store.db.prepare('UPDATE resources SET current_firmware = ? WHERE id = ?').run(firmwareSha, resourceId)
}
