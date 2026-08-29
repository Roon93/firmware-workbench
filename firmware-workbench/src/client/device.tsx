/** 虚拟打印机面板(设计文档 §6):SVG 设备正面视图 + 场景操作 + 作业时间线。 */

import type { SimState } from './model.js'

type SimScenario = string
import { timeShort, type DemoLogLine } from './model.js'
import { StatusChip, Terminal } from './ui.js'

const SCENARIOS: Array<{ group: string; items: Array<{ key: SimScenario; desc: string }> }> = [
  {
    group: '主流程',
    items: [{ key: 'success', desc: '扫描 → 图像 → 出纸 1 页' }],
  },
  {
    group: '异常与恢复',
    items: [
      { key: 'cancel-before-scan', desc: '扫描前取消,回到就绪' },
      { key: 'scan-timeout', desc: '扫描超时 → FAILED' },
      { key: 'paper-empty-then-recover', desc: '缺纸 → 补纸 → 继续' },
      { key: 'paper-empty-no-recovery', desc: '缺纸未恢复 → FAILED' },
      { key: 'engine-recoverable-error', desc: '引擎可恢复错误,自动重试' },
    ],
  },
]

const SCREEN_TEXT: Record<string, { main: string; sub: string; tone: string }> = {
  IDLE: { main: 'READY', sub: '就绪', tone: '#8b93a5' },
  SCANNING: { main: 'SCANNING', sub: '扫描中 · 300dpi', tone: '#2bc8f0' },
  PROCESSING: { main: 'PROCESSING', sub: '图像处理中', tone: '#2bc8f0' },
  PRINTING: { main: 'PRINTING', sub: '出纸中…', tone: '#2bc8f0' },
  WAITING_FOR_PAPER: { main: 'NO PAPER', sub: '缺纸,请补纸', tone: '#ff8a4d' },
  COMPLETED: { main: 'COMPLETE', sub: '复印完成 · 1 页', tone: '#3fbf7f' },
  FAILED: { main: 'ERROR', sub: '作业失败', tone: '#ff5c5c' },
  CANCELLED: { main: 'CANCELLED', sub: '已取消', tone: '#7d8590' },
}

export function DevicePanel(props: { sim: SimState | null; width?: number }): React.JSX.Element {
  const sim = props.sim
  const jobState = sim?.job?.state ?? 'IDLE'
  const screen = SCREEN_TEXT[jobState] ?? SCREEN_TEXT.IDLE!
  const busy = ['SCANNING', 'PROCESSING', 'PRINTING'].includes(jobState)
  const error = ['WAITING_FOR_PAPER', 'FAILED'].includes(jobState)
  const paperRatio = Math.max(0, Math.min(1, (sim?.device.paperCount ?? 200) / (sim?.device.paperCapacity ?? 250)))
  const done = jobState === 'COMPLETED'

  return (
    <svg width={props.width ?? 330} viewBox="0 0 400 360" style={{ display: 'block', flex: 'none' }}>
      {/* 机身 */}
      <rect x={10} y={10} width={380} height={340} rx={18} fill="var(--wb-bg-2)" stroke="var(--wb-border-strong)" strokeWidth={1.5} />
      <rect x={10} y={10} width={380} height={60} rx={18} fill="url(#wb-dev-gloss)" opacity={0.5} />
      <defs>
        <linearGradient id="wb-dev-gloss" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity={0.08} />
          <stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* 顶盖:平板扫描器 */}
      <rect x={40} y={30} width={230} height={54} rx={8} fill="#0d1117" stroke="var(--wb-border-strong)" />
      <text x={56} y={52} fontSize={10} fill="#55607a" fontFamily="var(--wb-font-mono)">FLATBED A4</text>
      <rect x={48} y={62} width={214} height={14} rx={3} fill="#111827" />
      {jobState === 'SCANNING' && (
        <rect x={48} y={62} width={214} height={14} rx={3} fill="url(#wb-scan-grad)">
          <animate attributeName="opacity" values="0.2;1;0.2" dur="1.2s" repeatCount="indefinite" />
        </rect>
      )}
      <defs>
        <linearGradient id="wb-scan-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#2bc8f0" stopOpacity={0.1} />
          <stop offset="0.5" stopColor="#2bc8f0" stopOpacity={0.9} />
          <stop offset="1" stopColor="#2bc8f0" stopOpacity={0.1} />
        </linearGradient>
      </defs>

      {/* 指示灯 */}
      <circle cx={306} cy={46} r={6} fill="#3fbf7f" />
      <circle cx={328} cy={46} r={6} fill={busy ? '#2bc8f0' : '#1e2632'} stroke="#313b4d">
        {busy && <animate attributeName="opacity" values="1;0.25;1" dur="0.8s" repeatCount="indefinite" />}
      </circle>
      <circle cx={350} cy={46} r={6} fill={error ? '#ff5c5c' : '#1e2632'} stroke="#313b4d" />

      {/* 屏幕 */}
      <rect x={40} y={104} width={230} height={112} rx={10} fill="#0d1117" stroke="#313b4d" />
      <text x={58} y={152} fontSize={19} fontWeight={650} fill={screen.tone} fontFamily="var(--wb-font-mono)">
        {screen.main}
      </text>
      <text x={58} y={180} fontSize={12} fill="#9aa4b6">{screen.sub}</text>
      {sim?.job && (
        <text x={58} y={202} fontSize={10} fill="#55607a" fontFamily="var(--wb-font-mono)">
          {sim.job.jobId} · {sim.job.scenario}
        </text>
      )}

      {/* 出纸口 */}
      <rect x={296} y={130} width={84} height={10} rx={3} fill="#0d1117" stroke="#313b4d" />
      {done && (
        <g>
          <rect x={308} y={118} width={52} height={74} rx={2} fill="#f5f6f8" stroke="#c9d1de">
            <animate attributeName="y" from={186} to={112} dur="1.2s" fill="freeze" calcMode="spline" keySplines="0.2 0.7 0.3 1" />
          </rect>
          <text x={318} y={148} fontSize={9} fill="#5a6475" fontFamily="var(--wb-font-mono)">A4</text>
          <line x1={312} y1={158} x2={356} y2={158} stroke="#c9d1de" strokeWidth={0.8} />
          <line x1={312} y1={164} x2={352} y2={164} stroke="#c9d1de" strokeWidth={0.8} />
          <line x1={312} y1={170} x2={350} y2={170} stroke="#c9d1de" strokeWidth={0.8} />
        </g>
      )}

      {/* 纸盒 */}
      <rect x={40} y={252} width={230} height={64} rx={8} fill="#0d1117" stroke="var(--wb-border-strong)" />
      <text x={56} y={272} fontSize={10} fill="#55607a" fontFamily="var(--wb-font-mono)">CASSETTE · A4</text>
      <rect x={56} y={282} width={198} height={18} rx={3} fill="#111827" />
      <rect
        x={56}
        y={282}
        width={Math.max(0, 198 * paperRatio)}
        height={18}
        rx={3}
        fill={paperRatio === 0 ? '#ff8a4d' : '#33d6b0'}
        opacity={0.75}
      />
      <text x={56} y={314} fontSize={10} fill={paperRatio === 0 ? '#ff8a4d' : '#9aa4b6'} fontFamily="var(--wb-font-mono)">
        {sim?.device.paperCount ?? 200} / {sim?.device.paperCapacity ?? 250} 张
      </text>

      {/* 品牌铭牌 */}
      <text x={306} y={310} fontSize={10} fill="#55607a" fontFamily="var(--wb-font-mono)">PRINTER-01</text>
      <text x={306} y={326} fontSize={9} fill="#3d4557" fontFamily="var(--wb-font-mono)">RK3588 · SIM</text>
    </svg>
  )
}

