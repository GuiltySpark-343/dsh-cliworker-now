import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import {
  createNativeStopControl,
  receiveNativeStopControl,
  createPiOmpControl,
} from '../src/host/pi-omp-control.mjs'

vi.mock('../src/host/cli-account-binding.ts', () => ({
  readCliAccountBinding: async () => 'synthetic-account',
}))
vi.mock('../src/host/authorized-catalog.ts', () => ({
  ACCOUNT_CHANGED: 'changed',
  authorizeSelection: async (preference: unknown) => ({ binding: 'synthetic-account', preference }),
}))
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) {
    try {
      await close()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Synthetic stop fixture cleanup failed')
})
const directory = () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-native-stop-')))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}
it('delivers a run-scoped native cancel before Host terminates and confirms the owned range', async () => {
  const project = directory(),
    order: string[] = []
  let ready!: () => void, rejectReady!: (error: unknown) => void
  const readyPromise = new Promise<void>((resolve, reject) => {
    ready = resolve
    rejectReady = reject
  })
  let receiver: Awaited<ReturnType<typeof receiveNativeStopControl>>
  let receiverCleanup: Promise<void> | undefined
  const closeReceiver = () => (receiverCleanup ??= receiver ? receiver.close() : Promise.resolve())
  const backend: ProcessBackend = {
    resolveExecutable: async () => '/synthetic/agy',
    spawn(spec) {
      const request = JSON.parse(readFileSync(spec.argv.at(-1)!, 'utf8'))
      const stdout = new PassThrough(),
        stderr = new PassThrough()
      let settle!: (value: { exitCode: number }) => void,
        ended = false
      const done = new Promise<{ exitCode: number }>((resolve) => {
        settle = resolve
      })
      const terminate = () => {
        if (ended) return
        ended = true
        order.push('range-terminate')
        // The real bridge closes its receiver before its process exit receipt.
        // Host cleanup may remove the mailbox immediately after that receipt.
        void closeReceiver().finally(() => {
          stdout.end()
          stderr.end()
          settle({ exitCode: 143 })
        })
      }
      void receiveNativeStopControl(request.stopDirectory, request.stopNonce, async () => {
        order.push('native-cancel')
      })
        .then((value) => {
          receiver = value
          stdout.write(JSON.stringify({ type: 'session', id: 'synthetic-stop' }) + '\n')
          ready()
        })
        .catch(rejectReady)
      spec.signal?.addEventListener('abort', terminate, { once: true })
      return {
        stdout,
        stderr,
        done,
        terminate,
        waitForExit: async () => {
          await done
          order.push('exit-confirmed')
          return true
        },
      } as SubprocessHandle
    },
  }
  const storage = new WorkerStorage(join(project, 'state'))
  const runtime = new WorkerRuntime(storage, backend, DEFAULT_CONFIG)
  cleanups.push(() => runtime.close())
  cleanups.push(closeReceiver)
  const task = runtime.submit(
    'parent',
    project,
    'synthetic',
    'synthetic stop',
    { model: 'synthetic-model', effort: 'low' },
    'accept-edits',
  )
  await Promise.race([
    readyPromise,
    task.done.then((worker) => {
      throw new Error(`Synthetic task exited before ready: ${worker.status}`)
    }),
  ])
  const stopped = await runtime.stop('parent', task.worker.id)
  expect(stopped.status).toBe('interrupted')
  expect(stopped.interruptionReason).toBe('user')
  expect(order).toEqual(['native-cancel', 'range-terminate', 'exit-confirmed'])
  await expect(task.done).resolves.toMatchObject({ status: 'interrupted' })
  await closeReceiver()
})
it('keeps native cancellation normal when exit 1 and warning stderr arrive before Host polls its receipt', async () => {
  const project = directory()
  let ready!: () => void
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve
  })
  let receiver: Awaited<ReturnType<typeof receiveNativeStopControl>>
  const backend: ProcessBackend = {
    resolveExecutable: async () => '/synthetic/agy',
    spawn(spec) {
      const request = JSON.parse(readFileSync(spec.argv.at(-1)!, 'utf8'))
      const stdout = new PassThrough(),
        stderr = new PassThrough()
      let settle!: (value: { exitCode: number }) => void,
        ended = false
      const done = new Promise<{ exitCode: number }>((resolve) => {
        settle = resolve
      })
      const finish = async () => {
        if (ended) return
        ended = true
        await receiver.close()
        stdout.end()
        stderr.end()
        settle({ exitCode: 1 })
      }
      void receiveNativeStopControl(request.stopDirectory, request.stopNonce, async () => {
        stderr.write('Synthetic SQLite warning\n')
        stdout.write(
          JSON.stringify({ type: 'result', status: 'ERROR', response: '', error: '任务已停止' }) + '\n',
        )
        setTimeout(() => {
          void finish()
        }, 0)
      }).then((value) => {
        receiver = value
        stdout.write(JSON.stringify({ type: 'session', id: 'synthetic-native-stop' }) + '\n')
        ready()
      })
      spec.signal?.addEventListener(
        'abort',
        () => {
          void finish()
        },
        { once: true },
      )
      return {
        stdout,
        stderr,
        done,
        terminate() {
          void finish()
        },
        waitForExit: async () => {
          await done
          return true
        },
      } as SubprocessHandle
    },
  }
  const storage = new WorkerStorage(join(project, 'state'))
  const runtime = new WorkerRuntime(storage, backend, DEFAULT_CONFIG)
  cleanups.push(() => runtime.close())
  const task = runtime.submit(
    'parent',
    project,
    'synthetic',
    'cancel race',
    { model: 'synthetic-model', effort: 'low' },
    'accept-edits',
  )
  await readyPromise
  const result = await runtime.stop('parent', task.worker.id)
  expect(result).toMatchObject({ status: 'interrupted', interruptionReason: 'user' })
  expect(result.error).toBeUndefined()
})
it('keeps the stop mailbox distinct from the steering command namespace', async () => {
  const path = directory()
  const control = await createPiOmpControl(join(path, 'control'), { timeoutMs: 60 })
  const called = vi.fn(async () => {})
  const receiver = await receiveNativeStopControl(join(path, 'control'), control.nonce, called)
  cleanups.push(async () => {
    await receiver.close()
    await control.close()
  })
  await expect(control.steer('untrusted arbitrary text', 'synthetic')).rejects.toThrow('超时')
  expect(called).not.toHaveBeenCalled()
})
it('deduplicates stop delivery and waits for the native cancellation handler before acknowledging', async () => {
  const path = directory()
  const control = await createNativeStopControl(join(path, 'stop'))
  let received = 0,
    release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const receiver = await receiveNativeStopControl(join(path, 'stop'), control.nonce, async () => {
    received++
    await gate
  })
  cleanups.push(async () => {
    release()
    await receiver.close()
    await control.close()
  })
  const first = control.stop(),
    second = control.stop()
  expect(first).toBe(second)
  let complete = false
  void first.then(() => {
    complete = true
  })
  await vi.waitFor(() => expect(received).toBe(1))
  expect(complete).toBe(false)
  release()
  await first
})
