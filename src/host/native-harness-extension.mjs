// Explicit, run-scoped Pi extension. No user extensions or configuration are loaded.
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNativeHarnessClient, readNativeHarnessConnection } from './native-harness-mcp.mjs'

export const nativeHarnessExtensionToolName = name => `dsh_${createHash('sha256').update(name).digest('hex').slice(0, 20)}_${name.replace(/[^A-Za-z0-9_]/gu, '_').slice(0, 24)}`
async function catalogue(client, signal) {
  const value = await client.request('catalogue', 'tools/list', {}, signal)
  if (!value || !Array.isArray(value.tools) || value.tools.length > 256 || value.tools.some(tool =>
    !tool || typeof tool.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/u.test(tool.name) || typeof tool.description !== 'string' ||
    !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema))) throw new Error('DSH 工具目录无效')
  if (new Set(value.tools.map(tool => tool.name)).size !== value.tools.length) throw new Error('DSH 工具目录重名')
  return value.tools
}
/** Query only schemas before launch so --tools can remain an exact whitelist. */
export async function prepareNativeHarnessExtension(connection, { signal, entryPath = join(dirname(fileURLToPath(import.meta.url)), 'native-harness-extension.mjs') } = {}) {
  if (!connection || connection.executionReady !== true) return { argv: [], tools: [] }
  if (connection.binding.cli !== 'pi') throw new Error('当前 CLI 的隔离工具扩展尚未核验')
  const client = createNativeHarnessClient(connection)
  const tools = await catalogue(client, signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000))
  return { argv: ['--extension', entryPath], tools: tools.map(tool => nativeHarnessExtensionToolName(tool.name)) }
}

export default async function nativeHarnessExtension(api) {
  const connection = readNativeHarnessConnection()
  if (!connection || connection.binding.cli !== 'pi' || connection.executionReady !== true) throw new Error('DSH 工具扩展没有当前运行授权')
  const client = createNativeHarnessClient(connection)
  const tools = await catalogue(client, AbortSignal.timeout(5_000))
  for (const tool of tools) api.registerTool({
    name: nativeHarnessExtensionToolName(tool.name), label: `DSH ${tool.name}`,
    description: `${tool.name}: ${tool.description}`, parameters: tool.inputSchema,
    // Pi's explicit --tools remains in force. Host
    // checks the live child/run identity and its permission chain on every call.
    async execute(toolCallId, args, signal) {
      if (typeof toolCallId !== 'string' || !toolCallId || toolCallId.length > 512) throw new Error('DSH 工具调用身份无效')
      signal?.throwIfAborted()
      let cancellation
      const abort = () => { cancellation ??= client.cancel(toolCallId, AbortSignal.timeout(5_000)).catch(() => {}) }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        const result = await client.request(toolCallId, 'tools/call', { name: tool.name, arguments: args }, signal)
        signal?.throwIfAborted()
        if (!result || !Array.isArray(result.content) || result.content.some(part => !part || part.type !== 'text' || typeof part.text !== 'string')) throw new Error('DSH 工具结果无效')
        return { content: result.content, details: { source: 'dsh-worker-tools', tool: tool.name }, ...(result.isError === true ? { isError: true } : {}) }
      } catch (error) {
        throw new Error(error instanceof Error && error.nativeHarnessPublicError === true ? error.message : 'DSH 工具调用状态无法确认；未自动重试')
      } finally {
        signal?.removeEventListener('abort', abort)
        await cancellation
      }
    },
  })
}
