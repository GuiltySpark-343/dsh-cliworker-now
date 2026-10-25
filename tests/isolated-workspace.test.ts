import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  assertIsolatedCopy,
  createIsolatedWorkspace,
  insideTarget,
  IsolationUnavailableError,
  isolationRoot,
  mergeIsolatedWorkspace,
  removeIsolatedWorkspace,
  workspacePaths,
} from '../src/host/isolated-workspace.ts'
import { projectDirectory } from '../src/host/process.ts'

// Synthetic project trees only; no CLI or Git command is run.
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function fixture() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-isolated-')))
  cleanup.push(() => rmSync(top, { recursive: true, force: true }))
  const project = join(top, 'app')
  mkdirSync(join(project, 'src'), { recursive: true })
  writeFileSync(join(project, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\nfive\n')
  writeFileSync(join(project, 'src', 'b.ts'), 'keep\n')
  writeFileSync(join(project, 'README.md'), '# app\n')
  writeFileSync(join(project, 'image.bin'), Buffer.from([0, 1, 2, 3]))
  mkdirSync(join(project, '.git'))
  writeFileSync(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(project, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(project, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  const root = isolationRoot(join(top, 'state'))
  return { top, project, root, workerId: randomUUID() }
}
async function create(context: ReturnType<typeof fixture>) {
  const result = await createIsolatedWorkspace(context)
  return { ...result, copy: result.path }
}
const posix = process.platform !== 'win32'

describe('isolated workspace copy', () => {
  it('copies the project privately, excluding .git and dependency directories', async () => {
    const context = fixture()
    const { copy } = await create(context)
    expect(copy).toBe(join(realpathSync(context.root), context.workerId, 'copy', 'app'))
    expect(readFileSync(join(copy, 'src', 'a.ts'), 'utf8')).toBe('one\ntwo\nthree\nfour\nfive\n')
    expect(readFileSync(join(copy, 'image.bin'))).toEqual(Buffer.from([0, 1, 2, 3]))
    expect(existsSync(join(copy, '.git'))).toBe(false)
    expect(existsSync(join(copy, 'node_modules'))).toBe(false)
    const paths = workspacePaths(realpathSync(context.root), context.workerId, context.project)
    expect(readFileSync(join(paths.base, 'src', 'a.ts'), 'utf8')).toBe('one\ntwo\nthree\nfour\nfive\n')
    // Binary content keeps only its hash; no baseline blob.
    expect(existsSync(join(paths.base, 'image.bin'))).toBe(false)
    if (posix) {
      expect(statSync(context.root).mode & 0o777).toBe(0o700)
      expect(statSync(paths.directory).mode & 0o777).toBe(0o700)
      expect(statSync(paths.manifest).mode & 0o777).toBe(0o600)
    }
  })

  it('accepts only the exact scheduler-owned copy and keeps the project check strict', async () => {
    const context = fixture()
    const { copy } = await create(context)
    expect(assertIsolatedCopy(context.root, context.workerId, context.project)).toBe(copy)
    expect(() => assertIsolatedCopy(context.root, randomUUID(), context.project)).toThrow('不存在')
    expect(() => assertIsolatedCopy(context.root, '../escape', context.project)).toThrow()
    if (posix) {
      // A planted link in place of the copy directory is rejected.
      const other = { ...context, workerId: randomUUID() }
      const paths = workspacePaths(realpathSync(context.root), other.workerId, context.project)
      mkdirSync(join(paths.directory, 'copy'), { recursive: true })
      symlinkSync(context.project, paths.copy)
      expect(() => assertIsolatedCopy(context.root, other.workerId, context.project)).toThrow('无效')
    }
    // projectDirectory() is unchanged; it still validates the user's project only.
    expect(projectDirectory(context.project)).toBe(context.project)
  })

  it('refuses over-limit projects before copying anything', async () => {
    const context = fixture()
    await expect(createIsolatedWorkspace({ ...context, limits: { maxEntries: 2 } })).rejects.toBeInstanceOf(
      IsolationUnavailableError,
    )
    await expect(createIsolatedWorkspace({ ...context, limits: { maxBytes: 3 } })).rejects.toThrow('总大小')
    expect(existsSync(join(context.root, context.workerId))).toBe(false)
  })

  it('removes a partial copy when cancelled', async () => {
    const context = fixture()
    const controller = new AbortController()
    controller.abort(new Error('synthetic stop'))
    await expect(createIsolatedWorkspace({ ...context, signal: controller.signal })).rejects.toThrow('synthetic stop')
    expect(existsSync(join(context.root, context.workerId))).toBe(false)
  })

  it.skipIf(!posix)('never follows links and skips links that leave the project', async () => {
    const context = fixture()
    const outside = join(context.top, 'secret')
    mkdirSync(outside)
    writeFileSync(join(outside, 'token'), 'do-not-copy')
    symlinkSync(outside, join(context.project, 'escape-dir'))
    symlinkSync('../../secret/token', join(context.project, 'src', 'escape-file'))
    symlinkSync('b.ts', join(context.project, 'src', 'alias.ts'))
    const { copy, skippedLinks } = await create(context)
    expect(skippedLinks).toBe(2)
    expect(existsSync(join(copy, 'escape-dir'))).toBe(false)
    expect(lstatSync(join(copy, 'src', 'escape-file'), { throwIfNoEntry: false })).toBeUndefined()
    expect(readlinkSync(join(copy, 'src', 'alias.ts'))).toBe('b.ts')
  })

  it('confirms removal', async () => {
    const context = fixture()
    await create(context)
    await removeIsolatedWorkspace(context.root, context.workerId)
    expect(existsSync(join(context.root, context.workerId))).toBe(false)
  })
})

describe('three-way merge back into the project', () => {
  it('writes one-sided additions, edits and deletions as plain working-tree changes', async () => {
    const context = fixture()
    const { copy } = await create(context)
    writeFileSync(join(copy, 'src', 'a.ts'), 'one\ntwo\nTHREE\nfour\nfive\n')
    writeFileSync(join(copy, 'src', 'new.ts'), 'created\n')
    mkdirSync(join(copy, 'docs', 'deep'), { recursive: true })
    writeFileSync(join(copy, 'docs', 'deep', 'guide.md'), 'guide\n')
    mkdirSync(join(copy, 'empty'))
    unlinkSync(join(copy, 'src', 'b.ts'))
    // Dependency output in the copy is never merged.
    mkdirSync(join(copy, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(copy, 'node_modules', 'left-pad', 'index.js'), 'x\n')
    const result = await mergeIsolatedWorkspace(context)
    expect(result).toEqual({
      status: 'merged',
      written: ['docs/deep/guide.md', 'src/a.ts', 'src/new.ts'],
      deleted: ['src/b.ts'],
    })
    expect(readFileSync(join(context.project, 'src', 'a.ts'), 'utf8')).toBe('one\ntwo\nTHREE\nfour\nfive\n')
    expect(readFileSync(join(context.project, 'docs', 'deep', 'guide.md'), 'utf8')).toBe('guide\n')
    expect(existsSync(join(context.project, 'empty'))).toBe(true)
    expect(existsSync(join(context.project, 'src', 'b.ts'))).toBe(false)
    expect(readdirSync(join(context.project, 'node_modules'))).toEqual(['pkg'])
    // The project's own Git metadata is untouched; nothing is committed.
    expect(readdirSync(join(context.project, '.git'))).toEqual(['HEAD'])
    expect(readdirSync(join(context.project, 'src')).some((name) => name.includes('cwn-merge'))).toBe(false)
  })

  it('combines non-overlapping edits made on both sides', async () => {
    const context = fixture()
    const { copy } = await create(context)
    writeFileSync(join(copy, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\nFIVE\n')
    writeFileSync(join(context.project, 'src', 'a.ts'), 'ONE\ntwo\nthree\nfour\nfive\n')
    expect((await mergeIsolatedWorkspace(context)).status).toBe('merged')
    expect(readFileSync(join(context.project, 'src', 'a.ts'), 'utf8')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n')
  })

  it('writes nothing when any path conflicts and lists every conflict', async () => {
    const context = fixture()
    const { copy } = await create(context)
    writeFileSync(join(copy, 'src', 'a.ts'), 'one\nCOPY\nthree\nfour\nfive\n')
    writeFileSync(join(context.project, 'src', 'a.ts'), 'one\nMAIN\nthree\nfour\nfive\n')
    writeFileSync(join(copy, 'image.bin'), Buffer.from([9, 9]))
    writeFileSync(join(context.project, 'image.bin'), Buffer.from([8, 8]))
    writeFileSync(join(copy, 'clean.txt'), 'would be added\n')
    unlinkSync(join(copy, 'README.md'))
    writeFileSync(join(context.project, 'README.md'), '# changed in main\n')
    writeFileSync(join(copy, 'both-new.txt'), 'copy\n')
    writeFileSync(join(context.project, 'both-new.txt'), 'main\n')
    const result = await mergeIsolatedWorkspace(context)
    expect(result.status).toBe('conflict')
    if (result.status !== 'conflict') return
    expect(result.copy).toBe(copy)
    expect(result.conflicts.map((item) => item.path)).toEqual(['README.md', 'both-new.txt', 'image.bin', 'src/a.ts'])
    // Main is unchanged and has no conflict markers or staged files.
    expect(existsSync(join(context.project, 'clean.txt'))).toBe(false)
    expect(readFileSync(join(context.project, 'src', 'a.ts'), 'utf8')).toBe('one\nMAIN\nthree\nfour\nfive\n')
    expect(readFileSync(join(copy, 'src', 'a.ts'), 'utf8')).toBe('one\nCOPY\nthree\nfour\nfive\n')
  })

  it('skips identical results and is safe to merge again after a partial write-back', async () => {
    const context = fixture()
    const { copy } = await create(context)
    writeFileSync(join(copy, 'src', 'a.ts'), 'same\n')
    writeFileSync(join(context.project, 'src', 'a.ts'), 'same\n')
    writeFileSync(join(copy, 'README.md'), '# merged\n')
    expect(await mergeIsolatedWorkspace(context)).toMatchObject({ status: 'merged', written: ['README.md'] })
    expect(await mergeIsolatedWorkspace(context)).toEqual({ status: 'merged', written: [], deleted: [] })
  })

  it('treats a case-only rename as a conflict', async () => {
    const context = fixture()
    const { copy } = await create(context)
    const content = readFileSync(join(copy, 'README.md'))
    unlinkSync(join(copy, 'README.md'))
    writeFileSync(join(copy, 'readme.md'), content)
    const result = await mergeIsolatedWorkspace(context)
    expect(result.status).toBe('conflict')
    expect(readFileSync(join(context.project, 'README.md'), 'utf8')).toBe('# app\n')
  })

  it.skipIf(!posix)('applies an executable-bit change made only in the copy', async () => {
    const context = fixture()
    const { copy } = await create(context)
    chmodSync(join(copy, 'src', 'b.ts'), 0o755)
    expect((await mergeIsolatedWorkspace(context)).status).toBe('merged')
    expect(statSync(join(context.project, 'src', 'b.ts')).mode & 0o111).not.toBe(0)
  })

  it.skipIf(!posix)('refuses links that leave the project and paths routed through links', async () => {
    const context = fixture()
    const { copy } = await create(context)
    symlinkSync('/etc/hosts', join(copy, 'hosts'))
    let result = await mergeIsolatedWorkspace(context)
    expect(result).toMatchObject({ status: 'conflict', conflicts: [{ path: 'hosts' }] })
    unlinkSync(join(copy, 'hosts'))
    // Main replaced a directory with a link to elsewhere; writing through it must not happen.
    const outside = join(context.top, 'outside')
    mkdirSync(outside)
    writeFileSync(join(copy, 'src', 'c.ts'), 'new\n')
    rmSync(join(context.project, 'src'), { recursive: true })
    symlinkSync(outside, join(context.project, 'src'))
    result = await mergeIsolatedWorkspace(context)
    expect(result.status).toBe('conflict')
    expect(readdirSync(outside)).toEqual([])
  })

  it('reports a type change as a conflict', async () => {
    const context = fixture()
    const { copy } = await create(context)
    unlinkSync(join(copy, 'README.md'))
    mkdirSync(join(copy, 'README.md'))
    expect((await mergeIsolatedWorkspace(context)).status).toBe('conflict')
    expect(readFileSync(join(context.project, 'README.md'), 'utf8')).toBe('# app\n')
  })
})

it('classifies link targets with POSIX and Windows separators without touching the filesystem', () => {
  // Windows forms are checked as strings only; not verified on a Windows machine.
  expect(insideTarget('src/alias.ts', 'b.ts')).toBe('src/b.ts')
  expect(insideTarget('src/alias.ts', '..\\README.md')).toBe('README.md')
  expect(insideTarget('src/alias.ts', '..\\..\\secret')).toBeUndefined()
  expect(insideTarget('a', 'C:\\Users\\x')).toBeUndefined()
  expect(insideTarget('a', 'c:/Users/x')).toBeUndefined()
  expect(insideTarget('a', '/etc/hosts')).toBeUndefined()
  expect(insideTarget('a/b/c', '../../../x')).toBeUndefined()
})
