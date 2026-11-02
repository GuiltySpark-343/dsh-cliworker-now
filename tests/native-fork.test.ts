import { afterEach, describe, expect, it, vi } from 'vitest'
import { workerArguments } from '../src/host/adapters.ts'
import { forkNativeCodex } from '../src/host/native-codex.mjs'
import { nativeClaudeArgv } from '../src/host/native-claude.mjs'
import { forkNativeKimi } from '../src/host/native-kimi.mjs'
import { forkNativeQoder } from '../src/host/native-qoder.mjs'
import { forkNativeZcode } from '../src/host/native-zcode.mjs'
import { forkNativeOpenCode } from '../src/host/native-opencode.mjs'
import { forkNativeMimo } from '../src/host/native-mimo.mjs'
import { httpJson, startSessionServer, closeServer } from '../src/host/native-http.mjs'

vi.mock('../src/host/native-http.mjs', async (original) => ({
  ...await original<typeof import('../src/host/native-http.mjs')>(),
  startSessionServer: vi.fn(async () => ({ base: 'http://127.0.0.1:0', headers: { Authorization: '模拟回环认证' }, managed: '模拟服务进程' })),
  httpJson: vi.fn(async () => ({ id: '模拟新原生ID' })),
  closeServer: vi.fn(async () => {}),
}))
afterEach(() => vi.clearAllMocks())
// 模拟各 CLI 的原生响应；没有网络服务、真实账号或模型调用。
function fixture(cli: string, override: Record<string, unknown> = {}) {
  const config = { cli, project: '/模拟项目', prompt: '模拟元数据', mode: 'accept-edits', conversationId: '模拟原生ID',
    preference: { cli, model: cli === 'zcode' || cli === 'opencode' || cli === 'mimo' ? '模拟提供商/模拟模型' : '模拟模型', effort: 'default' },
    forkOperation: 'fork', maxRunBytes: 1000000, maxLineBytes: 100000, timeoutMs: 10000, env: {}, ...override } as any
  config.argv = cli === 'opencode' ? ['opencode', 'run', '--session', config.conversationId, config.prompt]
    : cli === 'zcode' ? ['zcode', '--cwd', config.project, '--mode', 'edit', '--resume', config.conversationId, '--prompt', config.prompt]
    : workerArguments(cli, config.project, config.preference, config.mode, config.prompt, config.timeoutMs, config.conversationId, true)
  const peer = { request: vi.fn(async (method: string) => {
    if (method === 'initialize') return { agentCapabilities: { sessionCapabilities: { fork: {}, delete: {}, close: {} } } }
    if (method === 'thread/fork') return { thread: { id: '模拟新原生ID' } }
    if (method === 'session/fork') return { sessionId: '模拟新原生ID', forkedSessionId: '模拟新原生ID' }
    if (method === 'session/resume') return { session: { sessionId: config.conversationId, workspace: { workspacePath: config.project } } }
    if (method === 'session/messages') return { messages: [
      { info: { role: 'assistant', id: '模拟前轮助手' }, parts: [] },
      { info: { role: 'user', id: '模拟最新用户' }, parts: [] },
      { info: { role: 'assistant', id: '模拟最新助手' }, parts: [] },
    ] }
    return {}
  }), send: vi.fn(async () => {}), onMessage: vi.fn(() => vi.fn()), close: vi.fn(async () => {}) }
  const io = { openStdio: vi.fn(async () => peer), native: vi.fn(), result: vi.fn(), signal: new AbortController().signal }
  return { config, peer, io }
}

