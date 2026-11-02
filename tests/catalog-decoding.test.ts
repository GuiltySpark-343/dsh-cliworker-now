import { expect, it } from 'vitest'
import { PassThrough, Readable } from 'node:stream'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { captureCatalogMetadata } from '../src/host/adapters.ts'
import { DEFAULT_CONFIG, discoverModels, type ProcessBackend } from '../src/host/process.ts'

// Simulated CLI output: every byte arrives as its own chunk, so each multi-byte
// UTF-8 character is split across chunk boundaries. No CLI is executed.
function backend(text: string): ProcessBackend {
  return {
    resolveExecutable: async (name) => name,
    spawn: () => {
      // Readable.from keeps each Buffer as a separate chunk.
      const stdout = Readable.from([...Buffer.from(text, 'utf8')].map((byte) => Buffer.from([byte]))),
        stderr = new PassThrough()
      stderr.end()
      return {
        stdout,
        stderr,
        done: Promise.resolve({ exitCode: 0 }),
        terminate: () => {},
        waitForExit: async () => true,
      } as unknown as SubprocessHandle
    },
  }
}

it('decodes split multi-byte characters in captured catalog metadata', async () => {
  const text = '{"models":[{"id":"synthetic","name":"模拟模型·中文"}]}\n'
  const output = await captureCatalogMetadata(backend(text), DEFAULT_CONFIG, ['synthetic-cli'], '/', new AbortController().signal)
  expect(output).toBe(text)
  expect(output).not.toContain('�')
})

it('decodes split multi-byte characters in the Antigravity model catalog', async () => {
  const models = await discoverModels(backend('synthetic-model\t模拟 模型\n'), DEFAULT_CONFIG, '/', new AbortController().signal)
  expect(models).toEqual([{ id: 'synthetic-model', label: '模拟 模型' }])
})
