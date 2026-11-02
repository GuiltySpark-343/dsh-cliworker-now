import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type LogsDirectoryMode = 'project' | 'global'

/**
 * Large, append-only run logs (timeline and native streams) belong to the project
 * they describe: a project on another drive must not fill the system disk, and the
 * history travels with the checkout. Worker metadata, presets, bindings, markers
 * and backups stay in the global state directory because they are session-scoped
 * or shared across projects.
 */
export function projectLogDirectory(project: string): string {
  return join(project, '.dsh', 'cliworker-now', 'logs')
}

export class StateLayout {
  private readonly directories = new Map<string, string>()
  private readonly adopted = new Set<string>()

  constructor(
    private readonly globalDirectory: string,
    private readonly mode: LogsDirectoryMode = 'project',
    private readonly onFallback?: (project: string, error: unknown) => void,
  ) {}

  /** The directory a project's logs actually use; falls back to the global one. */
  directoryFor(project: string): string {
    if (this.mode === 'global') return this.globalDirectory
    const cached = this.directories.get(project)
    if (cached) return cached
    try {
      const directory = projectLogDirectory(project)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      // A per-project state directory must never appear in the project's git status.
      const ignore = join(project, '.dsh', '.gitignore')
      if (!existsSync(ignore)) writeFileSync(ignore, '*\n', { mode: 0o600 })
      this.directories.set(project, directory)
      return directory
    } catch (error) {
      this.onFallback?.(project, error)
      this.directories.set(project, this.globalDirectory)
      return this.globalDirectory
    }
  }

  /** Writes land in the active directory; reads prefer it and fall back to the legacy one. */
  pathFor(project: string, name: string, read = false): string {
    const current = join(this.directoryFor(project), name)
    if (!read || current === this.globalDirectory) return current
    if (existsSync(current)) return current
    const legacy = join(this.globalDirectory, name)
    return existsSync(legacy) ? legacy : current
  }

  /** Move a legacy append-only file under the project before the first append. */
  adopt(project: string, name: string): void {
    const target = this.pathFor(project, name, false)
    const marker = `${target}\u0000${name}`
    if (this.adopted.has(marker) || target === join(this.globalDirectory, name)) return
    this.adopted.add(marker)
    const legacy = join(this.globalDirectory, name)
    if (!existsSync(legacy) || existsSync(target)) return
    try {
      renameSync(legacy, target)
    } catch {
      try {
        copyFileSync(legacy, target)
        unlinkSync(legacy)
      } catch {
        /* Keep reading the legacy file; new appends continue in the project copy. */
        try {
          writeFileSync(target, '', { mode: 0o600, flag: 'a' })
        } catch {
          /* Fall back entirely to the global directory on the next path lookup. */
        }
      }
    }
  }
}
