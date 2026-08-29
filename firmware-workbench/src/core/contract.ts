import type { GateDecision, InterfaceContract } from '../types.js'
import type { WorkbenchStore } from './store.js'

/**
 * 接口契约与门禁(方案 4.3/7.2/15.3):
 * 契约先行、增量冻结;已冻结契约不可修改,变更必须产生新版本。
 */

function rowToContract(row: Record<string, unknown>): InterfaceContract {
  return {
    id: row.id as string,
    name: row.name as string,
    version: row.version as string,
    status: row.status as InterfaceContract['status'],
    body: JSON.parse(row.body as string),
    frozenAt: (row.frozen_at as string) ?? undefined,
    createdAt: row.created_at as string,
  }
}

export function createContract(
  store: WorkbenchStore,
  input: { name: string; version: string; body: unknown; actor?: string },
): InterfaceContract {
  const now = store.now()
  const id = `IF-${input.name}@${input.version}`
  store.db
    .prepare(
      `INSERT INTO contracts (id, name, version, status, body, created_at)
       VALUES (?, ?, ?, 'draft', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(id, input.name, input.version, JSON.stringify(input.body ?? {}), now)
  store.appendEvent(input.actor ?? 'architect', 'contract.create', { id })
  return getContract(store, id) as InterfaceContract
}

export function getContract(store: WorkbenchStore, id: string): InterfaceContract | undefined {
  const row = store.db.prepare('SELECT * FROM contracts WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  return row ? rowToContract(row) : undefined
}

/** 按 名称@版本 或 最新冻结版本 取契约 */
export function findFrozenContract(store: WorkbenchStore, name: string, version?: string): InterfaceContract | undefined {
  if (version) {
    return getContract(store, `IF-${name}@${version}`)
  }
  const row = store.db
    .prepare("SELECT * FROM contracts WHERE name = ? AND status = 'frozen' ORDER BY created_at DESC LIMIT 1")
    .get(name) as Record<string, unknown> | undefined
  return row ? rowToContract(row) : undefined
}

export function listContracts(store: WorkbenchStore): InterfaceContract[] {
  const rows = store.db.prepare('SELECT * FROM contracts ORDER BY created_at').all() as Array<
    Record<string, unknown>
  >
  return rows.map(rowToContract)
}

/** 冻结契约(G3 契约基线):冻结后 body 不可再改 */
export function freezeContract(store: WorkbenchStore, id: string, actor = 'architect'): InterfaceContract {
  const contract = getContract(store, id)
  if (!contract) throw new Error(`契约不存在: ${id}`)
  if (contract.status === 'frozen') return contract
  const now = store.now()
  store.db.prepare("UPDATE contracts SET status = 'frozen', frozen_at = ? WHERE id = ?").run(now, id)
  store.appendEvent(actor, 'contract.freeze', { id })
  return getContract(store, id) as InterfaceContract
}

/** 已冻结契约不可修改(方案 15.3:已批准基线不能静默修改) */
export function updateContractBody(store: WorkbenchStore, id: string, body: unknown, actor = 'architect'): InterfaceContract {
  const contract = getContract(store, id)
  if (!contract) throw new Error(`契约不存在: ${id}`)
  if (contract.status === 'frozen') {
    throw new Error(`契约 ${id} 已冻结,不可修改;请创建新版本 ${contract.name}@next`)
  }
  store.db.prepare('UPDATE contracts SET body = ? WHERE id = ?').run(JSON.stringify(body), id)
  store.appendEvent(actor, 'contract.update', { id })
  return getContract(store, id) as InterfaceContract
}

// ---------- 门禁(方案 7.2/15.1) ----------

export function setGateDecision(
  store: WorkbenchStore,
  input: { id: string; scope: string; decision: GateDecision['decision']; signer?: string; conditions?: string[] },
): GateDecision {
  const now = store.now()
  store.db
    .prepare(
      `INSERT INTO gates (id, scope, decision, signer, decided_at, conditions)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET decision = excluded.decision, signer = excluded.signer,
         decided_at = excluded.decided_at, conditions = excluded.conditions`,
    )
    .run(
      input.id,
      input.scope,
      input.decision,
      input.signer ?? null,
      input.decision === 'pending' ? null : now,
      JSON.stringify(input.conditions ?? []),
    )
  store.appendEvent(input.signer ?? 'gate-keeper', 'gate.decision', { ...input })
  return getGate(store, input.id) as GateDecision
}

export function getGate(store: WorkbenchStore, id: string): GateDecision | undefined {
  const row = store.db.prepare('SELECT * FROM gates WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return undefined
  return {
    id: row.id as string,
    scope: row.scope as string,
    decision: row.decision as GateDecision['decision'],
    signer: (row.signer as string) ?? undefined,
    decidedAt: (row.decided_at as string) ?? undefined,
    conditions: JSON.parse((row.conditions as string) ?? '[]'),
  }
}

export function listGates(store: WorkbenchStore): GateDecision[] {
  const rows = store.db.prepare('SELECT * FROM gates ORDER BY id').all() as Array<Record<string, unknown>>
  return rows.map(row => ({
    id: row.id as string,
    scope: row.scope as string,
    decision: row.decision as GateDecision['decision'],
    signer: (row.signer as string) ?? undefined,
    decidedAt: (row.decided_at as string) ?? undefined,
    conditions: JSON.parse((row.conditions as string) ?? '[]'),
  }))
}
