import { useEffect, useMemo, useState } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { listDevices, revokeDevice, listEnrollments, approveEnrollment, denyEnrollment, getCompanionIdentity, type DeviceDto, type EnrollmentDto } from './api.js'

function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'" }
async function copyText(text: string): Promise<void> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return } } catch { /* HTTP development origin fallback. */ }
  const previous = document.activeElement
  const input = document.createElement('textarea')
  input.value = text; input.readOnly = true; input.style.position = 'fixed'; input.style.opacity = '0'
  document.body.appendChild(input)
  try { input.select(); if (!document.execCommand('copy')) throw new Error('Clipboard unavailable') }
  finally { input.remove(); if (previous instanceof HTMLElement) previous.focus() }
}

export function DeviceSettings({ close }: SettingsSectionOwnerProps) {
  const [devices, setDevices] = useState<DeviceDto[]>([])
  const [requests, setRequests] = useState<EnrollmentDto[]>([])
  const [authority, setAuthority] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [serverOrigin, setServerOrigin] = useState(() => window.location.origin)
  const [allowHttp, setAllowHttp] = useState(false)
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string>()
  const [preferred, setPreferred] = useState(() => window.localStorage.getItem('dsh-companion.preferred-device') ?? '')
  const reload = async () => {
    try { const [d,r,a] = await Promise.all([listDevices(),listEnrollments(),getCompanionIdentity()]); setDevices(d); setRequests(r); setAuthority(a) }
    catch (caught) { setError((caught as Error).message) }
    finally { setLoading(false) }
  }
  useEffect(() => { void reload(); const timer = window.setInterval(() => void reload(),3000); return () => window.clearInterval(timer) }, [])
  const command = useMemo(() => {
    try {
      const url = new URL(serverOrigin)
      if (url.origin !== serverOrigin || url.username || url.password || !['http:','https:'].includes(url.protocol)) return ''
      const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname)
      if (url.protocol === 'http:' && !loopback && !allowHttp) return ''
      const proto = url.protocol === 'https:' ? '=https' : '=http,https'
      return 'curl --disable -fsS --connect-timeout 10 --max-time 120 --proto '+shellQuote(proto)+' '+shellQuote(url.origin+'/api/companion/bootstrap.sh')+' | bash -s -- '+shellQuote(url.origin)+(allowHttp ? ' --allow-insecure-http' : '')
    } catch { return '' }
  },[serverOrigin,allowHttp])
  const copy = async () => { try { await copyText(command); setCopied(true); window.setTimeout(()=>setCopied(false),1500) } catch { setError('复制失败，请直接复制下方启动命令。') } }
  const choose = (id: string) => { setPreferred(id); window.localStorage.setItem('dsh-companion.preferred-device',id); window.dispatchEvent(new CustomEvent('dsh-companion:preferred-device',{detail:{deviceId:id}})) }
  const revoke = async (device: DeviceDto) => {
    if (!window.confirm('撤销 '+device.name+'？该 Device 的所有 Forward Lease 都会关闭。')) return
    try { await revokeDevice(device.id); setError(''); await reload() } catch (caught) { setError((caught as Error).message) }
  }
  const decide = async (request: EnrollmentDto, allow: boolean) => {
    if (allow && !confirmed[request.requestId]) return
    setBusy(request.requestId)
    try { await (allow ? approveEnrollment : denyEnrollment)(request.requestId); setError(''); await reload() }
    catch (caught) { setError((caught as Error).message) }
    finally { setBusy(undefined) }
  }
  return <div className="dco-settings">
    <header className="dco-settings-head"><div><span className="dco-eyebrow">LOCALHOST · LEAST PRIVILEGE</span><h3>Companion Devices</h3><p>同一条命令完成首次启动、替换旧版本和失配恢复。不修改 Bifrost 或系统代理。</p></div><button className="dco-button" onClick={close}>完成</button></header>
    <section className="dco-pairing" aria-label="统一启动 Companion">
      <h4>在 Device 上执行这一条命令</h4>
      <label>Device 可访问的 DSH 地址<input aria-label="DSH server origin" value={serverOrigin} onChange={event=>setServerOrigin(event.target.value)} spellCheck={false}/></label>
      <label className="dco-checkbox-row"><input type="checkbox" checked={allowHttp} onChange={event=>setAllowHttp(event.target.checked)}/>允许明文 HTTP（仅限可信测试网络；代码和凭证不受 TLS 保护）</label>
      <p>脚本自动拉取并校验此 Host 的最新版：已有安装就安全替换并重新启动；没有就完成首次启动。当前 CLI 支持 macOS，需要设备已安装 Node.js 22+，首次会询问 SSH alias。</p>
      {command ? <><pre><code>{command}</code></pre><button className="dco-button dco-primary" onClick={()=>void copy()}>{copied ? '已复制启动命令' : '复制启动命令'}</button></> : <p>请输入完整 HTTPS origin；可信测试网络的 HTTP 需明确勾选许可。</p>}
      <div className="dco-safety">首次或 Host 改变时，终端显示验证码并打开此页面。核对下面请求后允许即可，不需要下载 CLI 或区分 setup/update。</div>
    </section>
    <section aria-label="待授权的 Device"><h4>待授权的 Device</h4>
      {requests.filter(r=>r.status==='pending'||r.status==='approving').length===0 && <p>暂无待授权请求。运行上方命令后会自动出现。</p>}
      {requests.filter(r=>r.status==='pending'||r.status==='approving').map(request=><article key={request.requestId} className="dco-device-card">
        <div className="dco-device-title"><strong>{request.name}</strong><code>{request.userCode}</code></div>
        <div className="dco-device-meta">{request.osVersion} · {request.architecture} · CLI {request.companionVersion}</div>
        <label className="dco-checkbox-row"><input type="checkbox" checked={!!confirmed[request.requestId]} onChange={event=>setConfirmed({...confirmed,[request.requestId]:event.target.checked})}/>我已核对验证码与自己的 Device 终端一致</label>
        <div className="dco-pair-actions"><button className="dco-button dco-primary" disabled={!confirmed[request.requestId]||busy===request.requestId||request.status!=='pending'} onClick={()=>void decide(request,true)}>允许此 Device</button><button className="dco-button" disabled={busy===request.requestId||request.status!=='pending'} onClick={()=>void decide(request,false)}>拒绝</button></div>
        <div className="dco-safety">只建立配对，不授予任何转发 Lease。不要批准不认识的请求。</div>
      </article>)}
    </section>
    <div className="dco-safety">连接状态仅表示 Companion 与 Host 的控制通道；Device 整机或浏览器在线不等于 Companion 已连接。</div>
    <div className="dco-device-list">{loading ? <div className="dco-empty-small">正在读取 Device…</div> : devices.length===0 ? <div className="dco-empty-small">此 Host 尚无配对的 Device。不同测试数据目录不共享配对；请运行统一命令校验或重新授权。</div> : devices.map(device=><article key={device.id} className={'dco-device-card'+(device.revokedAt?' dco-revoked':'')}>
      <div className="dco-device-title"><strong>{device.name}</strong><span className={'dco-chip '+(device.revokedAt?'dco-chip-muted':device.online?'dco-chip-green':'dco-chip-muted')}>{device.revokedAt?'已撤销':device.online?'控制通道在线':'Companion 未连接'}</span></div>
      <div className="dco-device-meta">macOS {device.osVersion} · {device.architecture} · CLI {device.companionVersion}</div>
      <div className="dco-device-meta">上次控制通道活动 {device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '尚未连接'}</div>
      <div className="dco-device-actions"><label><input type="radio" name="companion-preferred" disabled={!!device.revokedAt} checked={preferred===device.id} onChange={()=>choose(device.id)}/>默认使用此 Device</label><button className="dco-button" disabled={!!device.revokedAt} onClick={()=>void revoke(device)}>撤销</button></div>
      <details><summary>诊断信息</summary><dl><dt>Device ID</dt><dd><code>{device.id}</code></dd><dt>Capabilities</dt><dd>Local forward · protocol v{device.capabilities.protocolVersion}</dd></dl></details>
    </article>)}</div>
    <details><summary>当前 Host 身份</summary><p>Origin: <code>{window.location.origin}</code></p><p>Authority: <code>{authority||'读取中'}</code></p><p>普通重启保留身份和配对。不同 DSH_HOME 或重建测试数据是不同 Host，需要明确重新授权，不迁移旧 Lease。</p></details>
    {error && <div className="dco-error-banner">{error}</div>}
  </div>
}
