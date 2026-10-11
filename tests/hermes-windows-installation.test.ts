import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { hermesDistlibSource, hermesLauncherCheckout } from '../src/host/hermes-windows-installation.ts'
import { hermesNativeCommand, hermesCommandInstallationHome } from '../src/host/hermes-installation.ts'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let home: string
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'hermes-windows-committed-synthetic-')))
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  rmSync(home, { recursive: true, force: true })
})
// This is a synthetic stored ZIP layout, not a runnable PE or an installed CLI.
function distlib(source: string, name = '__main__.py') {
  const stub = Buffer.alloc(128)
  stub.write('MZ')
  const body = Buffer.from(source),
    filename = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(body.length, 22)
  local.writeUInt16LE(filename.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50)
  central.writeUInt32LE(body.length, 20)
  central.writeUInt32LE(body.length, 24)
  central.writeUInt16LE(filename.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + filename.length, 12)
  end.writeUInt32LE(local.length + filename.length + body.length, 16)
  return Buffer.concat([stub, local, filename, body, central, filename, end])
}
function source(checkout: string) {
  return `import os, re, sys\nsys.path.insert(0, ${JSON.stringify(checkout)})\nsys._hermes_pin_default_home = True\nimport hermes_bootstrap\nfrom hermes_cli.main import main\nsys.exit(main())\n`
}
function fixture() {
  const checkout = join(home, 'hermes-agent')
  const key = createHash('sha256').update(checkout).digest('hex').slice(0, 16)
  const install = join(home, 'installs', key),
    environment = join(install, 'environments', 'current', 'venv')
  const launcher = join(home, 'bin', 'hermes.exe'),
    facts = join(install, 'facts.json')
  for (const directory of [
    join(home, 'bin'),
    join(checkout, 'hermes_cli'),
    join(checkout, 'pm'),
    join(environment, 'Scripts'),
  ])
    mkdirSync(directory, { recursive: true })
  for (const name of ['hermes_bootstrap.py', 'hermes_cli/main.py', 'pm/environments.py', 'pm/filesystem.py'])
    writeFileSync(join(checkout, name), '# synthetic metadata only')
  writeFileSync(join(environment, 'Scripts/python.exe'), 'synthetic interpreter placeholder; never executed')
  writeFileSync(join(environment, 'pyvenv.cfg'), '# synthetic')
  writeFileSync(facts, JSON.stringify({ packages: { venv: { environment } } }))
  writeFileSync(launcher, distlib(source(checkout)))
  return { checkout, environment, launcher, facts }
}
describe('Hermes Windows committed dependency binding (synthetic, no account or network)', () => {
  it('pins the exact recorded install venv while preserving literal native arguments', async () => {
    const f = fixture(),
      args = ['model', '中文 路径', '& whoami', 'literal"quote']
    const command = await hermesNativeCommand(f.launcher, args)
    expect(command[0]).toBe(join(f.environment, 'Scripts/python.exe'))
    expect(command.slice(3, 6)).toEqual([f.checkout, f.facts, f.environment])
    expect(command.slice(6)).toEqual(args)
    expect(hermesCommandInstallationHome(command)).toBe(home)
  })
  it('uses the same binding for the fixed cmd fallback without evaluating Python or cmd', async () => {
    const f = fixture(),
      launcher = join(home, 'bin', 'hermes.cmd')
    const python = join(f.environment, 'Scripts/python.exe')
    const encoded = Buffer.from(source(f.checkout)).toString('base64')
    writeFileSync(
      launcher,
      `@echo off\r\n"${python}" -I -c "import base64; exec(base64.b64decode('${encoded}'))" %*\r\n`,
    )
    expect(await hermesNativeCommand(launcher, ['auth'])).toEqual(
      await hermesNativeCommand(f.launcher, ['auth']),
    )
  })
  it('does not choose a stale or foreign environment when the committed record is missing or invalid', async () => {
    const f = fixture()
    writeFileSync(f.facts, JSON.stringify({ packages: { venv: { environment: home } } }))
    await expect(hermesNativeCommand(f.launcher, ['model'])).rejects.toThrow('安装依赖不可用')
    rmSync(f.facts)
    await expect(hermesNativeCommand(f.launcher, ['model'])).rejects.toThrow('安装依赖不可用')
  })
  it('does not use an incomplete committed venv or start after cancellation', async () => {
    const f = fixture()
    rmSync(join(f.environment, 'Scripts/python.exe'))
    await expect(hermesNativeCommand(f.launcher, ['model'])).rejects.toThrow('安装依赖不可用')
    const abort = new AbortController()
    abort.abort(new Error('synthetic cancellation'))
    await expect(hermesNativeCommand(f.launcher, ['model'], abort.signal)).rejects.toThrow(
      'synthetic cancellation',
    )
  })
  it('rejects archive member traversal and inconsistent directory bounds', () => {
    expect(() => hermesDistlibSource(distlib(source(home), '../main.py'))).toThrow()
    const invalid = distlib(source(home))
    invalid.writeUInt32LE(0xfffffff0, invalid.length - 22 + 12)
    expect(() => hermesDistlibSource(invalid)).toThrow()
  })
  it('refuses computed or ambiguous checkout selection and leaves old self-contained entries alone', () => {
    expect(() =>
      hermesLauncherCheckout(source(home).replace(JSON.stringify(home), "os.getenv('FOREIGN_HOME')")),
    ).toThrow()
    expect(() =>
      hermesLauncherCheckout(source(home) + `sys.path.insert(0, ${JSON.stringify(home)})\n`),
    ).toThrow()
    expect(
      hermesLauncherCheckout(source(home).replace('sys._hermes_pin_default_home = True\n', '')),
    ).toBeUndefined()
    expect(hermesDistlibSource(Buffer.alloc(128))).toBeUndefined()
  })
})
