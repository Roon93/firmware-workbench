/** 工作台骨架(设计文档 §3):token 注入、侧边导航、视图路由、统一数据流。 */

import { useState } from 'react'
import { WbProvider, useWorkbenchData, type WbData } from './model.js'
import { Icon } from './ui.js'
import { WB_CSS } from './theme.js'
import { DemoView } from './views-demo.js'
import { AcceptanceView, CockpitView, DagView, OverviewView, ResourcesView, TestsView } from './views.js'

export const inject = ['theme']

type ViewKey = 'demo' | 'overview' | 'dag' | 'acceptance' | 'tests' | 'resources' | 'cockpit'

const NAV: Array<{ key: ViewKey; label: string; icon: string }> = [
  { key: 'demo', label: '演示中心', icon: 'play' },
  { key: 'overview', label: '总览', icon: 'gauge' },
  { key: 'dag', label: '任务 DAG', icon: 'git-branch' },
  { key: 'acceptance', label: '需求与验收', icon: 'shield-check' },
  { key: 'tests', label: '测试', icon: 'flask' },
  { key: 'resources', label: '资源', icon: 'box' },
  { key: 'cockpit', label: '设备座舱', icon: 'printer' },
]

function ensureStyle(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById('wb-style')) return
  const style = document.createElement('style')
  style.id = 'wb-style'
  style.textContent = WB_CSS
  document.head.appendChild(style)
}

export function Dashboard(props: { colorScheme: 'light' | 'dark' }): React.JSX.Element {
  ensureStyle()
  const data = useWorkbenchData()
  const [view, setView] = useState<ViewKey>('demo')
  const [fullscreen, setFullscreen] = useState(false)
  const scheme = props.colorScheme === 'light' ? 'light' : 'dark'

  // 收起态:DSH 页面右下角一个悬浮入口,点击全屏进入工作台
  if (!fullscreen) {
    return (
      <button className="wb-fab" onClick={() => setFullscreen(true)} title="进入打印机固件工作台">
        <Icon name="printer" size={16} /> 进入工作台
      </button>
    )
  }

  return (
    <WbProvider value={data}>
      <div className="wb-root wb-fullscreen" data-scheme={scheme}>
        <div className="wb-exit-bar">
          <button className="wb-btn wb-btn--sm" onClick={() => setFullscreen(false)}>
            <Icon name="x" size={11} /> 退出工作台
          </button>
          <span className="wb-exit-bar__title">打印机固件工作台</span>
          <span className="wb-exit-bar__sub">Printer-01 · RK3588 · 模拟闭环</span>
          <span style={{ flex: 1 }} />
          <span className="wb-dot" style={{ background: data.apiOk ? 'var(--wb-st-succeeded)' : 'var(--wb-st-failed_product)' }} />
        </div>
        <div className="wb-shell">
          <Sidebar view={view} onViewChange={setView} apiOk={data.apiOk} />
          <main className="wb-main">
            {data.apiError && <div className="wb-banner--api">座舱 API 不可达:{data.apiError}(自动重试中)</div>}
            {view === 'demo' && <DemoView data={data} onGotoAcceptance={() => setView('acceptance')} />}
            {view === 'overview' && <OverviewView data={data} onGoto={key => setView(key as ViewKey)} />}
            {view === 'dag' && <DagView data={data} />}
            {view === 'acceptance' && <AcceptanceView data={data} />}
            {view === 'tests' && <TestsView data={data} />}
            {view === 'resources' && <ResourcesView data={data} />}
            {view === 'cockpit' && <CockpitView data={data} />}
          </main>
        </div>
      </div>
    </WbProvider>
  )
}

function Sidebar(props: { view: ViewKey; onViewChange: (view: ViewKey) => void; apiOk: boolean }): React.JSX.Element {
  return (
    <aside className="wb-sidebar">
      <div className="wb-brand">
        <div className="wb-brand__logo">
          <Icon name="printer" size={15} />
        </div>
        <div>
          <div className="wb-brand__name">固件工作台</div>
          <div className="wb-brand__sub">Printer-01 · RK3588</div>
        </div>
      </div>
      {NAV.map(item => (
        <button
          key={item.key}
          className={`wb-nav__item${props.view === item.key ? ' wb-nav__item--active' : ''}`}
          onClick={() => props.onViewChange(item.key)}
        >
          <Icon name={item.icon} size={15} />
          {item.label}
        </button>
      ))}
      <div className="wb-sidebar__foot">
        <span className="wb-dot" style={{ background: props.apiOk ? 'var(--wb-st-succeeded)' : 'var(--wb-st-failed_product)' }} />
        {props.apiOk ? '座舱 API 正常' : 'API 不可达'}
      </div>
    </aside>
  )
}

export { useWorkbenchData, WbProvider }
export type { WbData }
