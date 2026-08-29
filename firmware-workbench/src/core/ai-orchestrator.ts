import { spawn } from 'node:child_process'
import type { WorkbenchStore } from './store.js'
import { addQuestion, proposeItem, draftDefine, submitDefine, listQuestions, getRequirement } from './align.js'

/**
 * AI 编排层(工作流提案 §3.3,P-C 提前落地 —— 用户判定"没有真模型就是形式化"):
 * 通过 DSH headless 会话调用 DSH 配置的模型(DeepSeek 官方或自定义提供方),
 * key/审批/会话管理全部留在 DSH 体系内,工作台不持有凭据。
 *
 * 约定:模型输出必须为 JSON;解析失败时返回 raw 由前端展示降级路径(手动填)。
 * 未配置 key 时 spawn 会快速失败(MISSING_CREDENTIAL),错误原文透传给操作者。
 */

export interface AiRunResult {
  ok: boolean
  output?: string
  raw?: string
  error?: string
}

function dshEntryPath(): string {
  // 与工作台同机的 DSH runtime:优先环境变量,其次默认成品布局
  const explicit = process.env.WB_DSH_ENTRY
  if (explicit) return explicit
  const nodeModules = process.env.DSH_PRINTER_WORKBENCH_DSH_RUNTIME
  if (nodeModules) return join(nodeModules, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return join('runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function join(...parts: string[]): string {
  return parts.join('/')
}

export async function runHeadless(
  _store: WorkbenchStore,
  prompt: string,
  opts: { timeoutMs?: number } = {},
): Promise<AiRunResult> {
  const entry = dshEntryPath()
  const nodeExe = process.execPath
  const timeoutMs = opts.timeoutMs ?? 180_000
  const args = [entry, '--profile', 'headless', prompt]

  return new Promise(resolve => {
    const child = spawn(nodeExe, args, {
      shell: false,
      windowsHide: true,
      env: { ...process.env, DSH_HOME: process.env.DSH_HOME ?? '' },
      cwd: process.env.WB_DSH_CWD ?? process.cwd(),
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      err += '\n[ai] 超时(180s)'
    }, timeoutMs)
    child.stdout?.on('data', data => {
      out += String(data)
    })
    child.stderr?.on('data', data => {
      err += String(data)
    })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ ok: false, error: `AI 进程启动失败: ${error.message}` })
    })
    child.on('exit', code => {
      clearTimeout(timer)
      if (code === 0 && out.trim()) {
        resolve({ ok: true, output: out.trim(), raw: out })
      } else {
        const message = [err.trim(), out.trim()].filter(Boolean).join('\n') || `exit ${code}`
        resolve({ ok: false, raw: message, error: extractCredentialHint(message) ?? `AI 任务失败(exit ${code})` })
      }
    })
  })
}

function extractCredentialHint(message: string): string | null {
  if (message.includes('MISSING_CREDENTIAL')) {
    return '模型未配置:请在 DSH 页面 设置 → 模型 → DeepSeek 填入 API 密钥(或在启动环境导出 DEEPSEEK_API_KEY),然后重试'
  }
  return null
}

