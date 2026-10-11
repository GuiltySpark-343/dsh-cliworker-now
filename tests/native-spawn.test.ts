import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

// Real isolated Node children, synthetic metadata only. The preload observes the
// OS spawn boundary without replacing the child, its streams or exit handling.
async function run(operation: 'pipe' | 'omp' | 'omp-failure') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-native-console-synthetic-')))
  roots.push(root)
  const record = join(root, 'spawn.json'),
    preload = join(root, 'preload.mjs'),
    entry = join(root, 'synthetic-native.mjs'),
    runner = join(root, 'runner.mjs')
  writeFileSync(
    preload,
    `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
const original = cp.spawn;
cp.spawn = (file, argv, options) => {
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({
    file, argv, cwd: options.cwd, stdio: options.stdio,
    windowsHide: options.windowsHide, detached: options.detached ?? false,
    shell: options.shell ?? false, envPreserved: options.env.CWN_SYNTHETIC === 'preserved'
  }));
  return original(file, argv, options);
};
syncBuiltinESMExports();
`,
  )
  writeFileSync(
    entry,
    operation === 'pipe'
      ? `let input=''; process.stdin.on('data', value => input += value);
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({args:process.argv.slice(2),input,cwd:process.cwd()}));
  process.stderr.write('synthetic-stderr'); process.exitCode=7;
});`
      : operation === 'omp-failure'
        ? `process.stderr.write('synthetic native private error'); process.exitCode=17;`
        : `process.stdout.write(JSON.stringify([{provider:'synthetic',id:'test-model',thinking:{efforts:['low','high']}}]));`,
  )
  const literal = ['空格 参数', '& no-shell', 'literal"quote', '', 'line\nnext']
  const env = `{...process.env,CWN_SYNTHETIC:'preserved'}`
  const module = new URL('../src/host/native-spawn.mjs', import.meta.url).href
  const catalog = new URL('../src/host/pi-native-catalog.mjs', import.meta.url).href
  writeFileSync(
    runner,
    operation === 'pipe'
      ? `import {spawnNativeProcess} from ${JSON.stringify(module)};
const child=spawnNativeProcess(process.execPath,${JSON.stringify([entry, ...literal])},{
  cwd:${JSON.stringify(root)},env:${env},stdio:['pipe','pipe','pipe']
});
let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
child.stdin.end(${JSON.stringify('synthetic-input\n')});
const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
console.log(JSON.stringify({code,stdout:JSON.parse(stdout),stderr}));`
      : `import {queryNativeCandidates} from ${JSON.stringify(catalog)};
try {
  const models=await queryNativeCandidates('omp',${JSON.stringify(entry)},${JSON.stringify(root)},${env});
  console.log(JSON.stringify({models}));
} catch(error) { console.log(JSON.stringify({error:error.message})); }
`,
  )
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, runner], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    expect(code, stderr).toBe(0)
    expect(stderr).toBe('')
    return { root, entry, literal, result: JSON.parse(stdout), launch: JSON.parse(readFileSync(record, 'utf8')) }
  } finally {
    clearTimeout(timer)
  }
}

describe('native child window presentation (real processes with synthetic payloads)', () => {
  it('requests hidden presentation while preserving literal argv, streams, cwd, environment and nonzero exit', async () => {
    const { root, entry, literal, result, launch } = await run('pipe')
    expect(launch).toEqual({
      file: process.execPath,
      argv: [entry, ...literal],
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
      shell: false,
      envPreserved: true,
    })
    expect(result).toEqual({
      code: 7,
      stdout: { args: literal, input: 'synthetic-input\n', cwd: root },
      stderr: 'synthetic-stderr',
    })
  })
  it.each(['omp', 'omp-failure'] as const)('requests hidden presentation for the OMP catalog child and preserves %s result', async (operation) => {
    const { root, entry, result, launch } = await run(operation)
    expect(launch).toEqual({
      file: process.execPath,
      argv: [entry, 'models', '--json', '--no-extensions', '--config', join(root, 'config.yml')],
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
      shell: false,
      envPreserved: true,
    })
    expect(result).toEqual(operation === 'omp'
      ? { models: [{ provider: 'synthetic', id: 'test-model', thinking: { efforts: ['low', 'high'] } }] }
      : { error: '无法读取 Pi/OMP 原生模型目录，请检查本机配置' })
  })
})
