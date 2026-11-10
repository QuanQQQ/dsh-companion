import { useEffect, useRef, useState, type ReactNode } from 'react'
import { forwardStatus } from '../forward-status.js'
import { DeviceSettings } from './device-settings.js'
import { ServicesIcon, ServicesTab } from './services.js'
import { getLocalSnapshot, getLaunchReview, localServiceAction, type LaunchReviewDto, type LinuxServiceDto, type LocalSnapshotDto } from './api.js'

type LaunchOperation = 'start' | 'restart' | 'launch'
type DialogState = { kind: 'devices' | 'create' } | { kind: 'logs'; name: string; text: string }
  | { kind: 'remove' | 'claim'; service: LinuxServiceDto }
  | { kind: 'review'; service: LinuxServiceDto; review: LaunchReviewDto; operation: LaunchOperation }

export function LocalServicesPanel({ visible, workspacePath }: { visible: boolean; workspacePath: string }) {
  const [snapshot, setSnapshot] = useState<LocalSnapshotDto>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [dialog, setDialog] = useState<DialogState>()
  const [forwardingOnly, setForwardingOnly] = useState(false)
  useEffect(() => {
    if (!visible || forwardingOnly) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try { setSnapshot(await getLocalSnapshot(controller.signal)); setError('') }
      catch (caught) { if (!controller.signal.aborted) setError(message(caught)) }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void load(), 2500) }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [visible, refresh, forwardingOnly])
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(timer) } }, [notice])
  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key); setError('')
    try { const value = await action(); setNotice(success); setRefresh(n => n + 1); return { ok: true as const, value } }
    catch (caught) { setError(message(caught)); return { ok: false as const } }
    finally { setBusy('') }
  }
  const review = async (service: LinuxServiceDto, operation: LaunchOperation) => {
    const result = await run(service.id, () => getLaunchReview(service.id), '')
    if (result.ok) setDialog({ kind: 'review', service, operation, review: result.value as LaunchReviewDto })
  }
  const logs = async (service: LinuxServiceDto) => {
    const result = await run(service.id, () => localServiceAction('logs', { service_id: service.id, lines: 200 }), '')
    if (result.ok) setDialog({ kind: 'logs', name: service.name, text: String(result.value) })
  }
  if (!visible) return null
  const services = snapshot?.linux.filter(service => service.desired !== 'removed' || !service.removalComplete) ?? []
  return <div className="dco-root dco-local-panel" data-dsh-local-services>
    <header className="dco-local-header"><div className="dco-title-row"><ServicesIcon /><h2>Local Services</h2></div>
      <p>管理开发服务，查看 Linux 运行状态与 设备转发状态。</p>
      <div className="dco-actions"><button className="dco-button" onClick={() => setDialog({ kind: 'devices' })}>设备设置</button><button className="dco-button" onClick={() => setForwardingOnly(value => !value)}>{forwardingOnly ? '开发服务' : '端口转发'}</button><button className="dco-button dco-primary" onClick={() => setDialog({ kind: 'create' })}>创建服务</button></div>
    </header>
    {error && <div className="dco-error-banner" role="alert">{error}</div>}
    {forwardingOnly ? <ServicesTab visible={visible} /> : !snapshot ? <div className="dco-center">正在读取开发服务…</div> : <main className="dco-card-list">
      {services.length === 0 && <div className="dco-empty"><ServicesIcon size={26}/><strong>还没有开发服务</strong><span>让当前项目的 Agent 创建服务，或在这里填写启动配置。</span><button className="dco-button" onClick={() => setDialog({ kind: 'create' })}>创建服务</button></div>}
      {services.map(service => <article className="dco-service-card" key={service.id} data-service-id={service.id}>
        <div className="dco-service-head"><div className="dco-service-title"><strong>{service.name}</strong><span>:{service.port}</span></div><span className="dco-chip">{linuxState(service)}</span></div>
        <div className="dco-project" title={service.workspacePath ?? ''}><span>项目</span><code>{service.workspacePath ?? '旧记录尚未关联项目'}</code></div>
        {service.health.reason && <p className="dco-local-detail">{service.health.reason}</p>}
        {service.lastError && <p className="dco-local-detail">{service.lastError}</p>}
        <ForwardSummary service={service} snapshot={snapshot} />
        <div className="dco-local-actions">
          {!service.workspacePath ? <button className="dco-button" disabled={!!busy} onClick={() => setDialog({ kind: 'claim', service })}>关联项目</button> : <>
            <button className="dco-button dco-primary" disabled={!!busy || service.desired === 'removed'} onClick={() => void review(service, 'start')}>启动</button>
            <button className="dco-button" disabled={!!busy || service.desired === 'removed'} onClick={() => void review(service, 'launch')}>启动并转发</button>
            <button className="dco-button" disabled={!!busy || service.desired === 'removed'} onClick={() => void review(service, 'restart')}>重启</button>
          </>}
          <button className="dco-button" disabled={!!busy} onClick={() => void run(service.id, () => localServiceAction('stop', { service_id: service.id }), '已提交停止服务')}>停止</button>
          <button className="dco-button" disabled={!!busy} onClick={() => void logs(service)}>日志</button>
          <button className="dco-button" disabled={!!busy} onClick={() => void run(service.id, () => localServiceAction('synchronize', { service_id: service.id }), '已重新同步转发声明')}>同步</button>
          <button className="dco-button danger" disabled={!!busy} onClick={() => setDialog({ kind: 'remove', service })}>移除</button>
        </div>
      </article>)}
    </main>}
    {notice && <div className="dco-toast" role="status">{notice}</div>}
    {dialog && <Modal close={() => setDialog(undefined)}>
      {error && <p className="dco-error-banner" role="alert">{error}</p>}
      {dialog.kind === 'devices' && <DeviceSettings close={() => setDialog(undefined)} />}
      {dialog.kind === 'logs' && <><h3>{dialog.name} · 最近日志</h3><pre className="dco-log">{dialog.text || '暂无日志'}</pre></>}
      {dialog.kind === 'create' && <CreateService initialWorkspace={workspacePath} busy={!!busy} submit={async body => { if ((await run('create', () => localServiceAction('create', body), '服务已创建，尚未启动')).ok) setDialog(undefined) }} />}
      {dialog.kind === 'claim' && <ClaimService service={dialog.service} initialWorkspace={workspacePath} busy={!!busy} submit={async path => { if ((await run(dialog.service.id, () => localServiceAction('claim', { service_id: dialog.service.id, workspace_path: path }), '旧服务已关联项目')).ok) setDialog(undefined) }} />}
      {dialog.kind === 'remove' && <><h3>移除「{dialog.service.name}」？</h3><p>应用将停止，关联转发将撤销。原端口继续作为历史记录保留。</p><code>{dialog.service.workspacePath}</code><div className="dco-dialog-actions"><button className="dco-button danger" disabled={!!busy} onClick={async () => { const result = await run(dialog.service.id, () => localServiceAction('remove', { service_id: dialog.service.id }), ''); if (result.ok) { setNotice((result.value as LinuxServiceDto).removalComplete ? '服务已移除' : '移除请求已提交，等待运行状态或转发确认'); setDialog(undefined) } }}>确认移除</button></div></>}
      {dialog.kind === 'review' && <LaunchConfirmation state={dialog} snapshot={snapshot} busy={!!busy} submit={async extra => {
        const result = await run(dialog.service.id, () => localServiceAction(dialog.operation, { service_id: dialog.service.id, configuration_digest: dialog.review.configurationDigest, ...extra }), dialog.operation === 'restart' ? '已执行重启，请查看服务状态' : '已执行启动，请查看服务状态')
        if (result.ok) { if (dialog.operation === 'launch') setNotice(phaseLabel((result.value as { phase?: string })?.phase)); setDialog(undefined) }
      }} />}
    </Modal>}
  </div>
}

