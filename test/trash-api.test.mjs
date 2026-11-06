import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const out = path.resolve('.agent-tmp/trash-test/trash-api.mjs')
await build({ entryPoints: ['src/client/api.ts'], outfile: out, bundle: true, packages: 'external', platform: 'node', format: 'esm' })
const { talkMapApi } = await import(pathToFileURL(out))
const json = body => new Response(JSON.stringify(body), { headers: {'content-type':'application/json'} })

test('ordinary deletion omits stopActivity for old strict backends; no automatic retry', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  let calls = 0
  globalThis.fetch = async (url, init) => {
    calls++
    assert.equal(url, '/talk-map/sessions/trash')
    assert.deepEqual(JSON.parse(init.body), {sessionIds:['a']})
    return json({results:[]})
  }
  assert.deepEqual(await talkMapApi.trashSessions(['a']), {results:[]})
  assert.equal(calls, 1)
})
test('old backend cannot receive stopActivity or silently downgrade a confirmed stop', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({url,init}); return json({entries:[]}) }
  await assert.rejects(() => talkMapApi.trashSessions(['a'], true), {code:'HOST_UPGRADE_REQUIRED'})
  assert.deepEqual(calls.map(call => call.url), ['/talk-map/trash'])
  assert.equal(calls[0].init, undefined)
})
test('capable backend receives exactly one explicitly confirmed stop/delete request', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(url)
    if (url === '/talk-map/trash') return json({entries:[],capabilities:{stopActivity:true}})
    assert.deepEqual(JSON.parse(init.body), {sessionIds:['a'],stopActivity:true})
    return json({results:[]})
  }
  await talkMapApi.trashSessions(['a'], true)
  assert.deepEqual(calls, ['/talk-map/trash','/talk-map/sessions/trash'])
})
