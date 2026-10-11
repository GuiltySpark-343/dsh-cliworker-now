import { describe, expect, it } from 'vitest'
import { createZcodeLoginLinkParser } from '../src/client/zcode-login-link.ts'

// Synthetic protocol text only; no account or live authorization URL is used.
const prompt = 'Open this URL to sign in:'
const query =
  'client_id=SYNTHETIC&redirect_uri=https%3A%2F%2Fexample.invalid%2Fcallback&state=SYNTHETIC%2Bstate&response_type=code'
const url = `https://chat.z.ai/api/oauth/authorize?${query}`
const frame = (value = url) => `${prompt}\r\n${value}\r\n`

describe('user-operated ZCode native login link parsing', () => {
  it('preserves the complete original query, encoding and order', () => {
    const parser = createZcodeLoginLinkParser()
    const original = `${url}&synthetic_extra=a%2Bb%26c`
    expect(parser.write(frame(original))).toBe(original)
  })

  it('waits for both complete lines across every possible split', () => {
    const output = frame()
    for (let index = 0; index < output.length; index++) {
      const parser = createZcodeLoginLinkParser()
      expect(parser.write(output.slice(0, index))).toBeUndefined()
      expect(parser.write(output.slice(index))).toBe(url)
    }
  })

  it('supports SGR and CRLF split across individual bytes', () => {
    const parser = createZcodeLoginLinkParser()
    const output = `\x1b[1;32m${prompt}\x1b[0m\r\n\x1b[36m${url}\x1b[0m\r\n`
    const found = [...output].map((character) => parser.write(character)).filter(Boolean)
    expect(found).toEqual([url])
  })

  it.each(['0', '2'])(
    'accepts observed ConPTY initialization with OSC %s title before native text',
    (titleCommand) => {
      // Control sequence order follows real Windows frames; all title/URL values
      // below are synthetic. No captured authorization data is retained.
      const frames = [
        `\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b]${titleCommand};SYNTHETIC POWERSHELL TITLE\x07\x1b[?25h`,
        `\x1b[?25l${'\x1b[K\r\n'.repeat(27)}\x1b[K\x1b[H\x1b[?25h`,
        `\x1b]${titleCommand};SYNTHETIC ZCODE\x1b\\`,
        frame(),
      ]
      const parser = createZcodeLoginLinkParser()
      expect(frames.map((data) => parser.write(data)).filter(Boolean)).toEqual([url])
      parser.reset()
      expect([...frames.join('')].map((character) => parser.write(character)).filter(Boolean)).toEqual([url])
    },
  )

  it('accepts cursor visibility controls without changing prompt or URL bytes', () => {
    const parser = createZcodeLoginLinkParser()
    expect(parser.write(`\x1b[?25l${prompt}\x1b[?25h\r\n${url}\x1b[?25l\r\n`)).toBe(url)
  })

  it('requires the exact prompt immediately before the URL', () => {
    for (const output of [
      `${url}\n`,
      `Fallback URL:\n${url}\n`,
      `Log: ${prompt}\n${url}\n`,
      `${prompt}\nOther output\n${url}\n`,
      `${prompt}\n\n${url}\n`,
      `${prompt}\n${url}`,
    ])
      expect(createZcodeLoginLinkParser().write(output)).toBeUndefined()
  })

  it.each([
    url.replace('https:', 'http:'),
    url.replace('chat.z.ai', 'chat.z.ai.example.invalid'),
    url.replace('chat.z.ai', 'example.invalid@chat.z.ai'),
    url.replace('chat.z.ai', 'chat.z.ai:444'),
    url.replace('/api/oauth/authorize?', '/api/oauth/authorize/else?'),
    url.replace('/api/oauth/authorize?', '/other/../api/oauth/authorize?'),
    url.replace('/api/oauth/authorize?', '/api/oauth/%61uthorize?'),
    `${url}#`,
    `${url}#fragment`,
    url.replace('SYNTHETIC&', 'SYNTHETIC &'),
    url.replace('SYNTHETIC&', 'SYNTHETIC\t&'),
    url.replace('https://', 'https:\\\\'),
    'javascript:alert(1)',
    `https://chat.z.ai/api/oauth/authorize?client_id=SYNTHETIC`,
    url.replace('&state=SYNTHETIC%2Bstate', ''),
    url.replace('state=SYNTHETIC%2Bstate', 'state='),
    `${url}&state=SECOND_SYNTHETIC`,
  ])('rejects unsafe, incomplete or ambiguous links (%#)', (value) => {
    expect(createZcodeLoginLinkParser().write(frame(value))).toBeUndefined()
  })

  it('accepts an explicit standard TLS port without normalizing its original text', () => {
    const value = url.replace('chat.z.ai/', 'chat.z.ai:443/')
    expect(createZcodeLoginLinkParser().write(frame(value))).toBe(value)
  })

  it('ignores OSC payloads even when they contain a fake prompt and URL', () => {
    const parser = createZcodeLoginLinkParser()
    expect(parser.write(`\x1b]0;${frame()}\x1b`)).toBeUndefined()
    expect(parser.write('\\\n')).toBeUndefined()
    expect(parser.write(frame())).toBe(url)
  })

  it('rejects cursor editing and carriage-return overwritten prompt/URL lines', () => {
    for (const output of [
      `hidden\r${frame()}`,
      `\x1b[2K${frame()}`,
      `${prompt}\n${url}\b\n`,
      `${prompt}\n${url}\rhidden\n`,
      `${prompt}\n\x1b[H${url}\n`,
      `${prompt}\n\x1b[K${url}\n`,
      `${prompt}\n\x1b[2J${url}\n`,
      `${prompt.slice(0, 4)}\x1b[H${prompt.slice(4)}\n${url}\n`,
      `${prompt}\n${url.slice(0, 50)}\x1b[H${url.slice(50)}\n`,
      `\x1b[3;1H${frame()}`,
      `\x1b]8;;${url}\x07${frame()}`,
      `${prompt}\n\x1b]0;SYNTHETIC TITLE\x07${url}\n`,
    ])
      expect(createZcodeLoginLinkParser().write(output)).toBeUndefined()
  })

  it('bounds oversized lines and can recover at a fresh prompt', () => {
    const parser = createZcodeLoginLinkParser()
    expect(parser.write(`${prompt}\n${url}&padding=${'x'.repeat(100_000)}\n`)).toBeUndefined()
    expect(parser.write(frame())).toBe(url)
  })

  it('rearms on repeated prompts, deduplicates links and returns the newest complete link', () => {
    const parser = createZcodeLoginLinkParser()
    expect(parser.write(`${prompt}\n${frame()}`)).toBe(url)
    expect(parser.write(frame())).toBeUndefined()
    const next = url.replace('SYNTHETIC%2Bstate', 'NEXT_SYNTHETIC_STATE')
    expect(parser.write(frame(next))).toBe(next)
    parser.reset()
    expect(parser.write(frame() + frame(next))).toBe(next)
  })

  it('reset forgets an incomplete prompt, pending URL, ANSI state and previous link', () => {
    for (const incomplete of [`${prompt}\n`, prompt.slice(0, 10), '\x1b[', '\x1b]unterminated']) {
      const parser = createZcodeLoginLinkParser()
      parser.write(incomplete)
      parser.reset()
      expect(parser.write(`${url}\n`)).toBeUndefined()
      expect(parser.write(frame())).toBe(url)
      parser.reset()
      expect(parser.write(frame())).toBe(url)
    }
  })
})
