/** 常规六视图(设计文档 §5.1-§5.6):总览 / DAG / 需求与验收 / 测试 / 资源 / 座舱。 */

import { useEffect, useState } from 'react'
import {
  fetchJson,
  STATUS_LABELS,
  timeShort,
  type WbData,
  type CaseView,
} from './model.js'
import { ActivityFeed, Card, EmptyState, Icon, KpiCard, StatusChip, StatusDot, Toast, ViewHead, useToast } from './ui.js'
import { DagLegend, TaskDag, TaskDetailPanel } from './dag.js'
import { DevicePanel, JobTimeline, ScenarioButtons } from './device.js'

// ---------- 总览 ----------

export function OverviewView(props: { data: WbData; onGoto: (view: string) => void }): React.JSX.Element {
  const { data } = props
  const snapshot = data.snapshot
  const [busyTask, setBusyTask] = useState<string | null>(null)
  const done = snapshot?.tasks.byStatus.succeeded ?? 0
  const total = snapshot?.tasks.total ?? 0
  const active = (snapshot?.tasks.byStatus.running ?? 0) + (snapshot?.tasks.byStatus.verifying ?? 0) + (snapshot?.tasks.byStatus.reserved ?? 0)
  const ready = snapshot?.ready.length ?? 0
  const blocked = (snapshot?.tasks.byStatus.blocked_dependency ?? 0) + (snapshot?.tasks.byStatus.blocked_gate ?? 0)
  const resBlocked = snapshot?.tasks.byStatus.blocked_resource ?? 0
  const lane = snapshot?.lane
  const laneHasItems =
    (lane?.openDefects?.length ?? 0) +
      (lane?.staleTasks?.length ?? 0) +
      (lane?.definesInReview?.length ?? 0) +
      (lane?.changedRequirements?.length ?? 0) >
    0

  const runNext = async (): Promise<void> => {
    const next = snapshot?.ready[0]
    if (!next) return
    setBusyTask(next.id)
    try {
      await fetchJson('/run-task', { method: 'POST', body: JSON.stringify({ taskId: next.id, humanAutoAccept: true }) })
    } finally {
      setBusyTask(null)
      await data.refresh()
    }
  }

  return (
    <div className="wb-view">
      <ViewHead
        title="总览"
        sub="Printer-01 · RK3588 · 模拟闭环"
        actions={
          <>
            <button className="wb-btn wb-btn--primary" disabled={!ready || busyTask !== null} onClick={() => void runNext()}>
              <Icon name="play" size={12} /> 运行下一个 Ready
            </button>
            <button className="wb-btn wb-btn--ghost" onClick={() => void data.refresh()}>
              <Icon name="refresh" size={12} />
            </button>
          </>
        }
      />
      {lane && laneHasItems && (
        <div className="wb-card" style={{ marginBottom: 'var(--wb-sp-3)' }}>
          <div className="wb-card__head">
            我的车道
            <span className="wb-card__head-sub">当前需要你处理的事项</span>
          </div>
          <div className="wb-card__body" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(lane.openDefects ?? []).map(defect => (
              <div key={defect.id} className="wb-task-row">
                <span className="wb-mono" style={{ color: 'var(--wb-st-failed_product)' }}>
                  {defect.id}
                </span>
                <span className="wb-task-row__title">{defect.title}</span>
                <StatusChip status={defect.severity === 'critical' ? 'PRODUCT_FAIL' : 'failed_test'} label={defect.severity} />
                <StatusChip status="blocked_gate" label={defect.status} />
              </div>
            ))}
            {(lane.staleTasks ?? []).slice(0, 5).map(task => (
              <div key={task.id} className="wb-task-row">
                <span className="wb-mono">{task.id}</span>
                <span className="wb-task-row__title">{task.title}</span>
                <StatusChip status="blocked_resource" label="stale 待重评估" />
              </div>
            ))}
            {(lane.definesInReview ?? []).map(define => (
              <div key={define.id} className="wb-task-row">
                <span className="wb-mono">{define.id}</span>
                <span className="wb-task-row__title">Define 评审中(v{define.version})</span>
                <StatusChip status="ready" label="待评审" />
              </div>
            ))}
            {(lane.changedRequirements ?? []).map(req => (
              <div key={req.id} className="wb-task-row">
                <span className="wb-mono">{req.id}</span>
                <span className="wb-task-row__title">{req.title}</span>
                <StatusChip status="changed" label="需求已变更,需重走 G1" />
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="wb-grid wb-grid--kpi" style={{ marginBottom: 'var(--wb-sp-3)' }}>
        <KpiCard label="任务进度" value={`${done}/${total}`} sub={`${Math.round((done / Math.max(1, total)) * 100)}%`} />
        <KpiCard label="进行中" value={active} sub={active > 0 ? '执行中' : '空闲'} tone={active > 0 ? 'run' : undefined} />
        <KpiCard label="就绪 / 等待" value={`${ready} / ${blocked + resBlocked}`} sub={`${ready} ready · ${resBlocked} 等真机`} />
        <KpiCard label="活动租约" value={snapshot?.activeLeases ?? 0} sub={`隔离 ${snapshot?.resources.quarantined.length ?? 0} 项`} />
        <KpiCard
          label="验收(L1 口径)"
          value={data.report ? data.report.decision : snapshot?.acceptance?.decision ?? '—'}
          sub={data.report ? `证据包 ${data.report.bundle.id.slice(0, 16)}…` : '未评估 · 演示或验收页触发'}
          tone={data.report?.decision === 'PASS' || snapshot?.acceptance?.decision === 'PASS' ? 'ok' : 'warn'}
          onClick={() => props.onGoto('acceptance')}
        />
      </div>

      <div className="wb-grid wb-grid--2col" style={{ marginBottom: 'var(--wb-sp-3)' }}>
        <Card title="需求与基线">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span className="wb-mono">{data.snapshot?.requirements?.[0]?.id ?? 'REQ-COPY-0001'}</span>
            <span style={{ fontWeight: 600, fontSize: 13 }}>{data.snapshot?.requirements?.[0]?.title ?? '面板发起单页黑白复印'}</span>
          </div>
          <div className="wb-faint" style={{ fontSize: 12, lineHeight: 1.9 }}>
            产品基线:PRD-A4-MONO-MFP-v0.1
            <br />
            平台基线:PLAT-RK3588-BSP(Phase 0 待冻结)
            <br />
            口径:模拟闭环 = L1;真机层级未验证,不宣称整机验收
          </div>
          <button className="wb-btn wb-btn--sm" style={{ marginTop: 8 }} onClick={() => props.onGoto('acceptance')}>
            查看 Define 与验收 →
          </button>
        </Card>
        <Card title="资源健康">
          {resourceHealthRows(data).map(row => (
            <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12 }}>
              <StatusDot status={row.status} />
              <span style={{ flex: 1 }} className="wb-muted">{row.label}</span>
              <span className="wb-mono">{row.count}</span>
            </div>
          ))}
          <button className="wb-btn wb-btn--sm" style={{ marginTop: 8 }} onClick={() => props.onGoto('resources')}>
            资源中心 →
          </button>
        </Card>
      </div>

      <Card title="最近活动" sub="审计事件流">
        <ActivityFeed events={data.events} limit={30} />
      </Card>
    </div>
  )
}

function resourceHealthRows(data: WbData): Array<{ label: string; count: number; status: string }> {
  const groups = new Map<string, number>()
  for (const res of data.resources) {
    groups.set(res.state, (groups.get(res.state) ?? 0) + 1)
  }
  const order = ['available', 'busy', 'reserved_state', 'maintenance', 'quarantined']
  const labels: Record<string, string> = {
    available: '可用',
    busy: '占用中',
    reserved_state: '已预约',
    maintenance: '维护中',
    quarantined: '已隔离(真机待接入)',
  }
  return order
    .filter(status => groups.has(status))
    .map(status => ({ label: labels[status] ?? status, count: groups.get(status) ?? 0, status }))
}

// ---------- DAG 视图 ----------

export function DagView(props: { data: WbData }): React.JSX.Element {
  const { data } = props
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const taskById = new Map(data.tasks.map(task => [task.id, task]))
  const selected = selectedId ? taskById.get(selectedId) ?? null : null

  const act = async (action: 'run' | 'release', taskId: string): Promise<void> => {
    setBusy(true)
    try {
      const path = action === 'run' ? '/run-task' : '/release-task'
      await fetchJson(path, { method: 'POST', body: JSON.stringify({ taskId, humanAutoAccept: true }) })
    } finally {
      setBusy(false)
      await data.refresh()
    }
  }

  return (
    <div className="wb-view wb-view--wide">
      <ViewHead
        title="任务 DAG"
        sub={`${data.tasks.length} 个任务 · 关键路径约 ${data.snapshot?.criticalPath.totalMinutes ?? 0} 分钟`}
      />
      <div className="wb-dag__legend" style={{ marginBottom: 'var(--wb-sp-3)' }}>
        <DagLegend />
      </div>
      <div className="wb-dag-wrap">
        <TaskDag
          tasks={data.tasks}
          criticalIds={data.snapshot?.criticalPath.ids ?? []}
          selectedId={selectedId ?? undefined}
          onSelect={setSelectedId}
          height={580}
        />
        <TaskDetailPanel
          task={selected}
          taskById={taskById}
          events={data.events}
          onRun={id => void act('run', id)}
          onRelease={id => void act('release', id)}
          running={busy}
        />
      </div>
    </div>
  )
}

// ---------- 需求与验收 ----------

export function AcceptanceView(props: { data: WbData }): React.JSX.Element {
  const { data } = props
  const [busy, setBusy] = useState(false)
  const { toast, show } = useToast()

  const evaluate = async (): Promise<void> => {
    setBusy(true)
    try {
      await fetchJson('/acceptance', { method: 'POST', body: JSON.stringify({ requirementId: data.snapshot?.requirements?.[0]?.id ?? 'REQ-COPY-0001' }) })
      await data.reloadReport()
      show('已重新评估(L1 口径)')
    } catch (error) {
      show(`评估失败:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const report = data.report
  return (
    <div className="wb-view">
      <ViewHead
        title="需求与验收"
        sub={data.snapshot?.requirements?.map(req => req.id).join(' · ')}
        actions={
          <>
            <button className="wb-btn" disabled={busy} onClick={() => void evaluate()}>
              <Icon name="refresh" size={12} /> 重新评估(L1)
            </button>
            {report && (
              <a className="wb-btn" href={`/_dsh/dsh-firmware-workbench/report/latest.md`} style={{ textDecoration: 'none' }}>
                <Icon name="download" size={12} /> 下载报告 .md
              </a>
            )}
          </>
        }
      />
      {(data.snapshot?.requirements?.length ?? 0) === 0 ? (
        <Card>
          <EmptyState icon="file-text" title="还没有需求" hint="先到演示中心一键装载,或用 fwctl requirement import 导入" />
        </Card>
      ) : (
        <>
          <div className="wb-grid wb-grid--2col" style={{ marginBottom: 'var(--wb-sp-3)' }}>
            <div className={`wb-card wb-decision wb-decision--${report?.decision ?? 'BLOCKED'}`}>
              <div className="wb-decision__value">{report?.decision ?? '—'}</div>
              <div className="wb-decision__sub">模拟闭环口径(L1)· {report?.acceptanceId ?? '未生成'}</div>
              {report && <div className="wb-decision__sub">{timeShort(report.decidedAt)} · 最高已验证层级:{report.highestVerifiedLevel}</div>}
              {report && (
                <div className="wb-coverage">
                  <Coverage label="必选" value={report.coverage.requiredCases} />
                  <Coverage label="通过" value={report.coverage.passed} />
                  <Coverage label="失败" value={report.coverage.failed} />
                  <Coverage label="阻塞" value={report.coverage.blocked} />
                  <Coverage label="未执行" value={report.coverage.notRun} />
                </div>
              )}
            </div>
            <div className="wb-card wb-decision">
              <div className="wb-decision__value" style={{ color: 'var(--wb-st-blocked_resource)' }}>BLOCKED</div>
              <div className="wb-decision__sub">全量口径(含真机)</div>
              <div className="wb-decision__sub" style={{ lineHeight: 1.8 }}>
                规则:BLOCKED / INVALID / 未执行 ≠ 通过
                <br />
                等待:TASK-COPY-0050 起(Phase 0 事实冻结)
              </div>
            </div>
          </div>

          <div className="wb-grid wb-grid--2col">
            <Card title="需求 Define" sub={data.snapshot?.requirements?.[0]?.id}>
              <div className="wb-quote">"{data.snapshot?.requirements?.[0]?.title}"</div>
              <div className="wb-side__title">主流程</div>
              <ol className="wb-list-num">
                <li>用户在面板选择复印</li>
                <li>设备 A4 平板 300dpi 扫描</li>
                <li>图像校正与半色调</li>
                <li>引擎输出 1 页黑白 A4</li>
                <li>面板与作业状态 COMPLETED</li>
              </ol>
              <div className="wb-side__title" style={{ marginTop: 10 }}>异常流(必须正确地失败)</div>
              <ol className="wb-list-num">
                <li>扫描超时 → FAILED,错误码 SCAN-TIMEOUT</li>
                <li>打印前缺纸 → WAITING_FOR_PAPER</li>
                <li>引擎可恢复错误 → 自动重试一次</li>
              </ol>
              <div className="wb-side__title" style={{ marginTop: 10 }}>恢复规则</div>
              <ol className="wb-list-num">
                <li>缺纸补纸后继续输出并 COMPLETED</li>
                <li>缺纸未恢复 → FAILED,清理任务恢复资源健康</li>
                <li>取消后设备回到就绪,无残留作业</li>
              </ol>
              <details className="wb-fold" style={{ marginTop: 10 }}>
                <summary>范围外 / 非功能目标</summary>
                <div className="wb-faint" style={{ fontSize: 12, lineHeight: 1.9, marginTop: 6 }}>
                  outOfScope:PC 打印驱动开发
                  <br />
                  性能 / 资源阈值:待产品负责人签署(Phase 0)
                  <br />
                  可靠性:异常后设备必须回到已知状态
                </div>
              </details>
            </Card>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--wb-sp-3)' }}>
              <Card title="用例覆盖">
                {(data.cases ?? []).map(testCase => {
                  const latest = data.runs.filter(run => run.caseId === testCase.id).at(-1)
                  return (
                    <div key={testCase.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12 }}>
                      <StatusChip status={testCase.level} label={testCase.level} />
                      <span style={{ flex: 1 }} className="wb-muted">{testCase.title}</span>
                      {latest ? <StatusChip status={latest.result} /> : <span className="wb-faint">未执行</span>}
                    </div>
                  )
                })}
              </Card>
              <Card title="证据包">
                {report ? (
                  <>
                    <div className="wb-mono" style={{ marginBottom: 8 }}>{report.bundle.id}</div>
                    {report.bundle.files.slice(0, 10).map(file => (
                      <div key={file.path} style={{ display: 'flex', gap: 8, fontSize: 11, padding: '2px 0' }}>
                        <span className="wb-mono wb-faint">{file.path}</span>
                        <span style={{ flex: 1 }} />
                        <span className="wb-faint">{file.bytes} B</span>
                      </div>
                    ))}
                    <div className="wb-faint" style={{ fontSize: 11, marginTop: 6 }}>
                      哈希校验:全部文件 SHA-256,内容寻址不可变(方案 13.2)
                    </div>
                  </>
                ) : (
                  <div className="wb-faint" style={{ fontSize: 12 }}>尚未生成。运行演示 P7 或点击"重新评估"。</div>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
      <Toast text={toast} />
    </div>
  )
}

function Coverage(props: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="wb-coverage__item">
      <div className="wb-coverage__num">{props.value}</div>
      <div className="wb-coverage__label">{props.label}</div>
    </div>
  )
}

// ---------- 测试 ----------

export function TestsView(props: { data: WbData }): React.JSX.Element {
  const { data } = props
  const [busyCase, setBusyCase] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const { toast, show } = useToast()
  const l1Cases = data.cases.filter(testCase => testCase.level === 'L1')

  const runCase = async (testCase: CaseView): Promise<void> => {
    setBusyCase(testCase.id)
    try {
      const result = await fetchJson<{ ok: boolean; run: { result: string } }>('/case-run', {
        method: 'POST',
        body: JSON.stringify({ caseId: testCase.id }),
      })
      show(`${testCase.id} ${result.run.result}`)
      await data.reloadReport()
      await data.refresh()
    } catch (error) {
      show(`失败:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusyCase(null)
    }
  }

  const runAllL1 = async (): Promise<void> => {
    for (const testCase of l1Cases) {
      await runCaseSilent(testCase.id)
    }
    await data.reloadReport()
    show(`L1 套件执行完成(${l1Cases.length} 条)`)
  }
  const runCaseSilent = async (caseId: string): Promise<void> => {
    await fetchJson('/case-run', { method: 'POST', body: JSON.stringify({ caseId }) })
  }
  const [triageCase, setTriageCase] = useState<string | null>(null)
  const [triageNote, setTriageNote] = useState('')
  const [aiSuggest, setAiSuggest] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const doTriage = async (caseId: string, attribution: string): Promise<void> => {
    await fetchJson('/triage/confirm', {
      method: 'POST',
      body: JSON.stringify({ caseId, attribution, note: triageNote, severity: 'major' }),
    })
    show(`${caseId} 归因 ${attribution} 已确认`)
    setTriageCase(null)
    setTriageNote('')
    await data.reloadReport()
    await data.refresh()
  }
  const aiTriage = async (caseId: string): Promise<void> => {
    setAiBusy(true)
    setAiSuggest(null)
    try {
      const result = await fetchJson<{
        ok: boolean
        suggestion?: { attribution: string; confidence: string; rationale: string }
        error?: string
      }>('/ai/triage', {
        method: 'POST',
        body: JSON.stringify({ caseId, failureMessage: `${caseId} 测试失败` }),
      })
      setAiSuggest(
        result.suggestion
          ? `${result.suggestion.attribution}(${result.suggestion.confidence}):${result.suggestion.rationale}`
          : result.error ?? 'AI 无建议',
      )
    } catch (error) {
      setAiSuggest(error instanceof Error ? error.message : String(error))
    } finally {
      setAiBusy(false)
    }
  }

  return (
    <div className="wb-view">
      <ViewHead
        title="测试"
        sub={`共 ${data.cases.length} 条用例 · 最近运行 ${data.runs.length} 次`}
        actions={
          <button className="wb-btn wb-btn--primary" onClick={() => void runAllL1()} disabled={busyCase !== null}>
            <Icon name="play" size={12} /> 运行全部 L1
          </button>
        }
      />
      <Card flush>
        <table className="wb-table">
          <thead>
            <tr>
              <th style={{ width: 30 }} />
              <th>用例</th>
              <th>层级</th>
              <th>最近结果</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {data.cases.map(testCase => {
              const runs = data.runs.filter(run => run.caseId === testCase.id)
              const latest = runs.at(-1)
              const isL4 = testCase.level === 'L4'
              const expandedRow = expanded === testCase.id
              return (
                <>
                  <tr
                    key={testCase.id}
                    style={{ cursor: 'pointer', opacity: isL4 ? 0.55 : 1 }}
                    onClick={() => {
                      setExpanded(expandedRow ? null : testCase.id)
                      if (!expandedRow && latest && ['PRODUCT_FAIL', 'TEST_FAIL', 'INFRA_FAIL'].includes(latest.result)) setTriageCase(testCase.id)
                    }}
                  >
                    <td>{isL4 ? <span className="wb-faint">◌</span> : <StatusDot status={latest ? latest.result : 'planned'} />}</td>
                    <td>
                      <span className="wb-mono">{testCase.id}</span> <span className="wb-muted">{testCase.title}</span>
                    </td>
                    <td><StatusChip status={testCase.level} label={testCase.level} /></td>
                    <td>
                      {latest ? (
                        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          <StatusChip status={latest.result} /> <span className="wb-faint">{timeShort(latest.finishedAt)}</span>
                        </span>
                      ) : isL4 ? (
                        <span className="wb-faint">排队中 · 等待真机资源</span>
                      ) : (
                        <span className="wb-faint">未执行</span>
                      )}
                    </td>
                    <td>
                      {isL4 ? (
                        <span className="wb-faint" style={{ fontSize: 11 }}>等待 Phase 0</span>
                      ) : (
                        <button
                          className="wb-btn wb-btn--sm"
                          disabled={busyCase !== null}
                          onClick={event => {
                            event.stopPropagation()
                            void runCase(testCase)
                          }}
                        >
                          {busyCase === testCase.id ? '运行中…' : '▶ 运行'}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedRow && (
                    <tr key={`${testCase.id}-detail`}>
                      <td colSpan={5} style={{ background: 'var(--wb-bg-2)' }}>
                        <div className="wb-side__title">步骤</div>
                        {testCase.steps.map((step, index) => (
                          <div key={index} style={{ fontSize: 12, padding: '2px 0' }}>
                            <span className="wb-mono wb-faint">{index + 1}.</span>
                            {step.action && <span className="wb-mono"> {step.action}</span>}
                            {step.expect && <span> ⇒ <span className="wb-mono">{step.expect}</span></span>}
                            {step.human && <span> 👤 {step.human}</span>}
                          </div>
                        ))}
                        {latest && ['PRODUCT_FAIL', 'TEST_FAIL', 'INFRA_FAIL'].includes(latest.result) && triageCase === testCase.id && (
                          <div style={{ marginTop: 8, padding: 10, background: 'var(--wb-bg-1)', border: '1px solid var(--wb-border)', borderRadius: 6 }}>
                            <div className="wb-side__title">失败归因(四分类,提案 §3.2)</div>
                            {aiSuggest && <div className="wb-banner" style={{ marginBottom: 6 }}>AI 建议:{aiSuggest}</div>}
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                              {[
                                ['product', '产品缺陷'],
                                ['test', '用例问题'],
                                ['infra', '基础设施'],
                                ['spec', '验收标准有误(回流需求变更)'],
                              ].map(([key, label]) => (
                                <button key={key} className="wb-btn wb-btn--sm" disabled={busyCase !== null} onClick={() => void doTriage(testCase.id, key)}>
                                  {label}
                                </button>
                              ))}
                              <button className="wb-btn wb-btn--sm wb-btn--ghost" disabled={aiBusy} onClick={() => void aiTriage(testCase.id)}>
                                <Icon name="zap" size={11} /> {aiBusy ? 'AI 分析中…' : 'AI 归因建议'}
                              </button>
                            </div>
                            <input
                              className="wb-input"
                              placeholder="归因说明/根因"
                              value={triageNote}
                              onChange={event => setTriageNote(event.target.value)}
                            />
                          </div>
                        )}
                        <div className="wb-side__title" style={{ marginTop: 8 }}>前置 / 证据</div>
                        <div className="wb-faint" style={{ fontSize: 11, lineHeight: 1.8 }}>
                          前置:{testCase.preconditions.join(' · ') || '—'}
                          <br />
                          证据:{testCase.evidence.join(' · ') || '—'}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </Card>
      <Toast text={toast} />
    </div>
  )
}

// ---------- 资源 ----------

export function ResourcesView(props: { data: WbData }): React.JSX.Element {
  const { data } = props
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const { toast, show } = useToast()

  const act = async (resourceId: string, action: 'quarantine' | 'maintain'): Promise<void> => {
    await fetchJson('/resource-action', { method: 'POST', body: JSON.stringify({ resourceId, action, reason: '人工隔离(演示)' }) })
    setConfirmId(null)
    show(action === 'quarantine' ? `${resourceId} 已隔离` : `${resourceId} 已恢复可用`)
    await data.refresh()
  }

  const quarantined = data.resources.filter(res => res.state === 'quarantined')
  const others = data.resources.filter(res => res.state !== 'quarantined')

  return (
    <div className="wb-view">
      <ViewHead title="测试资源" sub={`${data.resources.length} 类 · 占用 ${data.resources.filter(res => res.busyUnits > 0).length} · 隔离 ${quarantined.length}`} />
      <div className="wb-grid wb-grid--3col" style={{ marginBottom: 'var(--wb-sp-3)' }}>
        {others.map(res => (
          <div key={res.id} className="wb-res-card">
            <div className="wb-res-card__head">
              <span className="wb-res-card__id">{res.id}</span>
              <StatusChip status={res.busyUnits > 0 ? 'busy' : res.state} label={res.busyUnits > 0 ? `占用 ${res.busyUnits}/${res.units}` : STATUS_LABELS[res.state] ?? res.state} />
            </div>
            <div className="wb-res-card__desc">{res.description}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {res.mode === 'capacity' && (
                <div className="wb-cap">
                  {Array.from({ length: res.units }).map((_, index) => (
                    <span key={index} className={`wb-cap__unit${index < res.busyUnits ? ' wb-cap__unit--on' : ''}`} />
                  ))}
                </div>
              )}
              <span style={{ flex: 1 }} />
              <button className="wb-btn wb-btn--sm wb-btn--ghost" onClick={() => setConfirmId(res.id)}>
                隔离
              </button>
            </div>
          </div>
        ))}
      </div>
      {quarantined.length > 0 && (
        <>
          <div className="wb-side__title" style={{ marginBottom: 8 }}>已隔离(真机 / 工装 Provider 未接入)</div>
          <div className="wb-grid wb-grid--3col">
            {quarantined.map(res => (
              <div key={res.id} className="wb-res-card wb-res-card--quarantined">
                <div className="wb-res-card__head">
                  <span className="wb-res-card__id">{res.id}</span>
                  <StatusChip status="quarantined" />
                </div>
                <div className="wb-res-card__desc">{res.description}</div>
                <div className="wb-banner" style={{ fontSize: 11 }}>{res.quarantineReason ?? '未知原因'}</div>
                <button className="wb-btn wb-btn--sm" style={{ marginTop: 8 }} onClick={() => void act(res.id, 'maintain')}>
                  维护恢复
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <Card title="活动租约" style={{ marginTop: 'var(--wb-sp-3)' }} flush>
        {data.leases.length === 0 ? (
          <EmptyState title="当前没有活动租约" hint="运行任务后将在此显示资源占用" icon="clock" />
        ) : (
          <table className="wb-table">
            <thead>
              <tr><th>资源</th><th>任务</th><th>模式</th><th>到期</th><th /></tr>
            </thead>
            <tbody>
              {data.leases.map(lease => (
                <tr key={lease.id}>
                  <td className="wb-mono">{lease.resourceId}</td>
                  <td className="wb-mono">{lease.taskId}</td>
                  <td>{lease.mode}</td>
                  <td className="wb-faint">{timeShort(lease.expiresAt)}</td>
                  <td>
                    <button className="wb-btn wb-btn--sm" onClick={() => void act(lease.resourceId, 'maintain')}>
                      释放
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {confirmId && (
        <div className="wb-modal-mask" onClick={() => setConfirmId(null)}>
          <div className="wb-modal" onClick={event => event.stopPropagation()}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>隔离资源</div>
            <div className="wb-muted" style={{ fontSize: 12, marginBottom: 12 }}>
              将 <span className="wb-mono">{confirmId}</span> 标记为隔离(演示用途),随后可在资源卡上"维护恢复"。
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="wb-btn wb-btn--ghost" onClick={() => setConfirmId(null)}>取消</button>
              <button className="wb-btn wb-btn--danger" onClick={() => void act(confirmId, 'quarantine')}>确认隔离</button>
            </div>
          </div>
        </div>
      )}
      <Toast text={toast} />
    </div>
  )
}

// ---------- 设备座舱 ----------

export function CockpitView(props: { data: WbData }): React.JSX.Element {
  const { data } = props
  const [interactive, setInteractive] = useState(false)
  const job = data.sim?.job
  const running = !!job && !job.finished

  useEffect(() => {
    void data.refreshSim()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runScenario = async (scenario: string): Promise<void> => {
    await fetchJson('/sim/run', { method: 'POST', body: JSON.stringify({ scenario, interactive, slow: true }) })
    await data.refreshSim()
  }
  const action = async (name: 'load-paper' | 'give-up' | 'cancel'): Promise<void> => {
    await fetchJson('/sim/action', { method: 'POST', body: JSON.stringify({ action: name }) })
    await data.refreshSim()
  }

  return (
    <div className="wb-view wb-view--wide">
      <ViewHead
        title="设备座舱"
        sub="虚拟打印机 · 真机 Provider 待 Phase 0 接入"
        actions={
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={interactive} onChange={event => setInteractive(event.target.checked)} />
            手动交互模式(缺纸时由你补纸)
          </label>
        }
      />
      <div className="wb-grid" style={{ gridTemplateColumns: '340px 250px 1fr' }}>
        <Card title="虚拟设备" flush>
          <div style={{ padding: 'var(--wb-sp-3)' }}>
            <DevicePanel sim={data.sim} width={300} />
          </div>
        </Card>
        <Card title="复印操作">
          <ScenarioButtons
            running={running}
            activeScenario={job?.scenario}
            interactive={interactive}
            waitingPaper={job?.state === 'WAITING_FOR_PAPER'}
            onRun={scenario => void runScenario(scenario)}
            onAction={name => void action(name)}
          />
        </Card>
        <Card title="作业时间线" sub={job ? `${job.jobId} · ${job.scenario}` : undefined}>
          <JobTimeline sim={data.sim} />
          <details className="wb-fold" style={{ marginTop: 10 }}>
            <summary>统一事件流(审计视角)</summary>
            <div style={{ marginTop: 8 }}>
              <ActivityFeed events={data.events} limit={15} />
            </div>
          </details>
        </Card>
      </div>
    </div>
  )
}

