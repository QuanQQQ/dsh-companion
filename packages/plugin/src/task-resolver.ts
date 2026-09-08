import { isAbsolute, relative, resolve, sep } from 'node:path'
import { CompanionError } from './domain.js'

export interface TaskWorkspaceTaskRef {
  id: string
  status: string
  workspacePath: string
}

export interface TaskWorkspaceResolver {
  list(): Promise<TaskWorkspaceTaskRef[]>
  resolveFromCwd(cwd: string): Promise<TaskWorkspaceTaskRef | undefined>
}

export function createTaskWorkspaceResolver(webPort: number): TaskWorkspaceResolver {
  const endpoint = `http://127.0.0.1:${webPort}/api/task-workspace/tasks`
  return {
    async list() {
      const response = await fetch(endpoint, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) {
        throw new CompanionError('NOT_FOUND', 'Task Workspace public API is unavailable', 503)
      }
      const payload: unknown = await response.json()
      if (!payload || typeof payload !== 'object') throw new CompanionError('VALIDATION_ERROR', 'Task Workspace response is invalid')
      const tasks = (payload as Record<string, unknown>).tasks
      if (!Array.isArray(tasks)) throw new CompanionError('VALIDATION_ERROR', 'Task Workspace response has no tasks array')
      return tasks.map(parseTaskRef)
    },
    async resolveFromCwd(cwd) {
      return resolveTaskByWorkspacePath(await this.list(), cwd)
    },
  }
}

export function resolveTaskByWorkspacePath(
  tasks: readonly TaskWorkspaceTaskRef[],
  cwd: string,
): TaskWorkspaceTaskRef | undefined {
  const absoluteCwd = resolve(cwd)
  const matches = tasks.filter(task => containsPath(resolve(task.workspacePath), absoluteCwd))
  matches.sort((left, right) => resolve(right.workspacePath).length - resolve(left.workspacePath).length)
  return matches[0]
}

function parseTaskRef(value: unknown): TaskWorkspaceTaskRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CompanionError('VALIDATION_ERROR', 'Task Workspace task row is invalid')
  }
  const record = value as Record<string, unknown>
  const id = requireString(record.id, 'task.id')
  const status = requireString(record.status, 'task.status')
  if (!['active', 'waiting', 'completed', 'archived'].includes(status)) throw new CompanionError('VALIDATION_ERROR', 'Task status is invalid')
  const workspacePath = requireString(record.workspacePath ?? record.workspace_path, 'task.workspacePath')
  if (!isAbsolute(workspacePath)) throw new CompanionError('VALIDATION_ERROR', 'Task workspace path must be absolute')
  return { id, status, workspacePath }
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new CompanionError('VALIDATION_ERROR', `${field} is invalid`)
  return value
}
