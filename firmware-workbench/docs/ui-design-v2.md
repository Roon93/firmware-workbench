# 打印机固件工作台 Web UI 设计文档 v2

> 面向 `src/client/dashboard.tsx` 的重设计。目标读者:前端开发、后端配合开发、评审的产品/领导。
> 本文给出**确定性设计决策**:所有色值、字号、间距、交互行为、API 形状均为定案,可直接照做。

---

## 1. 设计目标与原则

### 1.1 产品定位

两个使用场景,优先级从高到低:

1. **汇报演示**(核心):向领导/客户一键演示"需求导入 → 契约冻结 → 五路并行开发 → 自测 → 模拟集成 → 异常恢复 → 证据化验收报告"的完整闭环。演示对象不是工程师,界面必须自带叙事,不需要讲解人解释"这个数字是什么意思"。
2. **日常工程使用**:看 DAG、跑任务、管资源、查证据。信息密度高、操作直达、不弹无用确认。

### 1.2 设计原则

| # | 原则 | 落地含义 |
|---|------|---------|
| P1 | **Mission Control,不是后台管理** | 视觉类比示波器/Grafana:深色为主、等宽字体承载机器数据(job id、时间戳、哈希、状态迁移)、状态色语义全局一致 |
| P2 | **状态即颜色,颜色即语义** | 全站 15 个任务状态 + 5 个资源状态共用一套语义色板;任何芯片、DAG 节点、KPI、时间线圆点都取自同一 token,绝不出现"同一状态两种颜色" |
| P3 | **演示是产品能力,不是操作流程** | 演示中心是一等视图;剧本由**后端编排**(DemoDirector),前端只做播放器,禁止前端循环调用业务 API 拼剧本 |
| P4 | **叙事与数据同屏** | 每个演示阶段配一句"为什么这一步重要";观众看画面,讲解人看数据,同一屏 |
| P5 | **诚实呈现未完成** | 真机任务 `blocked_resource`、资源 `quarantined`、"全量口径 BLOCKED"是演示的亮点而非瑕疵,用"预期停顿/等待 Phase 0"的明确视觉语言呈现,不用报错红字吓人 |
| P6 | **零依赖** | 只有 react/react-dom。样式 = 一个注入的 `<style>` + CSS 变量;图标 = 内联 SVG;图形 = SVG;无图片资源、无 router、无状态库 |
| P7 | **跟随 DSH 主题** | 默认深色;DSH 切亮色时整套 token 走亮色分支,组件代码零改动 |

### 1.3 明确不做

- 不做移动端适配(面板最小支持宽度 1024px,由 DSH 桌面宿主保证)。
- 不做 Websocket/SSE(本轮用轮询,见 §9.3)。
- 不做多语言(全站中文;`STATUS_LABELS` 保留为常量表)。
- 不重做后端数据模型,只补路由(§8)。

---

## 2. Design Tokens

### 2.1 主题机制

`Dashboard` 根元素持有 `data-scheme="dark" | "light"`(来自现有 `colorScheme` prop)。所有 token 定义在 `.wb-root[data-scheme=…]` 作用域下;组件只引用变量,不感知主题。**默认 dark**——即使 DSH 是亮色,演示前也建议手动切深色(演出效果最好)。

### 2.2 色彩

**中性色(深色主题)**

| Token | 值 | 用途 |
|---|---|---|
| `--wb-bg-0` | `#0b0e14` | 页面背景 |
| `--wb-bg-1` | `#11151c` | 卡片/面板背景 |
| `--wb-bg-2` | `#171d27` | 卡片内嵌块(表格头、代码块、终端) |
| `--wb-bg-3` | `#1e2632` | hover / 选中态背景 |
| `--wb-border` | `#232a37` | 常规边框、分隔线 |
| `--wb-border-strong` | `#313b4d` | hover 边框、输入框聚焦边框 |
| `--wb-text-1` | `#e6eaf2` | 主文字(标题、数值) |
| `--wb-text-2` | `#9aa4b6` | 次文字(说明、表头) |
| `--wb-text-3` | `#5f6b7e` | 弱文字(占位、时间戳) |

**中性色(亮色主题)**:`--wb-bg-0:#f5f6f8` / `--wb-bg-1:#ffffff` / `--wb-bg-2:#f0f2f5` / `--wb-bg-3:#e8ecf2` / `--wb-border:#e2e6ed` / `--wb-border-strong:#c9d1de` / `--wb-text-1:#1a2230` / `--wb-text-2:#5a6475` / `--wb-text-3:#98a2b3`。

**品牌色**(两主题共用)

| Token | 值 | 用途 |
|---|---|---|
| `--wb-accent` | `#5b8cff` | 主按钮、选中导航、关键路径描边、链接、焦点环 |
| `--wb-accent-hover` | `#729dff` | 主按钮 hover |
| `--wb-accent-bg` | `rgba(91,140,255,.14)` | 选中项底色、焦点行 |
| `--wb-danger` | `#ef4444` | 危险按钮(隔离资源)、API 错误横幅 |
| `--wb-danger-bg` | `rgba(239,68,68,.12)` | 错误横幅底色 |

**状态语义色(核心表,两主题共用主色;芯片 = 主色文字 + 12% 底 + 35% 边)**

| 状态 | Token 后缀 | 主色值 | 语义 | 使用位置 |
|---|---|---|---|---|
| `succeeded` | `-ok` | `#3fbf7f` | 成功/健康/可用 | 任务完成、资源 available、用例 PASS |
| `running` | `-run` | `#2bc8f0` | 正在执行(带 1.6s 呼吸脉冲动画) | 任务 running、资源 busy、面板 SCANNING/PRINTING |
| `verifying` | `-verify` | `#33d6b0` | 验证中 | 任务 verifying |
| `ready` | `-ready` | `#5b9dff` | 可运行、可点击执行(蓝 = 可行动) | Ready 队列、DAG 上"运行"按钮 |
| `reserved` | `-rsv` | `#7c8cff` | 已预约(租约已持有) | 任务 reserved、资源 reserved_state |
| `blocked_dependency` | `-dep` | `#e2b341` | 等待上游依赖(琥珀 = 可自行解除的等待) | DAG 节点、芯片 |
| `blocked_gate` | `-gate` | `#b48ef5` | 等待人/门禁决策(紫 = 需要人的输入) | G3 等待、门禁阻塞 |
| `blocked_resource` | `-res` | `#ff8a4d` | 等待资源(橙 = 设备性等待,演示中是**预期状态**) | 真机任务队列、缺纸等待 |
| `quarantined` | `-quar` | `#ff5c5c` | 已隔离(红 = 硬不可用) | 隔离资源、`failed_product` 复用红 |
| `failed_product` | `-fprod` | `#ef4444` | 产品失败(真 Bug) | 任务、报告 |
| `failed_test` | `-ftest` | `#f97316` | 测试失败(断言未过) | 用例结果 |
| `failed_infra` | `-finfra` | `#8b93a5` | 基础设施失败(灰蓝 = 非产品问题,可重试) | 任务、用例 |
| `invalid` | `-inv` | `#d98fd1` | 结果无效,需清理重跑 | 用例结果 |
| `cancelled` | `-cancel` | `#7d8590` | 已取消(中性灰,不是错误) | 任务、作业 |
| `planned` / `draft` | `-plan` | `#98a2b3` | 已规划/草稿 | DAG 未点亮节点 |
| `maintenance` | `-maint` | `#e2b341` | 维护中 | 资源状态 |

