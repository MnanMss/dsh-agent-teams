#!/usr/bin/env node
/**
 * Regression: a team created inside a git worktree must reach the Web surface.
 *
 * The activity route used to scan registered workspaces only. A session opened
 * on a worktree keeps its state under its own `<cwd>/.agent-teams`, and that
 * cwd is never a registered workspace, so the panel received no snapshot for
 * the team and could not render it (halt/plan kept working, because they derive
 * the root from the captain's session header).
 *
 * Two layers are covered:
 * - behaviour: `resolveSnapshotRoots` → `collectTeamsActivity` on real files;
 * - wiring: the `/state` route source must keep calling `resolveSnapshotRoots`,
 *   otherwise the whole fix is one refactor away from silently reappearing.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import {
  canonicalDirectory,
  collectArchivedTeamsActivity,
  collectTeamsActivity,
  resolveSnapshotRoots,
  snapshotRoots,
} from '../lib/snapshot.js'

/** The smallest team.json the collectors accept. */
const TEAM_RECORD = (teamId) => JSON.stringify({
  id: teamId,
  name: teamId,
  captainSessionId: `session-${teamId}`,
  createdAt: 1,
  taskSeq: 0,
  members: [],
  tasks: [],
})

/**
 * A context whose only used surfaces are the live session list, the member
 * session lookup (`agents.get`, returning "not running") and the logger.
 */
function sessionCtx(cwds) {
  return {
    logger: { warn() {} },
    agents: {
      list: () => cwds.map((cwd) => ({ session: { header: cwd === undefined ? {} : { cwd } } })),
      get: () => undefined,
    },
  }
}

/** Write the smallest durable team the collectors accept, under `<dir>/<stateDir>`. */
async function writeTeam(dir, teamId, stateDir = '.agent-teams') {
  const root = join(dir, stateDir, teamId)
  await mkdir(join(root, 'inbox'), { recursive: true })
  await writeFile(join(root, 'team.json'), TEAM_RECORD(teamId))
}

/** Write the smallest archived team: `<dir>/<stateDir>/archive/<teamId>/team.json`. */
async function writeArchivedTeam(dir, teamId, stateDir = '.agent-teams') {
  const root = join(dir, stateDir, 'archive', teamId)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'team.json'), TEAM_RECORD(teamId))
}

test('a live worktree session adds the state root the registry never lists', async () => {
  const roots = await snapshotRoots(
    [{ path: '/repo/main', title: 'main' }],
    ['/repo/main', '/repo/main/.worktrees/feature'],
    '.agent-teams',
  )
  assert.deepEqual(roots, [
    {
      workspace: 'main',
      stateRoot: '/repo/main/.agent-teams',
      workspacePath: '/repo/main',
    },
    {
      // No registered title exists for a worktree: the directory name stands in.
      workspace: 'feature',
      stateRoot: '/repo/main/.worktrees/feature/.agent-teams',
      workspacePath: '/repo/main/.worktrees/feature',
    },
  ])
})

test('one directory never yields two roots, whatever its spelling count', async () => {
  const roots = await snapshotRoots(
    [{ path: '/repo/main', title: 'main' }],
    ['/repo/main', '/repo/main', ''],
    '.agent-teams',
  )
  assert.equal(roots.length, 1)
  assert.equal(roots[0].stateRoot, '/repo/main/.agent-teams')
})

test('two directories sharing one state root collapse into one root', async () => {
  // A stateDir escaping with `..` makes both directories resolve to the same
  // state root; two roots would return every team in it twice.
  const roots = await snapshotRoots([{ path: '/repo/a', title: 'a' }], ['/repo/b'], '../shared/.agent-teams')
  assert.deepEqual(roots, [
    { workspace: 'a', stateRoot: '/repo/shared/.agent-teams', workspacePath: '/repo/a' },
  ])
})

