import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EvidenceRecord } from '../../types.js'
import type { WorkbenchStore } from '../store.js'

/**
 * 内容寻址证据仓(方案 13.1/13.2):
 * 大文件按 SHA-256 存入 objects/,数据库只存索引与关系。
 * 已写入的原始证据不可覆盖;同名同哈希为幂等写入。
 */

export class EvidenceStore {
  constructor(
    private readonly store: WorkbenchStore,
    readonly root: string,
  ) {}

  static defaultRoot(dbPath: string): string {
    return join(dirname(dbPath), 'evidence')
  }

  private objectPath(sha256: string): string {
    return join(this.root, 'objects', sha256.slice(0, 2), sha256)
  }

  sha256(data: Buffer | string): string {
    return createHash('sha256').update(data).digest('hex')
  }

  /** 写入单个证据文件:返回内容寻址记录(幂等) */
  putFile(name: string, data: Buffer | string, refs: Record<string, string> = {}): EvidenceRecord {
    const sha = this.sha256(data)
    const target = this.objectPath(sha)
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, data)
    }
    const id = `EVI-${sha.slice(0, 16)}`
    this.store.db
      .prepare(
        `INSERT INTO evidence (id, kind, name, sha256, path, bytes, refs, entries, created_at)
         VALUES (?, 'file', ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, name, sha, target, Buffer.byteLength(data), JSON.stringify(refs), this.store.now())
    this.store.appendEvent('system', 'evidence.put', { id, name, sha256: sha })
    return this.get(id) as EvidenceRecord
  }

  get(id: string): EvidenceRecord | undefined {
    const row = this.store.db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return undefined
    return {
      id: row.id as string,
      kind: row.kind as EvidenceRecord['kind'],
      name: row.name as string,
      sha256: row.sha256 as string,
      path: row.path as string,
      bytes: row.bytes as number,
      refs: JSON.parse(row.refs as string),
      entries: row.entries ? JSON.parse(row.entries as string) : undefined,
      createdAt: row.created_at as string,
    }
  }

  readFile(record: EvidenceRecord): Buffer {
    return readFileSync(record.path)
  }

  /** 校验哈希(方案 12.5:证据完整并通过哈希校验);bundle 类型重新聚合目录内容 */
  verify(record: EvidenceRecord): boolean {
    if (record.kind === 'bundle') {
      const aggregate = this.aggregateBundle(record.path)
      return aggregate === record.sha256
    }
    const data = readFileSync(record.path)
    return this.sha256(data) === record.sha256
  }

  private aggregateBundle(bundleDir: string): string {
    const entries: Array<{ path: string; sha256: string }> = []
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSafe(dir)) {
        const full = join(dir, entry)
        const relative = rel ? `${rel}/${entry}` : entry
        if (statIsDir(full)) {
          walk(full, relative)
        } else {
          entries.push({ path: relative, sha256: this.sha256(readFileSync(full)) })
        }
      }
    }
    walk(bundleDir, '')
    return this.sha256(entries.map(entry => `${entry.sha256}  ${entry.path}`).join('\n'))
  }

  /**
   * 登记一个已生成的 bundle 目录(方案 13.1 Evidence Bundle):
   * 遍历目录内全部文件,计算哈希,以 kind=bundle 记录;目录本身保持不可变。
   */
  registerBundle(bundleDir: string, name: string, refs: Record<string, string> = {}): EvidenceRecord {
    const entries: Array<{ path: string; sha256: string; bytes: number }> = []
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSafe(dir)) {
        const full = join(dir, entry)
        const relative = rel ? `${rel}/${entry}` : entry
        if (statIsDir(full)) {
          walk(full, relative)
        } else {
          const data = readFileSync(full)
          entries.push({ path: relative, sha256: this.sha256(data), bytes: data.byteLength })
        }
      }
    }
    walk(bundleDir, '')

    // bundle 清单:全部条目哈希的聚合哈希,作为 bundle 的内容标识
    const aggregate = this.sha256(entries.map(entry => `${entry.sha256}  ${entry.path}`).join('\n'))
    const id = `EVI-BUNDLE-${aggregate.slice(0, 16)}`
    this.store.db
      .prepare(
        `INSERT INTO evidence (id, kind, name, sha256, path, bytes, refs, entries, created_at)
         VALUES (?, 'bundle', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, name, aggregate, bundleDir, entries.reduce((sum, entry) => sum + entry.bytes, 0),
        JSON.stringify(refs), JSON.stringify(entries), this.store.now())
    this.store.appendEvent('system', 'evidence.register_bundle', { id, name, entries: entries.length })
    return this.get(id) as EvidenceRecord
  }

  list(limit = 100): EvidenceRecord[] {
    const rows = this.store.db
      .prepare('SELECT id FROM evidence ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{ id: string }>
    return rows.map(row => this.get(row.id) as EvidenceRecord)
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function statIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