派生规则(写死在 tokens 里,不运行时计算):每个状态 `X` 生成三个变量——
`--wb-st-X`(主色,上表)、`--wb-st-X-bg`(主色 @ 12% alpha)、`--wb-st-X-border`(主色 @ 35% alpha)。深色主题下芯片文字用主色;亮色主题下 `--wb-st-X` 统一换成加深 15% 的版本(在亮色 token 块中覆写,如 `#1e9e63`、`#0e8ec4`、`#c78a1e` 等,保证 4.5:1 对比度)。

**语义速记(演示讲解词可用)**:绿=成了、青=正在跑、蓝=可以点、琥珀=等上游、橙=等设备、紫=等人拍板、红=真坏了、灰=不算数。

### 2.3 字体与字号

```css
--wb-font-sans: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
--wb-font-mono: ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, "SFMono-Regular", monospace;
```

| Token | 值 | 用途 |
|---|---|---|
| `--wb-fs-11` | 11px / lh 1.5 | 表格辅助列、时间戳、事件流 |
| `--wb-fs-12` | 12px / lh 1.55 | 表格正文、芯片、说明文字 |
| `--wb-fs-13` | 13px / lh 1.6 | **全局基准字号**(正文、列表) |
| `--wb-fs-14` | 14px / lh 1.6 | 卡片标题、按钮 |
| `--wb-fs-16` | 16px / 600 | 视图标题、KPI 副标 |
| `--wb-fs-20` | 20px / 600 | KPI 大数字 |
| `--wb-fs-26` | 26px / 650 | 演示中心阶段标题、验收结论 |

**等宽字体使用场景(强制)**:job id、task id、资源 id、时间戳、ISO 时间、sha256/哈希、错误码(`SCAN-TIMEOUT`、`PAPER_EMPTY`)、终端日志、状态机状态名(`SCANNING`)、CLI 命令。类:`.wb-mono { font-family: var(--wb-font-mono); font-size: 12px; }`。数字统计(KPI 数值)也用等宽,保证跳动时宽度稳定。

### 2.4 间距 / 圆角 / 阴影 / 层级

```css
--wb-sp-1: 4px;  --wb-sp-2: 8px;  --wb-sp-3: 12px; --wb-sp-4: 16px;
--wb-sp-5: 20px; --wb-sp-6: 24px; --wb-sp-8: 32px;
--wb-r-sm: 4px;   /* 芯片、输入框、小按钮 */
--wb-r-md: 8px;   /* 卡片、终端 */
--wb-r-lg: 12px;  /* 模态、演示舞台 */
--wb-shadow-1: 0 1px 2px rgba(0,0,0,.35);
--wb-shadow-2: 0 8px 24px rgba(0,0,0,.35);   /* 深色;亮色改为 rgba(16,24,40,.10) */
--wb-z-sticky: 10; --wb-z-pop: 100; --wb-z-modal: 200; --wb-z-toast: 300;
```

间距纪律:卡片内边距 `--wb-sp-4`;卡片间距 `--wb-sp-3`;区块间距 `--wb-sp-6`;视图头部下边距 `--wb-sp-5`。信息密度目标:一屏(1080p,面板区 ~1400×820)在 DAG 视图内完整呈现 19 节点 + 侧栏。

### 2.5 CSS 类命名规范

前缀 `wb-`,BEM-lite。**组件库内禁止 inline style**(动画参数除外)。

| 类 | 用途 |
|---|---|
| `wb-root` / `wb-shell` / `wb-sidebar` / `wb-main` | 根、双栏骨架 |
| `wb-nav__item` (+ `--active`) | 侧边导航项 |
| `wb-view` / `wb-view__head` / `wb-view__title` | 视图容器与头部 |
| `wb-card` / `wb-card__head` / `wb-card__body` (+ `--flush`) | 通用卡片 |
| `wb-grid` / `wb-grid--kpi` / `wb-grid--2col` | 布局网格 |
| `wb-kpi` / `wb-kpi__value` / `wb-kpi__label` (+ `--{tone}`) | KPI 卡 |
| `wb-chip` (+ `wb-chip--{status}`) | 状态芯片(全局唯一状态色载体) |
| `wb-dot` (+ `wb-dot--{status}`) | 8px 状态圆点(时间线、图例) |
| `wb-btn` (+ `--primary` / `--ghost` / `--danger` / `--sm`) | 按钮 |
| `wb-table` (+ `wb-table th/td`) | 数据表(仅测试矩阵、租约两处) |
| `wb-dag` / `wb-dag__node` / `wb-dag__edge` / `wb-dag__node--critical` | DAG SVG |
| `wb-term` / `wb-term__line` (+ `--info/--warn/--err`) | 终端日志 |
| `wb-tl` / `wb-tl__item` / `wb-tl__dot` | 垂直时间线 |
| `wb-dev*` | 设备面板(§6) |
| `wb-empty` | 空状态(图标 + 一句话 + 可选动作按钮) |
| `wb-modal` / `wb-toast` | 确认弹层、轻提示 |

### 2.6 图标

内联 SVG,统一 `width/height=16`,`stroke="currentColor"`,`stroke-width=1.6`,`fill=none`,round cap/join(Feather 风格,自绘路径)。清单(导航 7 个 + 功能 8 个):play(演示)、gauge(总览)、git-branch(DAG)、shield-check(验收)、flask(测试)、box(资源)、printer(座舱)、refresh、chevron-right、x(关闭)、alert-triangle、file-text(报告)、download、clock、check、pause、skip-forward、rotate-ccw(重播)。

---

## 3. 信息架构与导航

### 3.1 视图清单(7 个,取代现有 4 个顶部按钮)

侧边栏从上到下,顺序即演示叙事顺序:

| # | 视图 | key | 理由 |
|---|------|-----|------|
| 1 | **演示中心** | `demo` | 核心新能力,置顶。打开页面即可一键开演 |
| 2 | **总览** | `overview` | 日常首页:KPI + 需求/基线 + 活动流 |
| 3 | **任务 DAG** | `dag` | 替代原"任务编排"表格。表格丢进详情侧栏,DAG 是主视图 |
| 4 | **需求与验收** | `acceptance` | 原 Overview 的 Define 卡升级为完整视图;双口径决定 + 报告渲染是卖点 |
| 5 | **测试** | `tests` | 原 Cockpit 里的用例列表独立成视图(7 用例矩阵 + 运行) |
| 6 | **资源** | `resources` | 原"测试资源"保留,卡片化 |
| 7 | **设备座舱** | `cockpit` | 虚拟打印机面板 + 作业时间线 + 事件流 |

调整说明:原"定义与总览"拆成 2/4(总览要快,验收要深);测试从座舱拆出(座舱聚焦设备画面);演示中心单独成页避免与总览抢焦点。

### 3.2 骨架

