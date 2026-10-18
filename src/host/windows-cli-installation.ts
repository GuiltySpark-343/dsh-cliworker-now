import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { resolveNativeEntry } from './native-launch.mjs'

export class WindowsCliInstallationError extends Error {
  readonly code = 'CLI_INSTALLATION_UNAVAILABLE'
  constructor(
    message: string,
    readonly installed = false,
  ) {
    super(message)
    this.name = 'WindowsCliInstallationError'
  }
}

/** A completed desktop/PATH search found no CLI; absence is not a broken installation. */
export class WindowsCliNotFoundError extends WindowsCliInstallationError {
  constructor(cli: 'zcode' | 'opencode' | 'qoder') {
    super(`${cli === 'zcode' ? 'ZCode' : cli === 'qoder' ? 'Qoder' : 'OpenCode'} CLI 未找到，请配置 ${cli}Executable`)
    this.name = 'WindowsCliNotFoundError'
  }
}

type WindowsEnvironment = { home?: string; env?: NodeJS.ProcessEnv }
const unavailableCodex = () =>
  new WindowsCliInstallationError('Codex Windows 应用包入口无法确认，请检查安装', true)

function directory(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim() || fallback
  if (!isAbsolute(value)) throw new WindowsCliInstallationError('Windows CLI 安装目录配置无效')
  return value
}

/** Fixed installer locations only; never scan arbitrary drives or select a venv by recency. */
export function windowsCliCandidates(cli: 'codex' | 'hermes' | 'qoder', options: WindowsEnvironment = {}): string[] {
  const env = options.env ?? process.env,
    home = options.home ?? homedir()
  if (cli === 'codex' || cli === 'qoder') {
    const npm = join(directory(env, 'APPDATA', join(home, 'AppData', 'Roaming')), 'npm')
    return cli === 'codex' ? [join(npm, 'codex.cmd')] : [
      join(home, '.qoder', 'bin', 'qodercli', 'qodercli.exe'),
      join(npm, 'qodercli.cmd'),
      join(npm, 'qoder.cmd'),
    ]
  }
  const root = join(directory(env, 'LOCALAPPDATA', join(home, 'AppData', 'Local')), 'hermes')
  return [
    join(root, 'bin', 'hermes.exe'),
    join(root, 'bin', 'hermes.cmd'),
    join(root, 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
  ]
}

/** A residue is not a runnable installation and is not evidence of an account. */
export function hasWindowsHermesInstallDirectory(options: WindowsEnvironment = {}): boolean {
  const env = options.env ?? process.env,
    home = options.home ?? homedir()
  return existsSync(join(directory(env, 'LOCALAPPDATA', join(home, 'AppData', 'Local')), 'hermes'))
}

function nativePe(path: string): string {
  const canonical = realpathSync(path),
    fd = openSync(canonical, 'r')
  try {
    const info = fstatSync(fd),
      head = Buffer.alloc(64),
      signature = Buffer.alloc(4)
    if (!info.isFile() || readSync(fd, head, 0, 64, 0) !== 64 || head.toString('ascii', 0, 2) !== 'MZ')
      throw new Error('Not a native PE file')
    const offset = head.readUInt32LE(0x3c)
    if (
      offset < 64 ||
      offset + 4 > info.size ||
      readSync(fd, signature, 0, 4, offset) !== 4 ||
      signature.toString('hex') !== '50450000'
    )
      throw new Error('Invalid PE signature')
    return canonical
  } finally {
    closeSync(fd)
  }
}

/** Validate an automatically discovered npm shim against Codex's own package, not just its name. */
export function validateWindowsCodexNpmEntry(path: string): string {
  return validateWindowsNpmEntry(path, '@openai/codex', 'codex', 'Codex')
}

/** Qoder's qoder alias is a dispatcher; prefer the package's actual qodercli bin. */
export function validateWindowsQoderNpmEntry(path: string): string {
  try {
    const command = basename(path).toLowerCase().replace(/\.cmd$/, '')
    if (!['qodercli', 'qoder'].includes(command)) throw new Error('Unexpected command')
    validateWindowsNpmEntry(path, '@qoder-ai/qodercli', command, 'Qoder')
    return windowsQoderPackageCli(resolveNativeEntry(path, 'win32'))
  } catch {
    throw new WindowsCliInstallationError('Qoder npm 安装入口无法确认，请检查安装', true)
  }
}

function windowsQoderPackageCli(executable: string): string {
  const entry = realpathSync(executable)
  for (let root = dirname(entry), depth = 0; depth < 5; depth++, root = dirname(root)) {
    const manifest = join(root, 'package.json')
    if (!existsSync(manifest)) continue
    if (statSync(manifest).size > 128 * 1024) throw new Error('Oversized package metadata')
    const data = JSON.parse(readFileSync(manifest, 'utf8'))
    if (data.name !== '@qoder-ai/qodercli') throw new Error('Foreign package')
    const bins = typeof data.bin === 'string' ? { qodercli: data.bin } : data.bin
    const binEntry = (bin: unknown) => {
      if (typeof bin !== 'string' || isAbsolute(bin) || win32.isAbsolute(bin) || bin.split(/[\\/]/).includes('..'))
        throw new Error('Invalid package bin')
      const path = realpathSync(resolve(root, bin)), inside = relative(root, path)
      if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep) || !statSync(path).isFile())
        throw new Error('Redirected package bin')
      return path
    }
    if (![bins?.qodercli, bins?.qoder].filter(value => value !== undefined).some(bin => binEntry(bin) === entry))
      throw new Error('Undeclared package entry')
    const cli = binEntry(bins?.qodercli ?? bins?.qoder)
    if (!/\.[cm]?js$/i.test(cli) || basename(cli).toLowerCase() === 'qoder-npm-dispatcher.cjs')
      throw new Error('No standalone package CLI')
    return cli
  }
  throw new Error('No package identity')
}

