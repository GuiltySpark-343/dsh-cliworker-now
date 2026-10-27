// Imported only by the Windows account-terminal runtime and its Electron CLI
// child. Electron attaches stdout/stderr to the parent console, but its GUI
// executable can leave fd 0 mapped to NUL. Reopen this already-owned console;
// do not redirect stdin for task processes or change the shared Host.
import childProcess from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { isatty, ReadStream } from 'node:tty'
export let accountInput = 0

/** `stdio` with an inherited stdin replaced by the console input `fd`; anything else as given. */
export function consoleStdio(stdio, fd) {
  if (stdio === 'inherit') return [fd, 'inherit', 'inherit']
  if (Array.isArray(stdio) && (stdio[0] === 'inherit' || stdio[0] === 0)) return [fd, ...stdio.slice(1)]
  return stdio
}

// A CLI's Node wrapper (Codex's npm codex.js, OpenCode's) starts its native program
// with inherited stdin, which is still NUL here: that program then reports
// "stdin is not a terminal". Hand such children the reopened console instead.
function inheritConsoleInput(fd) {
  for (const name of ['spawn', 'spawnSync']) {
    const original = childProcess[name]
    childProcess[name] = function (command, ...rest) {
      const at = Array.isArray(rest[0]) ? 1 : 0
      const options = rest[at]
      if (options && typeof options === 'object') {
        const stdio = consoleStdio(options.stdio, fd)
        if (stdio !== options.stdio) rest[at] = { ...options, stdio }
      }
      return original.call(this, command, ...rest)
    }
  }
  syncBuiltinESMExports()
}

if (process.platform === 'win32' && !isatty(0)) {
  try {
    accountInput = openSync('\\\\.\\CONIN$', 'r+')
    if (!isatty(accountInput)) throw new Error('not a console')
    const input = new ReadStream(accountInput)
    Object.defineProperty(process, 'stdin', { value: input, configurable: true })
    process.once('exit', () => { try { closeSync(accountInput) } catch {} })
    inheritConsoleInput(accountInput)
  } catch {
    if (accountInput) { try { closeSync(accountInput) } catch {} }
    throw new Error('Windows account console input unavailable')
  }
}
