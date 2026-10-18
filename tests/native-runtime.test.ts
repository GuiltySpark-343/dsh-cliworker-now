import { afterEach, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import { NATIVE_TRANSPORTS, usesNativeBridge } from '../src/host/native-worker.ts'
import { extractTelemetry } from '../src/host/telemetry.ts'

// Synthetic account admission and native bridge records. No user CLI or model is called.
vi.mock('../src/host/cli-account-binding.ts', () => ({
  readCliAccountBinding: async () => 'synthetic-account',
}))
vi.mock('../src/host/authorized-catalog.ts', () => ({
  ACCOUNT_CHANGED: 'account changed',
  authorizeSelection: async (preference: unknown) => ({ binding: 'synthetic-account', preference }),
}))
vi.mock('../src/host/claude-own-route.ts', () => ({
  readClaudeOwnRoute: async () => ({ kind: 'proxy' }),
  prepareClaudeWorkerLaunch: async (_route: unknown, argv: string[], directory: string) => {
    const snapshot = join(directory, 'synthetic-private-claude-settings.json')
    writeFileSync(snapshot, 'synthetic credential placeholder', { mode: 0o600 })
    return { argv, cleanup: async () => rmSync(snapshot, { force: true }) }
  },
}))
const closes: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})
function setup(status = 'SUCCESS') {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-native-runtime-')))
  closes.push(() => rmSync(project, { recursive: true, force: true }))
  const executable = join(project, 'synthetic-cli.mjs')
  writeFileSync(executable, '#!/usr/bin/env node\n// Synthetic launcher identity only; the backend below produces all records.\n', { mode: 0o700 })
  const requests: any[] = []
  const calls: SubprocessSpawnSpec[] = []
  const backend: ProcessBackend = {
    resolveExecutable: async () => executable,
    spawn(spec) {
      calls.push(spec)
      const stdout = new PassThrough(),
        stderr = new PassThrough()
      let settle!: (outcome: { exitCode: number }) => void
      const done = new Promise<{ exitCode: number }>((resolve) => {
        settle = resolve
      })
      const isBridge = spec.argv.some((arg) => arg.replaceAll('\\', '/').endsWith('/native-bridge.mjs'))
      if (isBridge) {
        const path = spec.argv.at(-1)!
        requests.push(JSON.parse(readFileSync(path, 'utf8')))
        if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
      }
      queueMicrotask(() => {
        const records = isBridge
          ? [
              { type: 'session', id: 'synthetic-session', model: 'synthetic-model' },
              { type: 'event', event: { kind: 'assistant', step: 0, text: '本轮正文' } },
              {
                type: 'result',
                status,
                response: '本轮正文',
                ...(status === 'UNCERTAIN' ? { error: '结果待核实，不要自动重试' } : {}),
              },
            ]
          : [
              { event: 'init', conversation_id: 'synthetic-session' },
              {
                event: 'result',
                result: {
                  conversation_id: 'synthetic-session',
                  status: 'SUCCESS',
                  response: 'legacy answer',
                },
              },
            ]
        stdout.end(records.map((record) => JSON.stringify(record) + '\n').join(''))
        stderr.end()
        settle({ exitCode: 0 })
      })
      return {
        stdout,
        stderr,
        done,
        terminate() {},
        waitForExit: async () => {
          await done
          return true
        },
      } as SubprocessHandle
    },
  }
  const storage = new WorkerStorage(join(project, 'state'))
  const runtime = new WorkerRuntime(storage, backend, DEFAULT_CONFIG)
  closes.push(() => runtime.close())
  return { project, storage, runtime, requests, calls, executable }
}
const pref = { cli: 'antigravity' as const, model: 'synthetic-model', effort: 'low' as const }
it('defaults new work to the native bridge, pins it on resume, and removes private per-run requests', async () => {
  const f = setup()
  const first = await f.runtime.submit('parent', f.project, 'synthetic', 'first', pref, 'accept-edits').done
  expect(first.status).toBe('completed')
  expect(first.transport).toBe('agy-stream-v1')
  expect(f.requests[0]).toMatchObject({ cli: 'antigravity', prompt: 'first', preference: pref })
  expect(f.requests[0].argv.at(-1)).toBe('任务：\nfirst')
  const second = await f.runtime.submit(
    'parent',
    f.project,
    'synthetic',
    'second',
    pref,
    'accept-edits',
    first.id,
  ).done
  expect(second.status).toBe('completed')
  expect(second.conversationId).toBe(first.conversationId)
  expect(f.requests[1].conversationId).toBe(first.conversationId)
  expect(
    readdirSync(join(f.storage.directory, 'native', first.id)).filter((name) =>
      name.startsWith('native-request-'),
    ),
  ).toEqual([])
  const saved = JSON.parse(readFileSync(join(f.storage.directory, `${first.id}.worker.json`), 'utf8'))
  expect(saved.transport).toBe('agy-stream-v1')
})
it('keeps pre-migration sessions on legacy wire without silently changing their transport', async () => {
  const f = setup()
  const first = await f.runtime.submit('parent', f.project, 'synthetic', 'first', pref, 'accept-edits').done
  const worker = f.storage.workers.get(first.id)!
  delete worker.transport
  f.storage.save(worker)
  const second = await f.runtime.submit(
    'parent',
    f.project,
    'synthetic',
    'legacy followup',
    pref,
    'accept-edits',
    first.id,
  ).done
  expect(second.status).toBe('completed')
  expect(second.transport).toBeUndefined()
  expect(second.lastResult).toBe('legacy answer')
  expect(f.requests).toHaveLength(1)
})
it('refuses unknown pinned protocols before launching a resume', async () => {
  const f = setup()
  const first = await f.runtime.submit('parent', f.project, 'synthetic', 'first', pref, 'accept-edits').done
  const worker = f.storage.workers.get(first.id)!
  worker.transport = 'future-unsupported'
  f.storage.save(worker)
  const count = f.calls.length
  expect(() =>
    f.runtime.submit('parent', f.project, 'synthetic', 'next', pref, 'accept-edits', first.id),
  ).toThrow('未知通信协议')
  expect(f.calls).toHaveLength(count)
})
it('retains the uncertain outcome and actual native text without marking it completed', async () => {
  const f = setup('UNCERTAIN')
  const worker = await f.runtime.submit('parent', f.project, 'synthetic', 'first', pref, 'accept-edits').done
  expect(worker.status).toBe('uncertain')
  expect(worker.lastResult).toBe('本轮正文')
  expect(worker.error).toContain('不要自动重试')
})
it('has an explicit mapping for all twelve live CLIs while Pi and OMP retain their existing RPC bridge', () => {
  expect(Object.keys(NATIVE_TRANSPORTS)).toHaveLength(12)
  for (const [cli, transport] of Object.entries(NATIVE_TRANSPORTS))
    expect(usesNativeBridge({ transport, preference: { ...pref, cli: cli as any } })).toBe(
      !['pi', 'omp'].includes(cli),
    )
})
it('keeps a Qoder worker on its ACP session for follow-up and refuses unsupported planning before spawn (synthetic)', async () => {
  const f = setup()
  const qoder = { ...pref, cli: 'qoder' as const, effort: 'default' as const }
  const first = await f.runtime.submit('parent', f.project, 'synthetic Qoder', 'first', qoder, 'accept-edits').done
  expect(first.status).toBe('completed')
  expect(first.transport).toBe('qoder-acp-v1')
  expect(f.requests[0].argv).toEqual([f.executable, '--acp', '--permission-mode', 'accept_edits', '--model', qoder.model])
  const second = await f.runtime.submit('parent', f.project, 'synthetic Qoder', 'next', qoder, 'accept-edits', first.id).done
  expect(second.status).toBe('completed')
  expect(second.conversationId).toBe(first.conversationId)
  expect(f.requests[1].conversationId).toBe(first.conversationId)
  const count = f.calls.length
  expect(() => f.runtime.submit('parent', f.project, 'synthetic plan', 'never sent', qoder, 'plan'))
    .toThrow('未公开只读规划')
  expect(f.calls).toHaveLength(count)
})
it('extracts native metric envelopes without exposing raw records as conversation events', () => {
  expect(
    extractTelemetry('claude', [
      { type: 'native', record: { type: 'result', usage: { input_tokens: 3, output_tokens: 5 } } },
    ]).usage,
  ).toMatchObject({ total: 8, input: 3, output: 5, scope: 'run' })
})
it('removes an already-prepared private credential snapshot when native setup fails before spawn', async () => {
  const f = setup()
  // A synthetic filesystem conflict after account preparation, before bridge creation.
  writeFileSync(join(f.storage.directory, 'native'), 'synthetic blocking file')
  const worker = await f.runtime.submit(
    'parent',
    f.project,
    'synthetic',
    'first',
    { cli: 'claude', model: 'synthetic-model', effort: 'low' },
    'accept-edits',
  ).done
  expect(worker.status).toBe('failed')
  expect(f.calls).toHaveLength(0)
  expect(existsSync(join(f.storage.directory, 'synthetic-private-claude-settings.json'))).toBe(false)
})
it('keeps the run occupied until its native Harness tool lease has drained', async () => {
  const f = setup()
  let drain!: () => void
  let cleaning!: () => void
  const entered = new Promise<void>(resolve => { cleaning = resolve })
  const release = new Promise<void>(resolve => { drain = resolve })
  let preparations = 0, cleanups = 0
  f.runtime.setHarnessPreparation(async (worker, signal) => {
    expect(worker.status).toBe('queued')
    expect(signal.aborted).toBe(false)
    expect(f.calls).toHaveLength(0)
    preparations++
    return { close: async () => { cleanups++; cleaning(); await release } }
  })
  const submission = f.runtime.submit('parent', f.project, 'synthetic', 'first', pref, 'accept-edits')
  let settled = false
  void submission.done.then(() => { settled = true })
  await entered
  expect(settled).toBe(false)
  expect(f.runtime.snapshot('parent', submission.worker.id).selectedBusy).toBe(true)
  drain()
  expect((await submission.done).status).toBe('completed')
  expect([preparations, cleanups]).toEqual([1, 1])
})
it('fails closed before CLI spawn when native child or tool admission fails', async () => {
  const f = setup()
  f.runtime.setHarnessPreparation(async () => { throw new Error('synthetic native binding failure') })
  const result = await f.runtime.submit('parent', f.project, 'synthetic', 'first', pref, 'accept-edits').done
  expect(result.status).toBe('failed')
  expect(result.error).toContain('synthetic native binding failure')
  expect(f.calls).toHaveLength(0)
})
it('does not report normal completion when the native Harness lease cannot drain', async () => {
  const f = setup()
  f.runtime.setHarnessPreparation(async () => ({ close: async () => { throw new Error('synthetic bridge drain failure') } }))
  const result = await f.runtime.submit('parent', f.project, 'synthetic', 'first', pref, 'accept-edits').done
  expect(result.status).toBe('failed')
  expect(result.error).toContain('synthetic bridge drain failure')
  expect(f.calls).toHaveLength(1)
})
