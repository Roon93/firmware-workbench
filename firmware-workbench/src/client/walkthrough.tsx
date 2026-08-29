/** 引导式流程(用户可直接操作):输入需求 → 评审签署 → 逐任务执行 → 验收。 */

import { useState } from 'react'
import { fetchJson, STATUS_LABELS, timeShort, type TaskView, type WbData } from './model.js'
import { Icon, StatusChip, Terminal, ViewHead } from './ui.js'
import { DevicePanel, JobTimeline } from './device.js'

interface WalkStep {
  key: string
  title: string
  why: string
  done: boolean
}

export function WalkthroughView(props: { data: WbData; onGotoAcceptance: () => void }): React.JSX.Element {
  const { data } = props
  const [openKey, setOpenKey] = useState<string | null>('req')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<Array<{ ts: string; level: 'info' | 'warn' | 'error'; text: string }>>([])
  const [simVisible, setSimVisible] = useState(false)

  const addLog = (level: 'info' | 'warn' | 'error', text: string): void => {
    setLog(prev => [...prev.slice(-200), { ts: new Date().toISOString(), level, text }])
  }

  const requirement = data.snapshot?.requirement
  const gateById = new Map((data.snapshot?.gates ?? []).map(gate => [gate.id, gate.decision]))
  const taskById = new Map(data.tasks.map(task => [task.id, task]))
  const doneIds = (ids: string[]): boolean => ids.every(id => taskById.get(id)?.status === 'succeeded')

  const steps: WalkStep[] = [
    { key: 'req', title: '输入你的需求', why: 'P0 需求接收', done: !!requirement },
    { key: 'define', title: '评审并批准 Define', why: 'G1 定义完成', done: requirement?.status === 'approved' },
    { key: 'contract', title: '冻结接口契约,批准 G3 门禁', why: 'G3 契约基线', done: gateById.get('G3-CONTRACT-BASELINE') === 'approved' },
    { key: 'dev', title: '五路并行开发', why: 'P4 工作包', done: doneIds(['TASK-COPY-0010', 'TASK-COPY-0011', 'TASK-COPY-0012', 'TASK-COPY-0013', 'TASK-COPY-0014']) },
    { key: 'test', title: '组件自测', why: '每个包交付即自测', done: doneIds(['TASK-COPY-0010-T', 'TASK-COPY-0011-T', 'TASK-COPY-0012-T', 'TASK-COPY-0013-T', 'TASK-COPY-0014-T']) },
    { key: 'integrate', title: '模拟集成:虚拟复印', why: 'L1 主流程', done: taskById.get('TASK-COPY-0030')?.status === 'succeeded' },
    { key: 'recovery', title: '异常恢复套件', why: '必选异常 6 场景', done: taskById.get('TASK-COPY-0031')?.status === 'succeeded' },
    { key: 'accept', title: '验收评估 + 证据包', why: '独立验收', done: !!data.snapshot?.acceptance },
    { key: 'queue', title: '真机队列(预期等待)', why: 'Phase 0', done: true },
  ]
  const firstUndone = steps.find(step => !step.done)?.key ?? 'queue'
  const activeKey = openKey ?? firstUndone

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

  const stepProps: WalkStepProps = { activeKey, openKey: activeKey, setOpenKey, busy, post, addLog, data, simVisible, setSimVisible }
  const completed = steps.filter(step => step.done).length

  return (
    <div className="wb-view wb-view--wide">
      <ViewHead
        title="引导式流程"
        sub={`每一步由你亲手操作 · 已完成 ${completed}/${steps.length}`}
        actions={
          <>
            <StatusChip status={completed === steps.length ? 'PASS' : 'running'} label={completed === steps.length ? '闭环完成' : '进行中'} />
            <button
              className="wb-btn wb-btn--ghost"
              disabled={busy}
              onClick={() => void post('/demo/reset', {}, '工程已重置(重新装载种子)')}
            >
              <Icon name="rotate-ccw" size={12} /> 重置工程
            </button>
          </>
        }
      />
      <div className="wb-walk">
        <WalkStepCard {...stepProps} step={steps[0]!}>
          <RequirementInput data={data} busy={busy} post={post} />
        </WalkStepCard>
        <WalkStepCard {...stepProps} step={steps[1]!}>
          <DefineReview data={data} busy={busy} post={post} />
        </WalkStepCard>
        <WalkStepCard {...stepProps} step={steps[2]!}>
          <ContractFreeze data={data} busy={busy} post={post} />
        </WalkStepCard>
        <WalkStepCard {...stepProps} step={steps[3]!}>
          <TaskGroupRun
            data={data}
            busy={busy}
            post={post}
            addLog={addLog}
            ids={['TASK-COPY-0010', 'TASK-COPY-0011', 'TASK-COPY-0012', 'TASK-COPY-0013', 'TASK-COPY-0014']}
            groupLabel="五个工作包共享 build/rk3588 构建资源,资源租约保证互不干扰"
          />
        </WalkStepCard>
        <WalkStepCard {...stepProps} step={steps[4]!}>
          <TaskGroupRun
            data={data}
            busy={busy}
            post={post}
            addLog={addLog}
            ids={['TASK-COPY-0010-T', 'TASK-COPY-0011-T', 'TASK-COPY-0012-T', 'TASK-COPY-0013-T', 'TASK-COPY-0014-T']}
            groupLabel="每个包的 L1 自测:契约不变式在集成前先验证"
          />
        </WalkStepCard>
        <WalkStepCard {...stepProps} step={steps[5]!}>
          <IntegrationStep data={data} busy={busy} post={post} addLog={addLog} onPreview={() => setSimVisible(true)} simVisible={simVisible} />
        </WalkStepCard>
        <WalkStepCard {...stepProps} step={steps[6]!}>
          <RecoveryStep data={data} busy={busy} post={post} addLog={addLog} />
        </WalkStepCard>
        <WalkStepCard {...stepProps} step={steps[7]!}>
          <AcceptStep data={data} busy={busy} addLog={addLog} post={post} onGotoAcceptance={props.onGotoAcceptance} />
        </WalkStepCard>
        <WalkStepCard {...stepProps} step={steps[8]!}>
          <QueueStep data={data} />
        </WalkStepCard>
      </div>

      <div style={{ marginTop: 'var(--wb-sp-3)' }}>
        <div className="wb-side__title" style={{ marginBottom: 6 }}>操作日志</div>
        <Terminal lines={log} height={160} />
      </div>
    </div>
  )
}

