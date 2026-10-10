// Imported only by the Windows account-terminal runtime and its Electron CLI
// child. Electron attaches stdout/stderr to the parent console, but its GUI
// executable can leave fd 0 mapped to NUL. Reopen this already-owned console;
// do not redirect stdin for task processes or change the shared Host.
import { openSync, closeSync } from 'node:fs'
import { isatty, ReadStream } from 'node:tty'
export let accountInput = 0
if (process.platform === 'win32' && !isatty(0)) {
  try {
    accountInput = openSync('\\\\.\\CONIN$', 'r+')
    if (!isatty(accountInput)) throw new Error('not a console')
    const input = new ReadStream(accountInput)
    Object.defineProperty(process, 'stdin', { value: input, configurable: true })
    process.once('exit', () => { try { closeSync(accountInput) } catch {} })
  } catch {
    if (accountInput) { try { closeSync(accountInput) } catch {} }
    throw new Error('Windows account console input unavailable')
  }
}