test('two worktrees whose state dirs are symlinked to one directory give one root', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'agent-teams-shared-')))
  try {
    const shared = join(base, 'shared', '.agent-teams')
    await mkdir(join(shared, 'shared-team'), { recursive: true })
    await writeFile(join(shared, 'shared-team', 'team.json'), TEAM_RECORD('shared-team'))
    const a = join(base, 'a')
    const b = join(base, 'b')
    await mkdir(a, { recursive: true })
    await mkdir(b, { recursive: true })
    // Different spellings, one physical directory behind `.agent-teams`.
    await symlink(shared, join(a, '.agent-teams'))
    await symlink(shared, join(b, '.agent-teams'))
    const roots = await snapshotRoots([], [a, b], '.agent-teams')
    assert.deepEqual(roots, [{
      workspace: 'a',
      stateRoot: await realpath(shared),
      workspacePath: a,
    }])
    const ctx = sessionCtx([a, b])
    assert.equal((await collectTeamsActivity(ctx, roots)).length, 1, 'a shared state root must not duplicate the team')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the state route resolves a worktree team through the real collector', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'agent-teams-roots-')))
  try {
    const main = join(base, 'main')
    const worktree = join(base, 'wt')
    await writeTeam(main, 'main-team')
    // The whole point: this team lives under the worktree, not a registered workspace.
    await writeTeam(worktree, 'worktree-team')
    const ctx = sessionCtx([worktree])
    const roots = await resolveSnapshotRoots(ctx, [{ path: main, title: 'main' }], '.agent-teams')
    const snapshots = await collectTeamsActivity(ctx, roots)
    assert.deepEqual(snapshots.map((snapshot) => snapshot.teamId).sort(), ['main-team', 'worktree-team'])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the /state route derives its roots from the live sessions, not the registry', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  // Source-level guard: the behaviour tests above pass even when the route is
  // reverted to the registry-only map, so pin the call the route must make.
  assert.match(
    source,
    /resolveSnapshotRoots\(\s*ctx,\s*workspaceRegistry\.list\(\),\s*resolved\.stateDir,?\s*\)/,
    '/state must call resolveSnapshotRoots(ctx, workspaceRegistry.list(), resolved.stateDir)',
  )
})

test('a session without a recorded cwd falls back to process.cwd() like the writers', async () => {
  const cwd = await canonicalDirectory(process.cwd())
  const roots = await resolveSnapshotRoots(sessionCtx([undefined, '']), [], '.agent-teams')
  assert.deepEqual(roots, [
    { workspace: basename(cwd), stateRoot: join(cwd, '.agent-teams'), workspacePath: cwd },
  ])
})

test('a failing live session scan degrades to the registered workspaces', async () => {
  const ctx = {
    logger: { warn() {} },
    agents: { list: () => { throw new Error('agent registry not ready') } },
  }
  const roots = await resolveSnapshotRoots(ctx, [{ path: '/repo/main', title: 'main' }], '.agent-teams')
  assert.deepEqual(roots, [
    { workspace: 'main', stateRoot: '/repo/main/.agent-teams', workspacePath: '/repo/main' },
  ])
})

