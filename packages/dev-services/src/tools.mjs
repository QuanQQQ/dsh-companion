const definitions = [
  ['create', '定义开发服务', 'Declare a service in the immutable original project Workspace. Does not start it or grant Device forwarding.'],
  ['list', '列出开发服务', 'List development services owned by the current original project Workspace.'],
  ['status', '查看开发服务', 'Inspect a current project service without starting it.'],
  ['start', '启动开发服务', 'Start an owned independent systemd user unit. Await an owned listener and active loopback TCP connect. Timeout or cancellation returns persisted not_ready; it does not stop the process. Requires current danger-full-access policy.'],
  ['stop', '停止开发服务', 'Explicitly stop only the signed owned unit process tree, preserving definition, port and forwarding permission.'],
  ['restart', '重启开发服务', 'Explicitly stop and restart the current project service. Requires danger-full-access; interrupts application requests.'],
  ['logs', '读取开发服务日志', 'Read bounded current project service journal output (1–500 lines, 64 KiB).'],
  ['remove', '删除开发服务', 'Stop and retire a current project service and its optional managed declaration. Check removalComplete; its port remains reserved.'],
  ['synchronize', '同步开发服务声明', 'Retry declaration-only synchronization. Does not create a Lease or recreate a manually retired declaration.'],
]
const createProperties = {
  name: { type: 'string' }, executable: { type: 'string', description: 'Absolute executable; no implicit shell.' },
  args: { type: 'array', items: { type: 'string' }, description: 'Literal argument vector.' },
  workdir: { type: 'string', description: 'Absolute directory inside immutable original project and sandbox root.' },
  port: { type: 'integer', minimum: 1024, maximum: 65535 },
  protocol: { type: 'string', enum: ['http', 'https', 'tcp'] },
}

/** rc.5 ToolDefinition canonical output and presentation; no owner/claim model tool. */
export function createTools({ facade }) {
  return definitions.map(([operation, title, description]) => {
    const properties = operation === 'create' ? createProperties : operation === 'list' ? {} : {
      service_id: { type: 'string', description: 'Stable service ID.' },
      ...(operation === 'logs' ? { lines: { type: 'integer', minimum: 1, maximum: 500 } } : {}),
    }
    return {
      name: `dev_service_${operation}`, description,
      parameters: { type: 'object', properties, required: operation === 'create' ? Object.keys(createProperties) : operation === 'list' ? [] : ['service_id'], additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      presentCall: () => ({ card: 'generic', title, kind: ['list', 'status', 'logs'].includes(operation) ? 'read' : 'execute' }),
      async execute(args, exec) {
        const value = await facade.agent(operation, args, exec)
        return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      },
    }
  })
}
