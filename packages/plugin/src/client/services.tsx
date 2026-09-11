import { useCallback, useEffect, useMemo, useState } from 'react'
import { isForwardCloseConfirmed } from '../closure.js'
import { DEFAULT_LEASE_TTL_MS } from '../domain.js'
import type { TabComponentProps } from 'dsh-better-sidebar/client/service'
import {
  getSnapshot, leaseAction, openLease, registerService, unregisterService,
  type CompanionSnapshotDto, type DeviceDto, type ForwardLeaseDto, type InstanceDto, type Protocol, type ServiceDto,
} from './api.js'

export function ServicesIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8.5 15.5l7-7M7 6.5l-2 2a4.24 4.24 0 006 6l2-2M17 17.5l2-2a4.24 4.24 0 00-6-6l-2 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><circle cx="5" cy="19" r="2" fill="currentColor"/><circle cx="19" cy="5" r="2" fill="currentColor"/></svg>
}

export function ServicesTab({ visible }: TabComponentProps) {
  const [snapshot, setSnapshot] = useState<CompanionSnapshotDto>()
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
  const [ttlMinutes, setTtlMinutes] = useState(DEFAULT_LEASE_TTL_MS / 60_000)

  const refresh = useCallback(() => setRefreshKey(value => value + 1), [])
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    let timer = 0
    const load = async () => {
      try {
        setSnapshot(await getSnapshot(controller.signal))
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
  }, [refreshKey, visible])

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
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
      showNotice('请输入 1–65535 之间的端口。')
      return
    }
    void runAction('register', () => registerService({ name: serviceName, port: parsed, protocol }), '全局 Service 已注册；尚未授权转发。')
    setRegisterOpen(false)
    setPort('')
  }
  const forwardAll = async () => {
    if (!snapshot || !selectedDevice) return
    const pending = snapshot.services.filter(item => currentLease(snapshot, item.id, selectedDevice.id)?.desiredState !== 'open')
    await runAction('all', async () => {
      for (const item of pending) await openLease(item.id, selectedDevice.id, ttlMinutes)
    }, pending.length ? `已创建 ${pending.length} 个显式 Lease。` : '此 Device 已有全部 Lease。')
  }

  if (!visible) return null
  if (loading) return <div className="dco-center"><span className="dco-spinner" />正在加载全局 Services…</div>

  return <div className="dco-root" data-dsh-companion-services>
    <header className="dco-header">
      <div className="dco-title-row"><span className="dco-mark"><ServicesIcon /></span><div><span className="dco-eyebrow">HOST · LOOPBACK</span><h2>Local Services</h2></div></div>
      <p>此 Host 统一维护的 loopback 服务声明与 Device 转发控制面，不随 Task 或 Session 切换。</p>
      <div className="dco-context"><span><small>服务范围</small><strong>当前 Host 全局</strong></span><label><small>目标 Device</small><select value={selectedDeviceId} onChange={event => setSelectedDeviceId(event.target.value)}>{devices.map(device => <option key={device.id} value={device.id}>{device.online ? '●' : '○'} {device.name}</option>)}</select></label></div>
    </header>

    {snapshot && <>
      <div className="dco-toolbar">
        <div className="dco-summary"><Summary value={snapshot.services.length} label="Global Services"/><Summary value={runningCount(snapshot, selectedDeviceId)} label="此 Device 运行中"/><Summary value={issueCount(snapshot, selectedDeviceId)} label="恢复 / 需处理" warning={issueCount(snapshot, selectedDeviceId) > 0}/></div>
        <div className="dco-toolbar-actions"><span className="dco-bounded"><i />持续自动恢复</span><label className="dco-ttl">TTL <select value={ttlMinutes} onChange={event => setTtlMinutes(Number(event.target.value))}><option value={30}>30 分钟</option><option value={120}>2 小时</option><option value={480}>8 小时</option><option value={1440}>24 小时</option><option value={DEFAULT_LEASE_TTL_MS / 60_000}>一周（7 天）</option></select></label><button className="dco-button" onClick={() => setRegisterOpen(value => !value)}>＋ 注册服务</button><button className="dco-button dco-primary" disabled={!selectedDevice?.online || busy === 'all'} onClick={() => void forwardAll()}>一键转发</button></div>
      </div>
      {registerOpen && <div className="dco-register"><div><strong>注册全局 Service</strong><small>同一端口只保留一个声明；注册不会自动建立 SSH 转发。</small></div><input value={serviceName} onChange={event => setServiceName(event.target.value)} aria-label="服务名称"/><input inputMode="numeric" placeholder="端口" value={port} onChange={event => setPort(event.target.value)} aria-label="端口"/><select value={protocol} onChange={event => setProtocol(event.target.value as Protocol)} aria-label="协议"><option>http</option><option>https</option><option>tcp</option></select><button className="dco-button dco-primary" disabled={busy === 'register'} onClick={createService}>注册</button></div>}
      {error && <div className="dco-error-banner">{error}</div>}
      <main className="dco-card-list">
        {snapshot.services.map(service => <ServiceCard key={service.id} service={service} snapshot={snapshot} device={selectedDevice} ttlMinutes={ttlMinutes} busy={busy} runAction={runAction} />)}
        {snapshot.services.length === 0 && <div className="dco-empty"><ServicesIcon size={28}/><strong>还没有 Service</strong><span>由 AI 调用 task_service_register（兼容名称），或在这里手动注册一个 loopback 端口。</span><button className="dco-button" onClick={() => setRegisterOpen(true)}>注册服务</button></div>}
      </main>
      <RetiredForwards snapshot={snapshot} busy={busy} runAction={runAction} />
      <footer className="dco-footer"><span>Listener 固定 127.0.0.1</span><span>同端口映射</span><span>Task / Session 结束不关闭 Lease</span></footer>
    </>}
    {!snapshot && <div className="dco-center">{error || '正在加载全局 Services…'}</div>}
    {notice && <div className="dco-toast" role="status">{notice}</div>}
  </div>
}

