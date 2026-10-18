import { expect, it } from 'vitest'
import { createNativeIO } from '../src/host/native-transport.mjs'
import { closeServer } from '../src/host/native-http.mjs'

// Synthetic local Node processes only. These reproduce the installed Hermes
// signal verdict contract without importing Hermes, accounts, HTTP or a model.
async function fixture(body: string, options = {}) {
  const frames: any[] = []
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const io = createNativeIO({ project: process.cwd(), maxLineBytes: 4096, maxRunBytes: 65536 },
    (line: string) => frames.push(JSON.parse(line)), new AbortController().signal)
  const child = io.spawn([process.execPath, '-e', `${body};console.log('READY');setInterval(()=>{},1000)`],
    { ...options, onStdout: () => ready() })
  await Promise.race([started, child.done.then(() => { throw new Error('Synthetic fixture exited before ready') })])
  io.session('SIMULATED_SESSION')
  io.result('SUCCESS', 'SIMULATED completed response', undefined, 'response')
  return { io, child, frames }
}

it('uses the Hermes planned SIGINT stop and preserves a completed result after confirmed exit zero', async () => {
  const f = await fixture("process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(1))", { stopSignal: 'SIGINT' })
  try {
    expect(await closeServer(f.child)).toEqual(process.platform === 'win32'
      ? { exitCode: null, signal: 'SIGINT' } : { exitCode: 0, signal: null })
    await f.io.close()
    expect(f.frames.at(-1)).toMatchObject({ status: 'SUCCESS', resultScope: 'response' })
  } finally { await f.child.stop() }
})

it('keeps SIGTERM as the default for other native CLI processes', async () => {
  const f = await fixture("process.on('SIGTERM',()=>process.exit(0));process.on('SIGINT',()=>process.exit(7))")
  try {
    expect(await closeServer(f.child)).toEqual(process.platform === 'win32'
      ? { exitCode: null, signal: 'SIGTERM' } : { exitCode: 0, signal: null })
    await f.io.close()
    expect(f.frames.at(-1).status).toBe('SUCCESS')
  } finally { await f.child.stop() }
})

it('does not allow a natural exit one after a nominal successful response', async () => {
  const f = await fixture('setTimeout(()=>process.exit(1),30)', { stopSignal: 'SIGINT' })
  try {
    expect((await f.child.done).exitCode).toBe(1)
    await expect(closeServer(f.child)).rejects.toThrow('原生 HTTP 服务异常退出')
    await f.io.close()
    expect(f.frames.at(-1)).toMatchObject({ status: 'ERROR', error: 'Native process exited unsuccessfully (1)' })
  } finally { await f.child.stop() }
})

it('does not exempt a nonzero exit merely because a planned stop was requested', async () => {
  const f = await fixture("process.stdin.on('data',()=>process.exit(1))", { stopSignal: 'SIGINT' })
  const original = f.child.process.kill.bind(f.child.process)
  // A synthetic native stop receipt produces exit(1) on both operating
  // systems. Windows does not deliver POSIX signal handlers to Node children.
  f.child.process.kill = () => { f.child.process.stdin.write('SIMULATED_STOP'); return true }
  try {
    await expect(closeServer(f.child)).rejects.toThrow('原生 HTTP 服务异常退出')
    await f.io.close()
    expect(f.frames.at(-1).status).toBe('ERROR')
  } finally { f.child.process.kill = original; await f.child.stop() }
})

it('retains spontaneous signal death as failure rather than an owned planned stop', async () => {
  const f = await fixture('', { stopSignal: 'SIGINT' })
  try {
    f.child.process.kill('SIGTERM')
    await f.child.done
    await f.io.close()
    expect(f.frames.at(-1)).toMatchObject({ status: 'ERROR', error: 'Native process exited unsuccessfully (SIGTERM)' })
  } finally { await f.child.stop() }
})

it('escalates an ignored planned stop to SIGKILL and waits for confirmed process exit', async () => {
  const f = await fixture("process.on('SIGINT',()=>{})", { stopSignal: 'SIGINT' })
  const original = f.child.process.kill.bind(f.child.process), signals: string[] = []
  f.child.process.kill = (signal: string) => { signals.push(signal); return signal === 'SIGINT' ? true : original(signal) }
  try {
    expect(await closeServer(f.child)).toEqual({ exitCode: null, signal: 'SIGKILL' })
    expect(f.child.process.signalCode).toBe('SIGKILL')
    expect(signals).toEqual(['SIGINT', 'SIGKILL'])
    await f.io.close()
  } finally { f.child.process.kill = original; await f.child.stop() }
})

it('rejects an unconfirmed stop even after both stop and kill deadlines', async () => {
  const f = await fixture("process.on('SIGINT',()=>{})", { stopSignal: 'SIGINT' })
  const original = f.child.process.kill.bind(f.child.process), signals: string[] = []
  f.child.process.kill = (signal: string) => { signals.push(signal); return true }
  try {
    await expect(closeServer(f.child)).rejects.toThrow('Native process exit is unconfirmed')
    expect(signals).toEqual(['SIGINT', 'SIGKILL'])
  } finally {
    f.child.process.kill = original
    original('SIGKILL')
    await f.child.done
    await f.io.close(new Error('SIMULATED exit could not be confirmed'))
  }
  expect(f.frames.at(-1).status).toBe('ERROR')
})