describe('模拟：Codex app-server 原生分支参数', () => {
  it.each([undefined, { turnId: '原生完成轮' }])('forks with inclusive lastTurnId=%j and no turn/start', async (forkAt) => {
    const f = fixture('codex', { forkAt })
    await forkNativeCodex(f.config, f.io)
    expect(f.io.openStdio.mock.calls[0]![0]).toEqual(['codex', 'app-server', '--stdio', '-c', 'model_reasoning_effort="default"', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"'])
    expect(f.peer.request).toHaveBeenCalledWith('thread/fork', expect.objectContaining({ threadId: '模拟原生ID',
      ...(forkAt ? { lastTurnId: '原生完成轮' } : {}), approvalPolicy: 'never', sandbox: 'workspace-write' }))
    expect(f.peer.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
    expect(f.io.native).toHaveBeenCalledWith({ type: 'cliworker.fork_created', id: '模拟新原生ID' })
    expect(f.peer.close).toHaveBeenCalledOnce()
  })
  it('rejects a reused native session ID', async () => {
    const f = fixture('codex'); f.peer.request.mockImplementation(async (method) => method === 'thread/fork' ? { thread: { id: f.config.conversationId } } : {})
    await expect(forkNativeCodex(f.config, f.io)).rejects.toThrow('新的原生会话')
    expect(f.io.native).not.toHaveBeenCalled(); expect(f.peer.close).toHaveBeenCalledOnce()
  })
  it('archives rollback resources and reports that permanent deletion is unavailable', async () => {
    const f = fixture('codex', { forkOperation: 'delete' })
    await forkNativeCodex(f.config, f.io)
    expect(f.peer.request).toHaveBeenCalledWith('thread/archive', { threadId: '模拟原生ID' })
    expect(f.io.native).toHaveBeenCalledWith(expect.objectContaining({ note: expect.stringContaining('未提供永久删除') }))
  })
})

describe('模拟：ACP 原生分支独立于 prompt', () => {
  it.each([['kimi', forkNativeKimi], ['qoder', forkNativeQoder], ['qodercn', forkNativeQoder]] as const)('%s uses its native ACP entry and standard fork response', async (cli, run) => {
    const f = fixture(cli)
    await run(f.config, f.io)
    expect(f.io.openStdio.mock.calls[0]![0]).toContain(cli === 'kimi' ? 'acp' : '--acp')
    expect(f.peer.request).toHaveBeenCalledWith('session/fork', { sessionId: '模拟原生ID', cwd: '/模拟项目', mcpServers: [] }, { jsonrpc: true })
    expect(f.peer.request.mock.calls.some(([method]) => method === 'session/prompt')).toBe(false)
    expect(f.io.native).toHaveBeenCalledWith({ type: 'cliworker.fork_created', id: '模拟新原生ID' })
    expect(f.peer.request).toHaveBeenCalledWith('session/close', { sessionId: '模拟新原生ID' }, { jsonrpc: true })
  })
  it('checks advertised fork support and closes transport on refusal', async () => {
    const f = fixture('kimi'); f.peer.request.mockResolvedValue({ agentCapabilities: {} })
    await expect(forkNativeKimi(f.config, f.io)).rejects.toThrow('未确认')
    expect(f.peer.close).toHaveBeenCalledOnce()
  })
  it('deletes only the newly assigned branch on rollback', async () => {
    const f = fixture('qoder', { forkOperation: 'delete', conversationId: '新分支ID' })
    await forkNativeQoder(f.config, f.io)
    expect(f.peer.request).toHaveBeenCalledWith('session/delete', { sessionId: '新分支ID', cwd: '/模拟项目', mcpServers: [] }, { jsonrpc: true })
    expect(f.peer.request.mock.calls.some(([method]) => method === 'session/fork')).toBe(false)
  })
})

describe('模拟：HTTP SDK Session.fork', () => {
  it.each([['opencode', forkNativeOpenCode], ['mimo', forkNativeMimo]] as const)('%s forks without sending any task', async (cli, run) => {
    const f = fixture(cli)
    await run(f.config, f.io)
    expect(startSessionServer).toHaveBeenCalledWith(f.config, f.io, cli)
    expect(httpJson).toHaveBeenCalledWith('http://127.0.0.1:0', '/session/%E6%A8%A1%E6%8B%9F%E5%8E%9F%E7%94%9FID/fork?directory=%2F%E6%A8%A1%E6%8B%9F%E9%A1%B9%E7%9B%AE',
      expect.objectContaining({ method: 'POST', body: {} }))
    expect(f.io.native).toHaveBeenCalledWith({ type: 'cliworker.fork_created', id: '模拟新原生ID' })
    expect(closeServer).toHaveBeenCalledOnce()
  })
  it('uses the SDK messageID spelling when an exact native cutoff is supplied', async () => {
    const f = fixture('opencode', { forkAt: { messageId: '原生消息ID' } })
    await forkNativeOpenCode(f.config, f.io)
    expect(httpJson).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ body: { messageID: '原生消息ID' } }))
  })
  it('deletes only the fork session on rollback', async () => {
    const f = fixture('mimo', { forkOperation: 'delete', conversationId: 'branch' })
    await forkNativeMimo(f.config, f.io)
    expect(httpJson).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('/session/branch?'), expect.objectContaining({ method: 'DELETE' }))
  })
  it('closes the HTTP service after native failure', async () => {
    const f = fixture('opencode'); vi.mocked(httpJson).mockRejectedValueOnce(new Error('模拟原生失败'))
    await expect(forkNativeOpenCode(f.config, f.io)).rejects.toThrow('模拟原生失败')
    expect(closeServer).toHaveBeenCalledOnce()
  })
})

