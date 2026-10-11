import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codexAppxExecutable,
  findWindowsCodexAppx,
  hasWindowsHermesInstallDirectory,
  presentWindowsCliCandidate,
  validateWindowsCodexNpmEntry,
  windowsCliCandidates,
} from '../src/host/windows-cli-installation.ts'

// Explicit synthetic installer/package fixtures. No account, network or installed CLI is used.
const roots: string[] = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'synthetic-windows-cli-'))
  roots.push(home)
  return { home, env: { APPDATA: join(home, 'Roaming'), LOCALAPPDATA: join(home, 'Local') } }
}
function pe(path: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  const data = Buffer.alloc(80)
  data.write('MZ')
  data.writeUInt32LE(64, 0x3c)
  data.write('PE\0\0', 64)
  writeFileSync(path, data)
}
function npm(f = fixture()) {
  const shim = windowsCliCandidates('codex', f)[0]!,
    root = join(f.env.APPDATA, 'npm/node_modules/@openai/codex')
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@openai/codex', version: '0.162.0', bin: { codex: 'bin/codex.js' } }),
  )
  writeFileSync(join(root, 'bin/codex.js'), '#!/usr/bin/env node\n// Synthetic; never executed.\n')
  writeFileSync(shim, '@echo off\r\nnode "%~dp0node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n')
  return { f, shim, root }
}
const packageRecord = {
  name: 'OpenAI.Codex',
  family: 'OpenAI.Codex_2p2nqsd0c76g0',
  fullName: 'OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0',
  publisher: 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B',
  signature: 'Store',
  status: 'Ok',
  location: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0',
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('known Windows CLI installation discovery', () => {
  it('recognizes Codex npm despite an unrelated or stale PATH and checks package identity', () => {
    const { f, shim, root } = npm()
    expect(presentWindowsCliCandidate('codex', { ...f, env: { ...f.env, PATH: '/synthetic/stale' } })).toBe(
      shim,
    )
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: '@third-party/codex', bin: { codex: 'bin/codex.js' } }),
    )
    expect(() => presentWindowsCliCandidate('codex', f)).toThrow('Codex npm 安装入口无法确认')
  })
  it.each(['../other.js', '/absolute.js', 'C:\\escape.js'])(
    'rejects npm bin traversal or a foreign absolute entry: %s',
    (bin) => {
      const { shim, root } = npm()
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: '@openai/codex', bin: { codex: bin } }),
      )
      expect(() => validateWindowsCodexNpmEntry(shim)).toThrow('Codex npm 安装入口无法确认')
    },
  )
  it('does not execute or accept a modified npm command script', () => {
    const { shim } = npm()
    writeFileSync(
      shim,
      '@echo off\r\nnode "%~dp0node_modules\\@openai\\codex\\bin\\codex.js" %* & whoami\r\n',
    )
    expect(() => validateWindowsCodexNpmEntry(shim)).toThrow('Codex npm 安装入口无法确认')
  })
  it('finds the native Hermes installer and legacy venv locations without searching arbitrary environments', () => {
    const f = fixture(),
      entries = windowsCliCandidates('hermes', f)
    expect(entries).toEqual([
      join(f.env.LOCALAPPDATA, 'hermes/bin/hermes.exe'),
      join(f.env.LOCALAPPDATA, 'hermes/bin/hermes.cmd'),
      join(f.env.LOCALAPPDATA, 'hermes/hermes-agent/venv/Scripts/hermes.exe'),
    ])
    pe(entries[2]!)
    expect(presentWindowsCliCandidate('hermes', f)).toBe(entries[2])
    pe(entries[0]!)
    expect(presentWindowsCliCandidate('hermes', f)).toBe(entries[0])
  })
  it('keeps a present broken Hermes entry as an error instead of falling through to another environment', () => {
    const f = fixture(),
      entries = windowsCliCandidates('hermes', f)
    pe(entries[2]!)
    mkdirSync(join(entries[0]!, '..'), { recursive: true })
    writeFileSync(entries[0]!, 'not a Windows program')
    expect(() => presentWindowsCliCandidate('hermes', f)).toThrow('Hermes Windows 安装入口无法确认')
  })
  it('distinguishes Hermes install/data residue from an executable without probing credentials or running an installer', () => {
    const f = fixture()
    expect(hasWindowsHermesInstallDirectory(f)).toBe(false)
    mkdirSync(join(f.env.LOCALAPPDATA, 'hermes/tools/git-fixture'), { recursive: true })
    mkdirSync(join(f.env.LOCALAPPDATA, 'hermes/.hermes-clone-fixture'))
    expect(hasWindowsHermesInstallDirectory(f)).toBe(true)
    expect(presentWindowsCliCandidate('hermes', f)).toBeUndefined()
  })
  it('rejects relative Windows installation roots', () => {
    expect(() => windowsCliCandidates('hermes', { env: { LOCALAPPDATA: './unexpected' } })).toThrow(
      '目录配置无效',
    )
  })
})

