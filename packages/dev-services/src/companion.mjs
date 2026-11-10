/** Adapt only declaration operations; deliberately no Device or Lease API access. */
export function companionAdapter(capability) {
  const input = (namespace, record) => ({
    owner: { provider: 'dsh-dev-services', namespace, id: record.id },
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
    ...(record.workspacePath ? { workspacePath: record.workspacePath } : {}),
    name: record.name, port: record.port, protocol: record.protocol,
    evidence: `Managed development service ${record.id}; expected 127.0.0.1:${record.port}`,
  })
  const call = async (operation, namespace, record) => {
    if (capability.version !== 1) throw new Error('Unsupported Companion managed declaration interface')
    const result = await capability[operation](input(namespace, record))
    return { state: operation === 'retire' ? 'retired' : result.archivedAt ? 'detached' : 'synced', id: result.id }
  }
  return {
    ensure: (namespace, record) => call('ensure', namespace, record),
    retire: (namespace, record) => call('retire', namespace, record),
  }
}
