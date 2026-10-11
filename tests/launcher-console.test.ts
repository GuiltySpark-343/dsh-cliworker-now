import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const privateLauncher = fileURLToPath(new URL('../src/host/private-launch.mjs', import.meta.url))
const accountLauncher = fileURLToPath(new URL('../src/host/windows-account-launch.mjs', import.meta.url))
const args = ['--synthetic-only', '中文 路径', '& whoami', 'literal"quote', '', 'line\nnext']

// These real, isolated Node helpers replace only their native child with an
// EventEmitter. No installed CLI, account, browser, clipboard or desktop is used.
// Capture the spawn boundary without changing the test runner's umask/signals.
async function run(kind: 'private' | 'account', mode: 'close' | 'error' | 'signal' | 'cancel' = 'close', windows = process.platform === 'win32') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-console-synthetic-')))
  roots.push(root)
  const preload = join(root, 'preload.mjs')
  writeFileSync(
    preload,
    `
import cp from 'node:child_process';
import tty from 'node:tty';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (process.env.CWN_SYNTHETIC_WINDOWS === '1') Object.defineProperty(process,'platform',{value:'win32'});
// A synthetic PTY handle: the native ConPTY/TTY behavior has separate OS tests.
tty.isatty = () => true;
cp.spawn = (executable, argv, options) => {
  emit({ executable, argv, stdio: options.stdio, windowsHide: options.windowsHide,
    shell: options.shell ?? false, detached: options.detached ?? false,
    environmentPreserved: options.env.CWN_SYNTHETIC_ENV === 'unchanged' });
  const child = new EventEmitter();
  child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  const close=(code,signal)=>{child.emit('exit',code,signal);child.stdout.end();child.stderr.end();child.emit('close',code,signal)};
  child.kill = signal => { emit({ forwardedSignal: signal }); queueMicrotask(() => close(null, signal)); };
  setTimeout(() => {
    if (process.env.CWN_SYNTHETIC_MODE === 'signal') process.emit('SIGTERM');
    else if (process.env.CWN_SYNTHETIC_MODE === 'error') {
      child.emit('error', new Error('synthetic native error must not be printed'));
      close(null, null);
    } else close(7, null);
  }, 10);
  return child;
};
syncBuiltinESMExports();
if (process.env.CWN_SYNTHETIC_KIND === 'account') {
  const timer = setInterval(() => {
    if (existsSync(join(process.env.CWN_SYNTHETIC_ROOT, 'exit'))) { clearInterval(timer); process.exit(0); }
  }, 10);
  if (process.env.CWN_SYNTHETIC_MODE === 'cancel') setTimeout(() => process.exit(0), 30);
}
`,
  )
  if (kind === 'account') {
    writeFileSync(join(root, 'ready'), 'ready')
    if (mode === 'cancel') writeFileSync(join(root, 'cancel'), 'cancel')
  }
  const requested = [process.execPath, privateLauncher, process.execPath, ...args]
  const argv =
    kind === 'private'
      ? [privateLauncher, process.execPath, ...args]
      : [accountLauncher, root, Buffer.from(JSON.stringify(requested)).toString('base64')]
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, ...argv], {
    env: {
      ...process.env,
      CWN_SYNTHETIC_KIND: kind,
      CWN_SYNTHETIC_MODE: mode,
      CWN_SYNTHETIC_ROOT: root,
      CWN_SYNTHETIC_ENV: 'unchanged',
      CWN_SYNTHETIC_WINDOWS: windows ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    return {
      root,
      code,
      stderr,
      records: stdout.trim()
        ? stdout
            .trim()
            .split('\n')
            .map((row) => JSON.parse(row))
        : [],
    }
  } finally {
    clearTimeout(timer)
  }
}

describe('plugin native launch console presentation (synthetic child, real wrappers)', () => {
  it.each(['private', 'account'] as const)(
    '%s keeps literal arguments/streams with no extra Windows console',
    async (kind) => {
      const result = await run(kind)
      // The account wrapper restores stdin only in an Electron child. Keep its
      // fixed preload in the expectation when this suite uses the Desktop runtime.
      const expectedArgs =
        kind === 'account' && process.versions.electron
          ? ['--import', new URL('../src/host/windows-account-stdio.mjs', import.meta.url).href, ...args]
          : args
      expect(result.records).toEqual([
        {
          executable: process.execPath,
          argv: expectedArgs,
          stdio: kind === 'private' ? (process.platform === 'win32' ? ['pipe', 'pipe', 'pipe'] : 'inherit') : [0, 1, 2],
          windowsHide: true,
          shell: false,
          detached: false,
          environmentPreserved: true,
        },
      ])
      expect(result.stderr).toBe('')
      if (kind === 'private') expect(result.code).toBe(7)
      else {
        expect(result.code).toBe(0)
        expect(JSON.parse(readFileSync(join(result.root, 'exit'), 'utf8'))).toEqual({
          exitCode: 7,
          signal: null,
        })
      }
    },
  )
  it('retains private launcher signal forwarding and its interruption outcome', async () => {
    const result = await run('private', 'signal')
    expect(result.records[1]).toEqual({ forwardedSignal: 'SIGTERM' })
    expect(result.code).toBe(143)
  })
  it('uses newly created background pipes for the Windows private helper while retaining its outcome', async () => {
    const result = await run('private', 'close', true)
    expect(result.records[0].stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(result.records[0].argv).toEqual(args)
    expect(result.records[0].windowsHide).toBe(true)
    expect(result.code).toBe(7)
    expect(result.stderr).toBe('')
  })
  it.each(['private', 'account'] as const)(
    '%s keeps native launch failures visible without raw errors',
    async (kind) => {
      const result = await run(kind, 'error')
      expect(result.stderr).toMatch(/^CLI launch failed\r?\n$/)
      if (kind === 'private') expect(result.code).toBe(1)
      else expect(JSON.parse(readFileSync(join(result.root, 'exit'), 'utf8')).exitCode).toBe(1)
    },
  )
  it('does not launch any account child after the Job adoption sees cancellation', async () => {
    const result = await run('account', 'cancel')
    expect(result.records).toEqual([])
    expect(result.code).toBe(0)
  })
})
