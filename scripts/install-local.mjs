// Local install: build this checkout and update the installed profile package in place.
//
// Why not `dsh plugin add link:` — a linked package resolves its `@deepseek-ai/*`
// peers from this checkout's node_modules (0.2.1-rc.3), while the running host owns
// its own copies. Two instances of the same Cordis packages is exactly the kind of
// breakage that is hard to diagnose. Copying the built artifacts keeps the shape of
// a normal npm install, so the host keeps resolving its own peers.
//
// Usage: node scripts/install-local.mjs [--profile web] [--dry-run]
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve('.')
const args = process.argv.slice(2)
const profile = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : 'web'
const dryRun = args.includes('--dry-run')
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const installed = join(dshHome, 'profiles', profile, 'node_modules', 'dsh-cliworker-now')
const staging = join(root, '.cache', 'install-package')
const backups = join(dshHome, 'cliworker-now', 'backups')
if (!existsSync(installed)) {
  console.error(`未找到已安装插件：${installed}`)
  process.exit(1)
}

if (!dryRun) {
  console.log('1/4 构建…')
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' })
}

console.log('2/4 准备打包目录…')
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
for (const entry of ['lib', 'runtime-host', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE']) {
  cpSync(join(root, entry), join(staging, entry), { recursive: true })
}
// Mirror the published package.json: no private flag, scripts or devDependencies.
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
delete manifest.private
delete manifest.scripts
delete manifest.devDependencies
manifest.publishConfig = { access: 'public', registry: 'https://registry.npmjs.org/' }
writeFileSync(join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = join(backups, stamp)
console.log(`3/4 备份现有安装到 ${backup}`)
if (!dryRun) {
  mkdirSync(backup, { recursive: true })
  for (const entry of ['lib', 'runtime-host', 'cordis.patch.yml', 'package.json', 'README.md', 'README.en.md', 'LICENSE']) {
    if (existsSync(join(installed, entry))) cpSync(join(installed, entry), join(backup, entry), { recursive: true })
  }
}

console.log(`4/4 覆盖 ${installed}${dryRun ? '（dry-run：未写入）' : ''}`)
if (!dryRun) {
  for (const entry of ['lib', 'runtime-host']) rmSync(join(installed, entry), { recursive: true, force: true })
  for (const entry of ['lib', 'runtime-host', 'cordis.patch.yml', 'package.json', 'README.md', 'README.en.md', 'LICENSE']) {
    cpSync(join(staging, entry), join(installed, entry), { recursive: true })
  }
}
console.log('完成。重启 DSH 宿主后生效。')
