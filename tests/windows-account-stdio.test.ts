import { expect, it } from 'vitest'
import { consoleStdio } from '../src/host/windows-account-stdio.mjs'

it('gives an inherited stdin the reopened console and leaves every other stdio as given', () => {
  expect(consoleStdio('inherit', 7)).toEqual([7, 'inherit', 'inherit'])
  expect(consoleStdio(['inherit', 'pipe', 2], 7)).toEqual([7, 'pipe', 2])
  expect(consoleStdio([0, 1, 2], 7)).toEqual([7, 1, 2])
  const piped = ['pipe', 'inherit', 'inherit']
  expect(consoleStdio(piped, 7)).toBe(piped)
  expect(consoleStdio(undefined, 7)).toBeUndefined()
  expect(consoleStdio('pipe', 7)).toBe('pipe')
  expect(consoleStdio([3, 1, 2], 7)).toEqual([3, 1, 2])
})