function ServiceCard(props: {
  service: ServiceDto
  snapshot: CompanionSnapshotDto
  device?: DeviceDto | undefined
  ttlMinutes: number
  busy: string
  runAction(key: string, action: () => Promise<void>, success: string): Promise<void>
}) {
  const { service, snapshot, device, ttlMinutes, busy, runAction } = props
  const lease = device ? currentLease(snapshot, service.id, device.id) : undefined
  const instance = lease ? snapshot.instances.find(item => item.leaseId === lease.id && item.generation === lease.generation) : undefined
  const state = displayState(lease, instance, device)
  const otherOpen = snapshot.leases.filter(item => item.serviceId === service.id && item.deviceId !== device?.id && item.desiredState === 'open')
  const actionKey = `service:${service.id}`
  const act = (action: () => Promise<void>, success: string) => runAction(actionKey, action, success)

  return <article className="dco-service-card">
    <div className="dco-service-head"><div><div className="dco-service-title"><strong>{service.name}</strong><span>:{service.port}</span></div><div className="dco-tags"><SourcePill source={service.source}/><span>{service.protocol.toUpperCase()}</span></div></div><StatePill state={state}/></div>
    <div className="dco-address"><code>Device 127.0.0.1:{service.port}</code><span>→</span><code>devbox 127.0.0.1:{service.port}</code></div>
    {lease && <div className="dco-lease-grid"><div><span>Forward Lease</span><b>期望 {lease.desiredState === 'open' ? 'Open' : 'Closed'} · TTL {ttlRemaining(lease.expiresAt)}</b></div><div><span>Forward Instance</span><b>{instanceSummary(instance, lease)}</b></div></div>}
    {instance?.errorCode && <div className={`dco-inline-error ${state === 'needs_attention' ? 'hard' : ''}`}><code>{instance.errorCode}</code><span>{instance.errorMessage ?? 'Forward Instance 运行失败'}</span></div>}
    <div className="dco-service-foot"><div className="dco-evidence" title={service.evidence}>{service.evidence ?? (service.source === 'manual' ? '用户手动注册' : 'AI 注册')}</div><ServiceActions service={service} device={device} lease={lease} instance={instance} busy={busy === actionKey} ttlMinutes={ttlMinutes} act={act}/></div>
    <div className="dco-service-foot"><span>注销仅移除声明，不停止 devbox 应用；会撤销所有 Device 的关联转发。</span><button className="dco-button" disabled={Boolean(busy)} onClick={() => {
      if (window.confirm('注销服务「' + service.name + '」(:' + service.port + ')？所有 Device 的关联转发都会关闭；devbox 应用进程不会停止。')) {
        void act(() => unregisterService(service.id), '服务已注销，关联转发关闭已提交；可在关闭记录中查看设备确认。')
      }
    }}>注销服务</button></div>
    {otherOpen.length > 0 && <div className="dco-other">另有 {otherOpen.length} 台 Device 持有 Open Lease：{otherOpen.map(item => snapshot.devices.find(deviceItem => deviceItem.id === item.deviceId)?.name).filter(Boolean).join('、')}</div>}
    <details className="dco-diagnostics"><summary>诊断详情 <span>Desired / Observed · g{lease?.generation ?? '—'}</span></summary><div className="dco-diagnostic-body">
      <div className="dco-runtime"><Fact label="Lease 期望" value={lease?.desiredState.toUpperCase() ?? 'NONE'}/><Fact label="Instance 观测" value={instance?.state.toUpperCase() ?? 'ABSENT'}/><Fact label="Generation" value={lease ? `g${lease.generation}` : '—'}/><Fact label="端口策略" value={`127.0.0.1:${service.port} ↔ :${service.port}`}/></div>
      <div className="dco-health"><Health label="Device WSS" value={device?.online ? 'connected' : 'offline'} good={Boolean(device?.online)}/><Health label="SSH child" value={instance?.sshChild ?? 'unknown'} good={instance?.sshChild === 'running'}/><Health label="Listener ownership" value={instance?.listener ?? 'unknown'} good={instance?.listener === 'owned'}/><Health label="Remote TCP probe" value={instance?.remoteProbe ?? 'unknown'} good={instance?.remoteProbe === 'healthy' || instance?.remoteProbe === 'disabled'}/></div>
      <div className="dco-recovery"><strong>Recovery</strong><span>网络、控制通道和 SSH 瞬态失败会持续退避重试（最长 30 秒）；端口冲突、认证、Host Key、撤销和 TTL 到期不会自动绕过。</span>{instance?.retryAttempt !== undefined && <code>连续失败尝试 {instance.retryAttempt} · next {instance.retryAt ? relativeTime(instance.retryAt) : 'pending'}</code>}</div>
      {lease?.desiredState === 'open' && <button className="dco-button" disabled={busy === actionKey} onClick={() => void act(() => leaseAction(lease.id, 'restart'), 'Lease 已按 close/open 两代 fencing 重启；TTL 未延长。')}>手动重启 Instance</button>}
    </div></details>
  </article>
}

