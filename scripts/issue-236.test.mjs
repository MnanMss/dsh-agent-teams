// Issue #236 regression: the stored session format must be observed on the
// running host, not read back from a nested `@deepseek-ai/dsh-session` copy.
//
// A profile can resolve the plugin's own DSH package line while the process
// loading it runs another generation (pinned lockfile, Desktop shell with an
// embedded core, duplicated store). That copy reported SESSION_FORMAT_VERSION 0
// on a v4 host, so `agentTeamsSource()` selected the retired `plugin` wrapper
// and the host's writer rejected every durable AgentTeams message:
//
//     format v4 message requires a producer-owned source kind
//
// These cases pin the contract in both directions: a live v4 header outranks
// the resolved module, a pre-v3 header still gets the released wrapper, and a
// host that exposes no header version keeps the old fallback.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentTeamsSource, hostSessionFormatVersion, observedSessionFormatVersion } from '../lib/harness-compat.js'
import { steerCaptainReport } from '../lib/members.js'

const releasedWrapper = { kind: 'plugin', plugin: '@nanmicoder/dsh-agent-teams' }
const modern = { kind: 'agent-teams' }
const command = { kind: 'agent-teams-command', goal: 'report on the plugin' }
const captain = version => ({ session: { header: { version } }, steer() {} })

await test('a live v4 session outranks a stale resolved module constant', () => {
  const agent = captain(4)
  assert.equal(observedSessionFormatVersion(agent), 4)
  assert.equal(hostSessionFormatVersion(observedSessionFormatVersion(agent)), 4)
  assert.deepEqual(agentTeamsSource(modern, observedSessionFormatVersion(agent)), modern)
  assert.deepEqual(agentTeamsSource(command, observedSessionFormatVersion(agent)), command)
})

await test('a pre-v3 session keeps the released plugin wrapper', () => {
  assert.deepEqual(agentTeamsSource(modern, observedSessionFormatVersion(captain(2))), releasedWrapper)
})

await test('an absent observation falls back to the resolved module, unchanged', () => {
  assert.equal(observedSessionFormatVersion(undefined), undefined)
  assert.equal(observedSessionFormatVersion({}), undefined)
  assert.equal(observedSessionFormatVersion({ session: {} }), undefined)
  assert.equal(observedSessionFormatVersion({ session: { header: {} } }), undefined)
  assert.equal(observedSessionFormatVersion({ session: { header: { version: 'v4' } } }), undefined)
  const fallback = hostSessionFormatVersion()
  assert.deepEqual(
    agentTeamsSource(modern, undefined),
    fallback >= 3 ? modern : releasedWrapper,
  )
})

await test('a captain report through a real call site uses the live header', () => {
  const steered = []
  const live = {
    session: { header: { version: 4 } },
    steer(message) { steered.push(message) },
  }
  assert.equal(steerCaptainReport(live, 'member-1', 'done'), true)
  assert.equal(steered.length, 1)
  assert.deepEqual(steered[0].source, modern)
})

// A failed member turn is delivered while the captain may be idle. Steering
// then parks the message until some later wake (a user message), which is how
// a failed task's report sat unread for hours. An idle captain must instead get
// its own follow-up turn; a running one still takes the report at its next step.
await test('an idle captain receives a member report as its own follow-up turn', () => {
  const steered = []
  const followed = []
  const idle = {
    session: { header: { version: 4 } },
    status: 'idle',
    steer(message) { steered.push(message) },
    followup(message) { followed.push(message) },
  }
  assert.equal(steerCaptainReport(idle, 'member-1', 'task t3 failed'), true)
  assert.equal(steered.length, 0, 'steering an idle captain parks the report')
  assert.equal(followed.length, 1)
  assert.deepEqual(followed[0].source, modern)
})

await test('a running captain still takes the report at its next step', () => {
  const steered = []
  const followed = []
  const running = {
    session: { header: { version: 4 } },
    status: 'running',
    steer(message) { steered.push(message) },
    followup(message) { followed.push(message) },
  }
  assert.equal(steerCaptainReport(running, 'member-1', 'progress'), true)
  assert.equal(steered.length, 1)
  assert.equal(followed.length, 0)
})

await test('a steering message the captain never claimed is re-delivered as a follow-up', async () => {
  const steered = []
  const followed = []
  const running = {
    session: { header: { version: 4 } },
    status: 'running',
    steer(message) { steered.push(message) },
    followup(message) { followed.push(message) },
    inbox: { get nextStep() { return steered }, nextTurn: [] },
    whenIdle: async () => {},
  }
  assert.equal(steerCaptainReport(running, 'member-1', 'task t3 failed'), true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(followed.length, 1, 'a parked report must not wait for an unrelated user message')
  assert.equal(followed[0].id, steered[0].id)
})

await test('a claimed steering message is not delivered twice', async () => {
  const followed = []
  const running = {
    session: { header: { version: 4 } },
    status: 'running',
    steer() {},
    followup(message) { followed.push(message) },
    inbox: { nextStep: [], nextTurn: [] },
    whenIdle: async () => {},
  }
  assert.equal(steerCaptainReport(running, 'member-1', 'progress'), true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(followed.length, 0)
})
