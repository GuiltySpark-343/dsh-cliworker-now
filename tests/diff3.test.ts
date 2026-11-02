import { expect, it } from 'vitest'
import { diff3Merge, diffHunks, splitLines } from '../src/host/diff3.ts'

const lines = (...values: string[]) => values.map((value) => `${value}\n`).join('')

it('keeps line terminators so a split and join is byte exact', () => {
  for (const text of ['', 'a', 'a\n', 'a\r\nb', '\n\nx\n', 'tail without newline'])
    expect(splitLines(text).join('')).toBe(text)
})

it('reports changed base ranges against the other side', () => {
  expect(diffHunks(['a\n', 'b\n', 'c\n'], ['a\n', 'B\n', 'c\n', 'd\n'])).toEqual([
    { baseStart: 1, baseLength: 1, sideStart: 1, sideLength: 1 },
    { baseStart: 3, baseLength: 0, sideStart: 3, sideLength: 1 },
  ])
  expect(diffHunks(['a\n'], ['a\n'])).toEqual([])
})

it('merges non-overlapping edits from both sides', () => {
  const base = lines('one', 'two', 'three', 'four', 'five')
  const ours = lines('ONE', 'two', 'three', 'four', 'five')
  const theirs = lines('one', 'two', 'three', 'four', 'FIVE', 'six')
  expect(diff3Merge(base, ours, theirs)).toEqual({ clean: true, text: lines('ONE', 'two', 'three', 'four', 'FIVE', 'six') })
})

it('accepts identical edits on both sides and one-sided edits', () => {
  const base = lines('a', 'b', 'c')
  expect(diff3Merge(base, lines('a', 'x', 'c'), lines('a', 'x', 'c'))).toEqual({ clean: true, text: lines('a', 'x', 'c') })
  expect(diff3Merge(base, base, lines('a', 'c'))).toEqual({ clean: true, text: lines('a', 'c') })
  expect(diff3Merge(base, lines('a', 'b', 'c', 'd'), base)).toEqual({ clean: true, text: lines('a', 'b', 'c', 'd') })
})

it('reports overlapping and adjacent edits as conflicts without markers', () => {
  const base = lines('a', 'b', 'c', 'd')
  expect(diff3Merge(base, lines('a', 'X', 'c', 'd'), lines('a', 'Y', 'c', 'd'))).toEqual({ clean: false, reason: 'overlap' })
  expect(diff3Merge(base, lines('a', 'X', 'c', 'd'), lines('a', 'b', 'Y', 'd'))).toEqual({ clean: false, reason: 'overlap' })
  // Two different insertions at the same place.
  expect(diff3Merge(base, lines('a', 'b', 'p', 'c', 'd'), lines('a', 'b', 'q', 'c', 'd'))).toEqual({
    clean: false,
    reason: 'overlap',
  })
})

it('keeps CRLF and a missing final newline intact', () => {
  const base = 'a\r\nb\r\nc'
  expect(diff3Merge(base, 'A\r\nb\r\nc', 'a\r\nb\r\nC')).toEqual({ clean: true, text: 'A\r\nb\r\nC' })
})

it('gives up on rewrites beyond the edit-distance bound', () => {
  const base = Array.from({ length: 3000 }, (_, index) => `line ${index}\n`).join('')
  const ours = Array.from({ length: 3000 }, (_, index) => `ours ${index}\n`).join('')
  const theirs = Array.from({ length: 3000 }, (_, index) => `theirs ${index}\n`).join('')
  expect(diff3Merge(base, ours, theirs)).toEqual({ clean: false, reason: 'too-large' })
})

it('merges a realistic file with many scattered edits', () => {
  const base = Array.from({ length: 400 }, (_, index) => `const v${index} = ${index}\n`)
  const ours = [...base],
    theirs = [...base]
  for (let index = 0; index < 400; index += 20) ours[index] = `const v${index} = 'ours'\n`
  for (let index = 10; index < 400; index += 20) theirs[index] = `const v${index} = 'theirs'\n`
  theirs.push('export {}\n')
  const expected = base.map((line, index) => (index % 20 === 0 ? ours[index]! : index % 20 === 10 ? theirs[index]! : line))
  expected.push('export {}\n')
  expect(diff3Merge(base.join(''), ours.join(''), theirs.join(''))).toEqual({ clean: true, text: expected.join('') })
})
