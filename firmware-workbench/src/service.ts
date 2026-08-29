import { join } from 'node:path'
import { WorkbenchStore } from './core/store.js'
import { Workbench } from './core/workbench.js'
import { seedResources } from './core/resources.js'
import { EvidenceStore } from './core/evidence/store.js'

/**
 * 工作台服务单例:DSH 插件与 fwctl 共享同一实现与同一份 SQLite 状态库。
 */

export class WorkbenchService {
  private storeRef?: WorkbenchStore

  private ensureStore(): WorkbenchStore {
    if (!this.storeRef) {
      const home = process.env.DSH_PRINTER_WORKBENCH_HOME
      const dbPath = process.env.DSH_PRINTER_WORKBENCH_DB ?? join(home ?? process.cwd(), 'workbench.db')
      const store = new WorkbenchStore(dbPath)
      seedResources(store)
      this.storeRef = store
    }
    return this.storeRef
  }

  get store(): WorkbenchStore {
    return this.ensureStore()
  }

  get workbench(): Workbench {
    return new Workbench(this.store)
  }

  get evidence(): EvidenceStore {
    return new EvidenceStore(this.store, EvidenceStore.defaultRoot(this.store.path))
  }

  async dispose(): Promise<void> {
    this.storeRef?.close()
    this.storeRef = undefined
  }
}

export const service = new WorkbenchService()