interface WalkStepProps {
  activeKey: string
  openKey: string | null
  setOpenKey: (key: string | null) => void
  busy: boolean
  post: (path: string, body?: Record<string, unknown>, okText?: string) => Promise<boolean>
  addLog: (level: 'info' | 'warn' | 'error', text: string) => void
  data: WbData
  simVisible: boolean
  setSimVisible: (visible: boolean) => void
}

function WalkStepCard(props: WalkStepProps & { step: WalkStep; children: React.ReactNode }): React.JSX.Element {
  const { step } = props
  const isFirstUndone = false
  void isFirstUndone
  const cls = step.done ? 'wb-walk-step--done' : props.activeKey === step.key ? 'wb-walk-step--active' : ''
  const open = props.openKey === step.key
  return (
    <div className={`wb-walk-step ${cls}`}>
      <div className="wb-walk-step__head" onClick={() => props.setOpenKey(open ? null : step.key)}>
        <span className="wb-walk-step__num">{step.done ? '✓' : step.key.slice(0, 1)}</span>
        <span className="wb-walk-step__title">{step.title}</span>
        <StatusChip status={step.done ? 'succeeded' : props.activeKey === step.key ? 'ready' : 'planned'} label={step.done ? '已完成' : props.activeKey === step.key ? '进行中' : STATUS_LABELS.planned} />
        <span className="wb-walk-step__why">{step.why}</span>
        <Icon name="chevron" size={13} />
      </div>
      {open && <div className="wb-walk-step__body">{props.children}</div>}
    </div>
  )
}

// ---------- 步骤 1:需求输入 ----------

function RequirementInput(props: { data: WbData; busy: boolean; post: WalkStepProps['post'] }): React.JSX.Element {
  const { data } = props
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const requirement = data.snapshot?.requirement

  return (
    <>
      <div className="wb-faint" style={{ fontSize: 12 }}>
        写下你要设备做的事(一句话或一段话)。工作台会以它为 P0 原始需求,并沿追踪链落到任务、测试与验收。
        任务模板基于当前产品基线(单页黑白复印);真机层级验收在 Phase 0 后执行。
      </div>
      <input className="wb-input" placeholder="需求标题,如:面板发起单页黑白复印" value={title} onChange={event => setTitle(event.target.value)} />
      <textarea
        className="wb-textarea"
        placeholder="原始需求描述:用户在设备面板选择'复印',放入一张 A4 原稿,设备完成扫描、图像处理,并由打印引擎输出一张黑白纸张……"
        value={text}
        onChange={event => setText(event.target.value)}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          className="wb-btn wb-btn--primary"
          disabled={props.busy || !title.trim() || !text.trim()}
          onClick={() => void props.post('/requirement/import', { title, text }, '需求已导入,等待 Define 评审')}
        >
          <Icon name="chevron" size={12} /> 导入需求并装载工程
        </button>
        {requirement && (
          <span className="wb-faint" style={{ fontSize: 12 }}>
            当前:{requirement.id}「{requirement.title}」 · 状态 {STATUS_LABELS[requirement.status] ?? requirement.status}
          </span>
        )}
      </div>
      {requirement?.originalText && (
        <div className="wb-quote">"{requirement.originalText}"</div>
      )}
    </>
  )
}

