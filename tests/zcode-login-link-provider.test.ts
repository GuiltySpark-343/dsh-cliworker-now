import { describe, expect, it, vi } from 'vitest'
import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { createZcodeLoginLinkProvider } from '../src/client/zcode-login-link-provider.ts'

// Synthetic xterm cells and authorization URL; never opens a real browser.
const url =
  'https://chat.z.ai/api/oauth/authorize?client_id=SYNTHETIC&redirect_uri=https%3A%2F%2Fexample.invalid%2Fcallback&state=SYNTHETIC%2Bstate&response_type=code'
type Cell = { getWidth(): number; getChars(): string }
const cell = (chars = '', width = 1): Cell => ({ getWidth: () => width, getChars: () => chars })
function fixture(value = url, columns = 80) {
  const rows: { isWrapped: boolean; length: number; getCell(index: number): Cell | undefined }[] = []
  let cells: Cell[] = []
  const flush = () => {
    const row = [...cells]
    while (row.length < columns) row.push(cell())
    rows.push({ isWrapped: rows.length > 0, length: columns, getCell: (index) => row[index] })
    cells = []
  }
  for (const character of value) {
    const width = /[\u4e00-\u9fff]/u.test(character) ? 2 : 1
    if (cells.length + width > columns) flush()
    cells.push(cell(character, width))
    if (width === 2) cells.push(cell('', 0))
  }
  if (cells.length || !rows.length) flush()
  const active = {
    get length() {
      return rows.length
    },
    getLine: (index: number) => rows[index],
  }
  const terminal = { cols: columns, buffer: { active } } as unknown as Pick<Terminal, 'buffer' | 'cols'>
  let current: string | undefined = url
  const open = vi.fn()
  const provider = createZcodeLoginLinkProvider(terminal, () => current, open)
  return {
    terminal,
    rows,
    provider,
    open,
    current: (next?: string) => {
      current = next
    },
  }
}
function links(provider: ILinkProvider, row = 1): ILink[] | undefined {
  const callback = vi.fn()
  provider.provideLinks(row, callback)
  expect(callback).toHaveBeenCalledOnce()
  return callback.mock.calls[0]![0]
}

describe('approved ZCode URL xterm link provider', () => {
  it.each([40, 80, 100, 500])(
    'makes the complete original URL clickable on every soft-wrapped row at width %s',
    (columns) => {
      const f = fixture(url, columns)
      for (let row = 1; row <= f.rows.length; row++) {
        const found = links(f.provider, row)!
        expect(found).toHaveLength(1)
        expect(found[0]!.text).toBe(url)
        expect(found[0]!.range).toEqual({
          start: { x: 1, y: 1 },
          end: { x: ((url.length - 1) % columns) + 1, y: Math.ceil(url.length / columns) },
        })
        expect(f.open).not.toHaveBeenCalled()
      }
      links(f.provider, f.rows.length)![0]!.activate({} as MouseEvent, 'untrusted alternate callback text')
      expect(f.open).toHaveBeenCalledExactlyOnceWith(url)
    },
  )

  it('calculates buffer coordinates from cells, including a wide query character and edge spaces', () => {
    const wide = `${url}&label=中`
    const f = fixture(`  ${wide}  `, 500)
    f.current(wide)
    expect(links(f.provider)![0]!.range).toEqual({
      start: { x: 3, y: 1 },
      end: { x: 2 + wide.length + 1, y: 1 },
    })
  })

  it('never discovers or automatically opens an arbitrary or not-yet-approved terminal URL', () => {
    const f = fixture()
    f.current()
    expect(links(f.provider)).toBeUndefined()
    expect(f.open).not.toHaveBeenCalled()
    for (const text of [
      'https://example.invalid/login',
      `other output ${url}`,
      `https://example.invalid/?next=${url}`,
      `${url}&different=1`,
      url.replace('%2B', '%2b'),
      `\x1b]8;;${url}\x07click\x1b]8;;\x07`,
    ])
      expect(links(fixture(text).provider)).toBeUndefined()
  })

  it('does not join separate hard lines into a URL', () => {
    const f = fixture(url, 80)
    f.rows[1]!.isWrapped = false
    expect(links(f.provider, 1)).toBeUndefined()
    expect(links(f.provider, 2)).toBeUndefined()
  })

  it('invalidates old callbacks on expiry, replacement, buffer rewrite or disposal', () => {
    for (const action of ['expire', 'replace', 'rewrite', 'dispose'] as const) {
      const f = fixture()
      const link = links(f.provider)![0]!
      if (action === 'expire') f.current()
      if (action === 'replace') f.current(`${url}&next=1`)
      if (action === 'rewrite') f.rows[0]!.getCell = () => cell('x')
      if (action === 'dispose') link.dispose!()
      link.activate({} as MouseEvent, url)
      expect(f.open).not.toHaveBeenCalled()
    }
  })

  it('uses buffer line coordinates independently of the visible viewport', () => {
    const f = fixture(url, 80)
    const blank = { isWrapped: false, length: 80, getCell: () => cell() }
    f.rows.unshift(blank, blank)
    expect(links(f.provider, 1)).toBeUndefined()
    expect(links(f.provider, 3)![0]!.range.start).toEqual({ x: 1, y: 3 })
  })

  it('bounds URL, buffer scan, incomplete scrollback and invalid line positions', () => {
    const f = fixture()
    for (const row of [0, -1, 0.5, NaN, f.rows.length + 1]) expect(links(f.provider, row)).toBeUndefined()
    f.current('x'.repeat(8_193))
    expect(links(f.provider)).toBeUndefined()
    const missingStart = fixture()
    missingStart.rows[0]!.isWrapped = true
    expect(links(missingStart.provider)).toBeUndefined()
    const huge = fixture('x'.repeat(20_000), 80)
    expect(links(huge.provider)).toBeUndefined()
  })
})
