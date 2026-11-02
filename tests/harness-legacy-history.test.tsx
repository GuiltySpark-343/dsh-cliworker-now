import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { HarnessLegacyHistory } from '../src/client/harness-legacy-history.tsx'

// SIMULATION: native controls and timeline rendering are replaced, while the
// legacy-history interaction runs. No Gateway request, CLI or model is used.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: any) => createElement('button', props, children),
  Modal: ({ open, children }: any) => open ? createElement('section', { role: 'dialog' }, children) : null,
}))
vi.mock('../src/client/conversation-timeline.tsx', () => ({ ConversationTimeline: () => null }))

it('keeps old pending messages in a read-only management snapshot without sending or merging them into native inbox', async () => {
  const history = vi.fn()
  const submitMessage = vi.fn()
  const retryQueuedFollowups = vi.fn()
  const props: any = {
    api: { cliworker: { history, submitMessage, retryQueuedFollowups } }, parentSessionId: 'parent',
    worker: { id: 'worker' }, items: [], truncated: false,
    queuedFollowups: [{ id: 'paused', prompt: 'Synthetic old paused message', state: 'paused', createdAt: '', pauseReason: '用户已停止' }],
  }
  let view!: ReturnType<typeof create>
  await act(async () => { view = create(createElement(HarnessLegacyHistory, props)) })
  expect(JSON.stringify(view.toJSON())).not.toContain('Synthetic old paused message')
  await act(async () => view.root.findByType('button').props.onClick())
  expect(view.root.findByProps({ 'aria-label': '只读旧待发消息' }).findAllByType('li')).toHaveLength(1)
  expect(JSON.stringify(view.toJSON())).toContain('Synthetic old paused message')
  expect(JSON.stringify(view.toJSON())).toContain('不会加入原生队列或自动发送')
  expect(view.root.findAllByType('form')).toHaveLength(0)
  expect(view.root.findAllByType('textarea')).toHaveLength(0)
  await act(async () => view.update(createElement(HarnessLegacyHistory, { ...props, queuedFollowups: [] })))
  expect(JSON.stringify(view.toJSON())).toContain('Synthetic old paused message')
  expect(history).not.toHaveBeenCalled()
  expect(submitMessage).not.toHaveBeenCalled()
  expect(retryQueuedFollowups).not.toHaveBeenCalled()
  await act(async () => view.unmount())
})
