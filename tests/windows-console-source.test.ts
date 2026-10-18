import { expect, it } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { selectBuildDependencies } from '../scripts/build-dependencies.mjs'

// Actual Windows file/source validation only. The copied official payloads
// are never executed; no accounts, CLI login or model requests are involved.
it.skipIf(process.platform !== 'win32')('accepts the fixed official ConPTY payload and rejects other paths, versions and bytes', async () => {
  const selected = selectBuildDependencies(process.cwd())
  const runtime = createRequire(selected.require.resolve('@deepseek-ai/dsh/package.json'))
  const provider = createRequire(runtime.resolve('@deepseek-ai/dsh-subprocess-local/package.json'))
  const official = dirname(provider.resolve('node-pty/package.json'))
  const root = await mkdtemp(join(tmpdir(), 'cwn-console-source-SIMULATED-'))
  try {
    const fixture = async (name: string, prebuilt = false) => {
      const pkg = join(root, name, 'node-pty'), conpty = join(pkg, prebuilt ? `prebuilds/win32-${process.arch}/conpty` : 'build/Release/conpty')
      await mkdir(conpty, { recursive: true })
      await cp(join(official, 'third_party'), join(pkg, 'third_party'), { recursive: true })
      const arch = process.arch === 'arm64' ? 'win10-arm64' : 'win10-x64'
      for (const name of ['OpenConsole.exe', 'conpty.dll'])
        await cp(join(pkg, 'third_party/conpty/1.25.260303002', arch, name), join(conpty, name))
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.2.0-beta.15' }))
      return { pkg, conpty, image: join(conpty, 'OpenConsole.exe') }
    }
    const good = await fixture('good'), prebuilt = await fixture('prebuilt', true), exe = await fixture('exe'), dll = await fixture('dll'), version = await fixture('version')
    await writeFile(exe.image, 'SIMULATED same-name executable is not trusted')
    await writeFile(join(dll.conpty, 'conpty.dll'), 'SIMULATED changed native dependency')
    await writeFile(join(version.pkg, 'package.json'), JSON.stringify({ name: 'node-pty', version: '0.0.0-SIMULATED' }))
    const outside = join(root, 'OpenConsole.exe')
    await cp(good.image, outside)
    const owner = await readFile(new URL('../src/host/windows-account-owner.ps1', import.meta.url), 'utf8')
    const declarations = owner.slice(owner.indexOf('Add-Type -TypeDefinition'), owner.indexOf('\n$job=$null'))
    const payload = Buffer.from(JSON.stringify([good.image, prebuilt.image, exe.image, dll.image, version.image, outside])).toString('base64')
    const script = `${declarations}\n$paths=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;@($paths|ForEach-Object { [bool](Get-TrustedNodePtyRoot $_) })|ConvertTo-Json -Compress`
    const scriptPath = join(root, 'source-proof.ps1')
    await writeFile(scriptPath, `\ufeff${script}`)
    const result = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    expect(JSON.parse(result)).toEqual([true, true, false, false, false, false])
    // Explicitly simulated proof objects: a valid manifest cannot authorize a
    // different owner nonce, physical package, archive or package identity.
    const request = { nonce: '12345678-1234-1234-1234-123456789abc', packageRoot: 'C:\\Host\\resources\\app.asar.unpacked\\dsh\\node_modules\\node-pty', archivePath: 'C:\\Host\\resources\\app.asar' }
    const proof = { ...request, name: 'node-pty', version: '1.2.0-beta.15' }
    const proofCases = [proof, { ...proof, nonce: 'different' }, { ...proof, packageRoot: 'C:\\foreign' }, { ...proof, archivePath: 'C:\\foreign.asar' }, { ...proof, name: 'foreign' }, { ...proof, version: '0.0.0-SIMULATED' }]
    const proofPayload = Buffer.from(JSON.stringify({ request, proofs: proofCases })).toString('base64')
    const proofScript = `${declarations}\n$case=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${proofPayload}'))|ConvertFrom-Json;@($case.proofs|ForEach-Object { Test-CwnManifestProof $_ $case.request })|ConvertTo-Json -Compress`
    const proofPath = join(root, 'nonce-proof.ps1')
    await writeFile(proofPath, `\ufeff${proofScript}`)
    const proofResult = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', proofPath], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    expect(JSON.parse(proofResult)).toEqual([true, false, false, false, false, false])
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
