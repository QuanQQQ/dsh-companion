import { useCallback, useEffect, useMemo, useState } from 'react'
import { isForwardCloseConfirmed } from '../closure.js'
import type { TabComponentProps } from 'dsh-better-sidebar/client/service'
import {
  getTaskSnapshot, leaseAction, listTasks, matchTask, openLease, registerService, unregisterService,
  type DeviceDto, type ForwardLeaseDto, type InstanceDto, type Protocol, type TaskServiceDto,
  type TaskSnapshotDto, type TaskSummaryDto,
} from './api.js'

export function TaskServicesIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8.5 15.5l7-7M7 6.5l-2 2a4.24 4.24 0 006 6l2-2M17 17.5l2-2a4.24 4.24 0 00-6-6l-2 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><circle cx="5" cy="19" r="2" fill="currentColor"/><circle cx="19" cy="5" r="2" fill="currentColor"/></svg>
}

export function TaskServicesTab({ scope, visible }: TabComponentProps) {
  const [task, setTask] = useState<TaskSummaryDto>()
  const [snapshot, setSnapshot] = useState<TaskSnapshotDto>()
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [registerOpen, setRegisterOpen] = useState(false)
  const [serviceName, setServiceName] = useState('Development service')
  const [port, setPort] = useState('')
  const [protocol, setProtocol] = useState<Protocol>('http')
  const [ttlMinutes, setTtlMinutes] = useState(120)

  const refresh = useCallback(() => setRefreshKey(value => value + 1), [])
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    let timer = 0
    const load = async () => {
      try {
        const tasks = (await listTasks(controller.signal)).filter(item => item.status !== 'archived')
        const matched = matchTask(tasks, scope.cwd)
        setTask(matched)
        if (!matched) {
          setSnapshot(undefined)
          setError('当前会话 cwd 未匹配任何 Task Workspace；不会回退到其他 Task。')
          return
        }
        const next = await getTaskSnapshot(matched.id, controller.signal)
        setSnapshot(next)
        setError('')
      } catch (caught) {
        if ((caught as Error).name !== 'AbortError') setError((caught as Error).message)
      } finally {
        setLoading(false)
        if (!controller.signal.aborted) timer = window.setTimeout(load, 2_500)
      }
    }
    void load()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [refreshKey, scope.cwd, visible])

  const devices = useMemo(() => snapshot?.devices.filter(device => !device.revokedAt) ?? [], [snapshot])
  useEffect(() => {
    if (devices.some(device => device.id === selectedDeviceId)) return
    const preferred = window.localStorage.getItem('dsh-companion.preferred-device')
    const selected = devices.find(device => device.id === preferred)
      ?? devices.find(device => device.online)
      ?? devices[0]
    setSelectedDeviceId(selected?.id ?? '')
  }, [devices, selectedDeviceId])
  const selectedDevice = devices.find(device => device.id === selectedDeviceId)

  const showNotice = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 3_000)
  }
  const runAction = async (key: string, action: () => Promise<void>, success: string) => {
    setBusy(key)
    try { await action(); showNotice(success); refresh() }
    catch (caught) { showNotice((caught as Error).message) }
    finally { setBusy('') }
  }
  const createService = () => {
    const parsed = Number(port)
    if (!task || !Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
      showNotice('请输入 1–65535 之间的端口。')
      return
    }
    void runAction('register', () => registerService(task.id, { name: serviceName, port: parsed, protocol }), 'Task Service 已注册；尚未授权转发。')
    setRegisterOpen(false)
    setPort('')
  }
  const forwardAll = async () => {
    if (!task || !snapshot || !selectedDevice) return
    const pending = snapshot.services.filter(item => currentLease(snapshot, item.id, selectedDevice.id)?.desiredState !== 'open')
    await runAction('all', async () => {
      for (const item of pending) await openLease(task.id, item.id, selectedDevice.id, ttlMinutes)
    }, pending.length ? `已创建 ${pending.length} 个显式 Lease。` : '此 Device 已有全部 Lease。')
  }

  if (!visible) return null
  if (loading) return <div className="dco-center"><span className="dco-spinner" />正在解析当前 Task…</div>

  return <div className="dco-root" data-dsh-companion-task-services>
    <header className="dco-header">
      <div className="dco-title-row"><span className="dco-mark"><TaskServicesIcon /></span><div><span className="dco-eyebrow">TASK WORKSPACE</span><h2>Task Services</h2></div></div>
      <p>Task 内 loopback 服务声明与 Mac 转发控制面。不会改动 Bifrost 或系统代理。</p>
      {task ? <div className="dco-context"><span><small>当前 Task</small><strong>{task.title}</strong></span><label><small>目标 Device</small><select value={selectedDeviceId} onChange={event => setSelectedDeviceId(event.target.value)}>{devices.map(device => <option key={device.id} value={device.id}>{device.online ? '●' : '○'} {device.name}</option>)}</select></label></div> : <div className="dco-context-note">{error}</div>}
    </header>

    {task && snapshot && <>
      <div className="dco-toolbar">
        <div className="dco-summary"><Summary value={snapshot.services.length} label="Task Services"/><Summary value={runningCount(snapshot, selectedDeviceId)} label="此 Device 运行中"/><Summary value={issueCount(snapshot, selectedDeviceId)} label="恢复 / 需处理" warning={issueCount(snapshot, selectedDeviceId) > 0}/></div>
        <div className="dco-toolbar-actions"><span className="dco-bounded"><i />有界自动恢复</span><label className="dco-ttl">TTL <select value={ttlMinutes} onChange={event => setTtlMinutes(Number(event.target.value))}><option value={30}>30 分钟</option><option value={120}>2 小时</option><option value={480}>8 小时</option></select></label><button className="dco-button" onClick={() => setRegisterOpen(value => !value)}>＋ 注册服务</button><button className="dco-button dco-primary" disabled={!selectedDevice?.online || busy === 'all'} onClick={() => void forwardAll()}>一键转发</button></div>
      </div>
      {registerOpen && <div className="dco-register"><div><strong>注册 Task Service</strong><small>注册只添加声明，不会自动建立 SSH 转发。</small></div><input value={serviceName} onChange={event => setServiceName(event.target.value)} aria-label="服务名称"/><input inputMode="numeric" placeholder="端口" value={port} onChange={event => setPort(event.target.value)} aria-label="端口"/><select value={protocol} onChange={event => setProtocol(event.target.value as Protocol)} aria-label="协议"><option>http</option><option>https</option><option>tcp</option></select><button className="dco-button dco-primary" disabled={busy === 'register'} onClick={createService}>注册</button></div>}
      {error && <div className="dco-error-banner">{error}</div>}
      <main className="dco-card-list">
        {snapshot.services.map(service => <ServiceCard key={service.id} service={service} snapshot={snapshot} task={task} device={selectedDevice} ttlMinutes={ttlMinutes} busy={busy} runAction={runAction} />)}
        {snapshot.services.length === 0 && <div className="dco-empty"><TaskServicesIcon size={28}/><strong>此 Task 还没有 Service</strong><span>由 AI 调用 task_service_register，或手动注册一个 loopback 端口。</span><button className="dco-button" onClick={() => setRegisterOpen(true)}>注册服务</button></div>}
      </main>
      <RetiredForwards snapshot={snapshot} busy={busy} runAction={runAction} />
      <footer className="dco-footer"><span>Listener 固定 127.0.0.1</span><span>同端口映射</span><span>Session 结束不关闭 Lease</span></footer>
    </>}
    {task && !snapshot && <div className="dco-center">{error || '正在加载 Task Services…'}</div>}
    {notice && <div className="dco-toast" role="status">{notice}</div>}
  </div>
}

