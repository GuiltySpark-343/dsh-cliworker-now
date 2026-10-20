import { lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, sep, win32 } from 'node:path'

export interface WindowsPathOptions { home?: string; env?: NodeJS.ProcessEnv }

/** Common installer bins only. No recursive search, arbitrary drive scan, or version selection. */
export function windowsCommonBinDirectories(options: WindowsPathOptions = {}): string[] {
  const env = options.env ?? process.env, home = options.home ?? homedir()
  const root = (key: string, fallback: string) => {
    const value = env[key]?.trim() || fallback
    if (!isAbsolute(value) && !win32.isAbsolute(value)) throw new Error('Windows CLI 安装目录配置无效')
    return value
  }
  return [join(home, '.local', 'bin'), join(root('APPDATA', join(home, 'AppData', 'Roaming')), 'npm'),
    join(home, '.bun', 'bin'), join(home, 'scoop', 'shims'),
    root('PNPM_HOME', join(root('LOCALAPPDATA', join(home, 'AppData', 'Local')), 'pnpm'))]
}

export function windowsCommandCandidates(commands: readonly string[], directories: readonly string[],
  env: NodeJS.ProcessEnv = process.env): string[] {
  if (commands.some(command => !/^[a-z0-9_-]+$/i.test(command))) throw new Error('Windows CLI 命令名称无效')
  const extensions = [...new Set((env.PATHEXT || '.EXE;.COM;.CMD;.BAT').split(';')
    .map(extension => extension.toLowerCase()).filter(extension => /^\.(exe|com|cmd|bat)$/.test(extension)))]
  return commands.flatMap(command => directories.flatMap(directory => extensions.map(extension => join(directory, command + extension))))
}

/** PATH cannot admit current-directory, relative, UNC, unresolved-variable, or shell-script lookups. */
export function windowsPathDirectories(paths: readonly string[]): string[] {
  const result = new Map<string, string>()
  for (const value of paths) {
    if (typeof value !== 'string' || value.length > 65_536) throw new Error('Windows PATH 探测结果无效')
    for (const raw of value.split(';')) {
      const directory = raw.trim().replace(/^"(.*)"$/, '$1')
      // POSIX absolute paths exist only for host-side synthetic filesystem tests.
      const absolute = /^[a-z]:[\\/]/i.test(directory) || (sep === '/' && isAbsolute(directory))
      if (!directory || directory.includes('\0') || directory.includes('%') || /^[\\/]{2}/.test(directory) ||
        !absolute) continue
      const key = directory.replace(/[\\/]+$/, '').toLowerCase()
      if (!result.has(key)) result.set(key, directory)
      if (result.size > 256) throw new Error('Windows PATH 探测结果过大')
    }
  }
  return [...result.values()]
}

/** A broken present entry is authoritative; only absent files may fall through. */
export function firstPresentWindowsPath(candidates: readonly string[]): string | undefined {
  for (const entry of candidates) {
    try { lstatSync(entry); return entry } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  return undefined
}

export const WINDOWS_PATH_QUERY = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $u=[Environment]::GetEnvironmentVariable('Path','User'); $m=[Environment]::GetEnvironmentVariable('Path','Machine'); [ordered]@{user=$(if($null -eq $u){''}else{[Environment]::ExpandEnvironmentVariables($u)});machine=$(if($null -eq $m){''}else{[Environment]::ExpandEnvironmentVariables($m)})}|ConvertTo-Json -Compress`

/** Read latest user/machine PATH after inherited PATH misses. The caller owns capture cleanup and cancellation. */
export async function findWindowsPathCommand(commands: readonly string[],
  capture: (argv: string[], cwd: string) => Promise<string>, signal: AbortSignal,
  options: WindowsPathOptions = {}): Promise<string | undefined> {
  signal.throwIfAborted()
  const env = options.env ?? process.env, system = env.SystemRoot || env.WINDIR || 'C:\\Windows'
  if (!/^[a-z]:[\\/]/i.test(system) || system.includes('\0')) throw new Error('Windows 系统目录配置无效')
  const raw = await capture([win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_PATH_QUERY, 'utf16le').toString('base64')], options.home ?? homedir())
  signal.throwIfAborted()
  if (raw.length > 131_072) throw new Error('Windows PATH 探测结果过大')
  const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, '').trim())
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => key !== 'user' && key !== 'machine')) throw new Error('Windows PATH 探测结果无效')
  const record = value as { user?: unknown; machine?: unknown }
  if (typeof record.user !== 'string' && record.user !== null || typeof record.machine !== 'string' && record.machine !== null)
    throw new Error('Windows PATH 探测结果无效')
  const directories = windowsPathDirectories([env.PATH ?? env.Path ?? '', record.user ?? '', record.machine ?? ''])
  return firstPresentWindowsPath(windowsCommandCandidates(commands, directories, env))
}