describe('registered Codex MSIX CLI identity (synthetic metadata)', () => {
  it('selects resources/codex.exe in the registered Store package, never the GUI executable or another version directory', () => {
    const validate = vi.fn((path: string) => path)
    const path = codexAppxExecutable(JSON.stringify(packageRecord), validate)
    expect(path).toBe(packageRecord.location + '\\app\\resources\\codex.exe')
    expect(validate).toHaveBeenCalledExactlyOnceWith(path)
  })
  it('accepts a registered relocated package without hardcoding Program Files', () => {
    const record = { ...packageRecord, location: 'D:\\InstalledApps\\' + packageRecord.fullName }
    expect(codexAppxExecutable(JSON.stringify(record), (path) => path)).toBe(
      record.location + '\\app\\resources\\codex.exe',
    )
  })
  it('keeps no registered package distinct from unverified metadata', () => {
    expect(codexAppxExecutable('null')).toBeUndefined()
    expect(() => codexAppxExecutable('[]')).toThrow('应用包入口无法确认')
    expect(() => codexAppxExecutable('not json')).toThrow('应用包入口无法确认')
  })
  it.each([
    { name: 'Other.Codex' },
    { family: 'OpenAI.Codex_other' },
    { publisher: 'CN=Other' },
    { signature: 'Developer' },
    { status: 'Modified' },
    { fullName: 'OpenAI.Codex_latest_x64__2p2nqsd0c76g0' },
    { location: '\\\\server\\share\\' + packageRecord.fullName },
    { location: 'relative\\' + packageRecord.fullName },
    { location: 'C:\\Program Files\\WindowsApps\\Old.Codex_1.0.0.0_x64__other' },
  ])('refuses mismatched/unhealthy registration: %j', (change) => {
    const validate = vi.fn((path: string) => path)
    expect(() => codexAppxExecutable(JSON.stringify({ ...packageRecord, ...change }), validate)).toThrow(
      '应用包入口无法确认',
    )
    expect(validate).not.toHaveBeenCalled()
  })
  it('refuses missing or redirected package binaries without silently selecting a GUI or WSL entry', () => {
    expect(() =>
      codexAppxExecutable(JSON.stringify(packageRecord), () => {
        throw new Error('ENOENT')
      }),
    ).toThrow('应用包入口无法确认')
    expect(() =>
      codexAppxExecutable(JSON.stringify(packageRecord), () => 'C:\\elsewhere\\codex.exe'),
    ).toThrow('应用包入口无法确认')
  })
  it('uses fixed PowerShell arguments and passes cancellation into the metadata boundary', async () => {
    const signal = new AbortController(),
      capture = vi.fn(async () => 'null')
    expect(await findWindowsCodexAppx(capture, signal.signal, { SystemRoot: 'C:\\Windows' })).toBeUndefined()
    const argv = capture.mock.calls[0]![0]
    expect(argv.slice(0, 5)).toEqual([
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ])
    expect(Buffer.from(argv[5]!, 'base64').toString('utf16le')).toContain(
      "Get-AppxPackage -Name 'OpenAI.Codex'",
    )
    signal.abort()
    await expect(findWindowsCodexAppx(capture, signal.signal)).rejects.toThrow()
    expect(capture).toHaveBeenCalledTimes(1)
  })
  it('does not accept a late registered entry after cancellation', async () => {
    const controller = new AbortController()
    const capture = async () => {
      controller.abort()
      return JSON.stringify(packageRecord)
    }
    await expect(findWindowsCodexAppx(capture, controller.signal)).rejects.toThrow()
  })
})
