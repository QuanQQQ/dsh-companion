import { useEffect, useMemo, useState } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createPairingTicket, listDevices, revokeDevice, type DeviceDto } from './api.js'

function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'" }

export function DeviceSettings({ close }: SettingsSectionOwnerProps) {
  const [devices, setDevices] = useState<DeviceDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [ticket, setTicket] = useState<{ code: string; expiresAt: string }>()
  const [sshAlias, setSshAlias] = useState('YOUR_SSH_ALIAS')
  const [copied, setCopied] = useState(false)
  const [serverOrigin, setServerOrigin] = useState(() => window.location.origin)
  const [allowHttp, setAllowHttp] = useState(false)
  const [preferred, setPreferred] = useState(() => window.localStorage.getItem('dsh-companion.preferred-device') ?? '')

  const reload = async () => {
    try { setDevices(await listDevices()); setError('') }
    catch (caught) { setError((caught as Error).message) }
    finally { setLoading(false) }
  }
  useEffect(() => {
    void reload()
    const timer = window.setInterval(() => void reload(), 3_000)
    return () => window.clearInterval(timer)
  }, [])

  const command = useMemo(() => ticket ? [
    'node "$HOME/Downloads/dsh-companion.mjs" setup',
    '--server ' + shellQuote(serverOrigin),
    '--ssh-host ' + shellQuote(sshAlias),
    ...(allowHttp ? ['--allow-insecure-http'] : []),
  ].join(' ') : '', [sshAlias, ticket, serverOrigin, allowHttp])

  const createTicket = async () => {
    try { setTicket(await createPairingTicket()); setError('') }
    catch (caught) { setError((caught as Error).message) }
  }
  const copyCommand = async () => {
    await navigator.clipboard.writeText(command)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }
  const setPreferredDevice = (deviceId: string) => {
    window.localStorage.setItem('dsh-companion.preferred-device', deviceId)
    setPreferred(deviceId)
  }
  const revoke = async (device: DeviceDto) => {
    if (!window.confirm(`撤销 ${device.name} 的 Pairing？该 Device 的全部 Open Lease 将被关闭。`)) return
    try { await revokeDevice(device.id); await reload() }
    catch (caught) { setError((caught as Error).message) }
  }

  return <div className="dco-settings" data-dsh-companion-settings>
    <div className="dco-settings-head"><div><span className="dco-eyebrow">DSH COMPANION</span><h3>Devices</h3><p>Pairing 是可撤销的长期信任；在线状态不是 Pairing。</p></div><button className="dco-icon-button" onClick={close} aria-label="关闭">×</button></div>
    <section className="dco-settings-section">
      <div className="dco-settings-section-head"><div><strong>已配对 Devices</strong><small>Preferred Device 只影响 UI 默认选择，不授权、不迁移、不故障转移。</small></div><button className="dco-button dco-primary" onClick={() => void createTicket()}>＋ 配对 Device</button></div>
      {loading && <div className="dco-center">正在加载 Devices…</div>}
      {!loading && devices.filter(item => !item.revokedAt).length === 0 && <div className="dco-empty compact"><strong>尚无已配对 Device</strong><span>下载本次固定 CLI，在 Mac Terminal 执行 setup 并输入一次性码，安装、配对并启用 LaunchAgent。</span></div>}
      <div className="dco-device-list">{devices.filter(item => !item.revokedAt).map(device => <article className="dco-device-card" key={device.id}>
        <span className="dco-device-glyph">⌘</span><div className="dco-device-main"><div><strong>{device.name}</strong><span className={device.online ? 'online' : ''}><i />{device.online ? '在线' : '离线'}</span>{preferred === device.id && <em>Preferred</em>}</div><small>macOS {device.osVersion} · {device.architecture} · Companion {device.companionVersion}</small></div>
        <div className="dco-device-actions"><button className="dco-button" disabled={preferred === device.id} onClick={() => setPreferredDevice(device.id)}>设为默认</button><button className="dco-button danger" onClick={() => void revoke(device)}>撤销</button></div>
        <details><summary>诊断信息</summary><div><code>{device.id}</code><span>最后心跳：{device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '尚未连接'}</span><span>TCP probe：{device.capabilities.tcpProbe ? '支持' : '关闭'}</span><span>协议版本：{device.capabilities.protocolVersion}</span></div></details>
      </article>)}</div>
    </section>

    {ticket && <section className="dco-pairing">
      <div><span className="dco-eyebrow">ONE-COMMAND SETUP</span><h4>在目标 Mac 的 Terminal 运行</h4><p>配对码单次有效，{new Date(ticket.expiresAt).toLocaleTimeString()} 到期。SSH alias 只留在 Mac，不会发送给 Host。</p></div>
      <label>本机 SSH alias<input value={sshAlias} onChange={event => setSshAlias(event.target.value)} spellCheck={false}/></label>
      <label>Mac 可访问的 DSH 地址<input value={serverOrigin} onChange={event => setServerOrigin(event.target.value)} spellCheck={false}/></label>
      <label><input type="checkbox" checked={allowHttp} onChange={event => setAllowHttp(event.target.checked)}/>允许明文 HTTP（仅限可信测试网络；配对凭证将不受 TLS 保护）</label>
      <p>需要 Mac 已安装 Node.js 22+。先<a href="/api/companion/downloads/cli.mjs" download="dsh-companion.mjs">下载此版本 CLI</a>到 Downloads，再运行命令。不要使用尚未发布的 npm 包。</p>
      <pre><code>{command}</code></pre>
      <p>终端提示时输入一次性配对码（不进入命令行参数）：<code>{ticket.code}</code></p>
      <div className="dco-pair-actions"><button className="dco-button dco-primary" onClick={() => void copyCommand()}>{copied ? '已复制' : '复制一键命令'}</button><button className="dco-button" onClick={() => void createTicket()}>重新生成</button></div>
      <div className="dco-safety">setup 会把固定 CLI bundle 复制到 <code>~/Library/Application Support/DSH Companion/</code>，把 token 存入 macOS Keychain，并安装用户 LaunchAgent。不会修改 Bifrost 或系统代理。</div>
    </section>}
    {error && <div className="dco-error-banner">{error}</div>}
  </div>
}
