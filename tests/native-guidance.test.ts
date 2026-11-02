import { afterEach, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareNativeWorker } from '../src/host/native-worker.ts'
import { DEFAULT_CONFIG } from '../src/host/process.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function preparedInput(cli: any = 'codex') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-guidance-SIMULATED-')))
  roots.push(root)
  const stateDirectory = join(root, 'state')
  mkdirSync(stateDirectory, { mode: 0o700 })
  return { cli, project: root, preference: { cli, model: 'synthetic-model', effort: 'low' as const },
    mode: 'accept-edits' as const, prompt: 'synthetic task', stateDirectory }
}

// Explicit synthetic Codex process: no installed CLI, credentials, network, or model.
const transcript = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
const note=(method,params)=>send({method,params});
const threadId='synthetic-session',turnId='synthetic-turn';
createInterface({input:process.stdin}).on('line',(line)=>{
 const value=JSON.parse(line);appendFileSync(process.env.CWN_GUIDANCE_LOG,line+'\\n');
 if(value.method==='initialize')send({id:value.id,result:{}});
 else if(value.method==='thread/start')send({id:value.id,result:{thread:{id:threadId},model:'synthetic-model',cwd:process.cwd(),approvalPolicy:'never',sandbox:{type:'workspaceWrite',networkAccess:false},reasoningEffort:'low'}});
 else if(value.method==='turn/start'){
  send({id:value.id,result:{turn:{id:turnId,status:'inProgress',items:[]}}});
  note('turn/started',{threadId,turn:{id:turnId,status:'inProgress',items:[]}});
  note('item/agentMessage/delta',{threadId,turnId,itemId:'answer',delta:'synthetic progress'});
 }else if(value.method==='turn/steer'){
  send({id:value.id,result:{turnId}});
  setTimeout(()=>{note('item/completed',{threadId,turnId,item:{id:'answer',type:'agentMessage',text:'synthetic progress accepted'}});note('turn/completed',{threadId,turn:{id:turnId,status:'completed',items:[]}})},80);
 }
}).on('close',()=>process.exit(0));
`

it('routes run-private guidance through the bridge to one existing native process, then closes admission', async () => {
  const input = preparedInput(), entry = join(input.project, 'synthetic-cli.mjs'), log = join(input.project, 'native-requests.jsonl')
  writeFileSync(entry, transcript, { mode: 0o700 })
  const launch = await prepareNativeWorker({
    argv: [entry, 'exec', '--json', '--skip-git-repo-check', '--model', input.preference.model, `任务：\n${input.prompt}`],
    env: { CWN_GUIDANCE_LOG: log },
  }, input, { ...DEFAULT_CONFIG, timeoutMs: 3000 })
  const request = JSON.parse(readFileSync(launch.argv.at(-1)!, 'utf8'))
  expect(request.controlDirectory).not.toBe(request.stopDirectory)
  expect(request.controlNonce).not.toBe(request.stopNonce)
  if (process.platform !== 'win32') expect(statSync(launch.argv.at(-1)!).mode & 0o777).toBe(0o600)
  const child = spawn(launch.argv[0], launch.argv.slice(1), { cwd: input.project,
    env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', pending = '', stderr = '', ready!: () => void
  const active = new Promise<void>((resolve) => { ready = resolve })
  child.stdout.on('data', (chunk) => {
    output += chunk; pending += chunk
    const lines = pending.split('\n'); pending = lines.pop()!
    for (const line of lines) {
      const frame = JSON.parse(line)
      if (frame.type === 'event' && frame.event.kind === 'assistant') ready()
    }
  })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  try {
    await Promise.race([active, done.then(() => { throw new Error(`Synthetic bridge exited before ready: ${stderr}`) })])
    const first = launch.steer!('synthetic guidance', 'guidance-one')
    expect(launch.steer!('synthetic guidance', 'guidance-one')).toBe(first)
    await first
    expect(await done).toBe(0)
    await expect(launch.steer!('after terminal', 'guidance-two')).rejects.toThrow('已关闭')
    const requests = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(requests.filter((value) => value.method === 'turn/start')).toHaveLength(1)
    expect(requests.filter((value) => value.method === 'turn/steer')).toHaveLength(1)
    const frames = output.trim().split('\n').map((line) => JSON.parse(line))
    expect(frames.at(-1)).toMatchObject({ status: 'SUCCESS', response: 'synthetic progress accepted' })
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await done }
    await launch.cleanup()
  }
})

it.each(['claude', 'antigravity', 'kimi', 'grok', 'zcode', 'mimo', 'opencode'] as const)(
  'does not expose a %s native steering mailbox from duplex capability alone', async (cli) => {
    const input = preparedInput(cli)
    const launch = await prepareNativeWorker({ argv: ['/synthetic-cli'] }, input, DEFAULT_CONFIG)
    try {
      expect(launch.steer).toBeUndefined()
      const request = JSON.parse(readFileSync(launch.argv.at(-1)!, 'utf8'))
      expect(request.controlNonce).toBeUndefined()
      expect(request.controlDirectory).toBeUndefined()
    } finally { await launch.cleanup() }
  },
)
