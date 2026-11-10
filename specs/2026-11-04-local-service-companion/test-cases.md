# 验收用例

Review：依据用户已确认范围由实现者准备，提供leader review入口；普通源码/单测自主执行。真实GUI/Mac条件未具备。

| Case | 验证目标与前置 | 操作 | 可观察预期 |
| --- | --- | --- | --- |
| AUTH-1 | rc.5公开trust/auth fake | owner-browser、匿名、signed API Peer、cross-site请求管理/approve | 仅真实owner-browser可授信，其他拒绝；缺失能力503 |
| SCOPE-1 | registered普通Workspace + 两个session | same/cross/unbound/symlink cwd和伪造Workspace参数 | Agent仅真实同Workspace可修改；全局安全列表不泄密 |
| MIG-1 | 临时SQLite v1 | 迁移、重复加载、损坏/未知版本 | 备份验证，旧Task记录unclaimed，原权限不编造，错误保留原数据 |
| MANAGED-1 | 单一CompanionService memory store | ensure重复、人工端口冲突、retire先行、迟到ensure | 幂等、不接管、不复活，不创建Lease/配对 |
| LINUX-1 | fake owned backend + 自有临时HTTP/TCP进程 | start、status、stop、restart、remove、logs | 分层state，精确自有清理，日志有界，command/env不在snapshot |
| LINUX-2 | 慢编译/延迟listener、自有临时进程 | startup等待超时和卸载 | starting/not_ready且进程仍活、可继续日志/status |
| LINUX-3 | owned/unknown/wildcard listeners | ownership+主动connect失败/成功 | 未归属不ready不杀，owned wildcard警告，业务health unknown |
| MAC-1 | mocked SSH及本地TCP/SSH fixture | probe成功/失败、旧CLI disabled | 实际connect才probe healthy，disabled不报Mac可用 |
| CLOSE-1 | lease/current observation | desired closed、旧代、SSH未退出、listener残留 | 只同代closed/exited/missing为确认 |
| LAUNCH-1 | fake设备、controlled clock | 无配置、首次未选、显式TTL、保存偏好、撤销/离线、多设备 | 不隐式挑选/切换；各阶段独立返回 |
| LAUNCH-2 | controlled generation/clock | stale、wrong generation、pending、error、ready | 同代新鲜online观测才ready；等待超时不撤销/续期/停服务 |
| UI-1 | 纯view model及组件契约测试 | 空/加载/error/跨Workspace/日志设置状态 | 原生slot正确，紧凑卡片字段和动作准确，无重复配对 |
| BUILD-1 | 精确0.2.1-rc.5依赖 | pnpm typecheck/test/build | 真实命令成功，无旧webRuntime/BetterSidebar依赖 |
| WEB-1 | PDM工具与隔离GUI | 实际浏览器交互保存回读 | 后续未验证；不能用mock作通过证据 |
| MAC-REAL-1 | 两设备实际Mac | launchd/Keychain/休眠/断网/端口数据路径 | 后续未验证；Linuxfixture不能替代 |

| OPERATOR-1 | owner-only真实HTTP与私有proof | review后确认digest，伪造proof、配置变化、撤销登录和restart双次校验 | 仅同一请求/操作/服务配置通过；完成后proof失效，命令不进入snapshot |
| HOST-1 | 实际Cordis4.0.5服务注册 | provide managed与operator能力并卸载 | 无ctx.set未注册服务异常，卸载回收能力 |
| MANAGED-AGENT-1 | 两Workspace和managed declaration | 旧Agent工具尝试注销或改动他项目转发 | 不绕过scoped dev-services边界；手工声明旧语义保留 |
| INSTALL-1 | 既有3090及临时自有业务服务 | 官方plugin manager安装，原生侧栏create/review/start/logs/stop/remove，刷新与重启 | 真正回读相同记录，其他插件和旧3080正常 |
| RETAIN-1 | 正式Git库与安装包 | 提交/合入并独立保存Git库后清理临时worktree | 可定位正式源码commit，已安装插件从包加载 |