export function ScenarioButtons(props: {
  running: boolean
  activeScenario?: string
  interactive: boolean
  waitingPaper: boolean
  onRun: (scenario: SimScenario) => void
  onAction: (action: 'load-paper' | 'give-up' | 'cancel') => void
}): React.JSX.Element {
  return (
    <div className="wb-scene-btns">
      <button
        className={`wb-btn wb-btn--primary${props.running ? '' : ''}`}
        disabled={props.running}
        onClick={() => props.onAction('cancel')}
        style={{ justifyContent: 'center' }}
      >
        取消当前作业
      </button>
      {SCENARIOS.map(group => (
        <div key={group.group}>
          <div className="wb-scene-btns__group">{group.group}</div>
          {group.items.map(item => (
            <button
              key={item.key}
              className={`wb-scene-btn${props.activeScenario === item.key ? ' wb-scene-btn--active' : ''}`}
              disabled={props.running}
              onClick={() => props.onRun(item.key)}
            >
              <span className="wb-scene-btn__key">{item.key}</span>
              <span className="wb-scene-btn__desc">{item.desc}</span>
            </button>
          ))}
        </div>
      ))}
      {props.waitingPaper && (
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button className="wb-btn wb-btn--primary" onClick={() => props.onAction('load-paper')}>
            补纸继续
          </button>
          <button className="wb-btn" onClick={() => props.onAction('give-up')}>
            放弃等待
          </button>
        </div>
      )}
      {!props.waitingPaper && props.interactive && (
        <div className="wb-faint" style={{ fontSize: 11 }}>
          交互模式:选择"paper-empty-then-recover"后可现场扮演用户补纸
        </div>
      )}
    </div>
  )
}

export function JobTimeline(props: { sim: SimState | null }): React.JSX.Element {
  const job = props.sim?.job
  if (!job) {
    return (
      <div className="wb-empty" style={{ padding: '40px 16px' }}>
        <div className="wb-empty__title">暂无作业</div>
        <div className="wb-empty__hint">从左侧发起一个复印场景</div>
      </div>
    )
  }
  const demoLines: DemoLogLine[] = job.events.map(event => ({
    ts: event.ts,
    level: event.kind.includes('error') ? 'error' : 'info',
    text: `${event.kind}${event.detail ? ` ${event.detail}` : ''}`,
  }))
  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span className="wb-mono" style={{ fontSize: 14, fontWeight: 600 }}>{job.jobId}</span>
        <span className="wb-faint" style={{ fontSize: 12 }}>{job.scenario}</span>
        <StatusChip status={job.finished ? (job.pass ? 'PASS' : 'PRODUCT_FAIL') : 'running'} label={job.finished ? (job.pass ? '符合预期' : '偏离预期') : '运行中'} />
        <span className="wb-faint" style={{ fontSize: 11 }}>{timeShort(job.startedAt)}</span>
      </div>
      <Terminal lines={demoLines} height={300} />
      {job.finished && job.message && (
        <div className="wb-faint" style={{ fontSize: 11, marginTop: 8 }}>{job.message}</div>
      )}
    </div>
  )
}
