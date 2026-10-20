import { afterEach, expect, it } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHermesServer } from '../src/host/native-hermes.mjs'
import { httpLimits } from '../src/host/native-http.mjs'

// Simulated native processes and a real loopback capabilities endpoint only.
// No Hermes account, CLI or model is called. Disk-only PIDs must not receive secrets.
const roots: string[] = [], servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true })))
})
async function fixture(options: { proof?: 'valid' | 'wrong-nonce' | 'none'; rootPid?: number; writerPid?: number;
  ownEntry?: boolean; stale?: boolean; wrongPort?: boolean; missingFeature?: boolean; abort?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cwn-hermes-ready-SIMULATED-')))
  roots.push(root)
  const calls: string[] = [], key = 'SIMULATED_GATEWAY_SECRET', controller = new AbortController()
  const features: Record<string, boolean> = Object.fromEntries(['run_submission', 'run_status', 'run_events_sse',
    'run_stop', 'run_approval_response', 'session_resources'].map(f => [f, true]))
  if (options.missingFeature) features.run_stop = false
  const server = createServer((request, response) => {
    calls.push(request.url!)
    expect(request.headers.authorization).toBe(`Bearer ${key}`)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ object: 'hermes.api_server.capabilities', auth: { type: 'bearer', required: true }, features }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port, actualPid = 4243
  await writeFile(join(root, 'gateway_state.json'), JSON.stringify({ pid: actualPid, platforms: { api_server: {
    writer_pid: options.writerPid ?? actualPid, state: 'connected',
    listener_base: `http://127.0.0.1:${options.wrongPort ? port + 1 : port}`,
    updated_at: new Date(Date.now() - (options.stale ? 60000 : 0)).toISOString(),
  } } }), { mode: 0o600 })
  let stopCount = 0, finish!: (value: unknown) => void
  const done = new Promise(resolve => { finish = resolve })
  const managed = { process: { pid: options.rootPid ?? 4242 }, done,
    stop: async () => { stopCount++; finish({ exitCode: 0, signal: null }); await done } }
  const own = fileURLToPath(new URL('../src/host/hermes-native-entry.py', import.meta.url))
  const config = { argv: options.ownEntry === false ? ['SIMULATED_LAUNCHER', 'chat'] : ['SIMULATED_PYTHON', '-I', own, 'SIMULATED_CHECKOUT', 'SIMULATED_FACTS', 'SIMULATED_VENV', 'chat'],
    project: root, timeoutMs: 1000 }
  let sentNonce: string | undefined
  const io = { signal: controller.signal, spawn: (_argv: unknown, launch: any) => {
    sentNonce = launch.env.CLIWORKER_HERMES_GATEWAY_NONCE
    queueMicrotask(() => {
      if (options.proof !== 'none') {
        const nonce = options.proof === 'wrong-nonce' ? '0'.repeat(32) : sentNonce
        const frame = `CLIWORKER_HERMES_GATEWAY_PID ${nonce} ${actualPid}\r\n`
        // Native stdout chunks can split the process receipt at any byte.
        launch.onStdout(Buffer.from(frame.slice(0, 23)))
        launch.onStdout(Buffer.from(frame.slice(23)))
      }
      if (options.abort) controller.abort()
    })
    return managed
  } }
  const run = () => startHermesServer(config, io, { home: root, env: {} }, port, key, httpLimits({ maxLineBytes: 4096 }))
  return { run, calls, managed, stopCount: () => stopCount, sentNonce: () => sentNonce }
}
it('accepts the actual Windows interpreter proved by the owned entry while the redirector PID differs', async () => {
  const f = await fixture()
  const server = await f.run()
  expect(f.sentNonce()).toMatch(/^[a-f0-9]{32}$/)
  expect(f.calls).toEqual(['/v1/capabilities'])
  expect(server.capabilities.features.run_submission).toBe(true)
  await f.managed.stop()
})
it.each([{ proof: 'none' as const }, { proof: 'wrong-nonce' as const }, { ownEntry: false },
  { writerPid: 4244 }, { stale: true }, { wrongPort: true }])(
  'never sends the bearer secret for unproved, stale or mismatched listener evidence (%j)', async options => {
    const f = await fixture(options)
    await expect(f.run()).rejects.toThrow('启动已中止')
    expect(f.calls).toEqual([])
    expect(f.stopCount()).toBe(1)
  },
)
it('preserves the direct-child PID path without requiring the optional receipt', async () => {
  const f = await fixture({ proof: 'none', rootPid: 4243, ownEntry: false })
  await f.run()
  expect(f.calls).toEqual(['/v1/capabilities'])
  expect(f.sentNonce()).toBeUndefined()
  await f.managed.stop()
})
it('cancels startup and confirms the owned child stop without contacting the endpoint', async () => {
  const f = await fixture({ proof: 'none', abort: true })
  await expect(f.run()).rejects.toThrow()
  expect(f.calls).toEqual([])
  expect(f.stopCount()).toBe(1)
})
it('still rejects a proved endpoint lacking required native capabilities', async () => {
  const f = await fixture({ missingFeature: true })
  await expect(f.run()).rejects.toThrow('缺少 run_stop 能力')
  expect(f.calls).toEqual(['/v1/capabilities'])
  expect(f.stopCount()).toBe(1)
})
