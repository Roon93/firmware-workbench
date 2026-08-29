/** 引导式流程 v2(工作流提案 §3.1):输入需求 → 澄清问答 → 条目与 Define 三态评审 → 契约 → 逐任务执行 → 验收。 */

import { useState } from 'react'
import {
  fetchJson,
  STATUS_LABELS,
  timeShort,
  type ItemView,
  type TaskView,
  type WbData,
} from './model.js'
import { Icon, StatusChip, Terminal, ViewHead } from './ui.js'
import { DevicePanel, JobTimeline } from './device.js'

interface WalkStep {
  key: string
  title: string
  why: string
  done: (ctx: WalkContext) => boolean
}

interface WalkContext {
  data: WbData
  reqId: string
}

export function WalkthroughView(props: { data: WbData; onGotoAcceptance: () => void }): React.JSX.Element {
  const { data } = props
  const requirements = data.snapshot?.requirements ?? []
  // 操作焦点:第一个未 approved 的需求(默认);可手动切换
  const [focusId, setFocusId] = useState<string | null>(null)
  const reqId =
    focusId && requirements.some(req => req.id === focusId)
      ? focusId
      : requirements.find(req => req.status !== 'approved')?.id ?? requirements[0]?.id ?? ''
  const requirement = requirements.find(req => req.id === reqId)

  const ctx: WalkContext = { data, reqId }
  const steps: WalkStep[] = [
    { key: 'req', title: '导入需求', why: 'P0 需求接收', done: () => requirements.length > 0 },
    {
      key: 'clarify',
      title: '澄清问答',
      why: '逐题回答,关闭全部盲点',
      done: () => {
        const questions = requirement?.questions ?? []
        return questions.length > 0 && questions.every(q => q.status !== 'open')
      },
    },
    {
      key: 'define',
      title: '条目与 Define 评审',
      why: 'approve / request-changes / comment',
      done: () => (requirement?.defines ?? []).some(define => define.status === 'approved'),
    },
    {
      key: 'contract',
      title: '冻结契约,批准 G3',
      why: 'G3 契约基线',
      done: () => (data.snapshot?.gates ?? []).some(gate => gate.id === 'G3-CONTRACT-BASELINE' && gate.decision === 'approved'),
    },
    {
      key: 'dev',
      title: '五路并行开发',
      why: 'P4 工作包',
      done: () => doneIds(data, ['TASK-COPY-0010', 'TASK-COPY-0011', 'TASK-COPY-0012', 'TASK-COPY-0013', 'TASK-COPY-0014']),
    },
    {
      key: 'selftest',
      title: '组件自测',
      why: '交付即自测',
      done: () => doneIds(data, ['TASK-COPY-0010-T', 'TASK-COPY-0011-T', 'TASK-COPY-0012-T', 'TASK-COPY-0013-T', 'TASK-COPY-0014-T']),
    },
    { key: 'integrate', title: '模拟集成', why: 'L1 主流程', done: () => taskStatus(data, 'TASK-COPY-0030') === 'succeeded' },
    { key: 'recovery', title: '异常恢复套件', why: '必选异常', done: () => taskStatus(data, 'TASK-COPY-0031') === 'succeeded' },
    { key: 'accept', title: '验收评估 + 证据包', why: '独立验收', done: () => !!data.snapshot?.acceptance },
    { key: 'queue', title: '真机队列(预期等待)', why: 'Phase 0', done: () => true },
  ]

  const firstUndone = steps.find(step => !step.done(ctx))?.key
  const [openKey, setOpenKey] = useState<string | null>('clarify')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<Array<{ ts: string; level: 'info' | 'warn' | 'error'; text: string }>>([])
  const activeKey = openKey ?? firstUndone ?? 'req'
  const completed = steps.filter(step => step.done(ctx)).length

  const addLog = (level: 'info' | 'warn' | 'error', text: string): void => {
    setLog(prev => [...prev.slice(-200), { ts: new Date().toISOString(), level, text }])
  }
  const post = async (path: string, body: Record<string, unknown> = {}, okText?: string): Promise<boolean> => {
    setBusy(true)
    try {
      await fetchJson(path, { method: 'POST', body: JSON.stringify(body) })
      if (okText) addLog('info', `✓ ${okText}`)
      await data.refresh()
      return true
    } catch (error) {
      addLog('error', `✗ ${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      setBusy(false)
    }
  }

  const shared: StepProps = { data, reqId, busy, post, addLog }

  return (
    <div className="wb-view wb-view--wide">
      <ViewHead
        title="引导式流程"
        sub={`对齐 → 推进 → 开发 · 已完成 ${completed}/${steps.length}`}
        actions={
          <>
            <StatusChip status={completed === steps.length ? 'PASS' : 'running'} label={completed === steps.length ? '闭环完成' : '进行中'} />
            {requirements.length > 1 && (
              <select
                className="wb-input"
                style={{ width: 'auto', padding: '4px 8px', fontSize: 12 }}
                value={reqId}
                onChange={event => setFocusId(event.target.value)}
              >
                {requirements.map(req => (
                  <option key={req.id} value={req.id}>
                    {req.id} {req.title}({STATUS_LABELS[req.status] ?? req.status})
                  </option>
                ))}
              </select>
            )}
            <button className="wb-btn wb-btn--ghost" onClick={() => void post('/demo/reset', {}, '工程已重置')}>
              <Icon name="rotate-ccw" size={12} /> 重置工程
            </button>
          </>
        }
      />

      {/* 需求清单(多需求,提案 G2) */}
      {requirements.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 'var(--wb-sp-3)' }}>
          {requirements.map(req => (
            <button
              key={req.id}
              className={`wb-task-row${req.id === reqId ? ' wb-scene-btn--active' : ''}`}
              style={{ cursor: 'pointer', flex: 'none' }}
              onClick={() => setFocusId(req.id)}
            >
              <StatusChip status={req.status} label={STATUS_LABELS[req.status] ?? req.status} />
              <span className="wb-mono" style={{ fontSize: 11 }}>{req.id}</span>
              <span style={{ fontSize: 12 }}>{req.title}</span>
              {(req.openQuestions ?? 0) > 0 && <span className="wb-faint" style={{ fontSize: 11 }}>{req.openQuestions} 题待答</span>}
            </button>
          ))}
        </div>
      )}

      <div className="wb-walk">
        <StepCard step={steps[0]!} {...shared} openKey={activeKey} setOpenKey={setOpenKey}>
          <ImportStep shared={shared} />
        </StepCard>
        <StepCard step={steps[1]!} {...shared} openKey={activeKey} setOpenKey={setOpenKey}>
          <ClarifyStep shared={shared} />
        </StepCard>
        <StepCard step={steps[2]!} {...shared} openKey={activeKey} setOpenKey={setOpenKey}>
          <DefineStep shared={shared} />
        </StepCard>
        <StepCard step={steps[3]!} {...shared} openKey={activeKey} setOpenKey={setOpenKey}>
          <ContractStep shared={shared} />
        </StepCard>
        <StepCard step={steps[4]!} {...shared} openKey={activeKey} setOpenKey={setOpenKey}>
          <TaskGroupRun shared={shared} ids={['TASK-COPY-0010', 'TASK-COPY-0011', 'TASK-COPY-0012', 'TASK-COPY-0013', 'TASK-COPY-0014']} groupLabel="五个工作包共享 build/rk3588 构建资源,资源租约保证互不干扰" />
        </StepCard>
        <StepCard step={steps[5]!} {...shared} openKey={activeKey} setOpenKey={setOpenKey}>
          <TaskGroupRun shared={shared} ids={['TASK-COPY-0010-T', 'TASK-COPY-0011-T', 'TASK-COPY-0012-T', 'TASK-COPY-0013-T', 'TASK-COPY-0014-T']} groupLabel="每个包的 L1 自测:契约不变式在集成前先验证" />
        </StepCard>
        <StepCard step={steps[6]!} {...shared} openKey={activeKey} setOpenKey={setOpenKey}>
          <IntegrationStep shared={shared} />
        </StepCard>
        <StepCard step={steps[7]!} {...shared} openKey={activeKey} setOpenKey={setOpenKey}>
          <RecoveryStep shared={shared} />
        </StepCard>
        <StepCard step={steps[8]!} {...shared} openKey={activeKey} setOpenKey={setOpenKey}>
          <AcceptStep shared={shared} onGotoAcceptance={props.onGotoAcceptance} />
        </StepCard>
        <StepCard step={steps[9]!} {...shared} openKey={activeKey} setOpenKey={setOpenKey}>
          <QueueStep shared={shared} />
        </StepCard>
      </div>

      {/* 变更传导(提案 §3.2):需求 changed 时任务被打回的可视化 */}
      {(data.snapshot?.lane?.staleTasks.length ?? 0) > 0 && (
        <div className="wb-banner" style={{ marginTop: 'var(--wb-sp-3)' }}>
          需求变更传导:{data.snapshot?.lane?.staleTasks.length} 个任务已打回待重评估
          {data.snapshot?.lane?.staleTasks[0]?.staleReason ? `(最近原因:${data.snapshot.lane.staleTasks[0]!.staleReason})` : ''}
        </div>
      )}

      <div style={{ marginTop: 'var(--wb-sp-3)' }}>
        <div className="wb-side__title" style={{ marginBottom: 6 }}>操作日志</div>
        <Terminal lines={log} height={160} />
      </div>
    </div>
  )
}

// ---------- 基础设施 ----------

interface StepProps {
  data: WbData
  reqId: string
  busy: boolean
  post: (path: string, body?: Record<string, unknown>, okText?: string) => Promise<boolean>
  addLog: (level: 'info' | 'warn' | 'error', text: string) => void
}

function taskStatus(data: WbData, id: string): string {
  return data.tasks.find(task => task.id === id)?.status ?? 'planned'
}

function doneIds(data: WbData, ids: string[]): boolean {
  return ids.every(id => taskStatus(data, id) === 'succeeded')
}

function StepCard(props: StepProps & { step: WalkStep; openKey: string; setOpenKey: (key: string | null) => void; children: React.ReactNode }): React.JSX.Element {
  const done = props.step.done({ data: props.data, reqId: props.reqId })
  const cls = done ? 'wb-walk-step--done' : props.openKey === props.step.key ? 'wb-walk-step--active' : ''
  return (
    <div className={`wb-walk-step ${cls}`}>
      <div className="wb-walk-step__head" onClick={() => props.setOpenKey(props.openKey === props.step.key ? null : props.step.key)}>
        <span className="wb-walk-step__num">{done ? '✓' : props.step.key.slice(0, 1).toUpperCase()}</span>
        <span className="wb-walk-step__title">{props.step.title}</span>
        <StatusChip status={done ? 'succeeded' : props.openKey === props.step.key ? 'ready' : 'planned'} label={done ? '已完成' : props.openKey === props.step.key ? '进行中' : STATUS_LABELS.planned} />
        <span className="wb-walk-step__why">{props.step.why}</span>
        <Icon name="chevron" size={13} />
      </div>
      {props.openKey === props.step.key && <div className="wb-walk-step__body">{props.children}</div>}
    </div>
  )
}

// ---------- 步骤 1:导入需求 ----------

function ImportStep(props: { shared: StepProps }): React.JSX.Element {
  const data = props.shared.data
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  return (
    <>
      <div className="wb-faint" style={{ fontSize: 12 }}>
        大需求直接写进来(自由文本)。导入后自动生成模板澄清问题;多需求并存,互不阻塞。
      </div>
      <input className="wb-input" placeholder="需求标题" value={title} onChange={event => setTitle(event.target.value)} />
      <textarea
        className="wb-textarea"
        placeholder="原始需求描述(多大都行,澄清阶段会逐题对齐)…"
        value={text}
        onChange={event => setText(event.target.value)}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          className="wb-btn wb-btn--primary"
          disabled={props.shared.busy || !title.trim() || !text.trim()}
          onClick={() => {
            void props.shared.post('/requirement/import', { title, text }, `需求已导入:${title}`).then(() => {
              setTitle('')
              setText('')
            })
          }}
        >
          <Icon name="chevron" size={12} /> 导入需求
        </button>
        <span className="wb-faint" style={{ fontSize: 12 }}>
          已有 {data.snapshot?.requirements?.length ?? 0} 条需求
        </span>
      </div>
    </>
  )
}

// ---------- 步骤 2:澄清问答 ----------

function ClarifyStep(props: { shared: StepProps }): React.JSX.Element {
  const { shared } = props
  const requirement = shared.data.snapshot?.requirements?.find(req => req.id === shared.reqId)
  const questions = requirement?.questions ?? []
  const open = questions.filter(q => q.status === 'open')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [newQuestion, setNewQuestion] = useState('')

  const [aiRunning, setAiRunning] = useState(false)
  const aiDraft = async (): Promise<void> => {
    setAiRunning(true)
    shared.addLog('info', 'AI 正在分析需求并起草澄清问题(约 30-90 秒)…')
    try {
      const result = await fetchJson<{ ok: boolean; added?: number; error?: string }>('/ai/clarify', {
        method: 'POST',
        body: JSON.stringify({ requirementId: shared.reqId }),
      })
      shared.addLog('info', `✓ AI 起草了 ${result.added ?? 0} 个澄清问题(已进入清单,待你回答)`)
      await shared.data.refresh()
    } catch (error) {
      shared.addLog('error', `✗ AI 起草失败:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setAiRunning(false)
    }
  }

  if (questions.length === 0) {
    return (
      <>
        <div className="wb-faint" style={{ fontSize: 12 }}>该需求还没有澄清问题。让 AI 分析需求起草问题,或手动补充。</div>
        <button className="wb-btn wb-btn--primary" disabled={shared.busy || aiRunning} onClick={() => void aiDraft()}>
          <Icon name="zap" size={12} /> {aiRunning ? 'AI 分析中…(30-90 秒)' : 'AI 起草澄清问题'}
        </button>
        <div className="wb-faint" style={{ fontSize: 11 }}>需要 DSH 已配置模型(设置 → 模型);未配置时会给出明确提示,仍可手动加问题。</div>
      </>
    )
  }

  return (
    <>
      <div className="wb-faint" style={{ fontSize: 12 }}>
        逐题回答(选项仅供参考)。全部回答后才能生成需求条目与 Define —— 这是"对齐"的核心环节。
        {open.length === 0 && <strong style={{ color: 'var(--wb-st-succeeded)' }}> 已全部回答,可以进入下一步。</strong>}
      </div>
      {questions.map(question => (
        <div key={question.id} className="wb-task-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="wb-mono" style={{ fontSize: 11, color: 'var(--wb-text-3)' }}>{question.id}</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{question.question}</span>
            {question.status === 'answered' ? <StatusChip status="succeeded" label="已回答" /> : <StatusChip status="blocked_gate" label="待回答" />}
          </div>
          {question.why && <div className="wb-faint" style={{ fontSize: 11 }}>为什么要问:{question.why}</div>}
          {question.status === 'answered' ? (
            <div className="wb-quote" style={{ marginBottom: 0 }}>{question.answer}</div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              {question.options.length > 0 && (
                <select
                  className="wb-input"
                  style={{ width: 'auto' }}
                  value={answers[question.id] ?? ''}
                  onChange={event => setAnswers(prev => ({ ...prev, [question.id]: event.target.value }))}
                >
                  <option value="">选择一项或自行输入…</option>
                  {question.options.map(option => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              )}
              <input
                className="wb-input"
                placeholder="你的回答"
                value={answers[question.id] ?? ''}
                onChange={event => setAnswers(prev => ({ ...prev, [question.id]: event.target.value }))}
              />
              <button
                className="wb-btn wb-btn--primary"
                disabled={shared.busy || !(answers[question.id] ?? '').trim()}
                onClick={() => {
                  void shared.post('/clarify/answer', { questionId: question.id, answer: answers[question.id] }, `${question.id} 已回答`).then(() => {
                    setAnswers(prev => {
                      const next = { ...prev }
                      delete next[question.id]
                      return next
                    })
                  })
                }}
              >
                回答
              </button>
            </div>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="wb-btn" disabled={shared.busy || aiRunning} onClick={() => void aiDraft()}>
          <Icon name="zap" size={12} /> {aiRunning ? 'AI 分析中…' : 'AI 追加盲点问题'}
        </button>
        <input
          className="wb-input"
          placeholder="补充问题(可选)…"
          value={newQuestion}
          onChange={event => setNewQuestion(event.target.value)}
        />
        <button
          className="wb-btn"
          disabled={shared.busy || !newQuestion.trim()}
          onClick={() => {
            void shared.post('/clarify/add', { requirementId: shared.reqId, question: newQuestion }, '问题已加入清单').then(() => setNewQuestion(''))
          }}
        >
          加问题
        </button>
      </div>
    </>
  )
}

// ---------- 步骤 3:条目 + Define 三态评审 ----------

function DefineStep(props: { shared: StepProps }): React.JSX.Element {
  const { shared } = props
  const requirement = shared.data.snapshot?.requirements?.find(req => req.id === shared.reqId)
  const items: ItemView[] = requirement?.items ?? []
  const defines = requirement?.defines ?? []
  const current = defines.at(-1)
  const [reviewComment, setReviewComment] = useState('')
  const [aiRunning, setAiRunning] = useState(false)
  const approved = defines.some(define => define.status === 'approved')

  const draft = async (): Promise<void> => {
    // 条目模板:从澄清答案映射(演示模板);已条目化则直接起草
    if (items.length === 0) {
      const ok = await shared.post(
        '/items/propose',
        {
          requirementId: shared.reqId,
          content: '按澄清答案生成的核心需求条目(从模板映射;可在评审意见中修订)',
          acceptance: [{ title: '模拟层:核心场景通过', method: 'automated', threshold: '按用例断言', maxLevel: 'L1' }],
          origin: 'clarify-template',
        },
        '需求条目已生成',
      )
      if (!ok) return
    }
    if (!(await shared.post('/define/draft', { requirementId: shared.reqId, body: { note: '引导流程起草' } }, 'Define 草稿已生成'))) return
    await shared.post('/define/submit', { defineId: latestDraftId(shared) }, 'Define 已提交评审(in-review)')
  }

  return (
    <>
      <div className="wb-faint" style={{ fontSize: 12 }}>
        需求条目化 → 起草 Define → 提交评审。评审三态:批准(G1 门禁)/ 要求修改(意见挂条目,打回修订 vN+1)/ 仅评论。
      </div>

      {items.length > 0 && (
        <div className="wb-check-list">
          {items.map(item => (
            <div key={item.id} className="wb-task-row">
              <span className="wb-task-row__id">{item.id}</span>
              <span className="wb-task-row__title" style={{ whiteSpace: 'normal' }}>{item.content}</span>
              <StatusChip status={item.status} label={STATUS_LABELS[item.status] ?? item.status} />
              {item.acceptance.map((criterion, index) => (
                <StatusChip key={index} status={criterion.maxLevel} label={criterion.maxLevel} />
              ))}
            </div>
          ))}
        </div>
      )}

      {defines.length > 0 && (
        <div className="wb-check-list">
          {defines.map(define => (
            <div key={define.id} className="wb-task-row">
              <span className="wb-mono">{define.id}</span>
              <StatusChip status={define.status === 'approved' ? 'succeeded' : define.status === 'in-review' ? 'ready' : define.status === 'rejected' ? 'failed_test' : 'planned'} label={define.status} />
              {define.submittedAt && <span className="wb-faint" style={{ fontSize: 11 }}>提交 {timeShort(define.submittedAt)}</span>}
            </div>
          ))}
        </div>
      )}

      {!approved && current?.status !== 'in-review' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="wb-btn wb-btn--primary"
              disabled={shared.busy || aiRunning}
              onClick={() => {
                setAiRunning(true)
                shared.addLog('info', 'AI 正在基于澄清答案起草条目与 Define(约 30-90 秒)…')
                fetchJson<{ ok: boolean; defineId?: string; items?: number; error?: string }>('/ai/define', {
                  method: 'POST',
                  body: JSON.stringify({ requirementId: shared.reqId }),
                })
                  .then(async result => {
                    shared.addLog('info', `✓ AI 起草 ${result.items ?? 0} 条条目并提交 Define ${result.defineId ?? ''}(in-review,待你评审)`)
                    await shared.data.refresh()
                  })
                  .catch(error => {
                    shared.addLog('error', `✗ AI 起草失败:${error instanceof Error ? error.message : String(error)}`)
                  })
                  .finally(() => setAiRunning(false))
              }}
            >
              <Icon name="zap" size={12} /> {aiRunning ? 'AI 分析中…(30-90 秒)' : 'AI 起草条目与 Define(提交评审)'}
            </button>
            <button className="wb-btn" disabled={shared.busy || aiRunning} onClick={() => void draft()}>
              <Icon name="file-text" size={12} /> 手动起草(模板)
            </button>
          </div>
          <div className="wb-faint" style={{ fontSize: 11 }}>
            AI 将基于原始需求与你的澄清答案起草;产出进入 in-review 待评审态——你仍是签署方。需要 DSH 已配置模型。
          </div>
        </div>
      )}

      {current?.status === 'in-review' && (
        <>
          <div className="wb-banner" style={{ borderColor: 'var(--wb-accent)', color: 'var(--wb-accent)', background: 'var(--wb-accent-bg)' }}>
            Define {current.id} 评审中:请做出评审决定(这一步就是"对齐"——批准或打回)
          </div>
          <input
            className="wb-input"
            placeholder="要求修改时的意见(挂到条目,例如:恢复策略未定义)"
            value={reviewComment}
            onChange={event => setReviewComment(event.target.value)}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="wb-btn wb-btn--primary"
              disabled={shared.busy}
              onClick={() => void shared.post('/define/review', { defineId: current.id, decision: 'approve', reviewer: 'web' }, `G1 批准:${current.id}`)}
            >
              <Icon name="check" size={12} /> 批准(G1 门禁)
            </button>
            <button
              className="wb-btn"
              disabled={shared.busy}
              onClick={() => {
                void shared
                  .post('/define/review', {
                    defineId: current.id,
                    decision: 'request-changes',
                    reviewer: 'web',
                    comments: [{ text: reviewComment || '需要修改' }],
                  }, '已要求修改(打回)')
                  .then(() => setReviewComment(''))
              }}
            >
              <Icon name="alert" size={12} /> 要求修改
            </button>
            <button
              className="wb-btn wb-btn--ghost"
              disabled={shared.busy}
              onClick={() => {
                void shared
                  .post('/define/review', { defineId: current.id, decision: 'comment', reviewer: 'web', comments: [{ text: reviewComment || '备注' }] })
                  .then(() => setReviewComment(''))
              }}
            >
              仅评论
            </button>
          </div>
        </>
      )}

      {approved && (
        <div className="wb-banner wb-banner--ok">
          Define 已批准(G1 ✓):验收标准已物化,任务 DAG 解锁。后续修改需求条目会触发变更传导(任务打回 stale)。
        </div>
      )}
    </>
  )
}

function latestDraftId(shared: StepProps): string {
  const requirement = shared.data.snapshot?.requirements?.find(req => req.id === shared.reqId)
  const draft = requirement?.defines?.filter(define => define.status === 'draft').at(-1)
  return draft?.id ?? ''
}

// ---------- 步骤 4:契约冻结 ----------

const CONTRACT_NAMES = ['IF-JOB-MANAGER', 'IF-SCANNER', 'IF-IMAGE-BUFFER', 'IF-ENGINE', 'IF-PANEL-UI']

function ContractStep(props: { shared: StepProps }): React.JSX.Element {
  const g3 = props.shared.data.snapshot?.gates?.find(gate => gate.id === 'G3-CONTRACT-BASELINE')
  const approved = g3?.decision === 'approved'
  return (
    <>
      <div className="wb-faint" style={{ fontSize: 12 }}>五个模块的接口契约:先签接口再并行开发。冻结后不可修改,变更必须开新版本(方案 4.3)。</div>
      <div className="wb-check-list">
        {CONTRACT_NAMES.map(name => (
          <div key={name} className="wb-check-item">
            <span className="wb-mono">{name}</span>
            <span style={{ flex: 1 }} />
            {approved ? <StatusChip status="succeeded" label="frozen v1" /> : <span className="wb-faint">draft</span>}
          </div>
        ))}
      </div>
      <button className="wb-btn wb-btn--primary" disabled={props.shared.busy || approved} onClick={() => void props.shared.post('/contracts/freeze', {}, '契约冻结 + G3 门禁批准')}>
        <Icon name="shield-check" size={12} /> {approved ? '契约已冻结,门禁已批准(G3 ✓)' : '冻结全部契约并批准 G3 门禁'}
      </button>
    </>
  )
}

// ---------- 步骤 5/6:任务组运行 ----------

function TaskGroupRun(props: { shared: StepProps; ids: string[]; groupLabel: string }): React.JSX.Element {
  const [runningId, setRunningId] = useState<string | null>(null)
  const runOne = async (taskId: string): Promise<void> => {
    setRunningId(taskId)
    props.shared.addLog('info', `▶ 运行 ${taskId}`)
    try {
      await fetchJson('/run-task', { method: 'POST', body: JSON.stringify({ taskId, humanAutoAccept: true }) })
      props.shared.addLog('info', `✓ ${taskId} 完成`)
    } catch (error) {
      props.shared.addLog('error', `✗ ${taskId}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setRunningId(null)
      await props.shared.data.refresh()
    }
  }
  const runAll = async (): Promise<void> => {
    for (const id of props.ids) {
      if (taskStatus(props.shared.data, id) !== 'succeeded') await runOne(id)
    }
  }
  const allDone = props.ids.every(id => taskStatus(props.shared.data, id) === 'succeeded')
  return (
    <>
      <div className="wb-faint" style={{ fontSize: 12 }}>{props.groupLabel}</div>
      <div className="wb-check-list">
        {props.ids.map(id => {
          const status = taskStatus(props.shared.data, id)
          const task = props.shared.data.tasks.find(item => item.id === id)
          return (
            <div key={id} className="wb-task-row">
              <span className="wb-task-row__id">{id.replace('TASK-COPY-', 'TC-')}</span>
              <span className="wb-task-row__title">{task?.title ?? id}</span>
              {task?.staleReason && <span className="wb-faint" style={{ fontSize: 10 }}>↻ stale</span>}
              <StatusChip status={status} />
              {status !== 'succeeded' && (
                <button className="wb-btn wb-btn--sm" disabled={props.shared.busy || runningId !== null} onClick={() => void runOne(id)}>
                  {runningId === id ? '运行中…' : '▶ 运行'}
                </button>
              )}
            </div>
          )
        })}
      </div>
      <button className="wb-btn wb-btn--primary" disabled={props.shared.busy || runningId !== null || allDone} onClick={() => void runAll()}>
        <Icon name="play" size={12} /> {allDone ? '全部完成 ✓' : '全部运行'}
      </button>
    </>
  )
}

// ---------- 步骤 7:模拟集成 ----------

function IntegrationStep(props: { shared: StepProps }): React.JSX.Element {
  const task = props.shared.data.tasks.find(item => item.id === 'TASK-COPY-0030')
  const [previewing, setPreviewing] = useState(false)
  const preview = async (): Promise<void> => {
    setPreviewing(true)
    await fetchJson('/sim/run', { method: 'POST', body: JSON.stringify({ scenario: 'success', slow: true }) })
    await props.shared.data.refreshSim()
    for (let i = 0; i < 40; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 500))
      const sim = await fetchJson<import('./model.js').SimState>('/sim/state')
      if (sim.job?.finished) break
    }
    setPreviewing(false)
    props.shared.addLog('info', '虚拟面板预演完成(COMPLETED,出纸 1 页)')
  }
  return (
    <>
      <div className="wb-faint" style={{ fontSize: 12 }}>五件套合体:虚拟设备完整跑一遍"扫描 → 图像 → 出纸"(L1 整机)。</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="wb-btn wb-btn--primary"
          disabled={props.shared.busy || task?.status === 'succeeded'}
          onClick={() => void props.shared.post('/run-task', { taskId: 'TASK-COPY-0030', humanAutoAccept: true }, 'TASK-COPY-0030 集成任务完成')}
        >
          <Icon name="play" size={12} /> {task?.status === 'succeeded' ? '集成任务已完成 ✓' : '运行集成任务'}
        </button>
        <button className="wb-btn" disabled={previewing || props.shared.busy} onClick={() => void preview()}>
          {previewing ? '虚拟面板运行中…' : '在虚拟面板慢速预演'}
        </button>
      </div>
      {previewing && (
        <div className="wb-dev" style={{ borderTop: '1px solid var(--wb-border)', paddingTop: 12 }}>
          <DevicePanel sim={props.shared.data.sim} width={280} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <JobTimeline sim={props.shared.data.sim} />
          </div>
        </div>
      )}
    </>
  )
}

// ---------- 步骤 8:异常恢复 ----------

const RECOVERY_SCENES = [
  { key: 'cancel-before-scan', expect: 'CANCELLED' },
  { key: 'scan-timeout', expect: 'FAILED' },
  { key: 'paper-empty-then-recover', expect: 'COMPLETED' },
  { key: 'paper-empty-no-recovery', expect: 'FAILED' },
  { key: 'engine-recoverable-error', expect: 'COMPLETED' },
]

function RecoveryStep(props: { shared: StepProps }): React.JSX.Element {
  const task = props.shared.data.tasks.find(item => item.id === 'TASK-COPY-0031')
  const done = task?.status === 'succeeded'
  return (
    <>
      <div className="wb-faint" style={{ fontSize: 12 }}>必选异常一个不落:失败场景也要"正确地失败"。按作业状态机逐场景断言。</div>
      <div className="wb-scene-wall" style={{ maxWidth: 640 }}>
        {RECOVERY_SCENES.map(scene => (
          <div key={scene.key} className={`wb-scene${done ? ' wb-scene--pass' : ' wb-scene--pending'}`}>
            <div className="wb-scene__name">{scene.key}</div>
            <div className="wb-mono" style={{ fontSize: 12 }}>
              {done ? <><Icon name="check" size={12} /> {scene.expect}</> : `预期 ${scene.expect}`}
            </div>
          </div>
        ))}
      </div>
      <button
        className="wb-btn wb-btn--primary"
        disabled={props.shared.busy || done}
        onClick={() => void props.shared.post('/run-task', { taskId: 'TASK-COPY-0031', humanAutoAccept: true }, '异常恢复套件 6/6 通过')}
      >
        <Icon name="play" size={12} /> {done ? '恢复套件已完成 ✓(6/6)' : '运行异常恢复套件'}
      </button>
    </>
  )
}

// ---------- 步骤 9:验收 ----------

function AcceptStep(props: { shared: StepProps; onGotoAcceptance: () => void }): React.JSX.Element {
  const acceptance = props.shared.data.snapshot?.acceptance
  const [evaluating, setEvaluating] = useState(false)
  const evaluate = async (): Promise<void> => {
    setEvaluating(true)
    try {
      await fetchJson('/acceptance', {
        method: 'POST',
        body: JSON.stringify({ requirementId: props.shared.reqId || 'REQ-COPY-0001', generateReport: true }),
      })
      props.shared.addLog('info', '✓ 验收评估完成,证据包已生成')
      await props.shared.data.reloadReport()
      await props.shared.data.refresh()
    } catch (error) {
      props.shared.addLog('error', `✗ ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setEvaluating(false)
    }
  }
  return (
    <>
      <div className="wb-faint" style={{ fontSize: 12 }}>独立验收:必选用例全部执行且通过才给 PASS;证据按 SHA-256 内容寻址打包(方案 12.5/13.2)。</div>
      {acceptance && (
        <div className={`wb-decision wb-decision--${acceptance.decision}`} style={{ padding: '12px 0' }}>
          <div className="wb-decision__value">{acceptance.decision} · L1</div>
          <div className="wb-decision__sub">{acceptance.acceptanceId} · {timeShort(acceptance.decidedAt)}</div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="wb-btn wb-btn--primary" disabled={evaluating || props.shared.busy} onClick={() => void evaluate()}>
          <Icon name="shield-check" size={12} /> {acceptance ? '重新评估并生成证据包' : '评估验收并生成证据包'}
        </button>
        {acceptance && (
          <button className="wb-btn" onClick={props.onGotoAcceptance}>
            <Icon name="file-text" size={12} /> 查看完整报告
          </button>
        )}
      </div>
    </>
  )
}

// ---------- 步骤 10:真机队列 ----------

function QueueStep(props: { shared: StepProps }): React.JSX.Element {
  const hw = props.shared.data.tasks.filter(task => ['TASK-COPY-0050', 'TASK-COPY-0051', 'TASK-COPY-0052'].includes(task.id))
  return (
    <>
      <div className="wb-banner">
        真机任务诚实排队:整机资源已隔离,等待 Phase 0 事实冻结。系统不会假装验证过它没验证的东西。
      </div>
      <div className="wb-check-list">
        {hw.map(task => (
          <div key={task.id} className="wb-task-row">
            <span className="wb-task-row__id">{task.id.replace('TASK-COPY-', 'TC-')}</span>
            <span className="wb-task-row__title">{task.title}</span>
            <StatusChip status={task.status} />
          </div>
        ))}
      </div>
    </>
  )
}

export type { TaskView }
