import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile, link, symlink, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { createPiOmpControl, receivePiOmpControl, nativeControlPathKey } from '../src/host/pi-omp-control.mjs'

const roots: string[] = []
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(timeoutMs = 400) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cwn-control-simulated-')))
  roots.push(root)
  const directory = join(root, 'control'),
    client = await createPiOmpControl(directory, { timeoutMs })
  cleanup.push(client.close)
  return { root, directory, client }
}

describe('run-private native steering mailbox (simulated, no CLI/model)', () => {
  it('matches Windows native and namespaced directory identities without changing POSIX case', () => {
    expect(nativeControlPathKey('C:\\Users\\Example\\control', 'win32')).toBe(
      nativeControlPathKey('\\\\?\\C:\\Users\\Example\\control', 'win32'),
    )
    expect(nativeControlPathKey('\\\\server\\share\\control', 'win32')).toBe(
      nativeControlPathKey('\\\\?\\UNC\\server\\share\\control', 'win32'),
    )
    expect(nativeControlPathKey('/private/Tmp/control', 'darwin')).not.toBe(
      nativeControlPathKey('/private/tmp/control', 'darwin'),
    )
  })

  it('awaits native acceptance and sends duplicate requests exactly once', async () => {
    const { directory, client } = await fixture()
    const accepted = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    const server = await receivePiOmpControl(directory, client.nonce, accepted)
    cleanup.unshift(server.close)
    await Promise.all([
      client.steer('literal $(no shell)', 'request-1'),
      client.steer('literal $(no shell)', 'request-1'),
    ])
    expect(accepted).toHaveBeenCalledOnce()
    expect(accepted).toHaveBeenCalledWith('literal $(no shell)', 'request-1', expect.any(String))
    await expect(client.steer('different message', 'request-1')).rejects.toThrow('其他消息')
  })

  it('retries only a definite rejection with a distinct attempt and native id', async () => {
    const { directory, client } = await fixture()
    let calls = 0
    const accepted = vi.fn(async (_message: string, _requestId: string, _attempt: string) => {
      if (++calls === 1) throw Object.assign(new Error('native refusal'), { code: 'STEER_REJECTED' })
    })
    const server = await receivePiOmpControl(directory, client.nonce, accepted)
    cleanup.unshift(server.close)
    await expect(client.steer('reject', 'one')).rejects.toMatchObject({ code: 'STEER_REJECTED' })
    await expect(client.steer('reject', 'one')).resolves.toBeUndefined()
    expect(accepted.mock.calls[0]![2]).not.toBe(accepted.mock.calls[1]![2])
    await expect(client.steer('accept', 'two')).resolves.toBeUndefined()
    expect(accepted).toHaveBeenCalledTimes(3)
  })

  it('never retries an uncertain native outcome and bounds definite rejection attempts', async () => {
    const { directory, client } = await fixture()
    const accepted = vi.fn(async (message) => { throw Object.assign(new Error('unknown'), message === 'reject' ? { code: 'STEER_REJECTED' } : {}) })
    const server = await receivePiOmpControl(directory, client.nonce, accepted)
    cleanup.unshift(server.close)
    await expect(client.steer('unknown', 'unknown')).rejects.toThrow('未确认')
    await expect(client.steer('unknown', 'unknown')).rejects.toThrow('未确认')
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(client.steer('reject', 'retry')).rejects.toMatchObject({ code: 'STEER_REJECTED' })
    await expect(client.steer('reject', 'retry')).rejects.toThrow('次数已达上限')
    expect(accepted).toHaveBeenCalledTimes(4)
  })

  it('preserves a published native success when process cleanup aborts before the next poll', async () => {
    const { directory, client } = await fixture()
    const id = 'receipt-before-abort', message = 'accepted before cleanup'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = client.steer(message, id)
      // Let filesystem work complete, then freeze the waiter at its first poll.
      while (vi.getTimerCount() === 0) await new Promise(resolve => setImmediate(resolve))
      const filename = (await readdir(directory)).find(name => name.endsWith('.request.json'))!
      const command = JSON.parse(await readFile(join(directory, filename), 'utf8'))
      await writeFile(join(directory, filename.replace('.request.', '.receipt.')), JSON.stringify({
        nonce: client.nonce, id, attempt: command.attempt, digest: createHash('sha256').update(message).digest('hex'), success: true,
      }), { mode: 0o600 })
      const closing = client.close()
      await vi.advanceTimersByTimeAsync(25)
      await closing
      await expect(pending).resolves.toBeUndefined()
      await expect(client.steer(message, id)).resolves.toBeUndefined()
    } finally { vi.useRealTimers() }
  })

  it('reports closed, aborted and missing acknowledgements without replay', async () => {
    const { directory, client } = await fixture(80)
    await expect(client.steer('never acknowledged', 'timeout')).rejects.toThrow('超时')
    const server = await receivePiOmpControl(directory, client.nonce, async () => undefined)
    await server.close()
    await expect(client.steer('after close', 'closed')).rejects.toThrow('关闭')
    const signal = AbortSignal.abort()
    await expect(client.steer('cancelled', 'aborted', signal)).rejects.toThrow('取消')
    await client.close()
    await expect(client.steer('disposed', 'disposed')).rejects.toThrow('关闭')
  })

  it('never executes a forged nonce or unsupported command', async () => {
    const { directory, client } = await fixture()
    const accepted = vi.fn(async () => undefined)
    const server = await receivePiOmpControl(directory, client.nonce, accepted)
    cleanup.unshift(server.close)
    for (const [id, type, nonce] of [
      ['forged', 'steer', 'wrong'],
      ['command', 'shell', client.nonce],
    ]) {
      const attempt = randomUUID(), key = createHash('sha256').update(`${id}:${attempt}`).digest('hex')
      await writeFile(
        join(directory, `${key}.request.json`),
        JSON.stringify({ id, attempt, type, nonce, message: 'bad' }),
      )
    }
    await client.steer('valid', 'valid')
    expect(accepted).toHaveBeenCalledExactlyOnceWith('valid', 'valid', expect.any(String))
  })

  it('rejects linked receipt files without following or altering their target', async () => {
    for (const kind of ['hard', 'symbolic'] as const) {
      const { root, directory, client } = await fixture()
      const source = join(root, 'outside.json')
      await writeFile(source, '{"private":"unchanged"}')
      const pending = client.steer('safe', kind)
      const assertion = expect(pending).rejects.toThrow()
      let filename = ''
      await vi.waitFor(async () => { filename = (await readdir(directory)).find(name => name.endsWith('.request.json')) ?? ''; expect(filename).not.toBe('') })
      await (kind === 'hard' ? link : symlink)(source, join(directory, filename.replace('.request.', '.receipt.')))
      await assertion
      expect(await readFile(source, 'utf8')).toBe('{"private":"unchanged"}')
    }
  })
})
