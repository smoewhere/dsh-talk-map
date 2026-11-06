import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
const out = path.resolve('.agent-tmp/trash-test/lifecycle.mjs')
await build({ entryPoints: ['src/host/session-lifecycle.ts'], outfile: out, bundle: true, platform: 'node', format: 'esm' })
const { installSessionLifecycle } = await import(pathToFileURL(out))
function fixture() {
  const agents = new Map(), sessions = new Map(), writes = [], releases = []
  const host = {
    sessions: { get: id => sessions.get(id) },
    sessionPersistence: { async create(header) { return {header, close: async () => {}} }, async open(id, access) { return { id, access, close: async () => {} } } },
    agentLoop: { async initializeAgent(owner, { session, setup }) {
      assert.equal(this, host.agentLoop)
      await setup?.()
      const agent = { id: session.header.id, session }
      sessions.set(agent.id, session); agents.set(agent.id, agent)
      return { agent, async dispose() {
        await session.append('final drain')
        releases.push(agent.id); sessions.delete(agent.id); agents.delete(agent.id)
      } }
    } },
    agents: { get: id => agents.get(id), async create(options) {
      assert.equal(this, host.agents)
      const session = { header: { id: options.sessionId, ...options.meta }, append(value) { writes.push(value) } }
      return host.agentLoop.initializeAgent(this, { session, setup: options.setup })
    }, async resume(options) { return this.create({ sessionId: options.resumeSessionId }) } },
  }
  return { host, adapter: installSessionLifecycle(host), agents, sessions, writes, releases }
}
test('idle release uses native handle, guards all append/input, retains handles on reload', async () => {
  const f = fixture(), h = await f.host.agents.create({ sessionId: 'a' })
  assert.equal(installSessionLifecycle(f.host), f.adapter)
  const thaw = await f.adapter.freeze(['a'])
  assert.throws(() => h.agent.session.append('late input'), { code: 'SESSION_TRASHED' })
  await assert.rejects(() => f.host.agents.resume({ resumeSessionId: 'a' }), { code: 'SESSION_TRASHED' })
  await assert.rejects(() => f.host.agents.create({ sessionId: 'child', parentAgent: h.agent }), { code: 'SESSION_TRASHED' })
  const read = await f.host.sessionPersistence.open('a', 'read')
  assert.equal(read.access, 'read')
  await f.adapter.release(['a'])
  assert.deepEqual(f.releases, ['a']); assert.deepEqual(f.writes, ['final drain'])
  thaw()
  const restored = await f.host.agents.resume({ resumeSessionId: 'a' })
  assert.equal(restored.agent.id, 'a')
})
test('whole-tree preflight refuses missing handles before releasing any session', async () => {
  const f = fixture()
  await f.host.agents.create({ sessionId: 'a' })
  f.sessions.set('child', {})
  await assert.rejects(() => f.adapter.freeze(['a', 'child']), { code: 'SESSION_RELEASE_UNAVAILABLE' })
  assert.deepEqual(f.releases, [])
  assert.equal(f.adapter.blocks('a'), false)
})
test('freeze joins in-flight creation; failed native disposal preserves error and fence', async () => {
  const f = fixture()
  let finish
  const pending = f.host.agents.create({ sessionId: 'a', setup: () => new Promise(resolve => { finish = resolve }) })
  const frozen = f.adapter.freeze(['a'])
  finish(); const handle = await pending
  const thaw = await frozen
  handle.dispose = async () => { throw Error('flush failed') }
  await assert.rejects(() => f.adapter.release(['a']), { code: 'SESSION_RELEASE_FAILED' })
  assert.ok(f.sessions.has('a')); assert.ok(f.adapter.blocks('a'))
  thaw()
})
test('internal-write authority expires for inherited asynchronous work', async () => {
  const f = fixture(); let late
  await f.adapter.own(async () => { late = () => f.adapter.assertWritable('a') })
  f.adapter.setFence(id => id === 'a')
  assert.throws(late, { code: 'SESSION_TRASHED' })
  await assert.rejects(() => f.host.sessionPersistence.open('a', 'write'), { code: 'SESSION_TRASHED' })
})

test('stopping permits final driver records, but never new user input or turns', async () => {
  const f = fixture(), h = await f.host.agents.create({ sessionId: 'a' })
  const thaw = await f.adapter.freeze(['a']), finish = f.adapter.drain(['a'])
  h.agent.session.append('tool/result')
  h.agent.session.append('step/end')
  h.agent.session.append('turn/end')
  assert.throws(() => h.agent.session.append('user/message'), {code:'SESSION_TRASHED'})
  assert.throws(() => h.agent.session.append('turn/start'), {code:'SESSION_TRASHED'})
  finish(); thaw()
})

test('a raced initializer closes its handed-off native handle instead of leaking the lease', async () => {
  const f = fixture(); f.adapter.setFence(id => id === 'a')
  let closed = false
  await assert.rejects(() => f.host.agentLoop.initializeAgent({}, {
    session: { header: {id:'a'}, append() {} },
    stored: {handle: {close: async () => {closed = true}}},
  }), {code:'SESSION_TRASHED'})
  assert.equal(closed, true)
  await assert.rejects(() => f.adapter.own(() => f.host.agents.create({sessionId:'a'})), {code:'SESSION_TRASHED'})
})

test('persistence creation cannot resurrect a deleted identity, including under internal disposal', async () => {
  const f = fixture(); f.adapter.setFence(id => id === 'a')
  await assert.rejects(() => f.host.sessionPersistence.create({id:'a'}), {code:'SESSION_TRASHED'})
  await assert.rejects(() => f.host.sessionPersistence.create({id:'child',origin:'subagent',parentSession:'a'}), {code:'SESSION_TRASHED'})
})
test('reload recognizes lifecycle errors from the previous module instance', async () => {
  const old = await import(pathToFileURL(out)), fresh = await import(pathToFileURL(out) + '?reload')
  assert.equal(fresh.isLifecycleError(new old.LifecycleError('SESSION_TRASHED', 'test')), true)
})