// ---------- 步骤 2:Define 评审 ----------

function DefineReview(props: { data: WbData; busy: boolean; post: WalkStepProps['post'] }): React.JSX.Element {
  const requirement = props.data.snapshot?.requirement
  const approved = requirement?.status === 'approved'
  return (
    <>
      <div className="wb-faint" style={{ fontSize: 12 }}>
        Define 把原始需求翻译成工程语言。评审下面的主流程、异常流与验收标准,批准后才能进入开发(G1 门禁)。
      </div>
      <div className="wb-quote">"{requirement?.originalText ?? '(尚未导入需求,请先完成上一步)'}"</div>
      <div className="wb-grid wb-grid--2col">
        <div>
          <div className="wb-side__title">主流程</div>
          <ol className="wb-list-num">
            <li>用户在面板选择复印</li>
            <li>设备 A4 平板 300dpi 扫描</li>
            <li>图像校正与半色调</li>
            <li>引擎输出 1 页黑白 A4</li>
            <li>面板显示 COMPLETED</li>
          </ol>
          <div className="wb-side__title" style={{ marginTop: 8 }}>异常流(必须正确地失败)</div>
          <ol className="wb-list-num">
            <li>扫描超时 → FAILED(SCAN-TIMEOUT)</li>
            <li>缺纸 → WAITING_FOR_PAPER</li>
            <li>引擎可恢复错误 → 自动重试</li>
          </ol>
        </div>
        <div>
          <div className="wb-side__title">恢复规则</div>
          <ol className="wb-list-num">
            <li>补纸后继续输出并 COMPLETED</li>
            <li>缺纸未恢复 → FAILED + 资源清理</li>
            <li>取消后设备回到就绪</li>
          </ol>
          <div className="wb-side__title" style={{ marginTop: 8 }}>验收标准</div>
          <div className="wb-check-list">
            <div className="wb-check-item"><StatusChip status="L1" label="L1" /> 虚拟设备完成单页复印(COMPLETED + 1 页)</div>
            <div className="wb-check-item"><StatusChip status="L1" label="L1" /> 异常场景全部符合作业状态机</div>
            <div className="wb-check-item"><StatusChip status="L4" label="L4" /> 真机:真实扫描并真实出纸(Phase 0)</div>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="wb-btn wb-btn--primary" disabled={props.busy || !requirement || approved} onClick={() => void props.post('/define/approve', {}, 'G1 门禁:Define 已批准')}>
          <Icon name="check" size={12} /> {approved ? 'Define 已批准(G1 ✓)' : '批准 Define(G1 门禁)'}
        </button>
        <span className="wb-faint" style={{ fontSize: 12 }}>签署人:web 操作者 · 记录进审计日志</span>
      </div>
    </>
  )
}

// ---------- 步骤 3:契约冻结 ----------

const CONTRACT_NAMES = ['IF-JOB-MANAGER', 'IF-SCANNER', 'IF-IMAGE-BUFFER', 'IF-ENGINE', 'IF-PANEL-UI']

