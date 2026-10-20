import { expect, it, vi } from 'vitest'
import { PassThrough, Readable } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ProcessBackend } from '../src/host/process.ts'
import { spawnWindowsHidden } from '../src/host/windows-hidden-process.ts'
import { spawnManagedAgent } from '../src/host/managed-agent.ts'
import { HARNESS_CONNECTION_ENV, runNativeHarnessMcp } from '../src/host/native-harness-mcp.mjs'

// Simulated process streams only: each UTF-8 byte is delivered separately.
const splitBytes = (text: string) => [...Buffer.from(text)].map(byte => Buffer.from([byte]))
const spec: SubprocessSpawnSpec = {
  argv: ['SIMULATED-cli'], cwd: process.cwd(),
  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
}

it('decodes a Windows receipt split byte by byte before parsing it', async () => {
  const receipt = { kind: 'exit', exitCode: 7, signal: null, detail: '模拟路径/中文模型' }
  const inner = {
    control: Readable.from(splitBytes(JSON.stringify(receipt))),
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: vi.fn(), waitForExit: async () => true,
  } as unknown as SubprocessHandle
  const backend = { spawn: () => inner } as unknown as ProcessBackend
  // Public exit facts are ASCII only and omit receipt details. Observe the
  // parsed receipt to check UTF-8 integrity at this stream's decoding boundary.
  const parse = vi.spyOn(JSON, 'parse')
  try {
    await expect(spawnWindowsHidden(backend, spec).done).resolves.toEqual({ exitCode: 7, signal: null })
    expect(parse.mock.results.map(result => result.value)).toContainEqual(receipt)
  } finally { parse.mockRestore() }
})

it.each(['end', 'close'] as const)('flushes an incomplete UTF-8 sequence when the receipt stream emits %s', async event => {
  const control = new PassThrough()
  const inner = {
    control, done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: vi.fn(), waitForExit: async () => true,
  } as unknown as SubprocessHandle
  const handle = spawnWindowsHidden({ spawn: () => inner } as unknown as ProcessBackend, spec)
  control.write(JSON.stringify({ kind: 'exit', exitCode: 0, signal: null }))
  control.write(Buffer.from([0xe4]))
  if (event === 'end') control.end()
  else control.destroy()
  await expect(handle.done).rejects.toThrow('回执异常')
})

it.skipIf(process.platform === 'win32')('preserves a split multi-byte terminal bridge error', async () => {
  const message = '模拟错误：找不到中文路径/模型'
  const terminal = {
    output: Readable.from(splitBytes(JSON.stringify({ channel: 'error', message }) + '\n')),
    done: Promise.resolve({ exitCode: 1, signal: null }),
    inspectForeground: async () => undefined,
    terminate: vi.fn(async () => {}),
  }
  const backend = { spawnTerminal: async () => terminal } as unknown as ProcessBackend
  const handle = await spawnManagedAgent(backend, spec)
  handle.stdout!.on('error', () => {})
  handle.stderr!.on('error', () => {})
  try {
    await expect(handle.done).rejects.toThrow(message)
  } finally { await handle.waitForExit() }
})

it('keeps split multi-byte MCP input intact through its existing UTF-8 string stream', async () => {
  const input = new PassThrough(), output = new PassThrough()
  const chunks: Buffer[] = []
  output.on('data', chunk => chunks.push(chunk))
  const carrier = runNativeHarnessMcp({ input, output, env: {
    [HARNESS_CONNECTION_ENV]: JSON.stringify({ url: 'http://127.0.0.1:1/rpc', token: 'A'.repeat(43), binding: {} }),
  } })
  try {
    for (const byte of splitBytes(JSON.stringify({ jsonrpc: '2.0', id: '模拟中文路径/模型', method: 'ping' }) + '\n')) input.write(byte)
    input.end()
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual({ jsonrpc: '2.0', id: '模拟中文路径/模型', result: {} })
  } finally { await carrier.close() }
})
