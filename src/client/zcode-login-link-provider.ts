import type { IBufferCellPosition, IBufferRange, ILinkProvider, Terminal } from '@xterm/xterm'

const maxUrlLength = 8_192
const maxCells = 16_384
const maxWrappedLines = 512
type TerminalBuffer = Pick<Terminal, 'buffer' | 'cols'>

/** Resolve only a complete displayed copy of an already approved native URL. */
function displayedUrlRange(
  terminal: TerminalBuffer,
  bufferLineNumber: number,
  url: string,
): IBufferRange | undefined {
  if (!url || url.length > maxUrlLength || !Number.isInteger(bufferLineNumber)) return undefined
  const buffer = terminal.buffer.active
  const index = bufferLineNumber - 1
  if (index < 0 || index >= buffer.length || terminal.cols < 1) return undefined
  let first = index
  while (buffer.getLine(first)?.isWrapped) {
    if (first === 0 || index - first >= maxWrappedLines) return undefined
    first--
  }
  let text = ''
  let cellCount = 0
  const positions: { start: IBufferCellPosition; end: IBufferCellPosition }[] = []
  for (let row = first; row < buffer.length; row++) {
    if (row - first >= maxWrappedLines) return undefined
    const line = buffer.getLine(row)
    if (!line) return undefined
    if (row !== first && !line.isWrapped) break
    const columns = Math.min(terminal.cols, line.length)
    if (!Number.isInteger(columns) || columns < 0 || cellCount + columns > maxCells) return undefined
    cellCount += columns
    for (let column = 0; column < columns; column++) {
      const cell = line.getCell(column)
      if (!cell) return undefined
      const width = cell.getWidth()
      if (width === 0) continue
      if (width !== 1 && width !== 2) return undefined
      const chars = cell.getChars() || ' '
      if (text.length + chars.length > maxCells) return undefined
      const position = {
        start: { x: column + 1, y: row + 1 },
        end: { x: column + width, y: row + 1 },
      }
      for (let character = 0; character < chars.length; character++) positions.push(position)
      text += chars
    }
  }
  // Native --no-browser prints the URL on its own logical line. A known URL
  // embedded in arbitrary output or a different URL must not become a link.
  if (text.trim() !== url) return undefined
  const offset = text.length - text.trimStart().length
  const start = positions[offset]?.start
  const end = positions[offset + url.length - 1]?.end
  if (!start || !end || bufferLineNumber < start.y || bufferLineNumber > end.y) return undefined
  return { start, end }
}

/**
 * The caller supplies only the active ZCode login parser's approved URL and
 * disposes its registerLinkProvider handle on close. No URL discovery, browser
 * opening, output logging, or persistence happens while links are requested.
 */
export function createZcodeLoginLinkProvider(
  terminal: TerminalBuffer,
  currentUrl: () => string | undefined,
  open: (url: string) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const url = currentUrl()
      const range = url ? displayedUrlRange(terminal, bufferLineNumber, url) : undefined
      if (!url || !range) {
        callback(undefined)
        return
      }
      let disposed = false
      callback([
        {
          range,
          text: url,
          activate() {
            if (disposed || currentUrl() !== url) return
            // A cached hover may outlive a resize, buffer rewrite or session close.
            const current = displayedUrlRange(terminal, bufferLineNumber, url)
            if (
              !current ||
              current.start.x !== range.start.x ||
              current.start.y !== range.start.y ||
              current.end.x !== range.end.x ||
              current.end.y !== range.end.y
            )
              return
            open(url)
          },
          dispose() {
            disposed = true
          },
        },
      ])
    },
  }
}
