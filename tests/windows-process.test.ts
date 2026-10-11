import { afterEach, describe, it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir, release } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnManagedAgent } from '../src/host/managed-agent.ts'
import { hermesNativeCommand, verifyHermesExecutable } from '../src/host/hermes-installation.ts'
import { spawnAccountTerminal } from '../src/host/windows-account-terminal.ts'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))
// These tests execute actual Windows OS primitives and temporary Node/Python
// programs. They do not authenticate a CLI or send model requests.

it.skipIf(process.platform !== 'win32').each(['terminate', 'abort'] as const)(
  'Windows %s uses the actual Host Job and kills a detached descendant',
  async (operation) => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    let pid: number | undefined
    const terminal = vi.spyOn(ctx.subprocess, 'spawnTerminal')
    // The provider does not publish its containment selector; its public
    // fallback warning plus real descendant quiescence are both checked.
    const warning = vi.spyOn(Reflect.get(ctx.subprocess, 'ctx').logger, 'warn')
    const controller = new AbortController()
    try {
      const handle = await spawnManagedAgent(ctx.subprocess, {
        argv: [process.execPath, resolve('tests/fixtures/detached-child.mjs')],
        cwd: process.cwd(),
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 500,
        signal: controller.signal,
      })
      void handle.done.catch(() => undefined)
      for await (const chunk of handle.stdout!) {
        pid = Number(String(chunk).trim())
        break
      }
      expect(pid).toBeGreaterThan(1)
      expect(terminal).not.toHaveBeenCalled()
      expect(warning.mock.calls.flat().join(' ')).not.toContain('weaker process-tree containment')
      process.kill(pid!, 0)
      if (operation === 'abort') controller.abort()
      else handle.terminate()
      expect(await handle.waitForExit()).toBe(true)
      expect(() => process.kill(pid!, 0)).toThrow()
    } finally {
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
      await ctx.fiber.dispose()
    }
  },
  15000,
)

