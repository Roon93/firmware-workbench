import type { WorkbenchStore } from './store.js'
import { setGateDecision } from './contract.js'

/**
 * 对齐层(工作流提案 v2.2 §3.1/§8):
 * 澄清问答 → 原子需求条目 → Define 版本链 → 三态评审(approve/request-changes/comment)
 * → 变更管理(stale 传导)。所有 loop 产物带 source_refs(知识溯源埋点,提案 §7.4)。
 */

export interface ClarifyQuestion {
  id: string
  requirementId: string
  question: string
  why?: string
  options?: string[]
  status: 'open' | 'answered' | 'skipped'
  answer?: string
  answeredBy?: string
  answeredAt?: string
  origin: 'manual' | 'ai-draft' | 'template'
  createdAt: string
}

export interface ItemAcceptance {
  title: string
  method: 'manual' | 'automated' | 'instrument'
  threshold?: string
  maxLevel: string
}

export interface RequirementItem {
  id: string
  requirementId: string
  seq: number
  content: string
  acceptance: ItemAcceptance[]
  priority: 'high' | 'medium' | 'low'
  status: 'proposed' | 'in-review' | 'approved' | 'changed'
  origin?: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface DefineVersion {
  id: string
  requirementId: string
  version: number
  body: Record<string, unknown>
  itemSnapshot: RequirementItem[]
  status: 'draft' | 'in-review' | 'approved' | 'rejected' | 'superseded'
  submittedAt?: string
  decidedAt?: string
  createdAt: string
}

export interface ReviewRecord {
  id: number
  targetId: string
  decision: 'approve' | 'request-changes' | 'comment'
  reviewer: string
  comments: Array<{ itemId?: string; section?: string; text: string }>
  decidedAt: string
}

/** 打印机固件需求的模板澄清问题(导入时自动生成,origin=template;P-E0 知识种子化后由 Knowledge 供给) */
export const TEMPLATE_QUESTIONS: Array<{ question: string; why: string; options: string[] }> = [
  {
    question: '目标纸张规格与介质范围是什么?',
    why: '决定纸路机构假设、引擎参数与用例矩阵(A4/A3/证卡/信封,克重范围)',
    options: ['仅 A4 普通纸', 'A4 + 证卡', 'A3 全幅'],
  },
  {
    question: '单双面、份数与缩放需求?',
    why: '决定作业参数模型与图像流水线分支',
    options: ['单面单份 1:1', '单面多份', '双面'],
  },
  {
    question: '异常场景(缺纸/卡纸/开盖/取消)各自的恢复策略是什么?',
    why: '恢复语义是 Define 高频漏项(历史评审归纳),必须在批准前定死',
    options: ['补纸后继续并完成', '补纸后询问继续/终止', '一律终止并回就绪'],
  },
  {
    question: '性能有量化目标吗(首张时间/连续速度)?',
    why: '没有数字就无法验收;允许"待签署"但必须显式记录',
    options: ['暂无,记为待产品签署', '有,见补充说明'],
  },
  {
    question: '是否涉及用户数据留存或网络暴露面?',
    why: '决定安全验收范围(方案 12.3 安全域)',
    options: ['无数据留存、无网络服务', '有,需安全评审'],
  },
]

function parse<T>(text: unknown, fallback: T): T {
  try {
    return JSON.parse(String(text)) as T
  } catch {
    return fallback
  }
}

// ---------- 需求(多需求集合,G2) ----------

export interface RequirementRow {
  id: string
  kind: string
  title: string
  originalText?: string
  status: string
  priority: string
  dependsOn?: string
  createdAt: string
  updatedAt: string
}

export function listRequirements(store: WorkbenchStore): RequirementRow[] {
  const rows = store.db.prepare('SELECT * FROM requirements ORDER BY created_at').all() as Array<
    Record<string, unknown>
  >
  return rows.map(row => ({
    id: row.id as string,
    kind: row.kind as string,
    title: row.title as string,
    originalText: (row.original_text as string) ?? undefined,
    status: row.status as string,
    priority: row.priority as string,
    dependsOn: (row.depends_on as string) ?? undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }))
}

export function getRequirement(store: WorkbenchStore, id: string): RequirementRow | undefined {
  return listRequirements(store).find(req => req.id === id)
}

/** 导入原始需求:进入 clarifying,并生成模板澄清问题(提案 §3.1) */
export function importRawRequirement(
  store: WorkbenchStore,
  input: { title: string; text: string; id?: string; priority?: 'high' | 'medium' | 'low' },
  actor = 'web',
): RequirementRow {
  const now = store.now()
  const seq = Number(store.getMeta('requirement.seq') ?? '0') + 1
  store.setMeta('requirement.seq', String(seq))
  const id = input.id ?? `REQ-${now.slice(0, 10).replaceAll('-', '')}-${String(seq).padStart(4, '0')}`

  store.db
    .prepare(
      `INSERT INTO requirements (id, kind, title, original_text, status, priority, created_at, updated_at)
       VALUES (?, 'feature', ?, ?, 'clarifying', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, original_text = excluded.original_text,
         updated_at = excluded.updated_at`,
    )
    .run(id, input.title, input.text, input.priority ?? 'medium', now, now)
  store.appendEvent(actor, 'requirement.import', { id, title: input.title, status: 'clarifying' })

  for (const [index, template] of TEMPLATE_QUESTIONS.entries()) {
    addQuestion(
      store,
      {
        requirementId: id,
        question: template.question,
        why: template.why,
        options: template.options,
        origin: 'template',
        sourceRefs: [`requirement:${id}`],
      },
      actor,
      index + 1,
    )
  }
  return getRequirement(store, id) as RequirementRow
}

// ---------- 澄清问答 ----------

export function listQuestions(store: WorkbenchStore, requirementId?: string): ClarifyQuestion[] {
  const rows = requirementId
    ? store.db.prepare('SELECT * FROM clarify_questions WHERE requirement_id = ? ORDER BY id').all(requirementId)
    : store.db.prepare('SELECT * FROM clarify_questions ORDER BY id').all()
  return (rows as Array<Record<string, unknown>>).map(row => ({
    id: row.id as string,
    requirementId: row.requirement_id as string,
    question: row.question as string,
    why: (row.why as string) ?? undefined,
    options: parse<string[]>(row.options, []),
    status: row.status as ClarifyQuestion['status'],
    answer: (row.answer as string) ?? undefined,
    answeredBy: (row.answered_by as string) ?? undefined,
    answeredAt: (row.answered_at as string) ?? undefined,
    origin: row.origin as ClarifyQuestion['origin'],
    createdAt: row.created_at as string,
  }))
}

export function addQuestion(
  store: WorkbenchStore,
  input: {
    requirementId: string
    question: string
    why?: string
    options?: string[]
    origin?: 'manual' | 'ai-draft' | 'template'
    sourceRefs?: string[]
  },
  actor = 'web',
  seqOverride?: number,
): ClarifyQuestion {
  const now = store.now()
  const req = getRequirement(store, input.requirementId)
  if (!req) throw new Error(`需求不存在: ${input.requirementId}`)
  const seq = seqOverride ?? listQuestions(store, input.requirementId).length + 1
  const id = `Q-${req.id.replace(/^REQ-/, '')}-${String(seq).padStart(2, '0')}`
  store.db
    .prepare(
      `INSERT INTO clarify_questions (id, requirement_id, question, why, options, origin, source_refs, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      id,
      input.requirementId,
      input.question,
      input.why ?? null,
      JSON.stringify(input.options ?? []),
      input.origin ?? 'manual',
      JSON.stringify(input.sourceRefs ?? []),
      now,
    )
  store.appendEvent(actor, 'clarify.add', { id, requirementId: input.requirementId, origin: input.origin ?? 'manual' })
  return listQuestions(store, input.requirementId).find(q => q.id === id) as ClarifyQuestion
}

export function answerQuestion(
  store: WorkbenchStore,
  questionId: string,
  answer: string,
  actor = 'web',
): ClarifyQuestion {
  const row = store.db.prepare('SELECT * FROM clarify_questions WHERE id = ?').get(questionId) as
    | Record<string, unknown>
    | undefined
  if (!row) throw new Error(`问题不存在: ${questionId}`)
  if (row.status === 'answered') throw new Error(`${questionId} 已回答;如需修改请走需求变更`)
  const now = store.now()
  store.db
    .prepare('UPDATE clarify_questions SET status = ?, answer = ?, answered_by = ?, answered_at = ? WHERE id = ?')
    .run('answered', answer, actor, now, questionId)
  store.appendEvent(actor, 'clarify.answer', {
    id: questionId,
    requirementId: row.requirement_id,
    sourceRefs: [`question:${questionId}`],
  })
  return listQuestions(store, row.requirement_id as string).find(q => q.id === questionId) as ClarifyQuestion
}

/** Clarify 门:无 open 问题才允许起草 Define(提案 §3.1) */
export function clarifyComplete(store: WorkbenchStore, requirementId: string): boolean {
  return !listQuestions(store, requirementId).some(q => q.status === 'open')
}

// ---------- 原子需求条目 ----------

export function listItems(store: WorkbenchStore, requirementId?: string): RequirementItem[] {
  const rows = requirementId
    ? store.db.prepare('SELECT * FROM requirement_items WHERE requirement_id = ? ORDER BY seq').all(requirementId)
    : store.db.prepare('SELECT * FROM requirement_items ORDER BY requirement_id, seq').all()
  return (rows as Array<Record<string, unknown>>).map(row => ({
    id: row.id as string,
    requirementId: row.requirement_id as string,
    seq: row.seq as number,
    content: row.content as string,
    acceptance: parse<ItemAcceptance[]>(row.acceptance, []),
    priority: row.priority as RequirementItem['priority'],
    status: row.status as RequirementItem['status'],
    origin: (row.origin as string) ?? undefined,
    version: row.version as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }))
}

export function proposeItem(
  store: WorkbenchStore,
  input: {
    requirementId: string
    content: string
    acceptance?: ItemAcceptance[]
    priority?: 'high' | 'medium' | 'low'
    origin?: string
  },
  actor = 'web',
): RequirementItem {
  const req = getRequirement(store, input.requirementId)
  if (!req) throw new Error(`需求不存在: ${input.requirementId}`)
  const now = store.now()
  const seq = listItems(store, input.requirementId).length + 1
  const id = `ITEM-${req.id.replace(/^REQ-/, '')}-${String(seq).padStart(2, '0')}`
  store.db
    .prepare(
      `INSERT INTO requirement_items (id, requirement_id, seq, content, acceptance, priority, status, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
    )
    .run(
      id,
      input.requirementId,
      seq,
      input.content,
      JSON.stringify(input.acceptance ?? []),
      input.priority ?? 'medium',
      input.origin ?? 'manual',
      now,
      now,
    )
  store.appendEvent(actor, 'item.propose', { id, requirementId: input.requirementId, origin: input.origin ?? 'manual' })
  // 有条目即进入 defining
  if (req.status === 'clarifying' || req.status === 'changed') {
    store.db
      .prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?')
      .run('defining', now, input.requirementId)
  }
  return listItems(store, input.requirementId).find(item => item.id === id) as RequirementItem
}

// ---------- Define 版本链与三态评审 ----------

export function listDefineVersions(store: WorkbenchStore, requirementId?: string): DefineVersion[] {
  const rows = requirementId
    ? store.db.prepare('SELECT * FROM define_versions WHERE requirement_id = ? ORDER BY version').all(requirementId)
    : store.db.prepare('SELECT * FROM define_versions ORDER BY requirement_id, version').all()
  return (rows as Array<Record<string, unknown>>).map(row => ({
    id: row.id as string,
    requirementId: row.requirement_id as string,
    version: row.version as number,
    body: parse<Record<string, unknown>>(row.body, {}),
    itemSnapshot: parse<RequirementItem[]>(row.item_snapshot, []),
    status: row.status as DefineVersion['status'],
    submittedAt: (row.submitted_at as string) ?? undefined,
    decidedAt: (row.decided_at as string) ?? undefined,
    createdAt: row.created_at as string,
  }))
}

export function draftDefine(
  store: WorkbenchStore,
  requirementId: string,
  body: Record<string, unknown>,
  actor = 'web',
): DefineVersion {
  const req = getRequirement(store, requirementId)
  if (!req) throw new Error(`需求不存在: ${requirementId}`)
  if (!clarifyComplete(store, requirementId)) {
    const open = listQuestions(store, requirementId).filter(q => q.status === 'open').length
    throw new Error(`澄清未完成(${open} 个问题待回答),不允许起草 Define(提案 §3.1 门)`)
  }
  const items = listItems(store, requirementId)
  if (items.length === 0) throw new Error('没有需求条目,不允许起草 Define')
  const now = store.now()
  const version = listDefineVersions(store, requirementId).length + 1
  const id = `DEF-${req.id.replace(/^REQ-/, '')}-v${version}`
  store.db
    .prepare(
      `INSERT INTO define_versions (id, requirement_id, version, body, item_snapshot, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
    )
    .run(id, requirementId, version, JSON.stringify(body), JSON.stringify(items), now)
  store.appendEvent(actor, 'define.draft', { id, requirementId, version, items: items.length })
  return listDefineVersions(store, requirementId).find(def => def.id === id) as DefineVersion
}

export function submitDefine(store: WorkbenchStore, defineId: string, actor = 'web'): DefineVersion {
  const now = store.now()
  const row = store.db.prepare('SELECT * FROM define_versions WHERE id = ?').get(defineId) as
    | Record<string, unknown>
    | undefined
  if (!row) throw new Error(`Define 版本不存在: ${defineId}`)
  if (row.status !== 'draft') throw new Error(`${defineId} 状态为 ${row.status},仅 draft 可提交`)
  store.db
    .prepare("UPDATE define_versions SET status = 'in-review', submitted_at = ? WHERE id = ?")
    .run(now, defineId)
  store.db
    .prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?')
    .run('in-review', now, row.requirement_id as string)
  store.db
    .prepare("UPDATE requirement_items SET status = 'in-review', updated_at = ? WHERE requirement_id = ? AND status = 'proposed'")
    .run(now, row.requirement_id as string)
  store.appendEvent(actor, 'define.submit', { defineId, requirementId: row.requirement_id })
  return listDefineVersions(store, row.requirement_id as string).find(def => def.id === defineId) as DefineVersion
}

export function listReviews(store: WorkbenchStore, targetId?: string): ReviewRecord[] {
  const rows = targetId
    ? store.db.prepare('SELECT * FROM reviews WHERE target_id = ? ORDER BY id DESC').all(targetId)
    : store.db.prepare('SELECT * FROM reviews ORDER BY id DESC LIMIT 50').all()
  return (rows as Array<Record<string, unknown>>).map(row => ({
    id: row.id as number,
    targetId: row.target_id as string,
    decision: row.decision as ReviewRecord['decision'],
    reviewer: row.reviewer as string,
    comments: parse<Array<{ itemId?: string; section?: string; text: string }>>(row.comments, []),
    decidedAt: row.decided_at as string,
  }))
}

/**
 * 三态评审(提案 §3.1,GitHub PR 式):
 * approve → 旧版本 superseded、条目 approved、G1 门禁批准、验收标准物化
 * request-changes → 版本 rejected、需求回 defining、意见留痕(挂条目)
 * comment → 仅意见留痕
 */
export function reviewDefine(
  store: WorkbenchStore,
  input: {
    defineId: string
    decision: 'approve' | 'request-changes' | 'comment'
    reviewer: string
    comments?: Array<{ itemId?: string; section?: string; text: string }>
  },
): { define: DefineVersion; requirement: RequirementRow; staleTasks?: string[] } {
  const now = store.now()
  const row = store.db.prepare('SELECT * FROM define_versions WHERE id = ?').get(input.defineId) as
    | Record<string, unknown>
    | undefined
  if (!row) throw new Error(`Define 版本不存在: ${input.defineId}`)
  if (row.status !== 'in-review') throw new Error(`${input.defineId} 状态为 ${row.status},仅 in-review 可评审`)
  const requirementId = row.requirement_id as string
  const req = getRequirement(store, requirementId)
  if (!req) throw new Error(`需求不存在: ${requirementId}`)

  store.db
    .prepare('INSERT INTO reviews (target_id, decision, reviewer, comments, decided_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.defineId, input.decision, input.reviewer, JSON.stringify(input.comments ?? []), now)
  store.db.prepare('UPDATE define_versions SET decided_at = ? WHERE id = ?').run(now, input.defineId)

  if (input.decision === 'comment') {
    store.appendEvent(input.reviewer, 'define.review', { defineId: input.defineId, decision: 'comment' })
    return {
      define: listDefineVersions(store, requirementId).find(def => def.id === input.defineId) as DefineVersion,
      requirement: req,
    }
  }

  if (input.decision === 'request-changes') {
    store.db
      .prepare("UPDATE define_versions SET status = 'rejected', decided_at = ? WHERE id = ?")
      .run(now, input.defineId)
    store.db
      .prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?')
      .run('defining', now, requirementId)
    store.db
      .prepare("UPDATE requirement_items SET status = 'proposed', updated_at = ? WHERE requirement_id = ?")
      .run(now, requirementId)
    store.appendEvent(input.reviewer, 'define.review', {
      defineId: input.defineId,
      decision: 'request-changes',
      comments: input.comments ?? [],
      sourceRefs: [`define:${input.defineId}`],
    })
    return {
      define: listDefineVersions(store, requirementId).find(def => def.id === input.defineId) as DefineVersion,
      requirement: getRequirement(store, requirementId) as RequirementRow,
    }
  }

  // approve
  store.db.exec("BEGIN IMMEDIATE")
  try {
    store.db
      .prepare("UPDATE define_versions SET status = 'approved', decided_at = ? WHERE id = ?")
      .run(now, input.defineId)
    store.db
      .prepare("UPDATE define_versions SET status = 'superseded' WHERE requirement_id = ? AND id != ? AND status IN ('approved','rejected')")
      .run(requirementId, input.defineId)
    store.db
      .prepare("UPDATE requirement_items SET status = 'approved', updated_at = ? WHERE requirement_id = ?")
      .run(now, requirementId)
    store.db
      .prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?')
      .run('approved', now, requirementId)
    // 验收标准物化(保持 testing/acceptance 链路兼容:AC-{条目}-{序号})
    store.db.prepare('DELETE FROM acceptance_criteria WHERE requirement_id = ?').run(requirementId)
    const insertAc = store.db.prepare(
      `INSERT INTO acceptance_criteria (id, requirement_id, title, method, threshold, max_level, status)
       VALUES (?, ?, ?, ?, ?, ?, 'approved')`,
    )
    for (const item of listItems(store, requirementId)) {
      item.acceptance.forEach((criterion, index) => {
        insertAc.run(
          `${item.id}-AC${index + 1}`,
          requirementId,
          criterion.title,
          criterion.method,
          criterion.threshold ?? null,
          criterion.maxLevel,
        )
      })
    }
    store.db.exec('COMMIT')
  } catch (error) {
    store.db.exec('ROLLBACK')
    throw error
  }

  setGateDecision(store, {
    id: `G1-${requirementId}`,
    scope: `${requirementId} 定义完成(G1)`,
    decision: 'approved',
    signer: input.reviewer,
    conditions: [`define:${input.defineId}`, ...(input.comments ?? []).map(c => `review-comment:${c.text.slice(0, 40)}`)],
  })
  store.appendEvent(input.reviewer, 'define.review', {
    defineId: input.defineId,
    decision: 'approve',
    requirementId,
    sourceRefs: [`define:${input.defineId}`],
  })
  return {
    define: listDefineVersions(store, requirementId).find(def => def.id === input.defineId) as DefineVersion,
    requirement: getRequirement(store, requirementId) as RequirementRow,
  }
}

// ---------- 变更管理(G5 来源分类 + stale 传导) ----------

export interface ChangeOutcome {
  changeId: number
  requirementId: string
  itemId?: string
  source: 'customer' | 'implementation-finding' | 'test-finding'
  staleTasks: string[]
  staleCases: string[]
}

/**
 * 修改已批准条目 → 需求 changed、G1 门禁回 pending、
 * 下游任务标 stale(回 planned,注明原因)、关联用例标需回归。
 */
export function changeItem(
  store: WorkbenchStore,
  input: {
    itemId: string
    content?: string
    acceptance?: ItemAcceptance[]
    source: 'customer' | 'implementation-finding' | 'test-finding'
    summary: string
    detail?: string
  },
  actor = 'web',
): ChangeOutcome {
  const now = store.now()
  const item = listItems(store).find(entry => entry.id === input.itemId)
  if (!item) throw new Error(`条目不存在: ${input.itemId}`)
  const requirementId = item.requirementId

  store.db
    .prepare(
      'UPDATE requirement_items SET content = ?, acceptance = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?',
    )
    .run(
      input.content ?? item.content,
      JSON.stringify(input.acceptance ?? item.acceptance),
      'changed',
      now,
      input.itemId,
    )
  store.db
    .prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?')
    .run('changed', now, requirementId)
  // G1 门禁回到待评审(变更必须重新过门禁)
  setGateDecision(store, {
    id: `G1-${requirementId}`,
    scope: `${requirementId} 定义完成(G1)`,
    decision: 'pending',
    signer: actor,
    conditions: [input.summary],
  })

  // stale 传导:该需求下未终态任务回 planned + stale 原因;终态(succeeded)允许回 planned(重规划例外)
  const staleTasks: string[] = []
  const taskRows = store.db
    .prepare('SELECT id, status, requirement_refs FROM tasks')
    .all() as Array<{ id: string; status: string; requirement_refs: string }>
  for (const task of taskRows) {
    const refs = parse<string[]>(task.requirement_refs, [])
    if (!refs.includes(requirementId)) continue
    staleTasks.push(task.id)
    store.db
      .prepare('UPDATE tasks SET status = ?, stale_reason = ?, blocked_reason = NULL, finished_at = NULL WHERE id = ?')
      .run('planned', `需求 ${requirementId} 变更:${input.summary}(${now.slice(0, 16)})`, task.id)
  }
  const staleCases = parse<string[]>(
    (store.db.prepare('SELECT id FROM test_cases WHERE requirement_refs LIKE ?').get(`%${requirementId}%`) as
      | { id: string }
      | undefined) ?? { id: '' },
    [],
  )
  const caseRows = store.db
    .prepare('SELECT id FROM test_cases')
    .all() as Array<{ id: string }>
  const staleCaseIds = caseRows
    .map(row => row.id)
    .filter(caseId => {
      const refs = parse<string[]>(
        (store.db.prepare('SELECT requirement_refs FROM test_cases WHERE id = ?').get(caseId) as
          | { requirement_refs: string }
          | undefined)?.requirement_refs ?? '[]',
        [],
      )
      return refs.includes(requirementId)
    })
  void staleCases

  store.db
    .prepare(
      `INSERT INTO change_records (requirement_id, item_id, source, summary, detail, stale_tasks, stale_cases, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(requirementId, input.itemId, input.source, input.summary, input.detail ?? null, JSON.stringify(staleTasks), JSON.stringify(staleCaseIds), now)
  store.appendEvent(actor, 'requirement.change', {
    requirementId,
    itemId: input.itemId,
    source: input.source,
    summary: input.summary,
    staleTasks,
    staleCases: staleCaseIds,
    sourceRefs: [`item:${input.itemId}`],
  })
  const changeRow = store.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }
  return { changeId: changeRow.id, requirementId, itemId: input.itemId, source: input.source, staleTasks, staleCases: staleCaseIds }
}

export function listChangeRecords(
  store: WorkbenchStore,
): Array<{
  id: number
  requirementId: string
  itemId?: string
  source: string
  summary: string
  detail?: string
  staleTasks: string[]
  staleCases: string[]
  createdAt: string
}> {
  const rows = store.db.prepare('SELECT * FROM change_records ORDER BY id DESC').all() as Array<
    Record<string, unknown>
  >
  return rows.map(row => ({
    id: row.id as number,
    requirementId: row.requirement_id as string,
    itemId: (row.item_id as string) ?? undefined,
    source: row.source as string,
    summary: row.summary as string,
    detail: (row.detail as string) ?? undefined,
    staleTasks: parse<string[]>(row.stale_tasks, []),
    staleCases: parse<string[]>(row.stale_cases, []),
    createdAt: row.created_at as string,
  }))
}

// ---------- 决策记录(ADR + 修正,G10) ----------

export function addDecision(
  store: WorkbenchStore,
  input: { scope: string; summary: string; rationale?: string; refs?: string[]; kind?: 'adr' | 'correction' },
  actor = 'web',
): void {
  store.db
    .prepare('INSERT INTO decisions (scope, kind, summary, rationale, refs, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(input.scope, input.kind ?? 'adr', input.summary, input.rationale ?? null, JSON.stringify(input.refs ?? []), actor, store.now())
  store.appendEvent(actor, 'decision.record', { scope: input.scope, kind: input.kind ?? 'adr' })
}

export function listDecisions(
  store: WorkbenchStore,
): Array<{ id: number; scope: string; kind: string; summary: string; rationale?: string; refs: string[]; actor: string; createdAt: string }> {
  const rows = store.db.prepare('SELECT * FROM decisions ORDER BY id DESC LIMIT 50').all() as Array<
    Record<string, unknown>
  >
  return rows.map(row => ({
    id: row.id as number,
    scope: row.scope as string,
    kind: row.kind as string,
    summary: row.summary as string,
    rationale: (row.rationale as string) ?? undefined,
    refs: parse<string[]>(row.refs, []),
    actor: row.actor as string,
    createdAt: row.created_at as string,
  }))
}

// ---------- "我的车道"(提案 §3.2 首页数据) ----------

export function laneSummary(store: WorkbenchStore): {
  openQuestions: Array<{ id: string; requirementId: string; question: string }>
  definesInReview: Array<{ id: string; requirementId: string; version: number }>
  changedRequirements: Array<{ id: string; title: string }>
  staleTasks: Array<{ id: string; title: string; staleReason?: string }>
} {
  const openQuestions = listQuestions(store)
    .filter(q => q.status === 'open')
    .map(q => ({ id: q.id, requirementId: q.requirementId, question: q.question }))
  const definesInReview = listDefineVersions(store)
    .filter(def => def.status === 'in-review')
    .map(def => ({ id: def.id, requirementId: def.requirementId, version: def.version }))
  const changedRequirements = listRequirements(store)
    .filter(req => req.status === 'changed')
    .map(req => ({ id: req.id, title: req.title }))
  const staleTasks = (store.db.prepare('SELECT id, title, stale_reason FROM tasks WHERE stale_reason IS NOT NULL').all() as Array<
    { id: string; title: string; stale_reason?: string }
  >).map(row => ({ id: row.id, title: row.title, staleReason: row.stale_reason ?? undefined }))
  return { openQuestions, definesInReview, changedRequirements, staleTasks }
}