function LaunchConfirmation({ state, snapshot, busy, submit }: { state: Extract<DialogState, { kind: 'review' }>; snapshot: LocalSnapshotDto | undefined; busy: boolean; submit(extra: Record<string, unknown>): Promise<void> }) {
  const linked = snapshot?.companion.services.find(service => service.id === state.service.companion.id)
  const devices = snapshot?.companion.devices.filter(device => !device.revokedAt) ?? []
  const [device, setDevice] = useState(() => devices.some(item => item.id === linked?.preferredDeviceId) ? linked?.preferredDeviceId ?? '' : '')
  const [ttl, setTtl] = useState(() => linked?.preferredTtlMs ? String(linked.preferredTtlMs / 60000) : '')
  const [confirmed, setConfirmed] = useState(false)
  const forwarding = state.operation === 'launch'
  return <><h3>{forwarding ? '启动并授权转发' : state.operation === 'restart' ? '确认重启服务' : '确认启动服务'}</h3>
    <p>将运行「{state.review.name}」的以下配置：</p><dl className="dco-review"><dt>项目</dt><dd>{state.review.workspacePath}</dd><dt>工作目录</dt><dd>{state.review.workdir}</dd><dt>可执行文件</dt><dd><code>{state.review.executable}</code></dd><dt>参数</dt><dd><pre>{JSON.stringify(state.review.args, null, 2)}</pre></dd><dt>端口</dt><dd>{state.review.port} · {state.review.protocol}</dd></dl>
    {forwarding && <div className="dco-local-form"><label>目标设备<select value={device} onChange={event => setDevice(event.target.value)}><option value="">明确选择设备</option>{devices.map(item => <option key={item.id} value={item.id}>{item.name}{item.online ? '（在线）' : '（离线）'}</option>)}</select></label><label>转发有效期<select value={ttl} onChange={event => setTtl(event.target.value)}><option value="">明确选择有效期</option><option value="30">30分钟</option><option value="120">2小时</option><option value="1440">1天</option><option value="10080">7天</option></select></label><p>已有有效转发保持原到期时间。未配对设备时，请先打开设备设置。</p></div>}
    <label className="dco-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>我确认运行以上命令{forwarding ? '并授权所选设备的转发' : ''}</label>
    <div className="dco-dialog-actions"><button className="dco-button dco-primary" disabled={busy || !confirmed || forwarding && (!device || !ttl)} onClick={() => void submit(forwarding ? { device_id: device, ttl_minutes: Number(ttl), authorize_forward: true, wait_ms: 10000 } : {})}>{busy ? '正在执行…' : forwarding ? '确认启动并转发' : '确认运行'}</button></div>
  </>
}

