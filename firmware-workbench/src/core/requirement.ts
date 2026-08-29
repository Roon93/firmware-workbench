import type { AcceptanceCriterion, DefineDocument, Requirement, RequirementKind } from '../types.js'
import type { WorkbenchStore } from './store.js'

/**
 * 需求与 Define(方案 4.1/15.1,附录 C):
 * 把原始需求转化为原子化、可验证、带边界的需求契约。
 */

function rowToRequirement(row: Record<string, unknown>): Requirement {
  return {
    id: row.id as string,
    kind: row.kind as RequirementKind,
    title: row.title as string,
    originalText: (row.original_text as string) ?? undefined,
    definition: row.definition ? (JSON.parse(row.definition as string) as DefineDocument) : undefined,
    status: row.status as Requirement['status'],
    priority: row.priority as Requirement['priority'],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export interface ImportRequirementInput {
  title: string
  originalText: string
  id?: string
  priority?: Requirement['priority']
  actor?: string
}

/** 导入原始需求(P0 需求接收):进入工作台的第一步;重复导入幂等(保留状态) */
export function importRequirement(store: WorkbenchStore, input: ImportRequirementInput): Requirement {
  const now = store.now()
  const id = input.id ?? `REQ-${now.slice(0, 10).replaceAll('-', '')}-${String(Number(store.getMeta('requirement.seq') ?? '0') + 1).padStart(4, '0')}`
  if (input.id) {
    const seq = Number(store.getMeta('requirement.seq') ?? '0')
    if (Number(id.replaceAll(/\D/g, '')) > seq) store.setMeta('requirement.seq', id.replaceAll(/\D/g, ''))
  } else {
    const seq = Number(store.getMeta('requirement.seq') ?? '0') + 1
    store.setMeta('requirement.seq', String(seq))
  }

  store.db
    .prepare(
      `INSERT INTO requirements (id, kind, title, original_text, status, priority, created_at, updated_at)
       VALUES (?, 'source', ?, ?, 'imported', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, original_text = excluded.original_text,
         updated_at = excluded.updated_at`,
    )
    .run(id, input.title, input.originalText, input.priority ?? 'medium', now, now)
  store.appendEvent(input.actor ?? 'product', 'requirement.import', { id, title: input.title })

  return getRequirement(store, id) as Requirement
}

export function getRequirement(store: WorkbenchStore, id: string): Requirement | undefined {
  const row = store.db.prepare('SELECT * FROM requirements WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  return row ? rowToRequirement(row) : undefined
}

export function listRequirements(store: WorkbenchStore): Requirement[] {
  const rows = store.db.prepare('SELECT * FROM requirements ORDER BY created_at').all() as Array<
    Record<string, unknown>
  >
  return rows.map(rowToRequirement)
}

/** Define 校验(方案 P1/G1):正常流、错误流和验收标准必须非空才能形成 Definition Baseline */
export function validateDefine(define: DefineDocument, criteria: AcceptanceCriterion[]): string[] {
  const errors: string[] = []
  if (!define.normalFlow || define.normalFlow.length === 0) errors.push('normalFlow 不能为空:必须描述正常路径')
  if (!define.errorFlows || define.errorFlows.length === 0) errors.push('errorFlows 不能为空:必须描述至少一个异常路径')
  if (!define.recoveryRules || define.recoveryRules.length === 0)
    errors.push('recoveryRules 不能为空:必须描述恢复策略')
  if (!define.outOfScope || define.outOfScope.length === 0)
    errors.push('outOfScope 不能为空:必须声明范围边界')
  if (criteria.length === 0) errors.push('验收标准不能为空:至少一条可验证的 AcceptanceCriterion')
  if (define.openQuestions && define.openQuestions.length > 0)
    errors.push(`存在未澄清问题(${define.openQuestions.length} 项),Define 不能冻结`)
  return errors
}

export interface DefineInput {
  requirementId: string
  define: DefineDocument
  criteria: Array<Omit<AcceptanceCriterion, 'id' | 'requirementId' | 'status'>>
  actor?: string
}

/** 写入 Define 并附验收标准;校验通过后状态 imported -> defined */
export function applyDefine(store: WorkbenchStore, input: DefineInput): { requirement: Requirement; errors: string[] } {
  const requirement = getRequirement(store, input.requirementId)
  if (!requirement) throw new Error(`需求不存在: ${input.requirementId}`)

  const criteria: AcceptanceCriterion[] = input.criteria.map((criterion, index) => ({
    ...criterion,
    id: `AC-${input.requirementId.replace(/^REQ-/, '')}-${String(index + 1).padStart(4, '0')}`,
    requirementId: input.requirementId,
    status: 'draft',
  }))

  const errors = validateDefine(input.define, criteria)
  const now = store.now()
  const nextStatus = errors.length === 0 ? 'defined' : 'imported'

  store.db
    .prepare('UPDATE requirements SET definition = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(input.define), nextStatus, now, input.requirementId)

  store.db.prepare('DELETE FROM acceptance_criteria WHERE requirement_id = ?').run(input.requirementId)
  const insert = store.db.prepare(
    `INSERT INTO acceptance_criteria (id, requirement_id, title, method, threshold, max_level, status)
     VALUES (?, ?, ?, ?, ?, ?, 'draft')`,
  )
  for (const criterion of criteria) {
    insert.run(
      criterion.id,
      criterion.requirementId,
      criterion.title,
      criterion.method,
      criterion.threshold ?? null,
      criterion.maxLevel,
    )
  }

  store.appendEvent(input.actor ?? 'product', 'requirement.define', {
    requirementId: input.requirementId,
    valid: errors.length === 0,
    errors,
    criteria: criteria.map(criterion => criterion.id),
  })

  return { requirement: getRequirement(store, input.requirementId) as Requirement, errors }
}

/** 批准 Define(G1 定义完成门禁),进入 approved;已批准则幂等返回 */
export function approveRequirement(store: WorkbenchStore, id: string, signer: string): Requirement {
  const requirement = getRequirement(store, id)
  if (!requirement) throw new Error(`需求不存在: ${id}`)
  if (requirement.status === 'approved') return requirement
  if (requirement.status !== 'defined') {
    throw new Error(`需求 ${id} 状态为 ${requirement.status},只有 defined 状态可批准`)
  }
  store.db.prepare("UPDATE requirements SET status = 'approved', updated_at = ? WHERE id = ?").run(store.now(), id)
  store.appendEvent(signer, 'requirement.approve', { id })
  return getRequirement(store, id) as Requirement
}

export function listAcceptanceCriteria(store: WorkbenchStore, requirementId: string): AcceptanceCriterion[] {
  const rows = store.db
    .prepare('SELECT * FROM acceptance_criteria WHERE requirement_id = ? ORDER BY id')
    .all(requirementId) as Array<Record<string, unknown>>
  return rows.map(row => ({
    id: row.id as string,
    requirementId: row.requirement_id as string,
    title: row.title as string,
    method: row.method as AcceptanceCriterion['method'],
    threshold: (row.threshold as string) ?? undefined,
    maxLevel: row.max_level as AcceptanceCriterion['maxLevel'],
    status: row.status as AcceptanceCriterion['status'],
  }))
}
