import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * SQLite 存储:实体表 + 审计事件(方案 13.2/15.4)。
 * 数据库保存索引、状态和关系;大文件由证据模块放入内容寻址目录。
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

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  original_text TEXT,
  definition TEXT,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  readonly path: string

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.path = dbPath
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
