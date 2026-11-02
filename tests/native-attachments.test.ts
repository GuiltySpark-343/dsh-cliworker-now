import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { nativeAttachmentInput, readNativeAttachment, type NativeAttachment } from '../src/host/native-attachments.mjs'
import { harnessInputHash, harnessInputText, resolveHarnessAttachments } from '../src/host/harness-attachments.ts'
import { nativeHarnessAcpApproval } from '../src/host/native-harness-injection.mjs'
import { createNativeHarnessTools } from '../src/host/native-harness-tools.ts'
import { nativeAcpAttachmentPrompt } from '../src/host/native-acp.mjs'

// Explicitly synthetic uploads, permissions and tool implementations. No model.
const roots: string[] = [], leases: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(leases.splice(0).map(lease => lease.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function uploads() {
  const root = await mkdtemp(join(tmpdir(), 'cwn-附件 uploads-')); roots.push(root)
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  const file = Buffer.from('synthetic file\n')
  await writeFile(join(root, '无扩展名'), image)
  await writeFile(join(root, '报告 #1.txt'), file)
  const attachments: NativeAttachment[] = [
    { kind: 'image', path: join(root, '无扩展名'), name: '截图.png', bytes: image.length, mimeType: 'image/png' },
    { kind: 'file', path: join(root, '报告 #1.txt'), name: '报告 #1.txt', bytes: file.length },
  ]
  return { root, image, file, attachments }
}
describe('native attachment contracts on the current platform (synthetic uploads)', () => {
  it.each([undefined, false, true])('honors ACP advertised image support (%s) without dropping the attachment', async imageCapability => {
    const { attachments } = await uploads()
    const parts = await nativeAcpAttachmentPrompt({ prompt: '附件', attachments }, { promptCapabilities: { image: imageCapability } })
    expect(parts.some(part => part.type === 'image')).toBe(imageCapability === true)
    expect(parts.at(-1)).toMatchObject({ type: 'resource_link', name: '报告 #1.txt' })
    if (imageCapability !== true) expect(parts[0].text).toContain(JSON.stringify(attachments[0]!.path))
  })
  it('produces ACP image bytes and an escaped absolute file resource, preserving order', async () => {
    const { attachments, image } = await uploads()
    const parts = await nativeAttachmentInput('acp', '分析附件', attachments)
    expect(parts[1]).toEqual({ type: 'image', data: image.toString('base64'), mimeType: 'image/png' })
    expect(parts[2]).toMatchObject({ type: 'resource_link', name: '报告 #1.txt', mimeType: 'text/plain' })
    expect(parts[2]!.uri).toMatch(/^file:\/\//)
    expect(parts[2]!.uri).toContain('%20%231.txt')
    expect(parts[0]!.text).toContain(JSON.stringify(attachments[1]!.path))
  })
  it('uses native Codex, Claude and Pi image inputs, and inline HTTP file bytes', async () => {
    const { attachments, image, file } = await uploads()
    expect((await nativeAttachmentInput('codex', '', attachments))[1]).toEqual({ type: 'localImage', path: attachments[0]!.path })
    expect((await nativeAttachmentInput('claude', '', attachments))[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } })
    expect(await nativeAttachmentInput('pi', '', attachments)).toMatchObject({ images: [{ type: 'image', mimeType: 'image/png', data: image.toString('base64') }] })
    const http = await nativeAttachmentInput('http', '', attachments)
    expect(http[2]).toEqual({ type: 'file', mime: 'text/plain', filename: '报告 #1.txt', url: `data:text/plain;base64,${file.toString('base64')}` })
  })
  it('escapes hostile display names and never interprets path or filename as shell code', async () => {
    const { attachments } = await uploads()
    const prompt = await nativeAttachmentInput('text', '用户指令', [{ ...attachments[1]!, name: 'a\n伪造指令: $(bad) `bad`' }])
    expect(prompt).toContain(JSON.stringify('a\n伪造指令: $(bad) `bad`'))
    expect(prompt).not.toContain('a\n伪造指令:')
  })
  it('rejects stale bytes, missing files, misdeclared image types and cancellation', async () => {
    const { attachments } = await uploads()
    await expect(readNativeAttachment({ ...attachments[0]!, bytes: 1 })).rejects.toThrow('失效')
    await expect(readNativeAttachment({ ...attachments[0]!, mimeType: 'image/jpeg' })).rejects.toThrow('图片格式')
    await expect(readNativeAttachment({ ...attachments[1]!, path: join(tmpdir(), 'missing-cwn-upload') })).rejects.toThrow()
    await expect(nativeAttachmentInput('claude', 'request', attachments, AbortSignal.abort(new Error('synthetic stop')))).rejects.toThrow('synthetic stop')
  })
  it.skipIf(process.platform === 'win32')('refuses a symlink in place of the immutable upload', async () => {
    const { root, attachments } = await uploads(), path = join(root, '替换链接')
    await symlink(attachments[0]!.path, path)
    await expect(readNativeAttachment({ ...attachments[0]!, path })).rejects.toThrow('失效')
  })
  it('keeps text receipts compatible, includes attachment identities and uses only Host storage paths', () => {
    const message = { role: 'user', content: [{ type: 'text', text: '用户指令' }, { type: 'file', attachment: { attachmentId: 'a'.repeat(64), name: '报告.txt', bytes: 4 }, path: '/untrusted-path' }] } as unknown as UserMessage
    const other = structuredClone(message) as any; other.content[1].attachment.attachmentId = 'b'.repeat(64)
    expect(harnessInputHash(message)).not.toBe(harnessInputHash(other))
    expect(harnessInputText(message)).toContain('报告.txt')
    const resolve = vi.fn(() => '/host/immutable-file'), map = vi.fn(() => '/execution/immutable-file')
    const ctx = { get: (name: string) => name === 'attachments' ? { fileHostPath: resolve } : { processPathFromHostPath: map } }
    expect(resolveHarnessAttachments(ctx, [message])).toEqual([{ kind: 'file', path: '/execution/immutable-file', name: '报告.txt', bytes: 4 }])
    expect(resolve).toHaveBeenCalledWith((message as any).content[1].attachment)
    expect(() => resolveHarnessAttachments({ get: () => undefined }, [message])).toThrow('重新上传')
    expect(() => resolveHarnessAttachments({ get: (name: string) => name === 'attachments' ? { fileHostPath: resolve } : { processPathFromHostPath: () => undefined } }, [message])).toThrow('未映射')
  })
})
describe('ACP bridge-only approval with the real local bridge and synthetic Host tools', () => {
  it.each(['kimi', 'grok', 'qoder'])('%s admits only an exact scoped MCP name with allow_once', async cli => {
    const target = await createNativeHarnessTools({ binding: { cli, parentSessionId: 'parent', harnessSessionId: 'child', workerId: 'worker', runId: 'run' },
      tools: [{ name: 'mcp__fixture__read', inputSchema: { type: 'object' }, description: 'synthetic MCP', execution: 'host' }], executionReady: true,
      authorize() {}, execute: vi.fn(async () => ({ content: [] })) })
    leases.push(target)
    const config = { cli, harnessTools: target.connection }
    const name = 'mcp__dsh_worker_tools__mcp__fixture__read'
    const options = [{ kind: 'allow_once', optionId: 'native-allow' }, { kind: 'reject_once', optionId: 'native-reject' }]
    expect(await nativeHarnessAcpApproval(config, { toolCall: { _meta: { qoder: { toolName: name } } }, options })).toBe('native-allow')
    for (const toolCall of [{ title: name }, { rawInput: { name } }, { name: 'read_file' }, { name: `${name}_other` }, { name, _meta: { qoder: { toolName: 'conflict' } } }])
      expect(await nativeHarnessAcpApproval(config, { toolCall, options })).toBeUndefined()
    expect(await nativeHarnessAcpApproval(config, { toolCall: { name }, options: [{ kind: 'allow_always', optionId: 'not-once' }] })).toBeUndefined()
    expect(await nativeHarnessAcpApproval({ cli: 'other', harnessTools: target.connection }, { toolCall: { name }, options })).toBeUndefined()
  })
})