export function ServiceActions(props: { service: ServiceDto; device?: DeviceDto | undefined; lease?: ForwardLeaseDto | undefined; instance?: InstanceDto | undefined; busy: boolean; ttlMinutes: number; act(action: () => Promise<void>, success: string): Promise<void> }) {
  const { service, device, lease, instance, busy, ttlMinutes, act } = props
  if (!device) return <button className="dco-button dco-primary" disabled>先配对 Device</button>
  if (lease?.desiredState === 'closed') return <div className="dco-actions">
    <button className="dco-button dco-primary" disabled={busy || Boolean(device.revokedAt)} onClick={() => void act(() => openLease(service.id, device.id, ttlMinutes), '已申请新的转发授权，TTL 从现在计时；Device 联机后先确认旧转发关闭，再开启。')}>重新开启转发</button>
    {!isForwardCloseConfirmed(lease, instance) && <button className="dco-button" disabled={busy} onClick={() => void act(() => leaseAction(lease.id, 'recheck'), '已重新提交关闭；等待设备确认。')}>重新检查关闭</button>}
  </div>
  if (!lease) return <button className="dco-button dco-primary" disabled={!device.online || busy} onClick={() => void act(() => openLease(service.id, device.id, ttlMinutes), '已创建 TTL-bound Forward Lease。')}>转发到此设备</button>
  return <div className="dco-actions">
    {instance?.state === 'running' ? <><button className="dco-button dco-primary" onClick={() => openLocal(service)}>打开 localhost</button><button className="dco-button" disabled={busy} onClick={() => void act(() => leaseAction(lease.id, 'restart'), '已提交重启；Lease ID 与 TTL 保持不变。')}>重启</button></> : <button className="dco-button" disabled={busy} onClick={() => void act(() => leaseAction(lease.id, 'recheck'), '已要求 Companion 立即对账。')}>立即重试</button>}
    <button className="dco-button" disabled={busy} onClick={() => void act(() => leaseAction(lease.id, 'close'), '停止转发已提交；服务声明保留，等待设备确认。')}>停止转发</button>
  </div>
}

function RetiredForwards({ snapshot, busy, runAction }: { snapshot: CompanionSnapshotDto; busy: string; runAction(key: string, action: () => Promise<void>, success: string): Promise<void> }) {
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

export function currentLease(snapshot: CompanionSnapshotDto, serviceId: string, deviceId: string): ForwardLeaseDto | undefined {
  return snapshot.leases.filter(item => item.serviceId === serviceId && item.deviceId === deviceId).at(-1)
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
function SourcePill({ source }: { source: ServiceDto['source'] }) {
  return <span className={`dco-source dco-source-${source}`}>{source === 'agent' ? 'AI 注册' : source === 'process' ? 'AI 发现' : '手动注册'}</span>
}
function Summary({ value, label, warning = false }: { value: number; label: string; warning?: boolean }) { return <div className={warning ? 'warning' : ''}><strong>{value}</strong><span>{label}</span></div> }
function Fact({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><b>{value}</b></div> }
function Health({ label, value, good }: { label: string; value: string; good: boolean }) { return <div><i className={good ? 'good' : ''}/><span>{label}</span><b>{value}</b></div> }
function instanceSummary(instance: InstanceDto | undefined, lease: ForwardLeaseDto): string {
  if (lease.desiredState === 'closed') return isForwardCloseConfirmed(lease, instance) ? 'SSH 已退出，listener 已消失' : '等待 Device 确认停止'
  if (!instance) return '等待 Device 对账'
  if (instance.listener === 'owned' && instance.sshChild === 'running') return 'SSH child + listener 已确认'
  if (instance.state === 'recovering') return '等待自动重建运行实例'
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
function runningCount(snapshot: CompanionSnapshotDto, deviceId: string): number { return snapshot.instances.filter(item => item.deviceId === deviceId && item.state === 'running').length }
function issueCount(snapshot: CompanionSnapshotDto, deviceId: string): number { return snapshot.instances.filter(item => item.deviceId === deviceId && (item.state === 'recovering' || item.state === 'needs_attention')).length }
function openLocal(service: ServiceDto): void {
  if (service.protocol === 'tcp') { void navigator.clipboard?.writeText(`127.0.0.1:${service.port}`); return }
  window.open(`${service.protocol}://localhost:${service.port}`, '_blank', 'noopener,noreferrer')
}