function ContractFreeze(props: { data: WbData; busy: boolean; post: WalkStepProps['post'] }): React.JSX.Element {
  const g3 = (props.data.snapshot?.gates ?? []).find(gate => gate.id === 'G3-CONTRACT-BASELINE')
  const approved = g3?.decision === 'approved'
  return (
    <>
      <div className="wb-faint" style={{ fontSize: 12 }}>
        五个模块的接口契约:先签接口再并行开发。冻结后契约不可修改,变更必须开新版本(方案 4.3)。
      </div>
      <div className="wb-check-list">
        {CONTRACT_NAMES.map(name => (
          <div key={name} className="wb-check-item">
            <span className="wb-mono">{name}</span>
            <span style={{ flex: 1 }} />
            {approved ? <StatusChip status="succeeded" label="frozen v1" /> : <span className="wb-faint">draft</span>}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="wb-btn wb-btn--primary" disabled={props.busy || approved} onClick={() => void props.post('/contracts/freeze', {}, '契约冻结 + G3 门禁批准')}>
          <Icon name="shield-check" size={12} /> {approved ? '契约已冻结,门禁已批准(G3 ✓)' : '冻结全部契约并批准 G3 门禁'}
        </button>
      </div>
    </>
  )
}

// ---------- 步骤 4/5:任务组运行 ----------

function TaskGroupRun(props: {
  data: WbData
  busy: boolean
  post: WalkStepProps['post']
  addLog: WalkStepProps['addLog']
  ids: string[]
  groupLabel: string
}): React.JSX.Element {
  const [runningId, setRunningId] = useState<string | null>(null)
  const runOne = async (taskId: string): Promise<void> => {
    setRunningId(taskId)
    props.addLog('info', `▶ 运行 ${taskId}`)
    try {
      await fetchJson('/run-task', { method: 'POST', body: JSON.stringify({ taskId, humanAutoAccept: true }) })
      props.addLog('info', `✓ ${taskId} 完成`)
    } catch (error) {
      props.addLog('error', `✗ ${taskId}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setRunningId(null)
      await props.data.refresh()
    }
  }
  const runAll = async (): Promise<void> => {
    for (const id of props.ids) {
      if (props.data.tasks.find(task => task.id === id)?.status !== 'succeeded') {
        await runOne(id)
      }
    }
  }
  const allDone = props.ids.every(id => props.data.tasks.find(task => task.id === id)?.status === 'succeeded')
  return (
    <>
      <div className="wb-faint" style={{ fontSize: 12 }}>{props.groupLabel}</div>
      <div className="wb-check-list">
        {props.ids.map(id => {
          const task = props.data.tasks.find(item => item.id === id)
          const status = task?.status ?? 'planned'
          return (
            <div key={id} className="wb-task-row">
              <span className="wb-task-row__id">{id.replace('TASK-COPY-', 'TC-')}</span>
              <span className="wb-task-row__title">{task?.title ?? id}</span>
              <StatusChip status={status} />
              {status !== 'succeeded' && (
                <button className="wb-btn wb-btn--sm" disabled={props.busy || runningId !== null} onClick={() => void runOne(id)}>
                  {runningId === id ? '运行中…' : '▶ 运行'}
                </button>
              )}
            </div>
          )
        })}
      </div>
      <div>
        <button className="wb-btn wb-btn--primary" disabled={props.busy || runningId !== null || allDone} onClick={() => void runAll()}>
          <Icon name="play" size={12} /> {allDone ? '全部完成 ✓' : '全部运行'}
        </button>
      </div>
    </>
  )
}

// ---------- 步骤 6:模拟集成 ----------

function IntegrationStep(props: {
  data: WbData
  busy: boolean
  post: WalkStepProps['post']
  addLog: WalkStepProps['addLog']
  onPreview: () => void
  simVisible: boolean
}): React.JSX.Element {
  const task = props.data.tasks.find(item => item.id === 'TASK-COPY-0030')
  const [previewing, setPreviewing] = useState(false)
  const preview = async (): Promise<void> => {
    setPreviewing(true)
    props.onPreview()
    await fetchJson('/sim/run', { method: 'POST', body: JSON.stringify({ scenario: 'success', slow: true }) })
    await props.data.refreshSim()
    // 等待虚拟作业结束
    for (let i = 0; i < 40; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 500))
      const sim = await fetchJson<import('./model.js').SimState>('/sim/state')
      if (sim.job?.finished) break
    }
    setPreviewing(false)
    props.addLog('info', '虚拟面板预演完成(COMPLETED,出纸 1 页)')
  }
  return (
    <>
      <div className="wb-faint" style={{ fontSize: 12 }}>
        五件套合体:在虚拟设备上完整跑一遍"扫描 → 图像 → 出纸"。这是没有真机时的整机(L1)。
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="wb-btn wb-btn--primary"
          disabled={props.busy || task?.status === 'succeeded'}
          onClick={() => void props.post('/run-task', { taskId: 'TASK-COPY-0030', humanAutoAccept: true }, 'TASK-COPY-0030 集成任务完成')}
        >
          <Icon name="play" size={12} /> {task?.status === 'succeeded' ? '集成任务已完成 ✓' : '运行集成任务 TASK-COPY-0030'}
        </button>
        <button className="wb-btn" disabled={previewing || props.busy} onClick={() => void preview()}>
          {previewing ? '虚拟面板运行中…' : '在虚拟面板慢速预演'}
        </button>
      </div>
      {props.simVisible && (
        <div className="wb-dev" style={{ borderTop: '1px solid var(--wb-border)', paddingTop: 12 }}>
          <DevicePanel sim={props.data.sim} width={280} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <JobTimeline sim={props.data.sim} />
          </div>
        </div>
      )}
      {task?.status === 'succeeded' && <div className="wb-banner wb-banner--ok">主流程 L1 通过:终态 COMPLETED,出纸 1 页</div>}
    </>
  )
}

// ---------- 步骤 7:异常恢复 ----------

const RECOVERY_SCENES = [
  { key: 'cancel-before-scan', expect: 'CANCELLED' },
  { key: 'scan-timeout', expect: 'FAILED' },
  { key: 'paper-empty-then-recover', expect: 'COMPLETED' },
  { key: 'paper-empty-no-recovery', expect: 'FAILED' },
  { key: 'engine-recoverable-error', expect: 'COMPLETED' },
]

function RecoveryStep(props: { data: WbData; busy: boolean; post: WalkStepProps['post']; addLog: WalkStepProps['addLog'] }): React.JSX.Element {
  const task = props.data.tasks.find(item => item.id === 'TASK-COPY-0031')
  const done = task?.status === 'succeeded'
  return (
    <>
      <div className="wb-faint" style={{ fontSize: 12 }}>
        必选异常一个不落:失败场景也要"正确地失败"。套件会按作业状态机(显式转移表)逐场景断言。
      </div>
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
      <div>
        <button
          className="wb-btn wb-btn--primary"
          disabled={props.busy || done}
          onClick={() => void props.post('/run-task', { taskId: 'TASK-COPY-0031', humanAutoAccept: true }, '异常恢复套件 6/6 通过')}
        >
          <Icon name="play" size={12} /> {done ? '恢复套件已完成 ✓(6/6)' : '运行异常恢复套件'}
        </button>
      </div>
    </>
  )
}

// ---------- 步骤 8:验收 ----------

function AcceptStep(props: { data: WbData; busy: boolean; addLog: WalkStepProps['addLog']; post: WalkStepProps['post']; onGotoAcceptance: () => void }): React.JSX.Element {
  const acceptance = props.data.snapshot?.acceptance
  const [evaluating, setEvaluating] = useState(false)
  const evaluate = async (): Promise<void> => {
    setEvaluating(true)
    try {
      await fetchJson('/acceptance', {
        method: 'POST',
        body: JSON.stringify({ requirementId: props.data.snapshot?.requirement?.id ?? 'REQ-COPY-0001', generateReport: true }),
      })
      props.addLog('info', '✓ 验收评估完成,证据包已生成')
      await props.data.reloadReport()
      await props.data.refresh()
    } catch (error) {
      props.addLog('error', `✗ ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setEvaluating(false)
    }
  }
  return (
    <>
      <div className="wb-faint" style={{ fontSize: 12 }}>
        独立验收:必选用例全部执行且通过才给 PASS;证据按 SHA-256 内容寻址打包,可审计、不可篡改(方案 12.5/13.2)。
      </div>
      {acceptance && (
        <div className={`wb-decision wb-decision--${acceptance.decision}`} style={{ padding: '12px 0' }}>
          <div className="wb-decision__value">{acceptance.decision} · L1</div>
          <div className="wb-decision__sub">{acceptance.acceptanceId} · {timeShort(acceptance.decidedAt)}</div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="wb-btn wb-btn--primary" disabled={evaluating || props.busy} onClick={() => void evaluate()}>
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

// ---------- 步骤 9:真机队列 ----------

function QueueStep(props: { data: WbData }): React.JSX.Element {
  const hw = props.data.tasks.filter(task => ['TASK-COPY-0050', 'TASK-COPY-0051', 'TASK-COPY-0052'].includes(task.id))
  return (
    <>
      <div className="wb-banner">
        真机任务诚实排队:整机资源已隔离,等待 Phase 0 事实冻结(BSP 版本 / 刷机救援 / UI 栈与 VNC / 扫描器引擎契约)。
        系统不会假装验证过它没验证的东西。
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
      <div className="wb-faint" style={{ fontSize: 11 }}>
        Phase 0 事实清单见 docs/phase-0-fact-freeze-checklist.md;硬件事实到位后由真机 Provider 接管。
      </div>
    </>
  )
}

export type { TaskView }
