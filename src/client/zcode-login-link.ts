const nativePrompt = 'Open this URL to sign in:'
const maxLineLength = 8_192
const requiredParameters = ['client_id', 'redirect_uri', 'state', 'response_type'] as const

/** Validate only the observed native authorization endpoint; return the original bytes. */
function nativeLoginUrl(line: string): string | undefined {
  if (
    line.length > maxLineLength ||
    !/^https:\/\/chat\.z\.ai(?::443)?\/api\/oauth\/authorize\?/.test(line) ||
    /[\s\p{C}<>"'\\#]/u.test(line)
  )
    return undefined
  try {
    const url = new URL(line)
    if (
      url.protocol !== 'https:' ||
      url.origin !== 'https://chat.z.ai' ||
      url.pathname !== '/api/oauth/authorize' ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== '443')
    )
      return undefined
    for (const parameter of requiredParameters) {
      const values = url.searchParams.getAll(parameter)
      if (values.length !== 1 || !values[0]?.trim()) return undefined
    }
    return line
  } catch {
    return undefined
  }
}

export interface ZcodeLoginLinkParser {
  /** Returns only a newly completed native URL, never a partial line. Does not open or log it. */
  write(chunk: string): string | undefined
  /** Forget pending ANSI/line state and the last URL on finish, close, retry or unmount. */
  reset(): void
}

/**
 * The caller must enable this only for a ZCode login session. URLs stay in memory.
 * Accept a single complete line immediately after the fixed native --no-browser
 * prompt. SGR/cursor visibility do not affect text. The observed ConPTY blank
 * screen initialization is accepted only before any prompt/URL text; arbitrary
 * cursor edits do not become trusted text. OSC payloads are never stored.
 */
export function createZcodeLoginLinkParser(): ZcodeLoginLinkParser {
  let mode: 'text' | 'escape' | 'csi' | 'osc' | 'osc-escape' = 'text'
  let line = ''
  let invalidLine = false
  let carriageReturn = false
  let csiParameters = true
  let csiLength = 0
  let csiSequence = ''
  let oscCommand = ''
  let oscCommandComplete = false
  let oscInitialization = false
  let awaitingUrl = false
  let previousUrl: string | undefined

  const reset = () => {
    mode = 'text'
    line = ''
    invalidLine = false
    carriageReturn = false
    csiParameters = true
    csiLength = 0
    csiSequence = ''
    oscCommand = ''
    oscCommandComplete = false
    oscInitialization = false
    awaitingUrl = false
    previousUrl = undefined
  }
  const finishLine = (): string | undefined => {
    const complete = invalidLine ? '' : line.trim()
    line = ''
    invalidLine = false
    carriageReturn = false
    if (complete === nativePrompt) {
      awaitingUrl = true
      return undefined
    }
    const candidate = awaitingUrl ? nativeLoginUrl(complete) : undefined
    awaitingUrl = false
    if (!candidate || candidate === previousUrl) return undefined
    previousUrl = candidate
    return candidate
  }
  return {
    reset,
    write(chunk) {
      let result: string | undefined
      for (const character of chunk) {
        if (mode === 'osc' || mode === 'osc-escape') {
          if (character === '\x07' || (mode === 'osc-escape' && character === '\\')) {
            // Only startup OSC 0/2 title metadata is inert here. In particular,
            // OSC 8 hyperlink targets never supply or decorate a login link.
            if (!oscInitialization || !oscCommandComplete || !['0', '2'].includes(oscCommand))
              invalidLine = true
            mode = 'text'
          } else {
            if (!oscCommandComplete) {
              if (character === ';') oscCommandComplete = true
              else if (oscCommand.length < 2) oscCommand += character
              else oscInitialization = false
            }
            mode = character === '\x1b' ? 'osc-escape' : 'osc'
          }
          continue
        }
        if (mode === 'escape') {
          if (character === '[') {
            mode = 'csi'
            csiParameters = true
            csiLength = 0
            csiSequence = ''
            continue
          }
          if (character === ']') {
            oscInitialization = !line && !awaitingUrl && !invalidLine
            oscCommand = ''
            oscCommandComplete = false
            mode = 'osc'
          } else {
            invalidLine = true
            mode = 'text'
          }
          if (character !== '\n') continue
        } else if (mode === 'csi') {
          csiLength++
          if (character >= '@' && character <= '~') {
            const sequence = csiSequence + character
            const decoration = character === 'm' && csiParameters
            const visibility = /^\?25[hl]$/.test(sequence)
            const initialization =
              !line && !awaitingUrl && !invalidLine && /^(?:2J|0?K|(?:1;1)?H)$/.test(sequence)
            if (csiLength > 64 || (!decoration && !visibility && !initialization)) invalidLine = true
            mode = 'text'
            continue
          }
          csiParameters &&= /^[0-9;:]$/.test(character)
          if (csiLength <= 64) csiSequence += character
          if (character !== '\n') continue
          invalidLine = true
          mode = 'text'
        }
        if (character === '\n') {
          const found = finishLine()
          if (found) result = found
          continue
        }
        if (carriageReturn) invalidLine = true
        carriageReturn = character === '\r'
        if (carriageReturn) continue
        if (character === '\x1b') {
          mode = 'escape'
          continue
        }
        if (/[\p{C}]/u.test(character)) invalidLine = true
        if (line.length + character.length > maxLineLength) invalidLine = true
        if (!invalidLine) line += character
      }
      return result
    },
  }
}
