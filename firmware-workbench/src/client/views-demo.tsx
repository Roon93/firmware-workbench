/** 演示中心:两种模式 —— 引导操作(用户亲手逐步执行)/ 自动演示(一键播放)。 */

import { WalkthroughView } from './walkthrough.js'


import { useEffect, useMemo, useState } from 'react'
import { fetchJson, timeShort, type DemoPhase, type WbData } from './model.js'
import { Card, Icon, StatusChip, Terminal, ViewHead } from './ui.js'
import { TaskDag } from './dag.js'
import { DevicePanel, JobTimeline } from './device.js'

export function DemoView(props: { data: WbData; onGotoAcceptance: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<'guide' | 'auto'>('guide')
  return (
    <>
      <div className="wb-view wb-view--wide" style={{ marginBottom: 'var(--wb-sp-3)' }}>
        <div className="wb-view__head" style={{ marginBottom: 0 }}>
          <h2 className="wb-view__title">演示中心</h2>
          <span className="wb-view__sub">引导操作 = 你亲手走完整流程 · 自动演示 = 一键播放给观众看</span>
          <span className="wb-view__spacer" />
          <div className="wb-mode-tabs">
            <button className={`wb-mode-tab${mode === 'guide' ? ' wb-mode-tab--active' : ''}`} onClick={() => setMode('guide')}>
              引导操作
            </button>
            <button className={`wb-mode-tab${mode === 'auto' ? ' wb-mode-tab--active' : ''}`} onClick={() => setMode('auto')}>
              自动演示
            </button>
          </div>
        </div>
      </div>
      {mode === 'guide' ? (
        <WalkthroughView data={props.data} onGotoAcceptance={props.onGotoAcceptance} />
      ) : (
        <AutoDemoView data={props.data} onGotoAcceptance={props.onGotoAcceptance} onGotoGuide={() => setMode('guide')} />
      )}
    </>
  )
}

function AutoDemoView(props: { data: WbData; onGotoAcceptance: () => void; onGotoGuide: () => void }): React.JSX.Element {
  const { data } = props
  const demo = data.demo
  const running = demo?.status === 'running'
  const awaiting = demo?.status === 'awaiting_next'
  const doneStatus = demo?.status === 'done'
  const currentPhase: DemoPhase | undefined = demo?.phases[demo.phaseIndex]
  const lastDone = useMemo(() => {
    if (!demo) return undefined
    for (let i = demo.phases.length - 1; i >= 0; i -= 1) {
      if (demo.phases[i]?.status === 'done') return demo.phases[i]
    }
    return undefined
  }, [demo])
  const stagePhase = doneStatus ? demo?.phases[demo.phases.length - 1] : (currentPhase ?? lastDone)

  // 单步模式 Enter 键推进(设计 §4.4)
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || !awaiting) return
      void fetchJson('/demo/step', { method: 'POST', body: '{}' })
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [awaiting])

  const post = async (path: string, body: Record<string, unknown> = {}): Promise<void> => {
    await fetchJson(path, { method: 'POST', body: JSON.stringify(body) })
    await data.refresh()
  }

  const statusChip = !demo || demo.status === 'idle'
    ? <StatusChip status="planned" label="未开始" />
    : running
      ? <StatusChip status="running" label="演示中" />
      : awaiting
        ? <StatusChip status="blocked_gate" label="等待下一步" />
        : <StatusChip status="PASS" label="演示完成" />

  return (
    <div className="wb-view wb-view--wide">
      <ViewHead
        title="自动演示"
        sub="从一句话需求到 PASS L1 验收报告 · 全程约 30 秒"
        actions={
          <>
            {statusChip}
            {!running && !awaiting && (
              <button
                className="wb-btn wb-btn--primary"
                onClick={() => void post('/demo/play', { mode: 'auto', reset: true, speedMs: 1500 })}
              >
                <Icon name="play" size={12} /> 开始完整演示
              </button>
            )}
            {running && (
              <button className="wb-btn" onClick={() => void post('/demo/pause')}>
                <Icon name="pause" size={12} /> 暂停
              </button>
            )}
            {(running || awaiting) && (
              <button className={`wb-btn${awaiting ? ' wb-btn--primary' : ''}`} disabled={!awaiting} onClick={() => void post('/demo/step')}>
                <Icon name="skip-forward" size={12} /> 下一步{awaiting ? '(Enter)' : ''}
              </button>
            )}
            {(running || awaiting || doneStatus) && (
              <button className="wb-btn wb-btn--ghost" onClick={() => void post('/demo/reset')}>
                <Icon name="rotate-ccw" size={12} /> 重播
              </button>
            )}
          </>
        }
      />

      {/* 阶段时间轴 */}
      <div className="wb-demo-steps">
        {(demo?.phases ?? SCRIPT_PREVIEW).map((phase, index) => {
          const cls =
            phase.status === 'done'
              ? 'wb-demo-step--done'
              : index === demo?.phaseIndex && (running || awaiting)
                ? 'wb-demo-step--active'
                : ''
          return (
            <button
              key={phase.id}
              className={`wb-demo-step ${cls}`}
              onClick={() => {
                /* 只读回放:舞台已按当前阶段切换,点击仅提示 */
              }}
            >
              <span className="wb-demo-step__dot">{phase.status === 'done' ? '✓' : index + 1}</span>
              <span className="wb-demo-step__label">{phase.title}</span>
            </button>
          )
        })}
        {!demo && (
          <div className="wb-faint" style={{ fontSize: 12, padding: '6px 10px' }}>
            10 个阶段:种子 → Define → 契约 → 并行开发 → 自测 → 集成 → 异常 → 验收 → 真机队列 → 完成
          </div>
        )}
      </div>

      <div className="wb-grid" style={{ gridTemplateColumns: '420px 1fr' }}>
        {/* 左:叙事 */}
        <div className="wb-demo-narr">
          {stagePhase ? (
            <>
              <div className="wb-demo-narr__phase">
                阶段 {(demo?.phaseIndex ?? 0) + 1} / {demo?.phases.length ?? 10} · {stagePhase.id}
                {demo?.mode === 'step' && awaiting ? ' · 单步模式' : ''}
              </div>
              <div className="wb-demo-narr__title">{stagePhase.title}</div>
              <div className="wb-demo-narr__text">{stagePhase.narrative}</div>
              <div className="wb-demo-narr__meta">
                {stagePhase.action && <span>▸ 动作:{stagePhase.action}</span>}
                {stagePhase.verify && <span>▸ 验证点:{stagePhase.verify}</span>}
                {demo?.startedAt && <span>▸ 开演 {timeShort(demo.startedAt)}{demo.finishedAt ? ` · 收官 ${timeShort(demo.finishedAt)}` : ''}</span>}
              </div>
            </>
          ) : (
            <>
              <div className="wb-demo-narr__phase">剧本预览</div>
              <div className="wb-demo-narr__title">一键演示完整研发闭环</div>
              <div className="wb-demo-narr__text">
                需求导入 → 接口契约 → 五路并行开发 → 自测 → 虚拟整机集成 → 异常恢复 → 证据化验收。
                真机任务诚实排队(Phase 0)。全程约 30 秒,支持单步讲解。
              </div>
            </>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="wb-btn wb-btn--sm" onClick={() => void post('/demo/play', { mode: 'step', reset: true })}>
              <Icon name="skip-forward" size={11} /> 单步播放
            </button>
            <button
              className="wb-btn wb-btn--sm wb-btn--ghost"
              onClick={() => void post('/demo/play', { mode: 'auto', reset: true, speedMs: demo?.speedMs === 700 ? 1500 : 700 })}
            >
              {demo?.speedMs === 700 ? '1x 速度' : '2x 速度'}
            </button>
          </div>
        </div>

        {/* 右:舞台 */}
        <div className="wb-demo-stage">
          <div className="wb-demo-stage__body">
            <StageContent phaseId={stagePhase?.id} data={data} onGotoAcceptance={props.onGotoAcceptance} />
          </div>
        </div>
      </div>

      {/* 终端 */}
      <div style={{ marginTop: 'var(--wb-sp-3)' }}>
        <Terminal lines={demo?.log ?? []} height={200} />
      </div>
    </div>
  )
}

const SCRIPT_PREVIEW: DemoPhase[] = [
  { id: 'P0', title: '装载种子', narrative: '', status: 'pending' },
  { id: 'P1', title: '需求 Define', narrative: '', status: 'pending' },
  { id: 'P2', title: '契约冻结', narrative: '', status: 'pending' },
  { id: 'P3', title: '并行开发', narrative: '', status: 'pending' },
  { id: 'P4', title: '组件自测', narrative: '', status: 'pending' },
  { id: 'P5', title: '模拟集成', narrative: '', status: 'pending' },
  { id: 'P6', title: '异常恢复', narrative: '', status: 'pending' },
  { id: 'P7', title: '验收', narrative: '', status: 'pending' },
  { id: 'P8', title: '真机队列', narrative: '', status: 'pending' },
  { id: 'P9', title: '完成', narrative: '', status: 'pending' },
]

function StageContent(props: { phaseId?: string; data: WbData; onGotoAcceptance: () => void }): React.JSX.Element {
  const { phaseId, data } = props
  switch (phaseId) {
    case 'P1': {
      return (
        <div style={{ width: '100%', maxWidth: 520 }}>
          <Card title="Define 摘要 · REQ-COPY-0001">
            <ol className="wb-list-num">
              <li>用户在面板选择复印</li>
              <li>A4 平板 300dpi 扫描</li>
              <li>图像校正与半色调</li>
              <li>引擎输出 1 页黑白 A4</li>
              <li>面板显示 COMPLETED</li>
            </ol>
            <div className="wb-faint" style={{ fontSize: 11, marginTop: 8 }}>验收标准 3 条:模拟主流程 / 异常语义 / 真机出纸</div>
          </Card>
        </div>
      )
    }
    case 'P2': {
      const contracts = ['IF-JOB-MANAGER', 'IF-SCANNER', 'IF-IMAGE-BUFFER', 'IF-ENGINE', 'IF-PANEL-UI']
      return (
        <div style={{ width: '100%', maxWidth: 520 }}>
          <Card title="契约基线 v1" sub="已冻结">
            {contracts.map(name => (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--wb-border)' }}>
                <span className="wb-mono">{name}</span>
                <span style={{ flex: 1 }} />
                <StatusChip status="succeeded" label="frozen v1" />
              </div>
            ))}
            <div style={{ marginTop: 10 }}>
              <StatusChip status="succeeded" label="G3-CONTRACT-BASELINE 已批准" />
            </div>
          </Card>
        </div>
      )
    }
    case 'P3':
    case 'P4': {
      const simTasks = data.tasks.filter(task => !['TASK-COPY-0050', 'TASK-COPY-0051', 'TASK-COPY-0052'].includes(task.id))
      const critical = data.snapshot?.criticalPath.ids ?? []
      return (
        <div style={{ width: '100%' }}>
          <TaskDag tasks={simTasks} criticalIds={critical} mini height={340} />
        </div>
      )
    }
    case 'P5': {
      return (
        <div className="wb-dev">
          <DevicePanel sim={data.sim} width={300} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <JobTimeline sim={data.sim} />
          </div>
        </div>
      )
    }
    case 'P6': {
      const wall = [
        { key: 'cancel-before-scan', state: 'CANCELLED' },
        { key: 'scan-timeout', state: 'FAILED' },
        { key: 'paper-empty-then-recover', state: 'COMPLETED' },
        { key: 'paper-empty-no-recovery', state: 'FAILED' },
        { key: 'engine-recoverable-error', state: 'COMPLETED' },
        { key: 'oracle 断言', state: '6/6' },
      ]
      const doneCount = data.tasks.find(task => task.id === 'TASK-COPY-0031')?.status === 'succeeded' ? 6 : countFromLog(data)
      return (
        <div className="wb-scene-wall">
          {wall.map((scene, index) => (
            <div key={scene.key} className={`wb-scene${index < doneCount ? ' wb-scene--pass' : index > doneCount ? ' wb-scene--pending' : ''}`}>
              <div className="wb-scene__name">{scene.key}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {index < doneCount ? <Icon name="check" size={13} /> : <span className="wb-faint">○</span>}
                <span className="wb-mono" style={{ fontSize: 12 }}>{scene.state}</span>
              </div>
            </div>
          ))}
        </div>
      )
    }
    case 'P7':
    case 'P9': {
      const acceptance = data.report ?? null
      const decision = acceptance?.decision ?? (phaseId === 'P9' ? 'PASS' : null)
      if (!decision) {
        return <div className="wb-faint">正在生成验收报告…</div>
      }
      const coverage = acceptance?.coverage
      return (
        <div style={{ width: '100%', maxWidth: 560 }}>
          <div className={`wb-decision wb-decision--${decision}`}>
            <div className="wb-decision__value" style={{ fontSize: 34 }}>{decision} · L1</div>
            <div className="wb-decision__sub">
              {acceptance?.acceptanceId ?? 'ACCEPT-REQ-COPY-0001'} · 最高已验证层级:{acceptance?.highestVerifiedLevel ?? 'L1(模拟层)'}
            </div>
            {coverage && (
              <div className="wb-coverage">
                <CoverageItem label="必选" value={coverage.requiredCases} />
                <CoverageItem label="通过" value={coverage.passed} />
                <CoverageItem label="失败" value={coverage.failed} />
                <CoverageItem label="阻塞" value={coverage.blocked} />
                <CoverageItem label="未执行" value={coverage.notRun} />
              </div>
            )}
            {acceptance?.bundle.id && (
              <div className="wb-faint wb-mono" style={{ fontSize: 11, marginTop: 12 }}>
                证据包 {acceptance.bundle.id} · {acceptance.bundle.files.length} 个文件
              </div>
            )}
            {phaseId === 'P9' && (
              <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button className="wb-btn wb-btn--primary" onClick={props.onGotoAcceptance}>
                  <Icon name="file-text" size={12} /> 查看完整报告
                </button>
              </div>
            )}
          </div>
        </div>
      )
    }
    case 'P8': {
      const hw = data.tasks.filter(task => ['TASK-COPY-0050', 'TASK-COPY-0051', 'TASK-COPY-0052'].includes(task.id))
      return (
        <div style={{ width: '100%', maxWidth: 560 }}>
          <div className="wb-banner" style={{ marginBottom: 12 }}>
            真机任务诚实排队:整机资源已隔离,等待 Phase 0 事实冻结——系统不会假装验证过它没验证的东西。
          </div>
          <Card title="真机任务队列" sub="blocked_resource">
            {hw.map(task => (
              <div key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--wb-border)' }}>
                <span className="wb-mono">{task.id}</span>
                <span style={{ flex: 1, fontSize: 12 }} className="wb-muted">{task.title}</span>
                <StatusChip status={task.status} />
              </div>
            ))}
          </Card>
        </div>
      )
    }
    default: {
      const stats = data.snapshot?.tasks.byStatus ?? {}
      const total = data.snapshot?.tasks.total ?? 0
      return (
        <div style={{ width: '100%', maxWidth: 560, textAlign: 'center' }}>
          <div className="wb-faint" style={{ fontSize: 13, marginBottom: 16 }}>
            {total > 0 ? `当前工程:${total} 个任务,等待开演` : '点击"开始完整演示",或先看一眼总览'}
          </div>
          <div className="wb-coverage" style={{ justifyContent: 'center' }}>
            {Object.entries(stats).map(([status, count]) => (
              <div key={status} className="wb-coverage__item">
                <div className="wb-coverage__num">{count}</div>
                <div className="wb-coverage__label">{status}</div>
              </div>
            ))}
          </div>
        </div>
      )
    }
  }
}

function countFromLog(data: WbData): number {
  const doneLine = data.demo?.log.filter(line => line.text.includes('/ 6 个场景通过')).at(-1)
  if (doneLine) return 6
  return (data.demo?.log.filter(line => line.text.includes('场景=') && line.level === 'info').length ?? 0)
}

function CoverageItem(props: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="wb-coverage__item">
      <div className="wb-coverage__num">{props.value}</div>
      <div className="wb-coverage__label">{props.label}</div>
    </div>
  )
}

