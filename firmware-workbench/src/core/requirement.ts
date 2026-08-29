import type { AcceptanceCriterion } from '../types.js'
import type { WorkbenchStore } from './store.js'

/**
 * v1 需求模块已由 core/align.ts 取代(工作流提案 v2.2)。
 * 本文件仅保留验收标准查询(acceptance/评估链路依赖)。
 */

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
