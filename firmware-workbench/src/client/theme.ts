/**
 * 工作台设计体系(设计文档 ui-design-v2.md §2)。
 * 全部 token + 组件样式以单个 <style id="wb-style"> 注入,幂等。
 */

export const WB_CSS = `
.wb-root {
  /* 中性色(深色) */
  --wb-bg-0: #0b0e14; --wb-bg-1: #11151c; --wb-bg-2: #171d27; --wb-bg-3: #1e2632;
  --wb-border: #232a37; --wb-border-strong: #313b4d;
  --wb-text-1: #e6eaf2; --wb-text-2: #9aa4b6; --wb-text-3: #5f6b7e;
  /* 品牌 */
  --wb-accent: #5b8cff; --wb-accent-hover: #729dff; --wb-accent-bg: rgba(91,140,255,.14);
  --wb-danger: #ef4444; --wb-danger-bg: rgba(239,68,68,.12);
  /* 字体 */
  --wb-font-sans: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  --wb-font-mono: ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, "SFMono-Regular", monospace;
  /* 间距 / 圆角 / 阴影 */
  --wb-sp-1: 4px; --wb-sp-2: 8px; --wb-sp-3: 12px; --wb-sp-4: 16px;
  --wb-sp-5: 20px; --wb-sp-6: 24px; --wb-sp-8: 32px;
  --wb-r-sm: 4px; --wb-r-md: 8px; --wb-r-lg: 12px;
  --wb-shadow-1: 0 1px 2px rgba(0,0,0,.35);
  --wb-shadow-2: 0 8px 24px rgba(0,0,0,.35);
  /* 状态语义色:主色 / 12% 底 / 35% 边 */
  --wb-st-succeeded: #3fbf7f; --wb-st-running: #2bc8f0; --wb-st-verifying: #33d6b0;
  --wb-st-ready: #5b9dff; --wb-st-reserved: #7c8cff;
  --wb-st-blocked_dependency: #e2b341; --wb-st-blocked_gate: #b48ef5; --wb-st-blocked_resource: #ff8a4d;
  --wb-st-quarantined: #ff5c5c; --wb-st-failed_product: #ef4444; --wb-st-failed_test: #f97316;
  --wb-st-failed_infra: #8b93a5; --wb-st-invalid: #d98fd1; --wb-st-cancelled: #7d8590;
  --wb-st-planned: #98a2b3; --wb-st-draft: #98a2b3; --wb-st-maintenance: #e2b341;
  --wb-st-available: #3fbf7f; --wb-st-busy: #2bc8f0; --wb-st-reserved_state: #7c8cff;
  --wb-st-PASS: #3fbf7f; --wb-st-PRODUCT_FAIL: #ef4444; --wb-st-TEST_FAIL: #f97316;
  --wb-st-INFRA_FAIL: #8b93a5; --wb-st-BLOCKED_RESOURCE: #ff8a4d; --wb-st-INVALID: #d98fd1;
  --wb-st-FLAKY: #e2b341; --wb-st-WAIVED: #b48ef5;
  --wb-st-L1: #3fbf7f; --wb-st-L4: #ff8a4d;

  font-family: var(--wb-font-sans);
  color: var(--wb-text-1);
  font-size: 13px;
  line-height: 1.6;
  background: var(--wb-bg-0);
  display: flex;
  justify-content: center;
  min-height: 100vh;
}
.wb-root[data-scheme="light"] {
  --wb-bg-0: #f5f6f8; --wb-bg-1: #ffffff; --wb-bg-2: #f0f2f5; --wb-bg-3: #e8ecf2;
  --wb-border: #e2e6ed; --wb-border-strong: #c9d1de;
  --wb-text-1: #1a2230; --wb-text-2: #5a6475; --wb-text-3: #98a2b3;
  --wb-shadow-2: 0 8px 24px rgba(16,24,40,.10);
  --wb-st-succeeded: #1e9e63; --wb-st-running: #0e8ec4; --wb-st-verifying: #0fa583;
  --wb-st-ready: #2f6fe0; --wb-st-reserved: #5a63e8;
  --wb-st-blocked_dependency: #c78a1e; --wb-st-blocked_gate: #8a5cd8; --wb-st-blocked_resource: #e06a1f;
  --wb-st-quarantined: #e03e3e; --wb-st-failed_product: #e03e3e; --wb-st-failed_test: #e0631f;
  --wb-st-failed_infra: #667085; --wb-st-invalid: #b865b0; --wb-st-cancelled: #6b7280;
  --wb-st-planned: #8792a3; --wb-st-draft: #8792a3;
}

.wb-shell { display: flex; width: 100%; max-width: 1400px; min-height: 100vh; }
.wb-sidebar {
  width: 208px; flex: none; padding: var(--wb-sp-4) var(--wb-sp-3);
  border-right: 1px solid var(--wb-border);
  display: flex; flex-direction: column; gap: 2px;
  position: sticky; top: 0; height: 100vh; box-sizing: border-box;
}
.wb-brand { display: flex; align-items: center; gap: 8px; padding: var(--wb-sp-2) var(--wb-sp-2) var(--wb-sp-4); }
.wb-brand__logo {
  width: 26px; height: 26px; border-radius: 6px; flex: none;
  background: linear-gradient(135deg, #5b8cff, #33d6b0);
  display: flex; align-items: center; justify-content: center; color: #fff;
}
.wb-brand__name { font-size: 13px; font-weight: 650; letter-spacing: .2px; }
.wb-brand__sub { font-size: 11px; color: var(--wb-text-3); }
.wb-nav__item {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 10px; border-radius: var(--wb-r-sm); border: none; width: 100%;
  background: transparent; color: var(--wb-text-2); cursor: pointer;
  font-size: 13px; font-family: inherit; text-align: left; position: relative;
}
.wb-nav__item:hover { background: var(--wb-bg-3); color: var(--wb-text-1); }
.wb-nav__item--active { background: var(--wb-accent-bg); color: var(--wb-text-1); font-weight: 600; }
.wb-nav__item--active::before {
  content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 2px;
  background: var(--wb-accent); border-radius: 1px;
}
.wb-sidebar__foot {
  margin-top: auto; padding: var(--wb-sp-2);
  display: flex; align-items: center; gap: 7px;
  font-size: 11px; color: var(--wb-text-3); border-top: 1px solid var(--wb-border);
}
.wb-main { flex: 1; min-width: 0; padding: var(--wb-sp-5) var(--wb-sp-6); box-sizing: border-box; }
.wb-view { max-width: 1120px; margin: 0 auto; }
.wb-view--wide { max-width: none; }
.wb-view__head { display: flex; align-items: center; gap: var(--wb-sp-3); margin-bottom: var(--wb-sp-5); flex-wrap: wrap; }
.wb-view__title { font-size: 16px; font-weight: 600; margin: 0; }
.wb-view__sub { font-size: 12px; color: var(--wb-text-3); }
.wb-view__spacer { flex: 1; }

.wb-card {
  background: var(--wb-bg-1); border: 1px solid var(--wb-border);
  border-radius: var(--wb-r-md); box-shadow: var(--wb-shadow-1);
}
.wb-card__head {
  padding: 10px var(--wb-sp-4); border-bottom: 1px solid var(--wb-border);
  display: flex; align-items: center; gap: var(--wb-sp-2);
  font-size: 13px; font-weight: 600; color: var(--wb-text-1);
}
.wb-card__head-sub { font-weight: 400; color: var(--wb-text-3); font-size: 11px; margin-left: 4px; }
.wb-card__body { padding: var(--wb-sp-4); }
.wb-card__body--flush { padding: 0; }

.wb-grid { display: grid; gap: var(--wb-sp-3); }
.wb-grid--kpi { grid-template-columns: repeat(5, 1fr); }
.wb-grid--2col { grid-template-columns: 1.2fr 1fr; }
.wb-grid--3col { grid-template-columns: repeat(3, 1fr); }
.wb-grid--side { grid-template-columns: 1fr 320px; }

.wb-kpi {
  background: var(--wb-bg-1); border: 1px solid var(--wb-border); border-radius: var(--wb-r-md);
  padding: 12px var(--wb-sp-4); cursor: default; transition: box-shadow .15s, transform .15s;
}
.wb-kpi:hover { box-shadow: var(--wb-shadow-2); }
.wb-kpi__label { font-size: 11px; color: var(--wb-text-2); margin-bottom: 2px; display: flex; align-items: center; gap: 6px; }
.wb-kpi__value { font-family: var(--wb-font-mono); font-size: 20px; font-weight: 600; line-height: 1.3; }
.wb-kpi__sub { font-size: 11px; color: var(--wb-text-3); margin-top: 2px; }
.wb-kpi--ok .wb-kpi__value { color: var(--wb-st-succeeded); }
.wb-kpi--warn .wb-kpi__value { color: var(--wb-st-blocked_resource); }
.wb-kpi--run .wb-kpi__value { color: var(--wb-st-running); }

.wb-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 1.7;
  font-family: var(--wb-font-mono); white-space: nowrap;
  background: color-mix(in srgb, var(--wb-st-c, var(--wb-st-planned)) 12%, transparent);
  color: var(--wb-st-c, var(--wb-st-planned));
  border: 1px solid color-mix(in srgb, var(--wb-st-c, var(--wb-st-planned)) 35%, transparent);
}
.wb-chip--plain { background: var(--wb-bg-2); color: var(--wb-text-2); border-color: var(--wb-border); }
.wb-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }

.wb-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 12px; border-radius: var(--wb-r-sm);
  border: 1px solid var(--wb-border-strong); background: var(--wb-bg-2); color: var(--wb-text-1);
  font-size: 12px; font-family: inherit; cursor: pointer; white-space: nowrap;
}
.wb-btn:hover { background: var(--wb-bg-3); border-color: var(--wb-text-3); }
.wb-btn:disabled { opacity: .45; cursor: not-allowed; }
.wb-btn--primary { background: var(--wb-accent); border-color: var(--wb-accent); color: #fff; font-weight: 600; }
.wb-btn--primary:hover { background: var(--wb-accent-hover); }
.wb-btn--ghost { background: transparent; border-color: transparent; color: var(--wb-text-2); }
.wb-btn--ghost:hover { background: var(--wb-bg-3); color: var(--wb-text-1); }
.wb-btn--danger { background: transparent; border-color: var(--wb-danger); color: var(--wb-danger); }
.wb-btn--sm { padding: 2px 8px; font-size: 11px; }

.wb-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.wb-table th {
  text-align: left; font-weight: 500; color: var(--wb-text-3); font-size: 11px;
  padding: 8px var(--wb-sp-3); border-bottom: 1px solid var(--wb-border);
  position: sticky; top: 0; background: var(--wb-bg-1);
}
.wb-table td { padding: 7px var(--wb-sp-3); border-bottom: 1px solid var(--wb-border); vertical-align: top; }
.wb-table tbody tr:hover { background: var(--wb-bg-2); }
.wb-table tbody tr:last-child td { border-bottom: none; }
.wb-mono { font-family: var(--wb-font-mono); font-size: 12px; }
.wb-muted { color: var(--wb-text-2); }
.wb-faint { color: var(--wb-text-3); }

/* 终端日志 */
.wb-term {
  background: #0d1117; border: 1px solid var(--wb-border); border-radius: var(--wb-r-md);
  font-family: var(--wb-font-mono); font-size: 12px; line-height: 1.65;
  padding: 10px 14px; overflow-y: auto; color: #c9d4e6;
}
.wb-term__line { display: flex; gap: 10px; white-space: pre-wrap; word-break: break-all; }
.wb-term__ts { color: #55607a; flex: none; }
.wb-term__lv { flex: none; width: 14px; text-align: center; }
.wb-term__line--info .wb-term__lv { color: #5b8cff; }
.wb-term__line--warn .wb-term__lv { color: #e2b341; }
.wb-term__line--warn { color: #e2b341; }
.wb-term__line--error .wb-term__lv { color: #ff5c5c; }
.wb-term__line--error { color: #ff8a8a; }

/* 垂直时间线 */
.wb-tl { position: relative; padding-left: 18px; }
.wb-tl::before { content: ""; position: absolute; left: 3px; top: 4px; bottom: 4px; width: 1px; background: var(--wb-border); }
.wb-tl__item { position: relative; padding: 3px 0 3px 6px; font-size: 12px; }
.wb-tl__dot { position: absolute; left: -18px; top: 9px; margin-left: 0; }
.wb-tl__time { font-family: var(--wb-font-mono); font-size: 11px; color: var(--wb-text-3); margin-right: 8px; }
.wb-tl__kind { font-family: var(--wb-font-mono); font-size: 11px; color: var(--wb-text-2); margin-right: 8px; }

/* 空状态 */
.wb-empty { text-align: center; padding: 48px 24px; color: var(--wb-text-2); }
.wb-empty__icon { color: var(--wb-text-3); margin-bottom: 10px; }
.wb-empty__title { font-size: 14px; font-weight: 600; color: var(--wb-text-1); margin-bottom: 4px; }
.wb-empty__hint { font-size: 12px; color: var(--wb-text-3); margin-bottom: 14px; }

/* 演示中心 */
.wb-demo-steps { display: flex; align-items: flex-start; gap: 0; margin-bottom: var(--wb-sp-4); overflow-x: auto; padding: 2px 0; }
.wb-demo-step { flex: 1; min-width: 72px; text-align: center; position: relative; background: none; border: none; cursor: pointer; font-family: inherit; color: var(--wb-text-3); padding: 0; }
.wb-demo-step__dot {
  width: 22px; height: 22px; border-radius: 50%; margin: 0 auto 6px;
  display: flex; align-items: center; justify-content: center;
  background: var(--wb-bg-2); border: 1.5px solid var(--wb-border-strong);
  font-family: var(--wb-font-mono); font-size: 10px; color: var(--wb-text-2);
  position: relative; z-index: 1;
}
.wb-demo-step__label { font-size: 11px; line-height: 1.3; display: block; }
.wb-demo-step::before {
  content: ""; position: absolute; top: 10px; left: -50%; width: 100%; height: 1.5px;
  background: var(--wb-border-strong);
}
.wb-demo-step:first-child::before { display: none; }
.wb-demo-step--done .wb-demo-step__dot { background: var(--wb-st-succeeded); border-color: var(--wb-st-succeeded); color: #0b0e14; }
.wb-demo-step--done::before { background: var(--wb-st-succeeded); }
.wb-demo-step--active .wb-demo-step__dot { border-color: var(--wb-accent); color: var(--wb-accent); animation: wb-pulse 1.6s ease-in-out infinite; }
.wb-demo-step--active { color: var(--wb-text-1); }
.wb-demo-step--active::before { background: var(--wb-accent); }
@keyframes wb-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(91,140,255,.45); } 50% { box-shadow: 0 0 0 6px rgba(91,140,255,0); } }

.wb-demo-narr {
  background: linear-gradient(160deg, var(--wb-bg-1), var(--wb-bg-2));
  border: 1px solid var(--wb-border); border-radius: var(--wb-r-lg);
  padding: var(--wb-sp-4); position: relative; overflow: hidden;
}
.wb-demo-narr::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--wb-accent);
}
.wb-demo-narr__phase { font-family: var(--wb-font-mono); font-size: 11px; color: var(--wb-accent); margin-bottom: 6px; }
.wb-demo-narr__title { font-size: 26px; font-weight: 650; line-height: 1.3; margin-bottom: 8px; }
.wb-demo-narr__text { font-size: 13px; color: var(--wb-text-2); line-height: 1.7; }
.wb-demo-narr__meta { margin-top: 12px; font-size: 11px; color: var(--wb-text-3); display: flex; flex-direction: column; gap: 3px; }

.wb-demo-stage {
  background: var(--wb-bg-1); border: 1px solid var(--wb-border); border-radius: var(--wb-r-lg);
  min-height: 380px; display: flex; flex-direction: column; overflow: hidden;
}
.wb-demo-stage__body { flex: 1; padding: var(--wb-sp-4); display: flex; align-items: center; justify-content: center; overflow: auto; }

.wb-scene-wall { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--wb-sp-2); width: 100%; }
.wb-scene {
  border: 1px solid var(--wb-border); border-radius: var(--wb-r-sm); padding: 10px 12px;
  background: var(--wb-bg-2); font-size: 12px;
}
.wb-scene__name { font-family: var(--wb-font-mono); font-size: 11px; color: var(--wb-text-2); margin-bottom: 4px; }
.wb-scene--pass { border-color: color-mix(in srgb, var(--wb-st-succeeded) 35%, transparent); background: color-mix(in srgb, var(--wb-st-succeeded) 8%, var(--wb-bg-2)); }
.wb-scene--pending { opacity: .5; }

/* 设备面板 */
.wb-dev { display: flex; gap: var(--wb-sp-3); align-items: stretch; width: 100%; }
.wb-dev__panel { flex: none; }
.wb-dev__screen-text { font-family: var(--wb-font-mono); }
.wb-scene-btns { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 220px; }
.wb-scene-btns__group { font-size: 11px; color: var(--wb-text-3); margin: 6px 0 2px; }
.wb-scene-btn {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  padding: 7px 10px; border-radius: var(--wb-r-sm); border: 1px solid var(--wb-border);
  background: var(--wb-bg-2); color: var(--wb-text-1); cursor: pointer; font-family: inherit;
  text-align: left;
}
.wb-scene-btn:hover { border-color: var(--wb-accent); background: var(--wb-accent-bg); }
.wb-scene-btn:disabled { opacity: .45; cursor: not-allowed; }
.wb-scene-btn--active { border-color: var(--wb-accent); background: var(--wb-accent-bg); }
.wb-scene-btn__key { font-family: var(--wb-font-mono); font-size: 12px; }
.wb-scene-btn__desc { font-size: 11px; color: var(--wb-text-3); }

/* DAG */
.wb-dag-wrap { display: flex; gap: var(--wb-sp-3); align-items: stretch; }
.wb-dag-canvas {
  flex: 1; min-width: 0; background: var(--wb-bg-1); border: 1px solid var(--wb-border);
  border-radius: var(--wb-r-md); overflow: auto; position: relative;
}
.wb-dag-canvas__inner { transform-origin: 0 0; }
.wb-dag__node { cursor: pointer; }
.wb-dag__node rect.body {
  fill: var(--wb-bg-2); stroke: var(--wb-border-strong); stroke-width: 1;
  rx: 8; transition: stroke .12s;
}
.wb-dag__node:hover rect.body { stroke: var(--wb-accent); }
.wb-dag__node--critical rect.body { stroke: var(--wb-accent); stroke-width: 1.6; }
.wb-dag__node--selected rect.body { stroke: var(--wb-accent); stroke-width: 2; }
.wb-dag__edge { fill: none; stroke: var(--wb-border-strong); stroke-width: 1.4; }
.wb-dag__edge--critical { stroke: var(--wb-accent); stroke-width: 2.2; }
.wb-dag__legend { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; font-size: 11px; color: var(--wb-text-2); }

/* 详情侧栏 */
.wb-side {
  width: 320px; flex: none; background: var(--wb-bg-1);
  border: 1px solid var(--wb-border); border-radius: var(--wb-r-md);
  padding: var(--wb-sp-4); overflow-y: auto; max-height: 640px;
}
.wb-side__section { margin-bottom: var(--wb-sp-3); }
.wb-side__title { font-size: 11px; color: var(--wb-text-3); font-weight: 600; letter-spacing: .4px; margin-bottom: 6px; }
.wb-banner {
  border-radius: var(--wb-r-sm); padding: 8px 10px; font-size: 12px;
  background: color-mix(in srgb, var(--wb-st-blocked_resource) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--wb-st-blocked_resource) 35%, transparent);
  color: var(--wb-st-blocked_resource);
}
.wb-banner--ok { background: color-mix(in srgb, var(--wb-st-succeeded) 12%, transparent); border-color: color-mix(in srgb, var(--wb-st-succeeded) 35%, transparent); color: var(--wb-st-succeeded); }

/* 决定卡 */
.wb-decision { text-align: center; padding: var(--wb-sp-5) var(--wb-sp-4); }
.wb-decision__value { font-size: 26px; font-weight: 650; font-family: var(--wb-font-mono); }
.wb-decision--PASS .wb-decision__value { color: var(--wb-st-succeeded); }
.wb-decision--BLOCKED .wb-decision__value { color: var(--wb-st-blocked_resource); }
.wb-decision--FAIL .wb-decision__value { color: var(--wb-st-failed_product); }
.wb-decision__sub { font-size: 12px; color: var(--wb-text-2); margin-top: 4px; }

.wb-coverage { display: flex; gap: var(--wb-sp-2); justify-content: center; margin-top: 10px; flex-wrap: wrap; }
.wb-coverage__item { text-align: center; min-width: 52px; }
.wb-coverage__num { font-family: var(--wb-font-mono); font-size: 16px; font-weight: 600; }
.wb-coverage__label { font-size: 10px; color: var(--wb-text-3); }

/* 资源卡 */
.wb-res-card {
  background: var(--wb-bg-1); border: 1px solid var(--wb-border); border-radius: var(--wb-r-md);
  padding: 12px var(--wb-sp-3);
}
.wb-res-card--quarantined { border-color: color-mix(in srgb, var(--wb-st-quarantined) 35%, transparent); }
.wb-res-card__head { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 4px; }
.wb-res-card__id { font-family: var(--wb-font-mono); font-size: 12px; }
.wb-res-card__desc { font-size: 11px; color: var(--wb-text-3); margin-bottom: 8px; min-height: 16px; }
.wb-cap { display: flex; gap: 3px; }
.wb-cap__unit { width: 10px; height: 5px; border-radius: 1px; background: var(--wb-bg-3); }
.wb-cap__unit--on { background: var(--wb-st-running); }

.wb-toast {
  position: fixed; right: 20px; bottom: 20px; z-index: 300;
  background: var(--wb-bg-1); border: 1px solid var(--wb-border-strong);
  border-radius: var(--wb-r-md); padding: 10px 16px; font-size: 13px;
  box-shadow: var(--wb-shadow-2); animation: wb-toast-in .18s ease-out;
}
@keyframes wb-toast-in { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }

.wb-modal-mask {
  position: fixed; inset: 0; z-index: 200; background: rgba(4,8,16,.55);
  display: flex; align-items: center; justify-content: center;
}
.wb-modal {
  background: var(--wb-bg-1); border: 1px solid var(--wb-border-strong); border-radius: var(--wb-r-lg);
  box-shadow: var(--wb-shadow-2); padding: var(--wb-sp-5); width: 400px;
}
.wb-input {
  width: 100%; box-sizing: border-box; padding: 6px 10px; font-size: 13px; font-family: inherit;
  background: var(--wb-bg-2); border: 1px solid var(--wb-border-strong);
  border-radius: var(--wb-r-sm); color: var(--wb-text-1);
}
.wb-banner--api {
  background: var(--wb-danger-bg); border: 1px solid color-mix(in srgb, var(--wb-danger) 35%, transparent);
  color: var(--wb-danger); border-radius: var(--wb-r-md); padding: 8px 14px; margin-bottom: var(--wb-sp-3);
  font-size: 12px;
}
.wb-quote {
  border-left: 3px solid var(--wb-border-strong); padding: 6px 12px; margin: 0 0 12px;
  color: var(--wb-text-2); font-style: italic; font-size: 12px; background: var(--wb-bg-2);
  border-radius: 0 var(--wb-r-sm) var(--wb-r-sm) 0;
}
.wb-list-num { margin: 0; padding-left: 18px; font-size: 12px; color: var(--wb-text-2); }
.wb-list-num li { margin-bottom: 2px; }
details.wb-fold > summary { cursor: pointer; font-size: 12px; color: var(--wb-text-2); }
details.wb-fold > summary:hover { color: var(--wb-text-1); }

/* 全屏工作台入口(设计补充:右侧悬浮按钮 + 一键进入) */
.wb-fab {
  position: fixed; right: 18px; bottom: 18px; z-index: 400;
  display: flex; align-items: center; gap: 8px;
  padding: 12px 18px; border-radius: 999px; border: none; cursor: pointer;
  background: linear-gradient(135deg, #5b8cff, #33d6b0); color: #fff;
  font-size: 14px; font-weight: 650; font-family: inherit;
  box-shadow: 0 6px 24px rgba(91,140,255,.45);
}
.wb-fab:hover { transform: translateY(-1px); box-shadow: 0 10px 28px rgba(91,140,255,.55); }
.wb-fullscreen {
  position: fixed; inset: 0; z-index: 500; overflow-y: auto;
  background: var(--wb-bg-0);
}
.wb-fullscreen .wb-shell { min-height: 100vh; }
.wb-exit-bar {
  position: sticky; top: 0; z-index: 510;
  display: flex; align-items: center; gap: 10px;
  padding: 8px 16px; background: var(--wb-bg-1);
  border-bottom: 1px solid var(--wb-border);
}
.wb-exit-bar__title { font-size: 12px; font-weight: 600; }
.wb-exit-bar__sub { font-size: 11px; color: var(--wb-text-3); }

/* 引导式流程(操作步骤卡) */
.wb-walk { display: flex; flex-direction: column; gap: var(--wb-sp-3); }
.wb-walk-step {
  background: var(--wb-bg-1); border: 1px solid var(--wb-border);
  border-radius: var(--wb-r-md); overflow: hidden;
}
.wb-walk-step--active { border-color: color-mix(in srgb, var(--wb-accent) 55%, var(--wb-border)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--wb-accent) 35%, transparent); }
.wb-walk-step--done { opacity: .82; }
.wb-walk-step--locked { opacity: .5; }
.wb-walk-step__head {
  display: flex; align-items: center; gap: 10px; padding: 10px var(--wb-sp-4);
  border-bottom: 1px solid var(--wb-border); cursor: pointer; user-select: none;
}
.wb-walk-step__num {
  width: 24px; height: 24px; border-radius: 50%; flex: none;
  display: flex; align-items: center; justify-content: center;
  background: var(--wb-bg-3); color: var(--wb-text-2);
  font-family: var(--wb-font-mono); font-size: 11px; font-weight: 600;
}
.wb-walk-step--done .wb-walk-step__num { background: var(--wb-st-succeeded); color: #0b0e14; }
.wb-walk-step--active .wb-walk-step__num { background: var(--wb-accent); color: #fff; }
.wb-walk-step__title { font-size: 13px; font-weight: 600; }
.wb-walk-step__why { font-size: 11px; color: var(--wb-text-3); flex: 1; text-align: right; }
.wb-walk-step__body { padding: var(--wb-sp-4); display: flex; flex-direction: column; gap: var(--wb-sp-3); }
.wb-task-row {
  display: flex; align-items: center; gap: 10px; padding: 7px 10px;
  border: 1px solid var(--wb-border); border-radius: var(--wb-r-sm); background: var(--wb-bg-2);
}
.wb-task-row__id { font-family: var(--wb-font-mono); font-size: 11px; color: var(--wb-text-2); flex: none; }
.wb-task-row__title { font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-textarea {
  width: 100%; box-sizing: border-box; min-height: 84px; padding: 8px 10px;
  font-size: 13px; font-family: inherit; line-height: 1.6; resize: vertical;
  background: var(--wb-bg-2); border: 1px solid var(--wb-border-strong);
  border-radius: var(--wb-r-sm); color: var(--wb-text-1);
}
.wb-mode-tabs { display: inline-flex; background: var(--wb-bg-2); border: 1px solid var(--wb-border); border-radius: var(--wb-r-sm); padding: 2px; }
.wb-mode-tab {
  padding: 4px 14px; font-size: 12px; border: none; background: transparent;
  color: var(--wb-text-2); cursor: pointer; border-radius: 3px; font-family: inherit;
}
.wb-mode-tab--active { background: var(--wb-accent); color: #fff; font-weight: 600; }
.wb-check-list { display: flex; flex-direction: column; gap: 4px; }
.wb-check-item { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 5px 8px; background: var(--wb-bg-2); border-radius: var(--wb-r-sm); }

`