function ServiceCard(props: {
  service: TaskServiceDto
  snapshot: TaskSnapshotDto
  task: TaskSummaryDto
  device?: DeviceDto | undefined
  ttlMinutes: number
  busy: string
  runAction(key: string, action: () => Promise<void>, success: string): Promise<void>
}) {
  const { service, snapshot, task, device, ttlMinutes, busy, runAction } = props
  const lease = device ? currentLease(snapshot, service.id, device.id) : undefined
  const instance = lease ? snapshot.instances.find(item => item.leaseId === lease.id && item.generation === lease.generation) : undefined
  const state = displayState(lease, instance, device)
  const otherOpen = snapshot.leases.filter(item => item.serviceId === service.id && item.deviceId !== device?.id && item.desiredState === 'open')
  const actionKey = `service:${service.id}`
  const act = (action: () => Promise<void>, success: string) => runAction(actionKey, action, success)

  return <article className="dco-service-card">
    <div className="dco-service-head"><div><div className="dco-service-title"><strong>{service.name}</strong><span>:{service.port}</span></div><div className="dco-tags"><SourcePill source={service.source}/><span>{service.protocol.toUpperCase()}</span></div></div><StatePill state={state}/></div>
    <div className="dco-address"><code>Mac 127.0.0.1:{service.port}</code><span>→</span><code>devbox 127.0.0.1:{service.port}</code></div>
    {lease && <div className="dco-lease-grid"><div><span>Forward Lease</span><b>期望 {lease.desiredState === 'open' ? 'Open' : 'Closed'} · TTL {ttlRemaining(lease.expiresAt)}</b></div><div><span>Forward Instance</span><b>{instanceSummary(instance, lease)}</b></div></div>}
    {instance?.errorCode && <div className={`dco-inline-error ${state === 'needs_attention' ? 'hard' : ''}`}><code>{instance.errorCode}</code><span>{instance.errorMessage ?? 'Forward Instance 运行失败'}</span></div>}
    <div className="dco-service-foot"><div className="dco-evidence" title={service.evidence}>{service.evidence ?? (service.source === 'manual' ? '用户在当前 Task 手动注册' : 'AI 在当前 Task 注册')}</div><ServiceActions service={service} task={task} device={device} lease={lease} instance={instance} busy={busy === actionKey} ttlMinutes={ttlMinutes} act={act}/></div>
    <div className="dco-service-foot"><span>注销仅移除声明，不停止 devbox 应用；会撤销所有 Device 的关联转发。</span><button className="dco-button" disabled={Boolean(busy)} onClick={() => {
      if (window.confirm('注销服务「' + service.name + '」(:' + service.port + ')？所有 Device 的关联转发都会关闭；devbox 应用进程不会停止。')) {
        void act(() => unregisterService(task.id, service.id), '服务已注销，关联转发关闭已提交；可在关闭记录中查看设备确认。')
      }
    }}>注销服务</button></div>
    {otherOpen.length > 0 && <div className="dco-other">另有 {otherOpen.length} 台 Device 持有 Open Lease：{otherOpen.map(item => snapshot.devices.find(deviceItem => deviceItem.id === item.deviceId)?.name).filter(Boolean).join('、')}</div>}
    <details className="dco-diagnostics"><summary>诊断详情 <span>Desired / Observed · g{lease?.generation ?? '—'}</span></summary><div className="dco-diagnostic-body">
      <div className="dco-runtime"><Fact label="Lease 期望" value={lease?.desiredState.toUpperCase() ?? 'NONE'}/><Fact label="Instance 观测" value={instance?.state.toUpperCase() ?? 'ABSENT'}/><Fact label="Generation" value={lease ? `g${lease.generation}` : '—'}/><Fact label="端口策略" value={`127.0.0.1:${service.port} ↔ :${service.port}`}/></div>
      <div className="dco-health"><Health label="Device WSS" value={device?.online ? 'connected' : 'offline'} good={Boolean(device?.online)}/><Health label="SSH child" value={instance?.sshChild ?? 'unknown'} good={instance?.sshChild === 'running'}/><Health label="Listener ownership" value={instance?.listener ?? 'unknown'} good={instance?.listener === 'owned'}/><Health label="Remote TCP probe" value={instance?.remoteProbe ?? 'unknown'} good={instance?.remoteProbe === 'healthy' || instance?.remoteProbe === 'disabled'}/></div>
      <div className="dco-recovery"><strong>Recovery</strong><span>瞬态失败由 Companion 最多重试 5 次；端口冲突、认证、Host Key、撤销、归档和 TTL 到期不会自动绕过。</span>{instance?.retryAttempt !== undefined && <code>自动重试 {Math.min(5, Math.max(0, instance.retryAttempt - 1))}/5 · 总尝试 {instance.retryAttempt} · next {instance.retryAt ? relativeTime(instance.retryAt) : 'pending'}</code>}</div>
      {lease?.desiredState === 'open' && <button className="dco-button" disabled={busy === actionKey} onClick={() => void act(() => leaseAction(lease.id, 'restart'), 'Lease 已按 close/open 两代 fencing 重启；TTL 未延长。')}>手动重启 Instance</button>}
    </div></details>
  </article>
}

