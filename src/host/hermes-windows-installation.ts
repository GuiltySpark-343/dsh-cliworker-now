import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'

/** Read only the single stored __main__.py member emitted by distlib. No ZIP
 * extraction, Python evaluation, installer invocation, or account lookup. */
export function hermesDistlibSource(bytes: Buffer): string | undefined {
  if (bytes.length < 128 || bytes.toString('ascii', 0, 2) !== 'MZ') return
  const end = bytes.length - 22
  if (bytes.readUInt32LE(end) !== 0x06054b50) return
  if (
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 8) !== 1 ||
    bytes.readUInt16LE(end + 10) !== 1 ||
    bytes.readUInt16LE(end + 20) !== 0
  )
    throw new Error('Unsupported Hermes launcher archive')
  const centralSize = bytes.readUInt32LE(end + 12)
  const central = end - centralSize
  if (central < 64 || centralSize < 46 || bytes.readUInt32LE(central) !== 0x02014b50)
    throw new Error('Invalid Hermes launcher directory')
  const nameSize = bytes.readUInt16LE(central + 28)
  const size = bytes.readUInt32LE(central + 24)
  const local = central - bytes.readUInt32LE(end + 16) + bytes.readUInt32LE(central + 42)
  if (
    centralSize !== 46 + nameSize ||
    bytes.subarray(central + 46, end).toString('utf8') !== '__main__.py' ||
    bytes.readUInt16LE(central + 8) !== 0 ||
    bytes.readUInt16LE(central + 10) !== 0 ||
    bytes.readUInt32LE(central + 20) !== size ||
    size > 128 * 1024 ||
    local < 64 ||
    local + 30 > central ||
    bytes.readUInt32LE(local) !== 0x04034b50 ||
    bytes.readUInt16LE(local + 6) !== 0 ||
    bytes.readUInt16LE(local + 8) !== 0 ||
    bytes.readUInt32LE(local + 18) !== size ||
    bytes.readUInt32LE(local + 22) !== size ||
    bytes.readUInt16LE(local + 26) !== nameSize ||
    bytes.readUInt16LE(local + 28) !== 0 ||
    local + 30 + nameSize + size !== central ||
    bytes.subarray(local + 30, local + 30 + nameSize).toString('utf8') !== '__main__.py'
  )
    throw new Error('Invalid Hermes launcher member')
  return bytes.subarray(local + 30 + nameSize, central).toString('utf8')
}

export function hermesLauncherCheckout(source: string): string | undefined {
  if (
    !source.startsWith('import os, re, sys\n') ||
    !source.includes('sys._hermes_pin_default_home = True\n') ||
    !source.includes('import hermes_bootstrap') ||
    !source.includes('from hermes_cli.main import main')
  )
    return
  // Python's repr(path) uses only literal escaped backslashes/quotes here.
  // Do not evaluate the launcher, interpolate its statements, or accept expressions.
  const roots = [
    ...source.matchAll(
      /^sys\.path\.insert\(0, ('(?:[^'\\\r\n]|\\[\\'])+'|"(?:[^"\\\r\n]|\\[\\"])+")\)\r?$/gm,
    ),
  ]
  if (roots.length !== 1) throw new Error('Ambiguous Hermes checkout')
  const path = roots[0]![1]!.slice(1, -1).replace(/\\([\\'"])/g, '$1')
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Invalid Hermes checkout')
  return path
}

export async function windowsHermesCheckout(
  executable: string,
  command: string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  let source: string | undefined
  if (basename(executable).toLowerCase() === 'hermes.exe') {
    const file = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024)
        throw new Error('Unsafe Hermes launcher')
      source = hermesDistlibSource(await file.readFile())
    } finally {
      await file.close()
    }
  } else if (command[1] === '-I' && command[2] === '-c') {
    const encoded = /^import base64; exec\(base64\.b64decode\('([A-Za-z0-9+/]+={0,2})'\)\)$/.exec(
      command[3] ?? '',
    )
    if (encoded) source = Buffer.from(encoded[1]!, 'base64').toString('utf8')
  }
  signal?.throwIfAborted()
  if (source === undefined) return
  const checkout = hermesLauncherCheckout(source)
  if (!checkout) return
  // Canonical spelling is part of the native install_key hash.
  return realpath(checkout)
}
