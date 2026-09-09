# 原生 SSH 配置与独立转发所有权

状态：已采用。

## 问题

解析 ssh -G 并重建白名单配置会丢失用户的认证和连接语义。识别个别 Kerberos shell 模板不能兼容其他用户的代理、跳板或认证工具。

## 决定

系统 OpenSSH 是可信本机 SSH 配置的唯一解释器。Companion 只接受人类本地选择的 alias，不接受 Host 下发的 SSH 配置或命令。删除配置解析器和所有认证模板适配。

每个 Forward Instance 使用独立 master、私有 ControlPath 和进程组。主连接清除配置里的转发；认证后通过无用户配置的 mux 请求添加唯一获准的同端口 loopback listener。成功必须同时满足 control socket、master PID 和 listener 所有权校验。

后台角色仍无交互 TTY、远程命令、LocalCommand、Agent/X11/TUN 转发，主连接严格校验 Host Key。连接与认证配置中的脚本由 SSH 正常执行，具有与用户手动执行它们相同的本地代码信任与副作用。

## 生命周期边界

只在当前创建的 master 仍存活时按其独立进程组发信号。恢复不按已保存的 PID/PGID 强杀，而是验证私有 control socket 后请求退出。V2 所有权记录允许关闭认证已完成但 listener 尚未创建的连接。

这不是任意本机脚本的沙箱：主动 daemonize、脱离进程组或操作外部服务的自定义脚本不在保证清理范围内；无法验证的残留保留证据并失败关闭。

## 验证

Linux 隔离 sshd 测试覆盖真实 ProxyCommand、ProxyJump、配置转发隔离、端口冲突与正常代理后代回收。契约测试覆盖拒绝伪造所有权、取消、mux 失败、超时和恢复。Linux listener 验证不等同于真实 Mac 数据路径验收。