function ServiceActions(props: { service: TaskServiceDto; task: TaskSummaryDto; device?: DeviceDto | undefined; lease?: ForwardLeaseDto | undefined; instance?: InstanceDto | undefined; busy: boolean; ttlMinutes: number; act(action: () => Promise<void>, success: string): Promise<void> }) {
  const { service, task, device, lease, instance, busy, ttlMinutes, act } = props
  if (!device) return <button className="dco-button dco-primary" disabled>先配对 Device</button>
  if (lease?.desiredState === 'closed' && !isForwardCloseConfirmed(lease, instance)) return <button className="dco-button" disabled={busy} onClick={() => void act(() => leaseAction(lease.id, 'recheck'), '已重新提交关闭；等待设备确认。')}>重新检查关闭</button>
  if (!lease || lease.desiredState === 'closed') return <button className="dco-button dco-primary" disabled={!device.online || busy} onClick={() => void act(() => openLease(task.id, service.id, device.id, ttlMinutes), '已创建 TTL-bound Forward Lease。')}>转发到此设备</button>
  return <div className="dco-actions">
    {instance?.state === 'running' ? <><button className="dco-button dco-primary" onClick={() => openLocal(service)}>打开 localhost</button><button className="dco-button" disabled={busy} onClick={() => void act(() => leaseAction(lease.id, 'restart'), '已提交重启；Lease ID 与 TTL 保持不变。')}>重启</button></> : <button className="dco-button" disabled={busy} onClick={() => void act(() => leaseAction(lease.id, 'recheck'), '已要求 Companion 对账。')}>重新检查</button>}
    <button className="dco-button" disabled={busy} onClick={() => void act(() => leaseAction(lease.id, 'close'), '停止转发已提交；服务声明保留，等待设备确认。')}>停止转发</button>
  </div>
}

