import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { DEFAULT_CONFIG } from '../src/host/process.ts'
import { readCliAccountBinding } from '../src/host/cli-account-binding.ts'
import type { Worker } from '../src/shared/types.ts'

vi.mock('../src/host/cli-account-binding.ts', async original => ({
  ...await original<typeof import('../src/host/cli-account-binding.ts')>(),
  readCliAccountBinding: vi.fn(async () => '模拟账号epoch'),
}))
vi.mock('../src/host/adapters.ts', async original => ({
  ...await original<typeof import('../src/host/adapters.ts')>(), resolveCliExecutable: vi.fn(async () => '/模拟/codex'),
}))
vi.mock('../src/host/native-worker.ts', async original => ({
  ...await original<typeof import('../src/host/native-worker.ts')>(),
  prepareNativeWorker: vi.fn(async (launch, input) => {
    const request = join(input.stateDirectory, `模拟request-${randomUUID()}.json`)
    writeFileSync(request, JSON.stringify({ ...input, argv: launch.argv }), { mode: 0o600 })
    return { argv: ['模拟原生桥', request], env: {}, cleanup: async () => rmSync(request, { force: true }) }
  }),
}))
// 模拟进程后端输出；验证真实 runtime 元数据事务，不启动任何程序。
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function fixture(mode: 'ok' | 'failed-after-id' | 'bad-frame' | 'no-id' = 'ok') {
  const directory = mkdtempSync(join(tmpdir(), '模拟原生分支事务-'))
  const storage = new WorkerStorage(join(directory, 'state'))
  const requests: any[] = []
  const backend = { resolveExecutable: vi.fn(), spawn: vi.fn((spec) => {
    const config = JSON.parse(readFileSync(spec.argv.at(-1), 'utf8')); requests.push(config)
    let lines = config.forkOperation === 'fork' && mode !== 'no-id'
      ? JSON.stringify({ type: 'native', record: { type: 'cliworker.fork_created', id: '模拟回执新ID' } }) + '\n' : ''
    if (mode === 'bad-frame' && config.forkOperation === 'fork') lines += '模拟截断非法JSON\n'
    lines += JSON.stringify({ type: 'result', status: config.forkOperation === 'fork' && mode === 'failed-after-id' ? 'ERROR' : 'SUCCESS', error: '模拟创建后失败' }) + '\n'
    return { stdout: (async function* () { yield Buffer.from(lines) })(), stderr: (async function* () {})(),
      done: Promise.resolve({ exitCode: 0 }), terminate: vi.fn(), waitForExit: vi.fn(async () => true) }
  }) }
  const runtime = new WorkerRuntime(storage, backend as any, DEFAULT_CONFIG)
  cleanup.push(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }) })
  const worker: Worker = { id: randomUUID(), runId: randomUUID(), parentSessionId: '模拟父', project: directory,
    preference: { cli: 'codex', model: '模拟模型', effort: 'default' }, transport: 'codex-app-v1', mode: 'plan', title: '模拟源',
    conversationId: '模拟原ID', status: 'completed', createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' }
  storage.save(worker); storage.bindAccount(worker.id, '模拟账号epoch')
  return { runtime, worker, requests, backend }
}
it('模拟：metadata fork and rollback use exact native response identities and no task input', async () => {
  const f = fixture(), before = structuredClone(f.worker)
  const result = await (f.runtime as any).forkNative(f.worker, { turnId: '原生轮ID' }, new AbortController().signal)
  expect(result.conversationId).toBe('模拟回执新ID')
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]).toMatchObject({ forkOperation: 'fork', forkAt: { turnId: '原生轮ID' }, conversationId: '模拟原ID', mode: 'plan' })
  expect(f.requests[0].argv).toContain('resume')
  await result.rollback()
  expect(f.requests[1]).toMatchObject({ forkOperation: 'delete', conversationId: '模拟回执新ID' })
  expect(f.worker).toEqual(before)
  expect(f.backend.spawn.mock.calls.every(([spec]) => spec.stdio.stdin === 'ignore')).toBe(true)
})
it.each(['failed-after-id', 'bad-frame'] as const)('模拟：%s still cleans the already created native ID', async mode => {
  const f = fixture(mode)
  await expect((f.runtime as any).forkNative(f.worker, {}, new AbortController().signal)).rejects.toThrow()
  expect(f.requests).toHaveLength(2)
  expect(f.requests[1]).toMatchObject({ forkOperation: 'delete', conversationId: '模拟回执新ID' })
  expect(f.worker.conversationId).toBe('模拟原ID')
})
it('模拟：missing native identity never invents an ID or deletes the source', async () => {
  const f = fixture('no-id')
  await expect((f.runtime as any).forkNative(f.worker, {}, new AbortController().signal)).rejects.toThrow('没有返回新的会话 ID')
  expect(f.requests).toHaveLength(1)
  expect(f.worker.conversationId).toBe('模拟原ID')
})
it('模拟：a branch after an account change forks under the current account and leaves rebinding to its first turn', async () => {
  const f = fixture()
  vi.mocked(readCliAccountBinding).mockResolvedValueOnce('模拟账号B')
  const result = await (f.runtime as any).forkNative(f.worker, {}, new AbortController().signal)
  expect(result.conversationId).toBe('模拟回执新ID')
  expect(readCliAccountBinding).toHaveBeenCalled()
  expect(f.requests).toHaveLength(1)
  // Metadata operations never write a binding; the source keeps its own.
  expect((f.runtime as any).storage.accountBinding(f.worker.id)).toBe('模拟账号epoch')
})
it('模拟：a branch without a signed-in account is refused before any native operation', async () => {
  const f = fixture()
  vi.mocked(readCliAccountBinding).mockRejectedValueOnce(new Error('本 CLI 未登录'))
  await expect((f.runtime as any).forkNative(f.worker, {}, new AbortController().signal)).rejects.toThrow('未登录')
  expect(f.requests).toHaveLength(0)
})