function CreateService({ initialWorkspace, busy, submit }: { initialWorkspace: string; busy: boolean; submit(body: Record<string, unknown>): Promise<void> }) {
  const [form, setForm] = useState({ workspace: initialWorkspace, name: '', executable: '', args: '[]', workdir: '', port: '', protocol: 'http' })
  const [error, setError] = useState('')
  const field = (name: keyof typeof form, value: string) => setForm(current => ({ ...current, [name]: value }))
  return <form className="dco-local-form" onSubmit={event => {
    event.preventDefault()
    try {
      const args: unknown = JSON.parse(form.args)
      if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('参数需要填写字符串数组')
      setError(''); void submit({ workspace_path: form.workspace, name: form.name, executable: form.executable, args, workdir: form.workdir || form.workspace, port: Number(form.port), protocol: form.protocol })
    } catch (caught) { setError(message(caught)) }
  }}><h3>创建开发服务</h3><label>项目目录<input required value={form.workspace} onChange={event => field('workspace', event.target.value)} /></label><label>服务名称<input required value={form.name} onChange={event => field('name', event.target.value)} /></label><label>可执行文件（绝对路径）<input required placeholder="/usr/bin/python3" value={form.executable} onChange={event => field('executable', event.target.value)} /></label><label>参数（JSON数组）<textarea required value={form.args} onChange={event => field('args', event.target.value)} /></label><label>工作目录（默认项目目录）<input value={form.workdir} onChange={event => field('workdir', event.target.value)} /></label><div className="dco-form-row"><label>固定端口<input required type="number" min="1024" max="65535" value={form.port} onChange={event => field('port', event.target.value)} /></label><label>协议<select value={form.protocol} onChange={event => field('protocol', event.target.value)}><option>http</option><option>https</option><option>tcp</option></select></label></div><p>创建只保存配置。启动时会再次展示命令供你确认。</p>{error && <p role="alert">{error}</p>}<div className="dco-dialog-actions"><button className="dco-button dco-primary" disabled={busy}>创建</button></div></form>
}
function ClaimService({ service, initialWorkspace, busy, submit }: { service: LinuxServiceDto; initialWorkspace: string; busy: boolean; submit(path: string): Promise<void> }) {
  const [path, setPath] = useState(initialWorkspace)
  return <form className="dco-local-form" onSubmit={event => { event.preventDefault(); void submit(path) }}><h3>关联「{service.name}」的项目</h3><p>旧任务归属无法直接确定，需要明确选择项目目录。</p><label>项目目录<input required value={path} onChange={event => setPath(event.target.value)} /></label><button className="dco-button dco-primary" disabled={busy}>确认关联</button></form>
}
function ForwardSummary({ service, snapshot }: { service: LinuxServiceDto; snapshot: LocalSnapshotDto }) {
  const declaration = snapshot.companion.services.find(item => item.id === service.companion.id)
  const deviceId = declaration?.preferredDeviceId
  const lease = snapshot.companion.leases.filter(item => item.serviceId === service.companion.id && item.deviceId === deviceId).at(-1)
  if (!lease) return <p className="dco-local-detail">设备转发：未配置{service.companion.state === 'error' ? '，声明同步失败' : ''}</p>
  const device = snapshot.companion.devices.find(item => item.id === lease.deviceId)
  const instance = snapshot.companion.instances.find(item => item.leaseId === lease.id && item.generation === lease.generation)
  const status = forwardStatus(lease, device, instance)
  return <p className="dco-local-detail">设备 {device?.name ?? '所选设备'}：{phaseLabel(status.phase)} · 到期 {new Date(lease.expiresAt).toLocaleString()}</p>
}
function Modal({ children, close }: { children: ReactNode; close(): void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const element = ref.current; element?.showModal(); return () => element?.close() }, [])
  return <dialog ref={ref} className="dco-dialog" onCancel={event => { event.preventDefault(); close() }}><button className="dco-button dco-dialog-close" aria-label="关闭对话框" onClick={close}>关闭</button>{children}</dialog>
}
function message(value: unknown): string { return value instanceof Error ? value.message : String(value) }
export function linuxState(service: LinuxServiceDto): string {
  if (service.desired === 'removed') return service.removalComplete ? '已移除' : '移除待确认'
  if (service.desired === 'stopped') return service.runtime.exists === false || service.runtime.state === 'inactive' ? '已停止' : '停止待确认'
  if (service.runtime.state === 'failed') return '启动失败'
  return service.health.state === 'ready' ? '端口可连接' : service.health.state === 'unsafe' ? '归属未验证' : '等待就绪'
}
function phaseLabel(phase?: string): string {
  return ({ ready: '本地连接已验证，应用尚未验证', closed: '已确认关闭', closing: '等待设备关闭确认', device_offline: '设备离线', forwarding_error: '转发异常', probe_unsupported: '设备版本不支持连接验证', waiting_for_mac: '等待设备确认', setup_required: '请先连接设备', device_selection_required: '请选择设备', authorization_required: '需要明确转发授权', starting: '服务尚在启动', linux_error: '服务尚未就绪', companion_unavailable: '转发声明尚未同步' } as Record<string, string>)[phase ?? ''] ?? '等待状态更新'
}