function RetiredForwards({ snapshot, busy, runAction }: { snapshot: TaskSnapshotDto; busy: string; runAction(key: string, action: () => Promise<void>, success: string): Promise<void> }) {
  const activeIds = new Set(snapshot.services.map(service => service.id))
  const retired = snapshot.leases.filter(lease => !activeIds.has(lease.serviceId))
  if (!retired.length) return null
  return <details className="dco-diagnostics"><summary>已注销服务的转发关闭记录（{retired.length}）</summary><div className="dco-diagnostic-body">
    <p>声明已移除不代表设备端口已停止。离线设备将在重新连接后对账；不会停止 devbox 应用。</p>
    {retired.map(lease => {
      const instance = snapshot.instances.find(item => item.leaseId === lease.id && item.generation === lease.generation)
      const confirmed = isForwardCloseConfirmed(lease, instance)
      return <div className="dco-service-foot" key={lease.id}>
        <span>:{lease.localPort} · {snapshot.devices.find(device => device.id === lease.deviceId)?.name ?? lease.deviceId} · {confirmed ? '已确认停止' : '待确认停止'} {instance?.errorCode}</span>
        {!confirmed && <button className="dco-button" disabled={Boolean(busy)} onClick={() => void runAction('retired:' + lease.id, () => leaseAction(lease.id, 'recheck'), '已重新提交关闭；等待设备确认。')}>重新检查关闭</button>}
      </div>
    })}
  </div></details>
}