describe('模拟：ZCode 与 Claude 独立协议', () => {
  it('forks ZCode latest assistant inclusively without a workspace checkpoint or session/send', async () => {
    const f = fixture('zcode')
    const request = f.peer.request.getMockImplementation()!
    f.peer.request.mockImplementation(async (method: string, params?: any) => {
      if (method === 'session/fork' && params?.target?.kind !== 'message')
        throw new Error('No workspace checkpoint is available yet.')
      return request(method)
    })
    await forkNativeZcode(f.config, f.io)
    expect(f.peer.request).toHaveBeenCalledWith('session/messages', { sessionId: '模拟原生ID' }, { jsonrpc: false })
    expect(f.peer.request).toHaveBeenCalledWith('session/fork', { sessionId: '模拟原生ID', target: { kind: 'message', messageId: '模拟最新助手' } }, { jsonrpc: false })
    expect(f.peer.request.mock.calls.findIndex(([method]) => method === 'session/resume')).toBeLessThan(f.peer.request.mock.calls.findIndex(([method]) => method === 'session/fork'))
    expect(f.peer.request.mock.calls.some(([method]) => method === 'session/send')).toBe(false)
    expect(f.io.native).toHaveBeenCalledWith({ type: 'cliworker.fork_created', id: '模拟新原生ID' })
    expect(f.peer.request).toHaveBeenCalledWith('session/close', { sessionId: '模拟新原生ID' }, { jsonrpc: false })
    expect(f.peer.close).toHaveBeenCalledOnce()
  })
  it('uses an explicitly supplied ZCode native message ID without substituting a checkpoint', async () => {
    const f = fixture('zcode', { forkAt: { messageId: '模拟精确截点' } })
    await forkNativeZcode(f.config, f.io)
    expect(f.peer.request).toHaveBeenCalledWith('session/fork', { sessionId: '模拟原生ID', target: { kind: 'message', messageId: '模拟精确截点' } }, { jsonrpc: false })
    expect(f.peer.request.mock.calls.some(([method]) => method === 'session/messages')).toBe(false)
  })
  it.each([{}, { messages: [] }, { messages: [{ info: { role: 'user', id: '模拟仅用户消息' } }] },
    { messages: [{ info: { role: 'assistant' } }] },
    { messages: [{ info: { role: 'assistant', id: ' ' } }] },
  ])('rejects missing ZCode native assistant IDs without inventing a checkpoint (%j)', async (history) => {
    const f = fixture('zcode'), request = f.peer.request.getMockImplementation()!
    f.peer.request.mockImplementation(async (method) => method === 'session/messages' ? history : request(method))
    await expect(forkNativeZcode(f.config, f.io)).rejects.toThrow('没有可分支的原生助手消息')
    expect(f.peer.request.mock.calls.some(([method]) => method === 'session/fork')).toBe(false)
    expect(f.io.native).not.toHaveBeenCalled()
    expect(f.peer.close).toHaveBeenCalledOnce()
  })
  it('reports ZCode permanent-delete limitation', async () => {
    const f = fixture('zcode', { forkOperation: 'delete' })
    await expect(forkNativeZcode(f.config, f.io)).rejects.toThrow('未公开永久删除')
    expect(f.peer.close).toHaveBeenCalledOnce()
  })
  it('uses Claude --resume + --fork-session + the saved inclusive native message UUID', () => {
    const f = fixture('claude')
    f.config.forkSource = { conversationId: f.config.conversationId, messageId: '固定UUID' }
    f.config.conversationId = undefined
    const argv = nativeClaudeArgv(f.config)
    expect(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2)).toEqual(['--resume', '模拟原生ID'])
    expect(argv).toContain('--fork-session')
    expect(argv.slice(argv.indexOf('--resume-session-at'), argv.indexOf('--resume-session-at') + 2)).toEqual(['--resume-session-at', '固定UUID'])
    expect(argv).not.toContain('--session-id')
    expect(f.config.argv).not.toContain('--fork-session')
  })
})
