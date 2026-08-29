import type { WorkbenchStore } from '../../../core/store.js'

/**
 * 真机 Provider 接口(方案 5.2 Board Adapter / 10.4):
 * 串口、SSH、刷机、VNC 的边界在此定义;Phase 0 事实冻结后由各真实实现替换 stub。
 * 工作台其他模块只依赖接口,不依赖具体硬件通道。
 */

export interface ProviderHealth {
  healthy: boolean
  detail: string
  checkedAt: string
}

export interface SerialProvider {
  /** 枚举可用串口(Windows COM) */
  listPorts(): Promise<Array<{ path: string; description?: string }>>
  /** 打开共享读日志通道(唯一控制器读取后分发,方案 9.4) */
  openRead(profile: { baudRate: number }): Promise<{ streamId: string }>
  /** 独占写命令通道(需持有 serial 独占租约) */
  write(streamId: string, data: string): Promise<void>
  close(streamId: string): Promise<void>
}

export interface SshProvider {
  exec(command: string, opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>
  upload(localPath: string, remotePath: string): Promise<void>
  download(remotePath: string, localPath: string): Promise<void>
}

export interface FlashProvider {
  /** 全量刷机:镜像清单、操作者、设备身份必须进入证据(方案 17.1 Destructive) */
  flash(input: { imageManifest: Record<string, string>; operator: string }): Promise<{ ok: boolean; log: string }>
  /** 救援入口(MaskROM/recovery/串口 U-Boot,Phase 0 验证) */
  rescue(): Promise<{ ok: boolean; log: string }>
}

export interface VncProvider {
  /** noVNC/websockify 地址(仅本机或研发网络,方案 17.3) */
  endpoint(): Promise<{ url: string; mode: 'view' | 'input' }>
  screenshot(): Promise<Buffer>
}

export interface BoardProvider {
  serial: SerialProvider
  ssh: SshProvider
  flash: FlashProvider
  vnc: VncProvider
  health(): Promise<ProviderHealth>
  /** 会话结束恢复已知状态(方案 9.6) */
  restoreKnownState(): Promise<void>
}

// ---------- stub 实现:无真机时的占位,操作全部记录审计事件 ----------

function now(): string {
  return new Date().toISOString()
}

export class StubBoardProvider implements BoardProvider {
  readonly reason: string

  constructor(
    private readonly store: WorkbenchStore,
    reason = '真机 Provider 未接入(Phase 0 事实待冻结)',
  ) {
    this.reason = reason
  }

  private refuse(action: string): never {
    this.store.appendEvent('stub-provider', 'provider.refused', { action, reason: this.reason })
    throw new Error(`${action} 不可用: ${this.reason}`)
  }

  readonly serial: SerialProvider = {
    listPorts: async () => [],
    openRead: async () => this.refuse('serial.openRead'),
    write: async () => this.refuse('serial.write'),
    close: async () => undefined,
  }

  readonly ssh: SshProvider = {
    exec: async () => this.refuse('ssh.exec'),
    upload: async () => this.refuse('ssh.upload'),
    download: async () => this.refuse('ssh.download'),
  }

  readonly flash: FlashProvider = {
    flash: async () => this.refuse('flash.flash'),
    rescue: async () => this.refuse('flash.rescue'),
  }

  readonly vnc: VncProvider = {
    endpoint: async () => this.refuse('vnc.endpoint'),
    screenshot: async () => this.refuse('vnc.screenshot'),
  }

  async health(): Promise<ProviderHealth> {
    return { healthy: false, detail: this.reason, checkedAt: now() }
  }

  async restoreKnownState(): Promise<void> {
    this.store.appendEvent('stub-provider', 'provider.restore_skipped', { reason: this.reason })
  }
}
