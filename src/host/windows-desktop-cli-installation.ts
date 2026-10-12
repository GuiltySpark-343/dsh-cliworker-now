import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { win32, type PlatformPath } from 'node:path'
import { WindowsCliInstallationError } from './windows-cli-installation.ts'
import { ProcessCleanupUnconfirmedError } from './process.ts'

export type WindowsDesktopCli = 'zcode' | 'opencode'
const label = (cli: WindowsDesktopCli) => (cli === 'zcode' ? 'ZCode' : 'OpenCode')
const failure = (cli: WindowsDesktopCli, message = '桌面安装信息探测失败') =>
  new WindowsCliInstallationError(`${label(cli)} ${message}，请配置 ${cli}Executable`)

/** Fixed OS metadata query only. No installer, shortcut target, or user command is executed. */
export const WINDOWS_DESKTOP_INSTALL_QUERY = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$watch=[Diagnostics.Stopwatch]::StartNew()
$rows=[Collections.Generic.List[object]]::new()
$complete=$true
$seen=0
function Bound {
  $script:seen++
  if($watch.ElapsedMilliseconds -gt 8000 -or $script:seen -gt 4096 -or $rows.Count -ge 128){throw 'Metadata limit'}
}
function Product([string]$name) {
  if($name -match '^ZCode(?:\s.*)?$'){return 'zcode'}
  if($name -match '^OpenCode(?:\s.*)?$'){return 'opencode'}
  return $null
}
function CleanFile([string]$value,[bool]$icon) {
  if([string]::IsNullOrWhiteSpace($value)){return $null}
  $p=$value.Trim()
  if($icon){$p=$p -replace ',\s*-?\d+\s*$',''}
  if($p.StartsWith('"') -and $p.EndsWith('"')){$p=$p.Substring(1,$p.Length-2)}
  if($p -match '[\x00-\x1f\x7f"]' -or $p -notmatch '^[A-Za-z]:[\\/]' -or $p -notmatch '\.(?:exe|ico)$'){return $null}
  return $p
}
function AddRoot([string]$cli,[string]$source,[string]$value) {
  if([string]::IsNullOrWhiteSpace($value)){return}
  Bound
  $p=$value.Trim().Trim('"')
  if($p -match '[\x00-\x1f\x7f"]' -or $p -notmatch '^[A-Za-z]:[\\/]'){return}
  $rows.Add([ordered]@{cli=$cli;source=$source;root=$p})
}
function AddTarget([string]$cli,[string]$source,[string]$value,[bool]$icon) {
  $p=CleanFile $value $icon
  if(!$p){return}
  Bound
  $rows.Add([ordered]@{cli=$cli;source=$source;target=$p})
}
$shell=$null
try {
  # Defaults are independent hints: deleting shortcuts/registration does not
  # hide a complete installation left at a known vendor location.
  if($env:LOCALAPPDATA) {
    foreach($leaf in @('Programs\ZCode')){AddRoot 'zcode' 'default-location' (Join-Path $env:LOCALAPPDATA $leaf)}
    foreach($leaf in @('Programs\@opencodedesktop','Programs\OpenCode','OpenCode')){AddRoot 'opencode' 'default-location' (Join-Path $env:LOCALAPPDATA $leaf)}
  }
  foreach($baseDir in @($env:ProgramFiles,[Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))) {
    if($baseDir){AddRoot 'zcode' 'default-location' (Join-Path $baseDir 'ZCode');AddRoot 'opencode' 'default-location' (Join-Path $baseDir 'OpenCode')}
  }
  foreach($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
      Bound
      $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
      try {
        $uninstall=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
        if($uninstall) {
          try {
            foreach($name in $uninstall.GetSubKeyNames()) {
              Bound
              $key=$uninstall.OpenSubKey($name)
              if(!$key){continue}
              try {
                $cli=Product ([string]$key.GetValue('DisplayName'))
                if(!$cli){continue}
                AddRoot $cli 'uninstall-location' ([string]$key.GetValue('InstallLocation'))
                AddTarget $cli 'uninstall-icon' ([string]$key.GetValue('DisplayIcon')) $true
              } finally {$key.Dispose()}
            }
          } finally {$uninstall.Dispose()}
        }
        foreach($entry in @(@('zcode','ZCode.exe'),@('opencode','OpenCode.exe'),@('opencode','opencode-cli.exe'))) {
          Bound
          $key=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\App Paths\'+$entry[1])
          if(!$key){continue}
          try {AddTarget $entry[0] 'app-path' ([string]$key.GetValue('')) $false} finally {$key.Dispose()}
        }
      } finally {$base.Dispose()}
    }
  }
  # Read only image paths of exact product names, never arguments or accounts.
  foreach($process in @(Get-Process -Name 'ZCode','OpenCode','OpenCode Beta','OpenCode Dev','OpenCode Desktop','OpenCode-Beta','OpenCode-Dev','OpenCode-Desktop' -ErrorAction SilentlyContinue)) {
    Bound
    $target=[string]$process.Path
    if($target){AddTarget $(if($process.ProcessName -ieq 'ZCode'){'zcode'}else{'opencode'}) 'running-process' $target $false}
  }
  $shell=New-Object -ComObject Shell.Application
  $queue=[Collections.Generic.Queue[object]]::new()
  $visited=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($folder in @('StartMenu','CommonStartMenu','DesktopDirectory','CommonDesktopDirectory')) {
    $path=[Environment]::GetFolderPath([Environment+SpecialFolder]::$folder)
    $maxDepth=if($folder -match 'StartMenu'){4}else{0}
    if($path -and $visited.Add($path)){$queue.Enqueue(@($path,0,$maxDepth))}
  }
  while($queue.Count -gt 0) {
    Bound
    if($visited.Count -gt 256){throw 'Directory limit'}
    $entry=$queue.Dequeue();$directory=[IO.DirectoryInfo]::new([string]$entry[0]);$depth=[int]$entry[1];$maxDepth=[int]$entry[2]
    if(!$directory.Exists -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)){continue}
    foreach($item in $directory.GetFileSystemInfos()) {
      Bound
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){continue}
      if($item -is [IO.DirectoryInfo]) {
        if($depth -lt $maxDepth -and $visited.Add($item.FullName)){$queue.Enqueue(@($item.FullName,$depth+1,$maxDepth))}
        # Only known shell folders and their bounded descendants are searched.
        continue
      }
      if($item.Extension -ine '.lnk'){continue}
      $cli=Product $item.BaseName
      if(!$cli){continue}
      $folder=$null;$linkItem=$null;$link=$null
      try {
        $folder=$shell.Namespace($directory.FullName)
        if(!$folder){throw 'Shortcut metadata unavailable'}
        $linkItem=$folder.ParseName($item.Name)
        if(!$linkItem -or !$linkItem.IsLink){throw 'Shortcut metadata unavailable'}
        $link=$linkItem.GetLink
        $target=CleanFile ([string]$link.Path) $false
        $name=if($target){[IO.Path]::GetFileName($target)}else{''}
        if(($cli -eq 'zcode' -and $name -ieq 'ZCode.exe') -or ($cli -eq 'opencode' -and $name -match '^(?:OpenCode(?:[ -](?:Beta|Dev|Desktop))?|opencode-cli)\.exe$')) {
          AddTarget $cli 'shortcut' $target $false
        }
      } finally {
        foreach($com in @($link,$linkItem,$folder)){if($com -and [Runtime.InteropServices.Marshal]::IsComObject($com)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($com)}}
      }
    }
  }
} catch {$complete=$false}
finally {if($shell -and [Runtime.InteropServices.Marshal]::IsComObject($shell)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}}
$json=[ordered]@{schema=1;complete=$complete;records=@($rows.ToArray())}|ConvertTo-Json -Depth 5 -Compress
if([Text.Encoding]::UTF8.GetByteCount($json) -gt 65536){$json='{"schema":1,"complete":false,"records":[]}'}
[Console]::WriteLine($json)
`

interface FileQueries {
  ordinaryFile(path: string): string | undefined
  directory(path: string): string | undefined
  peFile(path: string): string | undefined
}
export interface WindowsDesktopOptions {
  /** For explicit synthetic fixture paths only; production always uses win32. */
  path?: PlatformPath
  files?: FileQueries
}
let physicalFiles: typeof nodeFs | undefined
/** Installation identity is about disk files, not Electron's virtual ASAR tree. */
function physicalFs(): typeof nodeFs {
  return (physicalFiles ??= process.versions.electron
    ? (createRequire(import.meta.url)('original-fs') as typeof nodeFs)
    : nodeFs)
}
function ordinary(path: string): string | undefined {
  const { statSync, accessSync, constants, realpathSync } = physicalFs()
  try {
    const info = statSync(path)
    if (!info.isFile() || !info.size) throw new Error('Invalid file')
    accessSync(path, constants.R_OK)
    return realpathSync(path)
  } catch (error: any) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return undefined
    throw error
  }
}
function directory(path: string): string | undefined {
  const { statSync, realpathSync } = physicalFs()
  try {
    return statSync(path).isDirectory() ? realpathSync(path) : undefined
  } catch (error: any) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return undefined
    throw error
  }
}
function pe(path: string): string | undefined {
  const canonical = ordinary(path)
  if (!canonical) return undefined
  const { openSync, fstatSync, readSync, closeSync } = physicalFs()
  const fd = openSync(canonical, 'r')
  try {
    const info = fstatSync(fd),
      head = Buffer.alloc(64),
      signature = Buffer.alloc(4)
    if (readSync(fd, head, 0, 64, 0) !== 64 || head.toString('ascii', 0, 2) !== 'MZ')
      throw new Error('Invalid PE')
    const offset = head.readUInt32LE(0x3c)
    if (
      offset < 64 ||
      offset + 4 > info.size ||
      readSync(fd, signature, 0, 4, offset) !== 4 ||
      signature.toString('hex') !== '50450000'
    )
      throw new Error('Invalid PE')
    return canonical
  } finally {
    closeSync(fd)
  }
}
const files: FileQueries = { ordinaryFile: ordinary, directory, peFile: pe }
const contained = (root: string, entry: string, path: PlatformPath) => {
  const relative = path.relative(root.toLowerCase(), entry.toLowerCase())
  return (
    !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
  )
}
function safePath(value: unknown, path: PlatformPath): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 2048 ||
    /[\x00-\x1f\x7f"]/.test(value) ||
    !path.isAbsolute(value) ||
    (path === win32 && (!/^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}/.test(value))) ||
    value.split(/[\\/]/).includes('..')
  )
    throw new Error('Invalid path')
  return path.normalize(value)
}
function iconPath(value: unknown, path: PlatformPath): string {
  if (typeof value !== 'string') throw new Error('Invalid path')
  let target = value.trim().replace(/,\s*-?\d+\s*$/, '')
  if (target.startsWith('"') && target.endsWith('"')) target = target.slice(1, -1)
  return safePath(target, path)
}
function installationEntries(
  cli: WindowsDesktopCli,
  root: string,
  fs: FileQueries,
  path: PlatformPath,
): string[] {
  const foundRoot = fs.directory(root)
  if (!foundRoot) return []
  const canonicalRoot = safePath(foundRoot, path)
  const entries: string[] = []
  if (cli === 'zcode') {
    const entry = fs.ordinaryFile(path.join(root, 'resources', 'glm', 'zcode.cjs'))
    const provider = fs.ordinaryFile(path.join(root, 'resources', 'config', 'provider', 'zcode-builtin.json'))
    if (
      entry &&
      provider &&
      contained(canonicalRoot, entry, path) &&
      contained(canonicalRoot, provider, path)
    )
      entries.push(entry)
    else if (entry || provider) throw failure(cli, '桌面 CLI 配套文件不可用')
  } else {
    for (const candidate of [
      path.join(root, 'resources', 'opencode-cli.exe'),
      path.join(root, 'opencode-cli.exe'),
    ]) {
      const entry = fs.peFile(candidate)
      if (entry) {
        if (!contained(canonicalRoot, entry, path)) throw failure(cli, '桌面 CLI 入口被重定向')
        entries.push(entry)
      }
    }
  }
  const desktopNames =
    cli === 'zcode'
      ? ['ZCode.exe']
      : [
          'OpenCode.exe',
          'OpenCode Beta.exe',
          'OpenCode Dev.exe',
          'OpenCode Desktop.exe',
          'OpenCode-Beta.exe',
          'OpenCode-Dev.exe',
          'OpenCode-Desktop.exe',
        ]
  if (!entries.length && desktopNames.some((name) => fs.ordinaryFile(path.join(root, name))))
    throw failure(cli, '桌面已存在，但没有可用独立 CLI')
  return entries
}

/** Metadata is a bounded hint, never a command or an account source. */
export function windowsDesktopCliFromMetadata(
  cli: WindowsDesktopCli,
  raw: string,
  options: WindowsDesktopOptions = {},
): string | undefined {
  const path = options.path ?? win32,
    fs = options.files ?? files
  try {
    if (Buffer.byteLength(raw, 'utf8') > 65536) throw new Error('Metadata limit')
    const value = JSON.parse(raw.replace(/^\uFEFF/, '').trim())
    if (
      !value ||
      value.schema !== 1 ||
      value.complete !== true ||
      !Array.isArray(value.records) ||
      value.records.length > 128
    )
      throw new Error('Invalid metadata')
    const roots = new Map<string, string>()
    for (const record of value.records) {
      if (
        !record ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        !['zcode', 'opencode'].includes(record.cli) ||
        ![
          'uninstall-location',
          'uninstall-icon',
          'app-path',
          'shortcut',
          'default-location',
          'running-process',
        ].includes(record.source) ||
        Object.keys(record).some((key) => !['cli', 'source', 'root', 'target'].includes(key))
      )
        throw new Error('Invalid metadata')
      if (record.cli !== cli) continue
      let root: string
      if (
        record.root !== undefined &&
        record.target === undefined &&
        ['uninstall-location', 'default-location'].includes(record.source)
      )
        root = safePath(record.root, path)
      else if (
        record.target !== undefined &&
        record.root === undefined &&
        !['uninstall-location', 'default-location'].includes(record.source)
      ) {
        const target = iconPath(record.target, path),
          name = path.basename(target).toLowerCase()
        if (record.source === 'uninstall-icon') {
          if (!/\.(?:exe|ico)$/i.test(name)) throw new Error('Invalid icon')
        } else if (
          cli === 'zcode'
            ? name !== 'zcode.exe'
            : !/^(?:opencode(?:[ -](?:beta|dev|desktop))?|opencode-cli)\.exe$/.test(name)
        )
          throw new Error('Invalid target')
        root = path.dirname(target)
        if (cli === 'opencode' && name === 'opencode-cli.exe') {
          if (path.basename(root).toLowerCase() === 'resources') root = path.dirname(root)
        }
      } else throw new Error('Invalid metadata')
      roots.set(root.toLowerCase(), root)
    }
    const candidates: string[] = []
    let incomplete: WindowsCliInstallationError | undefined
    for (const root of roots.values()) {
      try {
        candidates.push(...installationEntries(cli, root, fs, path))
      } catch (error) {
        // An old desktop missing its companion CLI must not hide a complete
        // installation. Read/access errors still fail the overall discovery.
        if (!(error instanceof WindowsCliInstallationError)) throw error
        incomplete ??= error
      }
    }
    const unique = new Map(candidates.map((entry) => [entry.toLowerCase(), entry]))
    if (unique.size > 1) throw failure(cli, '发现多个可用安装')
    if (!unique.size && incomplete) throw incomplete
    return [...unique.values()][0]
  } catch (error) {
    if (error instanceof WindowsCliInstallationError) throw error
    throw failure(cli)
  }
}

export async function findWindowsDesktopCli(
  cli: WindowsDesktopCli,
  capture: (argv: string[], cwd: string) => Promise<string>,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  signal.throwIfAborted()
  const root = env.SystemRoot || env.WINDIR || 'C:\\Windows'
  let raw: string
  try {
    const command = win32.join(
      safePath(root, win32),
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    raw = await capture(
      [
        command,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(WINDOWS_DESKTOP_INSTALL_QUERY, 'utf16le').toString('base64'),
      ],
      homedir(),
    )
  } catch (error) {
    if (error instanceof ProcessCleanupUnconfirmedError) throw error
    signal.throwIfAborted()
    throw failure(cli)
  }
  signal.throwIfAborted()
  return windowsDesktopCliFromMetadata(cli, raw)
}

/** Do not treat a PATH/explicit Desktop GUI as the command-line binary. */
export function windowsOpenCodeDesktopCli(
  executable: string,
  explicit = false,
  options: WindowsDesktopOptions = {},
): string | undefined {
  const path = options.path ?? win32,
    fs = options.files ?? files
  if (!/^opencode(?:[ -](?:beta|dev|desktop))?\.exe$/i.test(path.basename(executable))) return undefined
  const root = path.dirname(executable)
  try {
    const marker = fs.ordinaryFile(path.join(root, 'resources', 'app.asar'))
    // Old Tauri bundles place a CLI alongside their GUI. The GUI PE subsystem
    // must confirm that case; a standalone console opencode.exe is unchanged.
    let legacyGui = false
    if (!marker && fs.ordinaryFile(executable)) {
      const { openSync, readSync, closeSync } = physicalFs()
      const fd = openSync(executable, 'r')
      try {
        const head = Buffer.alloc(64),
          kind = Buffer.alloc(2),
          signature = Buffer.alloc(4)
        if (readSync(fd, head, 0, 64, 0) === 64 && head.toString('ascii', 0, 2) === 'MZ') {
          const peOffset = head.readUInt32LE(0x3c),
            offset = peOffset + 24 + 68
          legacyGui =
            peOffset >= 64 &&
            readSync(fd, signature, 0, 4, peOffset) === 4 &&
            signature.toString('hex') === '50450000' &&
            readSync(fd, kind, 0, 2, offset) === 2 &&
            kind.readUInt16LE(0) === 2
        }
      } finally {
        closeSync(fd)
      }
    }
    if (!marker && !legacyGui) return undefined
    if (explicit) throw failure('opencode', '执行路径指向桌面主程序')
    const entries = installationEntries('opencode', root, fs, path)
    const unique = new Map(entries.map((entry) => [entry.toLowerCase(), entry]))
    if (unique.size !== 1)
      throw failure('opencode', unique.size ? '发现多个可用安装' : '桌面已存在，但没有可用独立 CLI')
    return [...unique.values()][0]
  } catch (error) {
    if (error instanceof WindowsCliInstallationError) throw error
    throw failure('opencode', '桌面 CLI 入口不可用')
  }
}