test('one unreadable root does not hide every other team', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'agent-teams-roots-')))
  try {
    const good = join(base, 'good')
    const bad = join(base, 'bad')
    await writeTeam(good, 'good-team')
    // `.agent-teams` is a FILE here, so readdir fails with ENOTDIR — not the
    // ENOENT the collector used to swallow silently.
    await mkdir(bad, { recursive: true })
    await writeFile(join(bad, '.agent-teams'), 'not a directory')
    const warnings = []
    const ctx = { logger: { warn: (line) => warnings.push(line) } }
    const snapshots = await collectTeamsActivity(
      ctx,
      await snapshotRoots([{ path: good, title: 'good' }, { path: bad, title: 'bad' }], [], '.agent-teams'),
    )
    assert.deepEqual(snapshots.map((snapshot) => snapshot.teamId), ['good-team'])
    assert.equal(warnings.length, 1, 'an unreadable root is reported, never thrown')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('one unreadable archive root does not hide every other archived team', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'agent-teams-archive-')))
  try {
    const good = join(base, 'good')
    const bad = join(base, 'bad')
    await writeArchivedTeam(good, 'old-team')
    // `archive` is a FILE here: listArchivedTeamIds rethrows ENOTDIR, and the
    // collector must report it instead of losing every root.
    await mkdir(join(bad, '.agent-teams'), { recursive: true })
    await writeFile(join(bad, '.agent-teams', 'archive'), 'not a directory')
    const warnings = []
    const ctx = { logger: { warn: (line) => warnings.push(line) } }
    const snapshots = await collectArchivedTeamsActivity(
      ctx,
      await snapshotRoots([{ path: good, title: 'good' }, { path: bad, title: 'bad' }], [], '.agent-teams'),
    )
    assert.deepEqual(snapshots.map((snapshot) => snapshot.teamId), ['old-team'])
    assert.equal(warnings.length, 1, 'an unreadable archive root is reported, never thrown')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a canonical session cwd collapses a symlinked duplicate of a workspace', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'agent-teams-cwd-')))
  try {
    const real = join(base, 'real')
    const alias = join(base, 'alias')
    await mkdir(real, { recursive: true })
    await symlink(real, alias)
    assert.equal(await canonicalDirectory(alias), real)
    const merged = await resolveSnapshotRoots(
      sessionCtx([alias]),
      [{ path: real, title: 'real' }],
      '.agent-teams',
    )
    assert.equal(merged.length, 1, 'a symlinked spelling must not duplicate every team snapshot')
    // The session side alone must still resolve — otherwise this case would pass
    // even with the live-session scan removed. The session cwd is canonicalized,
    // so the alias shows up under the real directory's name.
    assert.deepEqual(await resolveSnapshotRoots(sessionCtx([alias]), [], '.agent-teams'), [
      { workspace: 'real', stateRoot: join(real, '.agent-teams'), workspacePath: real },
    ])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a root directory keeps a non-empty display name', async () => {
  const roots = await snapshotRoots([], ['/'], '.agent-teams')
  assert.equal(roots.length, 1)
  assert.equal(roots[0].workspace, '/', 'basename("/") is empty: the panel must not show an unnamed workspace')
})

test('a vanished session directory keeps its raw spelling instead of disappearing', async () => {
  const missing = join(tmpdir(), 'agent-teams-gone-does-not-exist', 'wt')
  assert.equal(await canonicalDirectory(missing), missing)
})

test('a hung realpath lookup falls back to the raw path without freezing the poll', async () => {
  const hung = join(tmpdir(), 'agent-teams-hung-lookup')
  let lookups = 0
  const lookup = () => {
    lookups += 1
    // Never settles: the shape of a network mount that stopped answering.
    return new Promise(() => {})
  }
  const started = Date.now()
  assert.equal(await canonicalDirectory(hung, { timeoutMs: 20, lookup }), hung)
  assert.ok(Date.now() - started < 1000, 'one hung lookup must not freeze the panel')
  // `realpath` cannot be cancelled: retrying during the cooldown would queue
  // another stuck syscall into the libuv pool the whole host shares.
  assert.equal(await canonicalDirectory(hung, { timeoutMs: 20, lookup }), hung)
  assert.equal(lookups, 1, 'a timed-out path waits out the cooldown instead of retrying')
  const other = join(tmpdir(), 'agent-teams-hung-lookup-other')
  assert.equal(await canonicalDirectory(other, { timeoutMs: 20, lookup }), other)
  assert.equal(lookups, 2, 'the cooldown is per path')
})

test('one session with an unreadable header does not drop every worktree root', async () => {
  const warnings = []
  const ctx = {
    logger: { warn: (line) => warnings.push(line) },
    agents: {
      list: () => [
        { get session() { throw new Error('header unavailable') } },
        { session: { header: { cwd: '/repo/wt' } } },
      ],
    },
  }
  const roots = await resolveSnapshotRoots(ctx, [], '.agent-teams')
  // Before the fix one throwing header blanked every panel: the exact symptom
  // this route exists to remove, reintroduced by a different door.
  assert.deepEqual(roots, [
    { workspace: 'wt', stateRoot: '/repo/wt/.agent-teams', workspacePath: '/repo/wt' },
  ])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /readable cwd/)
})
