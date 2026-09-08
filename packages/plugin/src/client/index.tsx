import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { BetterSidebarService } from 'dsh-better-sidebar/client/service'
import { DeviceSettings } from './device-settings.js'
import { COMPANION_CSS } from './styles.js'
import { TaskServicesIcon, TaskServicesTab } from './task-services.js'

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
      id: 'dsh-companion:task-services',
      title: 'Task Services',
      icon: (size: number) => <TaskServicesIcon size={size}/>,
      order: 35,
      single: true,
      settings: {
        render: ({ close }) => <DeviceSettings close={close}/>,
      },
      component: TaskServicesTab,
    }), 'dsh-companion: register Task Services tab')
  })
}