/** Automatic hints must identify the standalone CLI, never an IDE or dispatcher. */
export function windowsQoderCliEntry(executable: string): string {
  try {
    // The official entry symlink resolves to qodercli-<installed version>.exe.
    // Accept only that observed target; never enumerate or choose a version.
    const nativeName = (path: string) => /^qodercli(?:-\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)?\.exe$/i.test(basename(path))
    if (nativeName(executable)) {
      const entry = nativePe(executable)
      if (!nativeName(entry)) throw new Error('Redirected native entry')
      return entry
    }
    if (/\.cmd$/i.test(executable)) return validateWindowsQoderNpmEntry(executable)
    if (/\.[cm]?js$/i.test(executable)) return windowsQoderPackageCli(executable)
    throw new Error('Not a standalone Qoder CLI')
  } catch {
    throw new WindowsCliInstallationError('Qoder Windows 安装入口无法确认，请配置 qoderExecutable', true)
  }
}

function validateWindowsNpmEntry(path: string, packageName: string, command: string, label: string): string {
  try {
    const root = join(dirname(path), 'node_modules', ...packageName.split('/'))
    const manifestPath = join(root, 'package.json')
    if (statSync(manifestPath).size > 128 * 1024) throw new Error('Oversized package metadata')
    const data = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const bin = typeof data.bin === 'string' ? data.bin : data.bin?.[command]
    if (
      data.name !== packageName ||
      typeof bin !== 'string' ||
      isAbsolute(bin) || win32.isAbsolute(bin) ||
      bin.split(/[\\/]/).includes('..')
    )
      throw new Error('Mismatched package identity')
    const entry = resolveNativeEntry(path, 'win32')
    if (realpathSync(entry) !== realpathSync(resolve(root, bin))) throw new Error('Mismatched package entry')
    return path
  } catch {
    throw new WindowsCliInstallationError(`${label} npm 安装入口无法确认，请检查安装`, true)
  }
}