it.skipIf(process.platform !== 'win32').each(['stop', 'natural-exit'] as const)(
  'real Windows account-style ConPTY %s closes its own child and preserves unrelated work',
  async (operation) => {
    const consoles = () => {
      const raw = execFileSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `@(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${process.pid} -and $_.Name -eq 'conhost.exe' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`,
        ],
        { encoding: 'utf8', windowsHide: true },
      ).trim()
      const value = raw ? JSON.parse(raw) : []
      return Array.isArray(value) ? value : [value]
    }
    const beforeConsoles = consoles()
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    // CI can pin the installed GUI-subsystem runtime without changing the SDK.
    // Every payload remains synthetic; no real CLI account is read.
    const accountRuntime = process.env.CLIWORKER_TEST_ELECTRON ?? process.execPath
    let ownerDirectory: string | undefined
    let ownerExit: number | 'pending' | 'rejected' | null = 'pending'
    let consoleIdentity: Record<string, boolean | string> | undefined
    const backend = {
      spawn: (spec: Parameters<typeof ctx.subprocess.spawn>[0]) => {
        const directoryIndex = spec.argv.indexOf('-Directory')
        if (directoryIndex >= 0) ownerDirectory = spec.argv[directoryIndex + 1]
        const handle = ctx.subprocess.spawn(spec)
        void handle.done.then(
          ({ exitCode }) => {
            ownerExit = exitCode
            if (exitCode !== 2 || !ownerDirectory) return
            // Sample before ConPTY cleanup removes the console. Only fixed
            // classifications are emitted; paths and raw errors stay local.
            try {
              consoleIdentity = JSON.parse(execFileSync('powershell.exe', [
                '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='Stop'
try {
  $directory=$env:CWN_ACCOUNT_FIXTURE_DIRECTORY
  $failure=Get-Content -LiteralPath (Join-Path $directory 'failure') -Raw | ConvertFrom-Json
  if ($failure.stage -ne 'attach-console') { @{available=$false} | ConvertTo-Json -Compress; exit }
  $console=[System.Diagnostics.Process]::GetProcessById([int]$failure.consolePid)
  try {
    $started=$console.StartTime.ToUniversalTime()
    $earliest=[System.IO.Directory]::GetCreationTimeUtc($directory).AddSeconds(-1)
    $latest=[System.IO.File]::GetLastWriteTimeUtc((Join-Path $directory 'pid'))
    $image=$console.MainModule.FileName
    $expected=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::System)) 'conhost.exe'
    $leaf=[System.IO.Path]::GetFileName($image).ToLowerInvariant()
    if ($leaf -notin @('conhost.exe','openconsole.exe')) { $leaf='other' }
    @{ available=$true; startedBeforeDirectory=($started -lt $earliest); startedAfterReceipt=($started -gt $latest);
       nativeImageMatches=[string]::Equals($image,$expected,[StringComparison]::OrdinalIgnoreCase);
       imageKind=$leaf; inspector64Bit=[Environment]::Is64BitProcess } | ConvertTo-Json -Compress
  } finally { $console.Dispose() }
} catch { @{available=$false} | ConvertTo-Json -Compress }
`,
              ], { encoding: 'utf8', windowsHide: true, timeout: 5000,
                env: { ...process.env, CWN_ACCOUNT_FIXTURE_DIRECTORY: ownerDirectory } }).trim())
            } catch { consoleIdentity = { available: false } }
          },
          () => { ownerExit = 'rejected' },
        )
        return handle
      },
      spawnTerminal: (spec: Parameters<typeof ctx.subprocess.spawnTerminal>[0]) => {
        const argv = [...spec.argv]
        argv[argv.indexOf('-RuntimePath') + 1] = accountRuntime
        return ctx.subprocess.spawnTerminal({ ...spec, argv })
      },
    }
    const literalArgs = ['中文 路径', '& whoami', 'literal"quote', 'back\\slash\\', '', '$HOME;`echo unsafe`']
    // No CLI login: both payloads are explicit Node lifecycle fixtures.
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    let childPid: number | undefined
    let terminal: Awaited<ReturnType<typeof ctx.subprocess.spawnTerminal>> | undefined
    try {
      terminal = await spawnAccountTerminal(backend, {
        argv: [
          accountRuntime,
          fileURLToPath(new URL('../src/host/private-launch.mjs', import.meta.url)),
          accountRuntime,
          '-e',
          `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true}); console.log(JSON.stringify({fixture:'account-terminal',pid:child.pid,tty:!!process.stdin.isTTY})); console.log('fixture-argv:'+JSON.stringify(process.argv.slice(1))); console.error('fixture-stderr:'+!!process.stderr.isTTY); console.log('fixture-stdout:'+!!process.stdout.isTTY); process.stdin.on('data',data=>{console.log('fixture-received:'+data.toString().trim()); ${operation === 'natural-exit' ? 'process.exit(7)' : ''}}); setInterval(()=>{},1000)`,
          '--',
          ...literalArgs,
        ],
        cwd: process.cwd(),
        env: {},
        rows: 24,
        cols: 80,
        terminalType: 'dumb',
        graceMs: 500,
      })
      void terminal.done.catch(() => undefined)
      expect(terminal.pid).toBeGreaterThan(0)
      let output = ''
      const reader = (async () => {
        for await (const chunk of terminal!.output) output += String(chunk)
      })()
      void reader.catch(() => undefined)
      await vi.waitFor(
        () => {
          const record = output.match(/\{"fixture":"account-terminal","pid":(\d+),"tty":true\}/)
          expect(record).not.toBeNull()
          childPid = Number(record![1])
          expect(output).toContain('fixture-argv:' + JSON.stringify(literalArgs))
          expect(output).toContain('fixture-stderr:true')
          expect(output).toContain('fixture-stdout:true')
        },
        { timeout: 10000 },
      )
      terminal.write('safe-fixture-input\r')
      await vi.waitFor(() => expect(output).toContain('fixture-received:safe-fixture-input'), {
        timeout: 5000,
      })
      if (operation === 'natural-exit')
        await expect(terminal.done).resolves.toEqual({ exitCode: 7, signal: null })
      await terminal.terminate()
      await reader
      expect(() => process.kill(childPid!, 0)).toThrow()
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow()
      expect(consoles().filter((pid) => !beforeConsoles.includes(pid))).toEqual([])
    } catch (error) {
      // Preserve the owner's original fixed receipt: cleanup deliberately fails
      // closed and can otherwise hide the first Win32/handshake failure in CI.
      // Never upload argv, environment, terminal content or temporary paths.
      const ownerFailure: Record<string, string | number> = {}
      if (ownerDirectory) {
        try {
          const receipt = JSON.parse(readFileSync(join(ownerDirectory, 'failure'), 'utf8'))
          const stages = ['await-bootstrap', 'create-job', 'attach-root', 'resolve-console',
            'validate-console-parent', 'attach-console', 'await-stop', 'stop-job', 'confirm-empty']
          if (stages.includes(receipt.stage)) ownerFailure.stage = receipt.stage
          for (const field of ['hostPid', 'ownerPid', 'consolePid', 'consoleParentPid', 'win32Code'])
            if (Number.isSafeInteger(receipt[field])) ownerFailure[field] = receipt[field]
        } catch { /* A missing receipt is itself useful handshake evidence. */ }
      }
      const stage = error && typeof error === 'object' ? Reflect.get(error, 'stage') : undefined
      const diagnostic = {
        fixture: 'synthetic-windows-account-terminal', operation,
        windowsVersion: release(), nodeVersion: process.versions.node,
        runtime: accountRuntime === process.execPath ? 'current-node' : 'explicit-test-runtime',
        ownerExit, ownerFailure, consoleIdentity,
        cleanupStage: ['receipt', 'terminal', 'owner', 'directory'].includes(stage) ? stage : null,
        receipts: Object.fromEntries(['owner-ready', 'pid', 'ready', 'cancel', 'stop', 'closed', 'exit']
          .map((name) => [name, !!ownerDirectory && existsSync(join(ownerDirectory, name))])),
      }
      mkdirSync('.test-data', { recursive: true, mode: 0o700 })
      writeFileSync(`.test-data/windows-account-process-${operation}.json`, JSON.stringify(diagnostic, null, 2), { mode: 0o600 })
      console.error('Windows account lifecycle diagnostic:', JSON.stringify(diagnostic))
      throw error
    } finally {
      await terminal?.terminate().catch(() => undefined)
      if (childPid) {
        try {
          process.kill(childPid, 'SIGKILL')
        } catch {}
      }
      unrelated.kill()
      await new Promise<void>((resolve) =>
        unrelated.exitCode !== null || unrelated.signalCode !== null
          ? resolve()
          : unrelated.once('exit', () => resolve()),
      )
      await ctx.fiber.dispose()
    }
  },
  25000,
)

describe.skipIf(process.platform !== 'win32')(
  'Hermes Windows official launcher contract (synthetic, real Python, no account/network)',
  () => {
    it('runs its fixed Python fallback with the recorded interpreter and literal user argv', async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'hermes-windows-entry-')))
      roots.push(root)
      mkdirSync(join(root, 'hermes_cli'))
      writeFileSync(join(root, 'hermes_bootstrap.py'), '# Explicit synthetic bootstrap, no account access\n')
      writeFileSync(
        join(root, 'hermes_cli/main.py'),
        'import json,sys\ndef main():\n    print(json.dumps(sys.argv[1:]))\n',
      )
      const python =
        process.env.CLIWORKER_TEST_PYTHON ||
        execFileSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
      const source = `import os, re, sys\nsys.path.insert(0, ${JSON.stringify(root)})\nimport hermes_bootstrap\nfrom hermes_cli.main import main\nsys.exit(main())\n`
      const code = `import base64; exec(base64.b64decode('${Buffer.from(source).toString('base64')}'))`
      const launcher = join(root, 'hermes.cmd')
      writeFileSync(launcher, `@echo off\r\n"${python}" -I -c "${code}" %*\r\n`)
      const args = ['model', '中文 路径', '& whoami', 'literal"quote']
      const command = await hermesNativeCommand(launcher, args)
      expect(command[0]).toBe(realpathSync(python))
      expect(command.slice(-args.length)).toEqual(args)
      await expect(verifyHermesExecutable(launcher, AbortSignal.timeout(5000))).resolves.toBeUndefined()
      expect(JSON.parse(execFileSync(command[0]!, command.slice(1), { encoding: 'utf8' }))).toEqual(args)
    })
    it('preserves an actual exe without guessing a dependency directory', async () => {
      const python =
        process.env.CLIWORKER_TEST_PYTHON ||
        execFileSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
      const command = await hermesNativeCommand(python, ['--version'])
      expect(command).toEqual([python, '--version'])
      await expect(verifyHermesExecutable(python, AbortSignal.timeout(5000))).resolves.toBeUndefined()
    })
  },
)