function currentLease(snapshot: TaskSnapshotDto, serviceId: string, deviceId: string): ForwardLeaseDto | undefined {
  return snapshot.leases.filter(item => item.serviceId === serviceId && item.deviceId === deviceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
}
function displayState(lease: ForwardLeaseDto | undefined, instance: InstanceDto | undefined, device: DeviceDto | undefined): 'running' | 'closed' | 'starting' | 'recovering' | 'needs_attention' | 'degraded' | 'unforwarded' | 'closing' {
  if (!lease) return 'unforwarded'
  if (lease.desiredState === 'closed') return isForwardCloseConfirmed(lease, instance) ? 'closed' : 'closing'
  if (instance?.state === 'needs_attention') return 'needs_attention'
  if (!device?.online) return 'degraded'
  if (!instance || instance.generation !== lease.generation) return 'starting'
  return instance.state === 'closed' ? 'starting' : instance.state
}
function StatePill({ state }: { state: ReturnType<typeof displayState> }) {
  const copy = { running: '运行中', closed: '已确认停止', closing: '待确认停止', starting: '启动中', recovering: '自动恢复中', needs_attention: '需要处理', degraded: '设备离线', unforwarded: '未转发' }
  return <span className={`dco-pill dco-state-${state}`}><i />{copy[state]}</span>
}
function SourcePill({ source }: { source: TaskServiceDto['source'] }) {
  return <span className={`dco-source dco-source-${source}`}>{source === 'agent' ? 'AI 注册' : source === 'process' ? 'AI 发现' : '手动注册'}</span>
}
function Summary({ value, label, warning = false }: { value: number; label: string; warning?: boolean }) { return <div className={warning ? 'warning' : ''}><strong>{value}</strong><span>{label}</span></div> }
function Fact({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><b>{value}</b></div> }
function Health({ label, value, good }: { label: string; value: string; good: boolean }) { return <div><i className={good ? 'good' : ''}/><span>{label}</span><b>{value}</b></div> }
function instanceSummary(instance: InstanceDto | undefined, lease: ForwardLeaseDto): string {
  if (lease.desiredState === 'closed') return isForwardCloseConfirmed(lease, instance) ? 'SSH 已退出，listener 已消失' : '等待 Device 确认停止'
  if (!instance) return '等待 Device 对账'
  if (instance.listener === 'owned' && instance.sshChild === 'running') return 'SSH child + listener 已确认'
  if (instance.state === 'recovering') return '等待重建运行实例'
  return '未确认 listener 所有权'
}
function ttlRemaining(expiresAt: string): string {
  const milliseconds = Date.parse(expiresAt) - Date.now()
  if (milliseconds <= 0) return '已到期'
  const minutes = Math.ceil(milliseconds / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`
}
function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 1_000))
  return `${seconds} 秒后`
}
function runningCount(snapshot: TaskSnapshotDto, deviceId: string): number { return snapshot.instances.filter(item => item.deviceId === deviceId && item.state === 'running').length }
function issueCount(snapshot: TaskSnapshotDto, deviceId: string): number { return snapshot.instances.filter(item => item.deviceId === deviceId && (item.state === 'recovering' || item.state === 'needs_attention')).length }
function openLocal(service: TaskServiceDto): void {
  if (service.protocol === 'tcp') { void navigator.clipboard?.writeText(`127.0.0.1:${service.port}`); return }
  window.open(`${service.protocol}://localhost:${service.port}`, '_blank', 'noopener,noreferrer')
}
