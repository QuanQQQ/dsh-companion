# 技术设计

## 调研依据

Companion main 的 `packages/plugin/src/index.ts` 注入 webRuntime；`http-route.ts` 仅用 requestRejection 判断管理权限；`service.ts` 单一 serial transaction 与 store 负责持久状态。`domain.ts` Lease TTL 最大 7 天，managedOwner 已存在。`closure.ts` 区分同代关闭观测。`packages/cli/src/controller.ts` SSH成功后 probe 为 disabled。

参考 dev-services 的 manager/store/systemd/runner/health 保留固定 unit 所有权及 cgroup 生命周期；旧工具 resolveTask 使用 Task Workspace HTTP API，需移除。现有 SQLite user_version=1 保存 Task ID，归属不可直接改写。

rc.5 精确安装包作为只读接口和构建参考；原生 sidebar 参照 Browser Fleet 的 sidebarRightTabs.register 与 sidebar.right.pane.tab slot 公开契约。owner-browser auth 与 session/Workspace 服务从 rc.5 类型和实现核对，不猜 webApp.trustedHosts。

## 模块与调用链

1. `packages/dev-services`：持久 store、scope 校验、Linux manager/backend、bounded tools，并在 Host 暴露同一 manager 的服务 facade。schema迁移保存旧 Task 归属为 unclaimed，不伪造 Workspace。
2. Companion Host：rc.5 trust fence、owner-browser管理认证、单一 CompanionService、declaration-only managed capability，及独立 explicit launch capability。两项 capability 分离防止声明自动升级为 Lease 权限。
3. 组合 launch：先经调用者 Workspace 和当前 sandboxPolicy 允许 Linux启动；未 ready 返回 starting，不开新 Lease。managed ensure 后查明确选择/保存的 Device；首次有显式TTL授权才保存偏好。等待最多有限时长，失败/超时保留有效 Lease，不停应用、不续期。
4. Mac CLI：保持协议 v1兼容，在 verified owned listener 上主动 TCP connect。旧 CLI probe disabled 显示“需升级以验证”，不能返回 ready。周期 fresh probe 与 generation/session fence 共同限制状态。
5. 原生 client：一个 Local Services panel显示 Linux和Companion状态。现有 Companion Devices页面保留。纯状态派生测试覆盖空、离线、陈旧、generation错位、失败和关闭待确认。

## 状态语义

| 层 | 可证明事实 | 不可代替 |
| --- | --- | --- |
| Linux runtime | 自有 unit/process 正在运行 | listener、业务健康 |
| Linux health ready | cgroup拥有IPv4可达listener且TCP主动连接成功 | 编译完成、HTTP业务健康 |
| Forward desired open | 明确授权仍有效 | Mac online/可访问 |
| Mac observed running | 同代SSH和listener观测 | TCP数据路径、观测新鲜性 |
| Combined ready | Linux ready、Device online、同代新鲜SSH/listener/probe | 应用业务健康 |
| Desired closed | 授权撤销 | 实际SSH已退出 |
| Close confirmed | 同代closed/exited/missing | 另一个generation状态 |

## 安全与失败边界

owner浏览器认证和Agent scope分别执行；API Peer不获得human approval。UI不接受Agent伪造owner标志。服务跨Workspace修改必须在真实owner浏览器的显式操作中完成。缺失公开契约时返回503。所有未知旧归属标为unclaimed，Agent不能认领；owner claim要求canonical workdir包含关系和注册Workspace一致。

长启动等待超时/Host卸载不停止自有持久unit；真实unsafe ownership/failed仍明确报告。stop/remove仅验证自有unit，不杀端口占用者。remove保留pending退役及端口tombstone；同步不得复活人工retire。

## 验证边界

只执行源码typecheck/build、unit与isolated fixture测试。PDM隔离GUI及真实Mac均不执行。测试结果、skip及限制按test-cases写入acceptance-report，不沿用旧VERIFICATION成功结论。
