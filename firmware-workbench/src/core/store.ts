import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * SQLite 存储:实体表 + 审计事件(方案 13.2/15.4;v2 工作流提案 §3.1/§8)。
 * 数据库保存索引、状态和关系;大文件由证据模块放入内容寻址目录。
 * v2 新增:澄清问题、原子需求条目、Define 版本链、三态评审、决策记录、变更记录
 * —— 全部带 source_refs(知识溯源埋点,提案 §7.4 硬约束)。
 */

export interface AuditEvent {
  id: number
  ts: string
  actor: string
  kind: string
  payload: Record<string, unknown>
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 需求(多需求集合,提案 G2;status: clarifying→defining→in-review→approved→changed)
CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'feature',
  title TEXT NOT NULL,
  original_text TEXT,
  status TEXT NOT NULL DEFAULT 'clarifying',
  priority TEXT NOT NULL DEFAULT 'medium',
  depends_on TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 澄清问题(提案 §3.1 Clarify;status: open|answered|skipped)
CREATE TABLE IF NOT EXISTS clarify_questions (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  question TEXT NOT NULL,
  why TEXT,
  options TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  answered_by TEXT,
  answered_at TEXT,
  origin TEXT NOT NULL DEFAULT 'manual',
  source_refs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

-- 原子需求条目(提案 §3.1;status: proposed|in-review|approved|changed)
CREATE TABLE IF NOT EXISTS requirement_items (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  seq INTEGER NOT NULL,
  content TEXT NOT NULL,
  acceptance TEXT NOT NULL DEFAULT '[]',
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'proposed',
  origin TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Define 版本链(提案 §3.1;status: draft|in-review|approved|rejected|superseded)
CREATE TABLE IF NOT EXISTS define_versions (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  item_snapshot TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  submitted_at TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(requirement_id, version)
);

-- 三态评审(approve|request-changes|comment;意见挂条目,提案 §3.1)
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  comments TEXT NOT NULL DEFAULT '[]',
  decided_at TEXT NOT NULL
);

-- 决策记录(ADR + 修正,提案 G10)
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'adr',
  summary TEXT NOT NULL,
  rationale TEXT,
  refs TEXT NOT NULL DEFAULT '[]',
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 变更记录(G5 来源分类:customer|implementation-finding|test-finding;含 stale 传导结果)
CREATE TABLE IF NOT EXISTS change_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id TEXT NOT NULL,
  item_id TEXT,
  source TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  stale_tasks TEXT NOT NULL DEFAULT '[]',
  stale_cases TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS acceptance_criteria (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  title TEXT NOT NULL,
  method TEXT NOT NULL,
  threshold TEXT,
  max_level TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  frozen_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(name, version)
);

CREATE TABLE IF NOT EXISTS gates (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  decision TEXT NOT NULL,
  signer TEXT,
  decided_at TEXT,
  conditions TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  requirement_refs TEXT NOT NULL,
  acceptance_refs TEXT NOT NULL,
  dependencies TEXT NOT NULL,
  inputs TEXT NOT NULL,
  outputs TEXT NOT NULL,
  resources TEXT NOT NULL,
  actions TEXT NOT NULL,
  policy TEXT NOT NULL,
  evidence TEXT NOT NULL,
  owner TEXT,
  estimate_minutes INTEGER,
  priority TEXT,
  note TEXT,
  status TEXT NOT NULL,
  blocked_reason TEXT,
  stale_reason TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_result TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS artifacts (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  produced_by TEXT NOT NULL REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (name, version)
);

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL,
  units INTEGER NOT NULL,
  description TEXT,
  state TEXT NOT NULL,
  health TEXT NOT NULL,
  busy_units INTEGER NOT NULL DEFAULT 0,
  quarantine_reason TEXT,
  current_firmware TEXT
);

CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  task_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  purpose TEXT NOT NULL,
  mode TEXT NOT NULL,
  units INTEGER NOT NULL,
  state TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leases_resource ON leases(resource_id, state);

CREATE TABLE IF NOT EXISTS test_cases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  level TEXT NOT NULL,
  requirement_refs TEXT NOT NULL,
  acceptance_refs TEXT NOT NULL,
  preconditions TEXT NOT NULL,
  steps TEXT NOT NULL,
  resources TEXT NOT NULL,
  cleanup TEXT NOT NULL,
  evidence TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_runs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES test_cases(id),
  task_id TEXT,
  level TEXT NOT NULL,
  firmware_sha TEXT,
  result TEXT NOT NULL,
  message TEXT,
  evidence_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  refs TEXT NOT NULL,
  entries TEXT,
  created_at TEXT NOT NULL
);

-- 缺陷(提案 §3.2/G3:severity+waiver;status: open→fixing→fixed→verified→closed|waived)
CREATE TABLE IF NOT EXISTS defects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  requirement_id TEXT,
  source_case TEXT,
  failure_run TEXT,
  attribution TEXT,
  root_cause TEXT,
  assignee TEXT,
  waiver_until TEXT,
  waiver_reason TEXT,
  source_refs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
`

export class WorkbenchStore {
  readonly db: DatabaseSync
  readonly path: string = ''

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
  }

  static defaultPath(): string {
    const home = process.env.DSH_PRINTER_WORKBENCH_HOME
    if (home) return join(home, 'workbench.db')
    return join(process.cwd(), 'work', 'workbench.db')
  }

  now(): string {
    return new Date().toISOString()
  }

  /** 审计事件(方案 17.2:工具参数、返回值和批准决定进入审计日志) */
  appendEvent(actor: string, kind: string, payload: Record<string, unknown> = {}): void {
    this.db
      .prepare('INSERT INTO events (ts, actor, kind, payload) VALUES (?, ?, ?, ?)')
      .run(this.now(), actor, kind, JSON.stringify(payload))
  }

  listEvents(limit = 100): AuditEvent[] {
    const rows = this.db
      .prepare('SELECT id, ts, actor, kind, payload FROM events ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ id: number; ts: string; actor: string; kind: string; payload: string }>
    return rows.map(row => ({ ...row, payload: JSON.parse(row.payload) }))
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  close(): void {
    this.db.close()
  }
}