/** 从模型输出中提取 JSON(宽容:```json 块 / 首个 [ 或 { 起) */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1]! : text
  const start = candidate.search(/[[{]/)
  if (start === -1) return null
  const openChar = candidate[start]
  const closeChar = openChar === '[' ? ']' : '}'
  const end = candidate.lastIndexOf(closeChar)
  if (end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

// ---------- AI 节点:澄清问题 ----------

interface ClarifyDraft {
  question: string
  why?: string
  options?: string[]
}

export async function aiClarifyQuestions(
  store: WorkbenchStore,
  requirementId: string,
  actor = 'web',
): Promise<{ ok: boolean; added: number; error?: string; raw?: string }> {
  const requirement = getRequirement(store, requirementId)
  if (!requirement) throw new Error(`需求不存在: ${requirementId}`)
  const existing = listQuestions(store, requirementId)

  const contextPack = [
    `你是打印机固件研发的需求澄清专家。下面是一条原始需求,请识别其中未明确、但会直接影响架构与验收的盲点,生成 3-6 个澄清问题。`,
    ``,
    `【原始需求】`,
    requirement.title,
    requirement.originalText ?? '(无详情)',
    ``,
    existing.length > 0 ? `【已有问题(不要重复)】\n${existing.map(q => `- ${q.question}`).join('\n')}` : '',
    ``,
    `【输出要求】只输出 JSON 数组,不要任何其他文字,格式:`,
    `[{"question":"问题","why":"为什么必须问(影响什么架构/验收决策)","options":["选项1","选项2"]}]`,
  ]
    .filter(Boolean)
    .join('\n')

  const result = await runHeadless(store, contextPack)
  if (!result.ok) {
    store.appendEvent(actor, 'ai.clarify_failed', { requirementId, error: result.error })
    return { ok: false, added: 0, error: result.error, raw: result.raw }
  }
  const drafts = extractJson<ClarifyDraft[]>(result.output ?? '')
  if (!Array.isArray(drafts) || drafts.length === 0) {
    store.appendEvent(actor, 'ai.clarify_unparsed', { requirementId })
    return { ok: false, added: 0, error: '模型输出无法解析为问题清单(原文见 raw)', raw: result.output }
  }
  let added = 0
  for (const draft of drafts) {
    if (!draft.question) continue
    addQuestion(
      store,
      {
        requirementId,
        question: draft.question,
        why: draft.why,
        options: draft.options ?? [],
        origin: 'ai-draft',
        sourceRefs: [`requirement:${requirementId}`, 'ai:headless'],
      },
      actor,
    )
    added += 1
  }
  store.appendEvent(actor, 'ai.clarify_done', { requirementId, added })
  return { ok: true, added }
}

// ---------- AI 节点:Define 起草 ----------

interface DefineDraft {
  items: Array<{ content: string; acceptance: Array<{ title: string; method?: string; threshold?: string; maxLevel?: string }> }>
  normalFlow: string[]
  errorFlows: string[]
  recoveryRules: string[]
}

export async function aiDraftDefine(
  store: WorkbenchStore,
  requirementId: string,
  actor = 'web',
): Promise<{ ok: boolean; defineId?: string; items?: number; error?: string; raw?: string }> {
  const requirement = getRequirement(store, requirementId)
  if (!requirement) throw new Error(`需求不存在: ${requirementId}`)
  if (!clarifyClosed(store, requirementId)) {
    const open = listQuestions(store, requirementId).filter(q => q.status === 'open').length
    return { ok: false, error: `澄清未完成(${open} 个问题待回答);请先回答问题或补充答案` }
  }
  const answers = listQuestions(store, requirementId)
    .filter(q => q.status === 'answered')
    .map(q => `Q: ${q.question}\nA: ${q.answer}`)

  const contextPack = [
    '你是打印机固件的系统分析师。基于原始需求与澄清答案,产出原子需求条目与工程化 Define。',
    '',
    `【原始需求】${requirement.title}\n${requirement.originalText ?? ''}`,
    '',
    '【澄清答案】',
    answers.join('\n\n'),
    '',
    '【输出要求】只输出 JSON,格式:',
    '{"items":[{"content":"条目描述(可独立验收)","acceptance":[{"title":"验收标准","method":"automated|manual","threshold":"通过阈值","maxLevel":"L1|L4"}]}],',
    ' "normalFlow":["步骤"],"errorFlows":["异常与错误码"],"recoveryRules":["恢复策略"]}',
    '要求:条目 2-4 条;normalFlow/errorFlows/recoveryRules 各 2-5 条;maxLevel 模拟层用 L1、需真机用 L4。',
  ].join('\n')

  const result = await runHeadless(store, contextPack)
  if (!result.ok) {
    store.appendEvent(actor, 'ai.define_failed', { requirementId, error: result.error })
    return { ok: false, error: result.error, raw: result.raw }
  }
  const draft = extractJson<DefineDraft>(result.output ?? '')
  if (!draft || !Array.isArray(draft.items) || draft.items.length === 0) {
    return { ok: false, error: '模型输出无法解析为 Define(原文见 raw)', raw: result.output }
  }
  for (const item of draft.items) {
    proposeItem(
      store,
      {
        requirementId,
        content: item.content,
        acceptance: (item.acceptance ?? []).map(criterion => ({
          title: criterion.title,
          method: criterion.method === 'manual' ? 'manual' : criterion.method === 'instrument' ? 'instrument' : 'automated',
          threshold: criterion.threshold,
          maxLevel: criterion.maxLevel === 'L4' ? 'L4' : 'L1',
        })),
        origin: 'ai-draft',
      },
      actor,
    )
  }
  const define = draftDefine(store, requirementId, {
    normalFlow: draft.normalFlow ?? [],
    errorFlows: draft.errorFlows ?? [],
    recoveryRules: draft.recoveryRules ?? [],
    note: 'AI 起草(headless),待人工评审',
  }, actor)
  submitDefine(store, define.id, actor)
  store.appendEvent(actor, 'ai.define_done', { requirementId, defineId: define.id, items: draft.items.length })
  return { ok: true, defineId: define.id, items: draft.items.length }
}

function clarifyClosed(store: WorkbenchStore, requirementId: string): boolean {
  return !listQuestions(store, requirementId).some(q => q.status === 'open')
}