export function presentWindowsCliCandidate(
  cli: 'codex' | 'hermes' | 'qoder',
  options: WindowsEnvironment = {},
): string | undefined {
  for (const path of windowsCliCandidates(cli, options)) {
    try {
      lstatSync(path)
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
      throw new WindowsCliInstallationError('Windows CLI 安装入口无法读取，请检查安装', true)
    }
    if (cli === 'codex') return validateWindowsCodexNpmEntry(path)
    if (cli === 'qoder') {
      if (/\.cmd$/i.test(path)) return validateWindowsQoderNpmEntry(path)
      try { nativePe(path); return path } catch {
        throw new WindowsCliInstallationError('Qoder Windows 安装入口无法确认，请检查安装', true)
      }
    }
    try {
      const entry = resolveNativeEntry(path, 'win32')
      if (/\.exe$/i.test(entry)) nativePe(entry)
      else if (entry !== path || !/\.cmd$/i.test(entry)) throw new Error('Unsupported Hermes entry')
      // Fixed Python cmd launchers are statically checked by resolveNativeEntry;
      // the existing Hermes verifier preserves the installer's own interpreter.
      return path
    } catch {
      throw new WindowsCliInstallationError('Hermes Windows 安装入口无法确认，请检查安装', true)
    }
  }
  return undefined
}

const codexFamily = 'OpenAI.Codex_2p2nqsd0c76g0'
const codexPublisher = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B'

/** Query current-user registered packages, never guess the newest WindowsApps directory. */
export const CODEX_APPX_QUERY = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=@(Get-AppxPackage -Name 'OpenAI.Codex'); if($p.Count -eq 0){'null';exit 0}; if($p.Count -ne 1){throw 'Ambiguous Codex package'}; $v=$p[0]; [ordered]@{name=$v.Name;family=$v.PackageFamilyName;fullName=$v.PackageFullName;publisher=$v.Publisher;signature=[string]$v.SignatureKind;status=[string]$v.Status;location=$v.InstallLocation}|ConvertTo-Json -Compress`

export interface CodexAppxRecord {
  name: string
  family: string
  fullName: string
  publisher: string
  signature: string
  status: string
  location: string
}

/** Exported separately for synthetic identity/relocation tests; no process or account access. */
export function codexAppxExecutable(
  raw: string,
  validateFile: (path: string) => string = nativePe,
): string | undefined {
  try {
    const value: unknown = JSON.parse(raw.trim())
    if (value === null) return undefined
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid package record')
    const p = value as CodexAppxRecord
    if (
      p.name !== 'OpenAI.Codex' ||
      p.family !== codexFamily ||
      p.publisher !== codexPublisher ||
      p.signature !== 'Store' ||
      p.status !== 'Ok' ||
      typeof p.fullName !== 'string' ||
      !/^OpenAI\.Codex_\d+(?:\.\d+){3}_(?:x64|arm64|x86)__2p2nqsd0c76g0$/.test(p.fullName) ||
      typeof p.location !== 'string' ||
      !win32.isAbsolute(p.location) ||
      p.location.includes('\0') ||
      p.location.startsWith('\\\\') ||
      win32.basename(p.location).toLowerCase() !== p.fullName.toLowerCase()
    )
      throw new Error('Unverified package identity')
    const candidate = win32.join(p.location, 'app', 'resources', 'codex.exe')
    const canonical = validateFile(candidate)
    // A registered package's CLI must stay in that package; never follow a swapped link elsewhere.
    if (win32.normalize(canonical).toLowerCase() !== win32.normalize(candidate).toLowerCase())
      throw new Error('Redirected package entry')
    return canonical
  } catch {
    throw unavailableCodex()
  }
}

export async function findWindowsCodexAppx(
  capture: (argv: string[], cwd: string) => Promise<string>,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  signal.throwIfAborted()
  const windows = env.SystemRoot || env.WINDIR || 'C:\\Windows'
  if (!win32.isAbsolute(windows)) throw new WindowsCliInstallationError('Windows 系统目录配置无效')
  const command = win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(CODEX_APPX_QUERY, 'utf16le').toString('base64')
  const raw = await capture(
    [command, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    homedir(),
  )
  signal.throwIfAborted()
  return codexAppxExecutable(raw)
}
