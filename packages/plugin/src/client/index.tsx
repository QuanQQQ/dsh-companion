import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { BetterSidebarService } from 'dsh-better-sidebar/client/service'
import { DeviceSettings } from './device-settings.js'
import { COMPANION_CSS } from './styles.js'
import { ServicesIcon, ServicesTab } from './services.js'

export const name = 'dsh-companion-client'
export const inject: string[] = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshCompanion = ''
    style.textContent = COMPANION_CSS
    document.head.append(style)
    return () => style.remove()
  }, 'dsh-companion: styles')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'dsh-companion-devices', order: 22, label: 'Companion Devices',
  }, DeviceSettings))

  ctx.inject?.(['betterSidebar'], sidebarContext => {
    const betterSidebar = (sidebarContext as unknown as { betterSidebar: BetterSidebarService }).betterSidebar
    sidebarContext.effect(() => betterSidebar.registerTab({
      // Keep the legacy tab id so saved layouts reopen; its behavior is Host-global.
      id: 'dsh-companion:task-services',
      title: 'Local Services',
      icon: (size: number) => <ServicesIcon size={size}/>,
      order: 35,
      single: true,
      settings: {
        render: ({ close }) => <DeviceSettings close={close}/>,
      },
      component: ServicesTab,
    }), 'dsh-companion: register Local Services tab')
  })
}
