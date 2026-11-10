import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { useCallback, useSyncExternalStore } from 'react'
import { DeviceSettings } from './device-settings.js'
import { LocalServicesPanel } from './local-services.js'
import { COMPANION_CSS } from './styles.js'
import { LOCAL_SERVICES_CSS } from './local-services-styles.js'

export const name = 'dsh-companion-client'
export const inject = ['slots', 'sidebarRightTabs', 'sessions']
export const LOCAL_SERVICES_TAB = 'dsh-companion:local-services'

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshCompanion = ''
    style.textContent = COMPANION_CSS + LOCAL_SERVICES_CSS
    document.head.append(style)
    return () => style.remove()
  }, 'dsh-companion: styles')
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'dsh-companion-devices', order: 22, label: 'Companion Devices',
  }, DeviceSettings)), 'dsh-companion: native device settings')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: 'dsh-companion', kind: LOCAL_SERVICES_TAB, title: () => 'Local Services', keepMounted: true,
    guide: [{ id: 'open', order: 35, title: () => 'Local Services', description: () => '管理开发服务与 Mac 转发' }],
  }), 'dsh-companion: native Local Services tab')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: 'dsh-companion',
    inject: (sessionId) => ({ sessionId, sessions: ctx.sessions }),
  }, NativeLocalServices)), 'dsh-companion: native sidebar body')
}

function NativeLocalServices({ sessionId, sessions, useTabInfo }: { sessionId: string; sessions: ISessions; useTabInfo: UseSidebarRightTabInfo }) {
  const { tab } = useTabInfo()
  const subscribe = useCallback((listener: () => void) => sessions.list.subscribe(listener), [sessions])
  const snapshot = useSyncExternalStore(subscribe, () => sessions.list.getSnapshot(), () => sessions.list.getSnapshot())
  const cwd = snapshot.byId[sessionId]?.cwd ?? ''
  return <LocalServicesPanel visible={tab.visible} workspacePath={cwd} />
}