```
┌ wb-root (max-width:1400px; margin:0 auto; height:100vh; padding:0) ───────────┐
│ ┌ wb-sidebar 208px ┐ ┌ wb-main (padding: var(--wb-sp-5) 24px) ──────────────┐ │
│ │ 品牌 + 导航 7 项  │ │ wb-view(路由 = useState,无 router)                │ │
│ │ 底部:连接状态点  │ │ 内部 max-width:1120px(演示中心放宽到 100%)        │ │
│ └──────────────────┘ └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

- 导航项:图标 16 + 文字 13px;激活态 `--wb-accent-bg` 底 + 左侧 2px accent 竖条;hover `--wb-bg-3`。
- 侧边栏底部常驻状态点:绿 = 座舱 API 正常(轮询成功),红 = 断连(显示"API 不可达")。
- **响应式**:面板宽 < 1180px 时侧栏收缩为 56px 纯图标(hover 展开 tooltip);< 1024px 维持图标栏。不做更窄。

### 3.3 全局数据流

`App` 组件持有单一 `useWorkbenchData()` hook:统一轮询(§9.3)获取 `snapshot/tasks/resources/events/cases/demo/sim`,通过 React context 下发;写操作(post)后立即触发一次定向刷新。视图组件只读 context,保证 DAG/座舱/演示中心看到的状态强一致(演示时三者同屏联动的前提)。

---

## 4. 演示中心(核心)

### 4.1 编排模型(定案)

- **后端新增 `DemoDirector`**(建议 `src/core/demo-player.ts`):持有剧本状态机,按阶段串行执行真实业务动作(复用 `seedDemo`、`runTaskLocally`、`evaluateRequirement`、`generateAcceptanceBundle`、`VirtualDevice`),把每个阶段产物写进事件流(`kind: 'demo.*'`)。演示状态存内存,进程重启即 idle。
- **前端是纯播放器**:只调 `/demo/*` 四个接口 + 轮询 `/demo/state`,绝不自己编排业务调用。
- 两种模式:`auto`(后端定时器按 `speedMs` 自动推进,默认 1500ms/步)与 `step`(停在 `awaiting_next`,等前端点"下一步")。随时可 `pause`(auto→step)。

### 4.2 剧本(阶段 - 叙事 - 画面 三栏表)

| # | 阶段(后端动作) | 面向观众的一句话叙事(界面原文) | 画面联动 |
|---|---|---|---|
| P0 | **装载种子**<br>`seedDemo(reset:true)` | "一条命令装载完整工程语境:1 条需求、5 份接口契约、19 个任务、7 个用例、12 类资源——这就是开工前的工程骨架。" | 全部 KPI 归零后回填;DAG 19 节点以灰(planned)铺开;终端打印种子清单 |
| P1 | **需求定义**<br>`TASK-COPY-0001` 标记 succeeded | "先把'复印'翻译成工程语言:主流程、异常流、验收标准——评审通过才允许写代码。" | 右侧舞台显示 Define 摘要卡(主流程 5 步);DAG L0 节点翻绿 |
| P2 | **契约冻结 + G3 门禁**<br>`TASK-COPY-0002` + G3 approved | "五个模块先签接口契约再并行开发,谁也不等谁、谁也不改谁的接口。" | 舞台列出 IF-JOB-MANAGER 等 5 个契约 v1 + G3 徽章;DAG L1 翻绿 |
| P3 | **五路并行开发**<br>顺序 run `0010/0011/0012/0013/0014` | "面板、作业、扫描、图像、引擎五个工作包同时开工,共享构建资源 build/rk3588——资源租约保证不打架。" | DAG 中间 5 节点同时青色脉冲,逐个翻绿(每个间隔 ~1.2s);资源卡 build/rk3588 显示 busy |
| P4 | **组件自测**<br>顺序 run `0010-T…0014-T` | "交付即自测:每个包在 L1 层验证契约不变式,问题不上溯到集成。" | 5 个 `-T` 节点翻绿;测试矩阵 L1 列开始出现 PASS 点 |
| P5 | **模拟集成(主流程)**<br>run `0030`(sim success,慢速时序) | "五件套合体:虚拟设备完整跑一遍'扫描 → 图像处理 → 出纸'——这就是没有真机时的整机。" | **座舱面板实况**:屏显 SCANNING→PROCESSING→PRINTING→COMPLETED;出纸动画;job 时间线逐条滚动;DAG 0030 翻绿 |
| P6 | **异常恢复套件**<br>run `0031`(copy-recovery,6 场景) | "必选异常一个不落:取消、扫描超时、缺纸恢复、缺纸终止、引擎错误——失败场景也要'正确地失败',这才是固件质量。" | 舞台出现 6 格场景结果墙,逐格点亮 pass;面板快速重演对应画面(缺纸时红 LED + PAPER_EMPTY 屏显);终端打印每场景 oracle 断言 |
| P7 | **验收评估 + 证据包**<br>run `0040` + `evaluateRequirement(L1)` + `generateAcceptanceBundle` | "独立验收:必选用例全部执行且通过才给 PASS,全过程证据打包留痕、可审计。" | 舞台渲染**验收报告卡**(结论 PASS L1、覆盖表 7 格、bundle id);DAG 0040 翻绿 |
| P8 | **真机队列(预期停顿)**<br>不执行;展示 `0050/0051/0052` | "真机任务诚实排队:整机资源已隔离,等待 Phase 0 事实冻结——系统不会假装验证过它没验证的东西。" | DAG 尾部 3 节点橙色 + 虚线边;舞台显示"排队等待真实设备(Phase 0)"说明条,停 3s(自动模式也停);资源卡 8 项红色"已隔离" |
| P9 | **完成** | "从一句话需求到 PASS L1 验收报告,全程 25 秒,每一步都有证据。" | 全屏结论横幅:PASS L1 大字 + 报告入口按钮 + "重播"按钮;彩带不需要,克制收尾 |

时序目标:auto 模式全程 25~35s(P5 单场景慢速时序约 4s:scan 1200 / process 700 / print 1500 ms;P6 每场景 ~1.5s)。

### 4.3 线框

```
┌ wb-view:演示中心 ────────────────────────────────────────────────────────────────┐
│  演示中心                                    [▶ 开始完整演示] [单步 ▸] [重播 ↺]   │
│                                                                                  │
│  ┌ 阶段时间轴(wb-demo-steps,横向 stepper,等宽 10 段)──────────────────────────┐ │
│  │ ●种子──●定义──●契约──●并行──●自测──▶集成──○异常──○验收──○真机──○完成          │ │
│  │  done   done  done  done  done  ACTIVE(pulse)                                │ │
│  └──────────────────────────────────────────────────────────────────────────────┘ │
│  ┌ 左:阶段叙事 420px ─────────────┐  ┌ 右:演示舞台 (flex-1, 高 ~380px) ────────┐ │
│  │ 阶段 06 / 09        [1x ▾]      │  │  (按阶段切换内容,见下表)               │ │
│  │ ┏━━━━━━━━━━━━━━━━━━━━━━━━━┓    │  │                                          │ │
│  │ ┃ 模拟集成:虚拟复印主流程  ┃    │  │   [DAG 迷你视图] / [虚拟面板] /          │ │
│  │ ┃ 五件套合体:虚拟设备完整   ┃    │  │   [报告卡] / [场景结果墙]                │ │
│  │ ┃ 跑一遍扫描→处理→出纸。    ┃    │  │                                          │ │
│  │ ┗━━━━━━━━━━━━━━━━━━━━━━━━━┛    │  │                                          │ │
│  │ ▸ 本阶段动作: TASK-COPY-0030   │  │                                          │ │
│  │ ▸ 验证点: 终态 COMPLETED,1 页 │  │                                          │ │
│  └────────────────────────────────┘  └──────────────────────────────────────────┘ │
│  ┌ 终端日志流(wb-term,高 200px,自动滚动,_mono)───────────────────────────────┐ │
│  │ 14:02:11  demo   ▶ 阶段 06 开始:模拟集成 TASK-COPY-0030                       │ │
│  │ 14:02:12  job    COPY_START -> SCANNING            [job-8f3a]                 │ │
│  │ 14:02:14  engine  出纸完成:1 页黑白 A4             [job-8f3a]                 │ │
│  │ 14:02:15  demo   ✓ TASK-COPY-0030 succeeded (15s est)                         │ │
│  └──────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 4.4 交互细节

- **开始完整演示**:主按钮(accent 实底)。点击 → `POST /demo/play {mode:'auto', reset:true}`。运行中主按钮变"暂停"(→ `POST /demo/pause`),"单步"变高亮的"下一步"(→ `POST /demo/step`)。
- **单步模式**:每阶段停在 `awaiting_next`;stepper 当前段呼吸,"下一步"按钮出现键盘提示 `Enter`(监听全局 keydown,仅 demo 视图且 awaiting 时生效)。
- **重播**:`POST /demo/reset` → 全部归 idle,日志清空,DAG 复灰。二次确认不需要(后端 reset 幂等,且种子会重装)。
- **阶段点击**:已完成/当前阶段可点击,舞台直接切换到该阶段的内容回放(只读,不回滚后端状态)。
- **日志流**:新行从底部追加,自动滚动;用户向上滚动时暂停自动滚动并在右下角出现"回到底部"浮标(`overflow-anchor: none` + 手动控制)。行结构:`时间戳(3 级灰) actor(kind 着色) 文本`。`error` 行 `--wb-st-fprod` 色。
- **联动**:演示运行期间,设备座舱视图与 DAG 视图同样在动(共享轮询)——讲解人中途切到 DAG 视图看细节再切回来,是预期用法。
- **空状态**(未开始):舞台区显示产品一句话 + 大按钮"开始完整演示" + "或 单步播放";左侧叙事区显示剧本简介(10 个阶段的目录,可点击跳转该阶段说明)。
- **速度**:叙事卡右上 `1x / 2x` 分段控件,改 `speedMs`(1500/700),`POST /demo/play {speedMs}` 热更。

### 4.5 舞台内容分派(实现规格)

| 阶段 | 舞台内容 | 复用组件 |
|---|---|---|
| P0 | KPI 缩略 4 卡 + 任务数计数动画 | `KpiCard` |
| P1 | Define 摘要卡(主流程编号列表 + 验收标准 3 条) | `DefineDoc`(compact) |
| P2 | 契约列表(5 行,冻结徽章)+ G3 门禁章 | `ContractList` |
| P3/P4 | DAG 迷你视图(仅 11 个模拟层节点,自适应 viewBox) | `TaskDag`(mini prop) |
| P5 | 虚拟打印机面板(完整动画)+ job 时间线 | `DevicePanel` + `JobTimeline` |
| P6 | 6 格场景结果墙(格 = 场景名 + 终态芯片 + pass 勾) | `ScenarioWall` |
| P7 | 验收报告卡(结论横幅 + 覆盖率 7 数字 + bundle id) | `DecisionCard` |
| P8 | 排队说明条 + 3 个真机任务列表(橙色芯片 + 原因) | `BlockedQueueCard` |
| P9 | 结论横幅 + "查看完整报告"按钮(跳验收视图) | `DecisionCard`(full) |

---

## 5. 各视图线框与交互说明

### 5.1 总览(Overview)

```
┌ wb-view ────────────────────────────────────────────────────────────────────────┐
│ 总览   Printer-01 · RK3588 · 模拟闭环                    [运行下一个 Ready] [⟳]  │
│                                                                                 │
│ ┌ wb-grid--kpi:5 列(等高 88px)────────────────────────────────────────────────┐│
│ │ ┌─────────┐┌─────────┐┌─────────┐┌─────────┐┌─────────────────────────────┐ ││
│ │ │任务进度  ││进行中   ││就绪/阻塞 ││活动租约  ││验收(L1 口径)               │ ││
│ │ │ 12/19   ││ 2      ││ 3 / 4   ││ 2      ││ PASS · 证据包 OK · 2h 前    │ ││
│ │ │▓▓▓▓▓░░░ ││ (青点)  ││ 3 ready ││        ││ 或:BLOCKED · 3 项未执行    │ ││
│ │ └─────────┘└─────────┘└─────────┘└─────────┘└─────────────────────────────┘ ││
│ └──────────────────────────────────────────────────────────────────────────────┘│
│ ┌ 需求与基线(2fr) ──────────────┐ ┌ 资源健康(1fr) ─────────────────────────────┐│
│ │ REQ-COPY-0001 面板发起单页黑白复印 [high]·approved                           ││
│ │ 产品基线 PRD-A4-MONO-MFP-v0.1 │ │ ● 4 available   ● 2 busy                   ││
│ │ 平台基线 PLAT-RK3588-BSP(Phase 0 待冻结)│ │ ● 1 maintenance ● 8 quarantined  ││
│ │ 口径:模拟闭环=L1;不宣称整机验收 │ │ → 点击行跳资源视图                        ││
│ │ [查看 Define →](跳 acceptance)│ └────────────────────────────────────────────┘│
│ └────────────────────────────────┘                                              │
│ ┌ 最近活动流(全宽,高 240px,wb-tl)────────────────────────────────────────────┐│
│ │ ● 14:02  task.succeeded  TASK-COPY-0030 模拟集成:虚拟设备单页复印主流程        ││
│ │ ● 14:01  lease.acquired  sim/engine ← TASK-COPY-0030 (exclusive, 至 14:31)    ││
│ │ ○ 13:58  demo.seed_done  19 tasks / 7 cases                                   ││
│ └──────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
```

交互:`运行下一个 Ready` = 现有逻辑保留(取 readyQueue 第一个,`POST /run-task`)。KPI 卡 hover 抬升(`shadow-1`→`shadow-2`),点击跳对应视图。验收 KPI 无数据时显示"未评估"+ 灰字"在演示或验收视图触发"。活动流取 `/events` 前 30 条,`kind` 前缀映射圆点色(`task.succeeded`→绿、`*.error`→红、其余灰)。

### 5.2 任务 DAG

```
┌ wb-view ────────────────────────────────────────────────────────────────────────────┐
│ 任务 DAG   [图例: ■成功 ■运行 ■就绪 ■等上游 ■等门禁 ■等资源 ■排队]   [适配缩放 100%▾]│
│ ┌ 画布(flex-1, wb-dag, SVG viewBox 自适应)────────────┐ ┌ 详情侧栏 320px ─────────┐│
│ │                                                      │ │ TASK-COPY-0031          ││
│ │   ┌──────────────┐                                   │ │ 模拟异常恢复:取消/超时/… ││
│ │   │ 0001 Define ●│  节点=150×44 圆角矩形             │ │ 状态:[已完成] 估值 20m   ││
│ │   └──────┬───────┘  左上状态条 3px                   │ │ ─ 依赖 ─                ││
│ │   ┌──────┴───────┐                                   │ │  · 0030 已完成 ✓        ││
│ │   │ 0002 契约  ● │                                   │ │ ─ 资源需求 ─            ││
│ │   └──────┬───────┘                                   │ │  · sim/scanner 1        ││
│ │      ┌┴┐┌┴┐┌┴┐┌┴┐┌┴┐  0010..0014(5 并行)          │ │  · sim/engine  1        ││
│ │      ┌┴┐┌┴┐┌┴┐┌┴┐┌┴┐  0010-T..0014-T               │ │ ─ 阻塞原因 ─(若有,橙条)││
│ │         ┌┴────┴┐                                   │ │ ─ 最近日志(事件过滤)──  ││
│ │         │ 0030 │  集成                             │ │  14:02:31 suite 6/6 pass││
│ │         └──┬───┘                                   │ │ ───────────────────     ││
│ │         ┌──┴───┐   关键路径:0001→0002→0012→0012-T  │ │ [▶ 运行此任务]          ││
│ │         │ 0031 │   →0030→0031→0040(accent 粗描边)  │ │ (或 [释放租约])         ││
│ │         └──┬───┘                                   │ └─────────────────────────┘│
│ │    ╔═══╗┌┴┐┌┴┐  0050/0051/0052 橙色+虚线出边        │                            │
│ │    ║0040║(排队等待真实设备)                          │                            │
│ │    ╚═══╝                                            │                            │
│ └──────────────────────────────────────────────────────┘ └─────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────────┘
```

**布局算法(定案)**:拓扑分层(Sugiyama 简化版)。层号 = 最长上游路径;同层节点水平均布,层间垂直间距 64px,节点水平间距 24px。边 = 三次贝塞尔(控制点取中点 x),`stroke: var(--wb-border-strong)`,宽 1.5;hover 节点时入边/出边高亮为 accent、其余节点降到 35% 不透明度。关键路径边:`--wb-accent`,宽 2.5,`stroke-dasharray` 无,节点加 `.wb-dag__node--critical` 外描边。无环校验失败(理论上不会)时降级为现有表格视图 + 顶部警告条。

**节点内容**:第一行 task id(mono 11px),第二行标题截断 12px,左侧 3px 状态色竖条,右下角估值 `20m`(text-3)。`blocked_*` 节点右上角小图标(alert-triangle 10px)。

**交互**:
- 单击节点 → 右侧详情侧栏(路由态 `selectedTaskId`,URL 不变)。侧栏含:状态芯片、依赖列表(各带状态点,点击跳转该任务)、资源需求(带当前可用性)、`blockedReason` 橙色横幅、动作按钮。
- 动作按钮按状态:`ready/planned/blocked_*` → `运行此任务`(`POST /run-task {taskId, humanAutoAccept:true}`,运行中转圈禁点);`reserved/running/verifying` → `释放租约`(`POST /release-task`)。
- 双击节点 → 事件流面板展开该任务日志(取 `/events?taskId=`,见 §8)。
- hover 节点 → tooltip:标题全称 + 状态 + 阻塞原因一行。
- 画布空白处滚轮缩放(0.6~1.6)+ 拖拽平移;右上"适配缩放"复位。
- 19 节点数据来自现有 `GET /tasks`(已含 `dependencies/resources/actions/policy` 全量字段,无需后端改动)。

### 5.3 需求与验收

```
┌ wb-view ────────────────────────────────────────────────────────────────────────┐
│ 需求与验收                       [重新评估(L1)] [下载报告 .md] [下载证据包]      │
│ ┌ 验收决定(双口径,两卡并排)───────────────────────────────────────────────────┐│
│ │ ┌ 模拟闭环口径(L1)──────────┐ ┌ 全量口径(含真机)────────────────────────┐ ││
│ │ │  大字:PASS      ✓         │ │  大字:BLOCKED        ⏸                  │ ││
│ │ │  ACCEPT-REQ-COPY-0001-003 │ │  原因:真机层级未验证(L4 用例排队)       │ ││
│ │ │  最高已验证层级:L1(模拟层)│ │  规则:BLOCKED/INVALID/未执行≠通过       │ ││
│ │ │  生成于 2026-08-28 14:05  │ │  等待:TASK-COPY-0050(Phase 0)          │ ││
│ │ └───────────────────────────┘ └──────────────────────────────────────────┘ ││
│ └──────────────────────────────────────────────────────────────────────────────┘│
│ ┌ 需求 Define(1.2fr)────────────────────┐ ┌ 覆盖与证据(1fr)───────────────────┐│
│ │ REQ-COPY-0001 · 面板发起单页黑白复印    │ │ 覆盖汇总(数字格):                 ││
│ │ ─ 主流程(编号 1-5 列表)              │ │  必选 7 · 通过 5 · 阻塞 2 · 失败 0  ││
│ │ ─ 异常流(3 条,橙色左条)             │ │ 用例明细表(用例/层级/最近结果)      ││
│ │ ─ 恢复规则(3 条,绿色左条)           │ │ ─ 证据包 ─                         ││
│ │ ─ 验收标准表(标题/方法/阈值/L 级)    │ │  bundle EVI-…(sha 前 8 位)        ││
│ │   全宽折叠区(<details> 语义,收起时只显示│ │  manifest.json / task-plan.yaml   ││
│ │   NFR 与 outOfScope)                   │ │  results/junit.xml … 文件树        ││
│ └─────────────────────────────────────────┘ └────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
```

要点:
- **报告渲染成页面,不是 yaml 原文**:`GET /report/latest` 返回结构化 JSON(§8),前端用 `DecisionCard` + `ReportBody` 渲染;"下载报告"直链 `GET /report/latest.md`(`content-type: text/markdown`,浏览器直接下载)。旧报告(历史 seq)通过决定卡上的"历史"下拉切换(取 `GET /report/list`)。
- Define 的原始文本(`original_text`)以引用块样式放在最上方(灰斜体),结构化 `definition` 在下——体现"从原话到工程语言"。
- 空状态:未评估过 → 决定区显示 `wb-empty`:"尚未生成验收决定",按钮"运行验收任务 TASK-COPY-0040"或"立即评估(L1)"。

### 5.4 测试

```
┌ wb-view ────────────────────────────────────────────────────────────────────────┐
│ 测试    最近运行 12 次 · L1 全通过                       [运行全部 L1]           │
│ ┌ 用例矩阵(wb-table,行=用例,7 行)─────────────────────────────────────────────┐│
│ │           │ 用例                │ 层级 │ 最近结果        │ 次数 │ 操作        ││
│ │ ● TC-FUNC-0001 面板发起单页复印… │ L1  │ [PASS · 14:02] │ 3   │ [▶ 运行]    ││
│ │ ● TC-REC-0002  扫描前取消        │ L1  │ [PASS]         │ 2   │ [▶ 运行]    ││
│ │ ● TC-REC-0003  扫描超时→FAILED   │ L1  │ [PASS]         │ 2   │ [▶ 运行]    ││
│ │ ● TC-REC-0004  缺纸补纸恢复      │ L1  │ [PASS]         │ 2   │ [▶ 运行]    ││
│ │ ● TC-REC-0005  缺纸未恢复终止    │ L1  │ [PASS]         │ 2   │ [▶ 运行]    ││
│ │ ◌ TC-REC-0006  真机真实出纸      │ L4  │ [BLOCKED_RESOURCE] │ 0 │ [排队中·灰] ││
│ │ ◌ TC-REC-0007  真机缺纸恢复      │ L4  │ [BLOCKED_RESOURCE] │ 0 │ [排队中·灰] ││
│ └──────────────────────────────────────────────────────────────────────────────┘│
│ ┌ 用例详情(点击行展开,下方抽屉)────────────────────────────────────────────────┐│
│ │ 前置条件 · 步骤(action/expect/human 图标区分)· 证据要求 · 历史运行列表        ││
│ └──────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
```

- L4 行整行 45% 不透明度 + 行首 `◌` 空心点;操作列显示灰字"排队中 · 等待真机资源"且按钮禁用(hover tooltip:已隔离,等待 Phase 0)。
- `运行`→ `POST /cases/:id/run`;按钮转圈;完成后该行"最近结果"刷新 + 右上 toast"TC-REC-0004 PASS"。
- 层级用 `wb-chip`:L1 绿、L4 橙。

### 5.5 资源

```
┌ wb-view ────────────────────────────────────────────────────────────────────────┐
│ 测试资源    12 类 · 占用 2 · 隔离 8                     [隔离全部模拟资源(演示)] │
│ ┌ 资源卡网格(3 列)───────────────────────────────────────────────────────────── ┐│
│ │ ┌──────────────────────────┐ ┌──────────────────────────┐ ┌──────────────────┐ ││
│ │ │ sim/scanner      [可用]  │ │ build/rk3588   [占用 1/2]│ │ device/printer-01│ ││
│ │ │ 虚拟扫描器(接口级)      │ │ 构建队列                  │ │ [已隔离]         ││
│ │ │                          │ │                          │ │ ┌──────────────┐ ││
│ │ └──────────────────────────┘ └──────────────────────────┘ │ │真机 Provider  │ ││
│ │                                                            │ │未接入(Phase 0)│ ││
│ │                                                            │ └──────────────┘ ││
│ │                                                            │ [已隔离,等待…]   ││
│ │                                                            └──────────────────┘││
│ └─────────────────────────────────────────────────────────────────────────────── ┘│
│ ┌ 活动租约(wb-table)─────────────────────────────────────────────────────────── ┐│
│ │ sim/engine ← TASK-COPY-0030 · exclusive · 至 14:31 · [释放]                    ││
│ └─────────────────────────────────────────────────────────────────────────────── ┘│
└───────────────────────────────────────────────────────────────────────────────── ┘
```

- 卡片:资源 id(mono)+ 描述 + 状态芯片 + 占用 `busy/units` 进度点。`quarantined` 卡:红边 + 隔离原因横幅 + `维护恢复` 按钮;`available` 卡 hover 显示 `隔离` 次按钮(点击弹确认模态,输入原因,默认"人工隔离(演示)")→ `POST /resource-action`。
- 隔离原因横幅固定一句:`真机 Provider 未接入(Phase 0 事实待冻结)`(来自后端字段,不前端硬编码)。
- 活动租约行 hover 高亮,"释放"按钮即现有 `POST /release-task`。

### 5.6 设备座舱(见 §6 详细设计)

```
┌ wb-view ────────────────────────────────────────────────────────────────────────────┐
│ 设备座舱   虚拟打印机 · job-8f3a                          [场景演示快捷: 成功|缺纸…] │
│ ┌ 左:虚拟设备 400px ──────────────┐ ┌ 中:复印操作 260px ─┐ ┌ 右:作业时间线 flex-1 ─┐│
│ │   (§6 的设备正面视图)           │ │ 场景 6 按钮(分组)  │ │ job-8f3a               ││
│ │                                 │ │ ─ 成功 ──────────  │ │ ●14:02:11 panel 发起…  ││
│ │  ┌────────┐                     │ │ ─ 异常恢复 ──────  │ │ ●14:02:12 SCAN…->PROC  ││
│ │  │ 屏幕    │  ● ● ● 指示灯      │ │ [补纸] [放弃]      │ │ ●14:02:14 出纸 1 页    ││
│ │  └────────┘                     │ │ [手动交互模式 ▢]   │ │ (状态迁移用箭头 mono)  ││
│ │  ───── 出纸口 ═══[纸]            │ │                    │ │ 统一事件流(可折叠)     ││
│ └─────────────────────────────────┘ └────────────────────┘ └────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. 虚拟打印机面板设计

### 6.1 设备正面视图(纯 SVG,400×360 viewBox)

```
        ┌────────────────────────────────────┐
        │  ╔══════════════════╗              │   ← 顶盖:平板扫描器(扫描中时
        │  ║   原稿玻璃 A4     ║              │      有青色扫描线从左到右往复)
        │  ╚══════════════════╝              │
        │   ┌────────────────┐   ● ● ●       │   ← 指示灯:电源(绿常亮)/
        │   │  屏幕 220×110   │   LED         │      活动(青,工作态闪烁)/
        │   │ "SCANNING…"    │               │      错误(红,FAILED/缺纸亮)
        │   └────────────────┘               │
        │                     ▓▓▓▓▓▓ ←出纸口 │   ← 出纸口缝(COMPLETED 时一页
        │   ┌──────────────┐   ┌─────┐      │      纸从缝里滑出,1.2s 动画)
        │   │ 纸盒 纸量 250 │   │纸页 │      │
        │   │ ▓▓▓▓▓▓▓░░ 80% │   └─────┘      │
        │   └──────────────┘                 │
        └────────────────────────────────────┘
```

各部件规格:

| 部件 | 规格与状态映射 |
|---|---|
| 屏幕 | 220×110 圆角内嵌屏(深底 `#0d1117` 固定,不随主题)。两行内容:第一行状态大字(mono 16px,如 `SCANNING`),第二行中文辅助(12px,如"扫描中 · 第 1/1 页")。状态色:IDLE 灰"就绪"、SCANNING/PROCESSING/PRINTING 青、WAITING_FOR_PAPER 橙 + 提示"缺纸,请补纸"、COMPLETED 绿"完成"、FAILED 红 + 错误码、CANCELLED 灰"已取消"。 |
| 扫描线 | SCANNING 时顶盖玻璃区一条 2px 青色横线,`@keyframes wb-scan` 1.2s 往复;其他状态隐藏 |
| 指示灯 | 3 个 10px 圆:电源(绿常亮)、活动(青,SCANNING/PROCESSING/PRINTING 时 0.8s 闪烁)、错误(红,WAITING_FOR_PAPER/FAILED 常亮) |
| 纸盒 | 底部横条,内部填充高度 = 纸量百分比(默认 80%,`GET /sim/state` 提供 `paperCount/paperCapacity`);`paper-empty` 场景触发时动画降至 0 并变橙 |
| 出纸口 | 右侧水平缝;COMPLETED 时一页 64×90 白纸(`--wb-bg-1` 亮边)从缝中滑出 28px + 轻微下倾,1.2s ease-out,随后停驻并显示"第 N 页";新作业开始时收回 |
| 机身 | 圆角矩形,深色主题下 `--wb-bg-2` + `--wb-border` 1.5px 描边 + 顶部渐变高光(linear-gradient,静态) |

### 6.2 复印操作区

- **场景按钮 6 个**(全宽竖排,分组标题):主流程组 = `success`;异常恢复组 = `cancel-before-scan / scan-timeout / paper-empty-then-recover / paper-empty-no-recovery / engine-recoverable-error`。按钮文案:场景 key(mono 12px)+ 中文一句话(11px text-2),如 `paper-empty-then-recover · 缺纸后补纸,继续出纸`。
- 点击 → `POST /sim/run {scenario}` → 返回 `jobId`,面板进入该作业的实况渲染(轮询 `/sim/state`,见下)。按钮运行中全部禁用,当前场景按钮高亮。
- **手动交互模式**(默认关):开启后 `paper-empty-then-recover` 不自动补纸——设备停在 WAITING_FOR_PAPER,操作区出现两个动作按钮:`[补纸继续]`(→ `POST /sim/action {action:'load-paper'}`)、`[放弃等待]`(→ `{action:'give-up'}`)。这是"人机协同"卖点:演示者可现场扮演用户补纸。
- 非交互场景的缺纸恢复由后端自动执行(现 `runCopy` 语义),面板照样呈现 WAITING_FOR_PAPER → PRINTING 的往返。

### 6.3 作业时间线(右侧)

- 头部:`job-8f3a`(mono,大号)+ 场景名 + 终态芯片;下为 wb-tl 垂直时间线,每项 = 时间戳(mono 11)+ 事件 kind + detail;状态迁移行(`job.state`)用 `A → B` 格式,迁移后的状态词按语义色着色。
- 底部可折叠"统一事件流"(`GET /events` 全量,审计视角),默认收起。
- 轮询:`/sim/state` 每 500ms(仅座舱视图或演示 P5/P6 阶段激活时;`/sim/run` 返回后自动开,终态后停)。设计定案:**后端在 `/sim/run` 使用慢速时序**(scan 1200 / process 700 / print 1500 ms;手动恢复等待无超时),让动画可见——不影响测试路径(测试用例运行仍走快速时序)。

---

## 7. 组件清单

(所有组件位于 `src/client/`,建议新结构:`dashboard.tsx` 仅剩骨架,视图拆 `views/*.tsx`,组件拆 `components/*.tsx`,tokens 在 `theme.css.ts` 导出注入字符串。)

| 组件 | Props(概要) | 说明 |
|---|---|---|
| `WbRoot` | `scheme: 'dark'\|'light'` | 注入 `<style>`(幂等)、`data-scheme`、提供 `WbContext` |
| `Sidebar` | `view, onViewChange, apiOk` | 导航 7 项 + 底部状态点;<1180px 收缩 |
| `ViewHeader` | `title, subtitle?, actions?: ReactNode` | 各视图统一头 |
| `StatusChip` | `status: string, label?: string` | 唯一状态色载体,类 `wb-chip--{status}` |
| `KpiCard` | `label, value, sub?, tone?, onClick?` | 总览 KPI;value 用 mono |
| `ActivityFeed` | `events: EventView[], limit?` | wb-tl 活动流 |
| `EmptyState` | `icon, title, hint?, actionLabel?, onAction?` | 全站空状态 |
| `TaskDag` | `tasks: TaskView[], criticalIds: string[], selectedId?, onSelect, mini?: boolean` | 分层布局 + SVG;mini 模式用于演示舞台 |
| `DagNode` / `DagEdge` | 内部组件 | 150×44 节点、贝塞尔边、hover 高亮 |
| `TaskDetailPanel` | `task: TaskView, deps: TaskView[], onRun, onRelease, events` | DAG 右侧抽屉 |
| `DemoPlayer` | `state: DemoState, onPlay/onPause/onStep/onReset, onSpeed` | 演示中心壳;组合 Stepper/Narrative/Stage/Term |
| `DemoStepper` | `phases: Phase[], current, onSelectPhase` | 横向阶段时间轴 |
| `DemoStage` | `phase: Phase` | 按 §4.5 分派舞台内容 |
| `DemoTerminal` | `lines: LogLine[]` | 终端流,自动滚动 + 回到底部浮标 |
| `DevicePanel` | `sim: SimState` | §6 SVG 设备;含出纸动画 |
| `ScenarioButtons` | `running: boolean, interactive: boolean, onRun(scenario), onAction(a)` | 6 场景 + 手动补纸/放弃 |
| `JobTimeline` | `job: SimJob` | 单作业事件时间线 |
| `CaseMatrix` | `cases: CaseView[], runs: RunRecord[], onRunCase` | 7 用例矩阵 + 行展开详情 |
| `ResourceCard` | `resource: ResourceView, onQuarantine, onMaintain` | 含隔离原因横幅 |
| `LeaseTable` | `leases: LeaseView[], onRelease` | 活动租约表 |
| `DefineDoc` | `requirement, define, criteria, compact?: boolean` | Define 结构化渲染(compact 供演示舞台) |
| `DecisionCard` | `report: LatestReport, caliber: 'L1'\|'full'` | 双口径决定卡 |
| `ReportView` | `report: LatestReport` | 报告正文排版渲染(覆盖表、理由、用例明细) |
| `ConfirmModal` / `Toast` | — | 隔离确认、操作轻提示 |
| `Icon` | `name: IconName, size?: number` | 内联 SVG 集合 |

共 25 个(含 2 个内部子组件),符合 15~25 目标。全站仅 `WbRoot` 持有 `<style>`,其余零 style 注入。

---

## 8. 后端 API 差距清单

现有保留:`GET /snapshot /tasks /resources /events /cases`;`POST /demo-seed /run-task /release-task /resource-action /acceptance`。`/tasks` 已返回完整 Task(含 dependencies/actions/policy),DAG 无需新接口。

### 新增路由(均挂现有 ROUTE_PREFIX,loopback 限制沿用)

| 路由 | 方法 | 请求 | 返回(定案形状) |
|---|---|---|---|
| `/demo/play` | POST | `{mode:'auto'\|'step', reset?:boolean, speedMs?:number}` | `{ok, runId, state: DemoState}`;已运行时幂等(仅热更 mode/speed) |
| `/demo/state` | GET | `?logCursor=N`(增量) | `{runId, mode, status:'idle'\|'running'\|'awaiting_next'\|'done', speedMs, phaseIndex, phases:[{id,title,narrative,status:'pending'\|'active'\|'done',startedAt?,finishedAt?}], logCursor, log:[{ts,level:'info'\|'warn'\|'error',text}]}` |
| `/demo/step` | POST | — | `{ok, state}`;仅 `awaiting_next` 时有效 |
| `/demo/pause` | POST | — | `{ok, state}`;auto→awaiting_next |
| `/demo/reset` | POST | — | `{ok, state}`;清 runId、日志,任务态经 `resetDemoState` 复位 |
| `/report/latest` | GET | — | `{acceptanceId, requirementId, decision, decidedAt, coverage:{...同 AcceptanceDecision.coverage}, reasons:[], highestVerifiedLevel, baselines:{product,platform,firmwareSha256,hardwareRevision}, bundle:{id, dir, files:[{path,bytes}]}, markdown}` |
| `/report/latest.md` | GET | — | `text/markdown; charset=utf-8`,`Content-Disposition: attachment`(直接复用 renderReportMd 输出) |
| `/report/list` | GET | — | `[{acceptanceId, decidedAt, decision}]`(历史下拉) |
| `/sim/run` | POST | `{scenario: SimScenario, interactive?:boolean}` | `{ok, jobId}`;interactive 时 paper-empty 场景停在 WAITING_FOR_PAPER |
| `/sim/state` | GET | — | `{device:{state: JobState, paperCount, paperCapacity, error?}, job:{jobId, scenario, state, events:[SimEvent], pass?}}`;无作业时 job=null |
| `/sim/action` | POST | `{action:'load-paper'\|'give-up'\|'cancel'}` | `{ok, applied: boolean, state}` |
| `/cases/:id/run` | POST | — | `{ok, runId, result: TestResult, message?}`;内部复用 local runner 的 sim 用例执行路径 |
| `/runs` | GET | `?caseId=&limit=` | `TestRunRecord[]`(现有 listTestRuns 加过滤参数) |
| `/events` | GET(增强) | `?after=<eventId>&limit=` | `{events: EventView[], cursor: number}`(增量拉取;不带参时行为同现状,兼容) |
| `/snapshot`(增强) | — | — | 追加 `requirement:{id,title,status}` 与 `acceptance:{decision,decidedAt}\|null`(从最近 bundle/评估缓存读) |

### 后端实现要点

1. **DemoDirector**(`src/core/demo-player.ts`):单例内存状态;`auto` 模式用 `setTimeout` 链推进;每阶段动作执行后 `refreshStates` + `appendEvent('demo', 'demo.phase_done', …)`;P5/P6 用 `VirtualDevice` 慢速时序并等待终态再进入下一阶段;`/demo/state` 由它直接回答。进程重启后 runId 失效、状态回 idle(可接受,演示无持久化需求)。
2. **交互式 sim**:`VirtualDevice.runCopy` 需支持 `interactive:true` 分支——在 `WAITING_FOR_PAPER` 处挂起等待外部 `loadPaper()/giveUp()`(现自动恢复逻辑改为回调/事件等待),`/sim/action` 驱动。
3. **`/report/latest`**:`generateAcceptanceBundle` 后把 `{acceptanceId, bundleId}` 写入 `store.setMeta('report.latest', …)`,GET 时读 meta + 重读 `acceptance/report.md` 与 `decision.json` 组装。
4. 真机任务阶段(P8)**不调用** run:DemoDirector 仅读取 `0050/0051/0052` 状态做展示,天然体现"诚实排队"。

### `dashboard.tsx` 保留 / 丢弃

| 处置 | 内容 |
|---|---|
| **保留** | `ROUTE_PREFIX`、`fetchJson`(错误处理模式)、`STATUS_LABELS`(迁 `i18n.ts`)、`colorScheme` prop 机制(`index.tsx` 不动)、轮询 + 错误横幅思想(重构进 `useWorkbenchData`) |
| **丢弃** | 全部 inline style 对象(`panel/chip/buttonStyle`)、顶部按钮条与四视图 switch、任务/资源两张 HTML 表(逻辑迁入 DAG 侧栏与资源卡)、全局 `log` 字符串数组(拆为 DemoTerminal / JobTimeline / 事件流)、`nextReady()` hack(readyQueue 由 snapshot.ready 提供且 KPI/演示共用)、`STATE_COLORS` 硬编码(改 `wb-chip--{status}` CSS 类) |

---

## 9. 实现注意事项

### 9.1 样式注入

- `theme.css.ts` 导出 `WB_CSS` 模板字符串(全部 token + 组件样式,预计 ~600 行);`WbRoot` 挂载时检查 `document.getElementById('wb-style')`,不存在才 `document.head.appendChild(<style id="wb-style">)`——React 严格模式/热重载下幂等。
- 亮/暗切换不改 CSS 文件:仅切根节点 `data-scheme`,变量级联生效。注意 LED 屏、终端底色等**刻意固定**的元素用字面量色,不放 token。
- 禁止组件运行时拼 CSS;`wb-chip--{status}` 类名白名单 = §2.2 状态表,未知状态兜底 `wb-chip--plan` + 原文 label。

### 9.2 Bundle 约束

- 构建:`tsdown --format cjs --platform browser`,`--deps.never-bundle react/react-dom(现有命令不动)`。**不新增任何 npm 依赖**(yaml 等只在服务端)。
- 体积护栏:DAG/设备 SVG 全部程序化生成,不内嵌路径数据文件;图标集单文件 ~2KB。目标 bundle(业务部分)< 80KB min。
- `tsconfig.client.json` 开着 `noUnusedLocals`,新组件注意无死代码。

### 9.3 轮询策略(定案)

| 场景 | 轮询对象 | 间隔 |
|---|---|---|
| 常态(任意视图) | `/snapshot + /tasks + /resources + /cases` | 4000ms(现状) |
| 事件流激活(总览/座舱) | `/events?after=cursor` | 2000ms |
| demo `running` 或任一任务 `running/reserved/verifying` | 全量 + `/demo/state` | 800ms |
| 座舱或演示 P5/P6 激活 | `/sim/state` | 500ms |
| 终态后 | 回落常态档 | — |

实现:单个 `useWorkbenchData` 内用"最小间隔"调度器(一档生效即全档生效,避免多定时器);页面隐藏(`document.hidden`)时暂停;写操作后立即定向刷新一次。`/events` 用 `after` 增量,前端按 id 去重合并,避免整表重渲染。

### 9.4 渲染细节

- DAG 用 `React.memo`(props: tasks 数组引用);轮询期间 tasks 未变时跳过布局重算(布局结果按 tasks 引用缓存)。
- 终端/时间线自动滚动:`overflow-anchor: bottom` 不可靠,用"距底 < 40px 才跟随"的手动策略(§4.4)。
- 动画只用 `opacity/transform`;DAG 脉冲用 SVG `<circle>` 的 CSS animation,不逐帧 JS。
- 所有时间显示 `toLocaleTimeString('zh-CN', {hour12:false})`;ISO/哈希原样 mono 展示,不本地化。
- fetch 失败:横幅 + 侧栏状态点变红;连续 3 次失败后退避到 10s。

### 9.5 验收清单(开发自测用)

1. DSH 亮/暗切换,全站无硬编码色泄漏(除屏幕/终端)。
2. 演示 auto 全程 ≥1 次成功,P8 有 3s 停顿,P9 出现 PASS L1。
3. 手动补纸:interactive 模式下 WAITING_FOR_PAPER 停住,补纸后出纸。
4. DAG 19 节点布局稳定(两次刷新布局不跳动),关键路径描边正确。
5. 双口径卡:L1 PASS 与全量 BLOCKED 同时可见。
6. 断开座舱 API(杀服务)后横幅 + 红点出现,恢复后自动回到 4s 轮询。
