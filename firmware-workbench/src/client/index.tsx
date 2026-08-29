import { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { Dashboard } from './dashboard.js'

export const inject = ['theme']

function subscribeTheme(ctx: ClientContext): (notify: () => void) => () => boolean {
  return notify => ctx.on('theme/change', notify)
}

function getColorScheme(ctx: ClientContext): () => 'light' | 'dark' {
  return () => ctx.theme.getTheme().active.colorScheme
}

export function apply(ctx: ClientContext): void {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const element = document.createElement('div')
    element.dataset.dshFirmwareWorkbench = 'true'
    document.body.append(element)
    const root = createRoot(element)
    const Host = (): React.JSX.Element => {
      const colorScheme = useSyncExternalStore(subscribeTheme(ctx), getColorScheme(ctx), getColorScheme(ctx))
      return <Dashboard colorScheme={colorScheme} />
    }
    root.render(<Host />)
    return () => {
      root.unmount()
      element.remove()
    }
  }, 'dsh-firmware-workbench: dashboard')
}
