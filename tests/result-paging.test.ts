import { expect, it } from 'vitest'
import { MAX_RESULT_PAGE, pageResult } from '../src/host/result-paging.ts'

it('pages a long result and terminates at the exact end', () => {
  const text = 'x'.repeat(50_000)
  const first = pageResult(text)
  expect(first.total).toBe(50_000)
  expect(first.text).toHaveLength(20_000)
  expect(first.next).toBe(20_000)
  expect(first.truncated).toBe(true)
  const second = pageResult(text, first.next!)
  expect(second.offset).toBe(20_000)
  expect(second.next).toBe(40_000)
  const third = pageResult(text, second.next!)
  expect(third.text).toHaveLength(10_000)
  expect(third.next).toBeNull()
  expect(third.truncated).toBe(false)
  expect(first.text + second.text + third.text).toBe(text)
})

it('clamps offset and limit and never exceeds the maximum page', () => {
  const text = 'y'.repeat(100_000)
  expect(pageResult(text, -5).offset).toBe(0)
  expect(pageResult(text, 200_000).text).toBe('')
  expect(pageResult(text, 200_000).next).toBeNull()
  expect(pageResult(text, 0, 1_000_000).text).toHaveLength(MAX_RESULT_PAGE)
  expect(pageResult(text, 0, 0).text).toHaveLength(1)
})
