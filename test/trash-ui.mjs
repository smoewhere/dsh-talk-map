/** Shipped bundle against DSH-owned session row menus. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve('.')
const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(existsSync)
if (!edge) throw Error('Microsoft Edge not found')
const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  const file = path.resolve(
    root,
    '.' +
      (pathname === '/'
        ? '/test/index.html'
        : pathname === '/client/client.dev.js'
          ? '/client/client.js'
          : pathname),
  )
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403).end()
    return
  }
  try {
    const bytes = await readFile(file)
    res
      .writeHead(200, {
        'content-type': file.endsWith('.html')
          ? 'text/html'
          : file.endsWith('.css')
            ? 'text/css'
            : 'text/javascript',
      })
      .end(bytes)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
console.log('UI fixture server ready')
const browser = await chromium.launch({ executablePath: edge, headless: true })
console.log('Isolated browser ready')
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/test/index.html`)
  await page.evaluate(() => window.__harness.nativeRows())
  await page.locator('[data-row-key]').first().waitFor()
  const row = page.locator('[data-row-key]').first()
  const sid = (await row.getAttribute('data-row-key')).slice(8)
  const native = () => page.locator(`[data-row-key="session:${sid}"]`)
  await mkdir('.agent-tmp/trash-ui', { recursive: true })
  await native().click({ button: 'right' })
  await page.getByRole('menuitem', { name: '原生置顶', exact: true }).waitFor()
  const deleteItem = page.getByRole('menuitem', { name: /删除会话/ })
  const icon = deleteItem.locator('svg[aria-hidden="true"]')
  assert.equal(await icon.count(), 1, 'delete has a decorative icon like other menu entries')
  assert.equal((await icon.boundingBox()).width, 14)
  assert.equal(await icon.getAttribute('viewBox'), '0 0 16 16', 'delete uses DSH trash-outline geometry')
  assert.equal(await icon.getAttribute('stroke-width'), '1', 'delete uses DSH regular stroke')
  assert.equal(await icon.locator('path').count(), 5)
  assert.equal(
    await deleteItem.evaluate((el) => getComputedStyle(el).color),
    await deleteItem.evaluate((el) => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--dsw-alias-state-error-primary)'
      el.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    }),
    'delete uses DSH danger tone',
  )
  await page.getByRole('menu').screenshot({ path: '.agent-tmp/trash-ui/session-menu-dark.png' })
  await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
  assert.equal(await page.getByRole('menu').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)')
  await page.getByRole('menu').screenshot({ path: '.agent-tmp/trash-ui/session-menu-light.png' })
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  await native().click({ button: 'right' })
  await page.getByRole('menuitem', { name: '原生置顶', exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => ({
    opened: window.__harness.log.filter((l) => l.kind === 'native.contextMenu').length,
    toggled: window.__harness.log.filter((l) => l.kind === 'native.more').length,
  })), { opened: 2, toggled: 0 }, 'DSH owns right click; the plugin only contributes the delete item')
  await page.keyboard.press('Escape')
  await page.getByRole('menu').waitFor({ state: 'detached' })
  await page.locator('[data-talkmap-session]').first().waitFor()
  await native().focus()
  await page.keyboard.press('Shift+F10')
  await deleteItem.waitFor()
  await page.keyboard.press('Escape')
  await native().press('ContextMenu')
  await deleteItem.waitFor()
  assert.equal(
    await page.evaluate(() => window.__harness.log.filter((l) => l.kind === 'native.otherAction').length),
    0,
    'the outlet contains other plugin buttons: none may be mistaken for More',
  )
  assert.equal(
    await page.evaluate(() => window.__harness.log.filter((l) => l.kind === 'native.open').length),
    0,
    'right click must not open a conversation',
  )
  await page.getByRole('menuitem', { name: /删除会话/ }).click()
  await page.getByRole('alertdialog').waitFor()
  assert.equal(
    await page.evaluate(() => window.__harness.recycleCalls().length),
    0,
    'no request before confirmation',
  )
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(
    await page.evaluate(() => window.__harness.recycleCalls().length),
    0,
    'cancel preserves session',
  )
  await native()
    .getByRole('button', { name: 'More ' + sid, exact: true })
    .click()
  await page.getByRole('menuitem', { name: /删除会话/ }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click()
  await native().waitFor({ state: 'detached' })
  assert.equal(await page.locator('[class*="tm_trashNotice"]').count(), 0, 'native deletion succeeds silently')
  await page
    .locator('[data-harness-sidebar]')
    .getByRole('button', { name: '回收站', exact: true })
    .click()
  await page.getByRole('button', { name: '还原', exact: true }).waitFor()
  assert.ok((await page.locator('article').textContent()).includes(sid))
  await page.getByRole('heading', { name: '会话相关存储' }).waitFor()
  assert.ok((await page.locator('article').textContent()).includes('2 KiB'))
  await page.getByRole('combobox').selectOption('size')
  await page.screenshot({ path: '.agent-tmp/trash-ui/recycle-bin-dark.png' })
  await page.setViewportSize({ width: 420, height: 850 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: '.agent-tmp/trash-ui/recycle-bin-narrow.png' })
  await page.setViewportSize({ width: 1100, height: 850 })
  await page.getByRole('button', { name: '还原', exact: true }).click()
  await native().waitFor()
  assert.equal(await page.evaluate(() => window.__harness.log.filter(l => l.kind === 'sessions.refresh').length), 1,
    'restore refreshes the native list even when no added event arrives, without a page reload')
  await page.getByText('回收站为空', { exact: true }).waitFor()
  await native().click({ button: 'right' })
  await page.getByRole('menuitem', { name: /删除会话/ }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click()
  await native().waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: '永久删除所选', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByText(/预计释放 2 KiB.*不可恢复/)
    .waitFor()
  await page.keyboard.press('Escape')
  assert.equal(
    await page.evaluate(
      () => window.__harness.recycleCalls().filter((c) => c.action === 'purge').length,
    ),
    0,
  )
  await page.getByRole('button', { name: '永久删除所选', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click()
  await page.getByText('回收站为空', { exact: true }).waitFor()
  await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
  await page.screenshot({ path: '.agent-tmp/trash-ui/recycle-bin-light.png' })
  // Mixed sizes, unknown measurements and partial failure use the same shipped panel.
  await page.evaluate(() => window.__harness.trashFixture(true))
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByText('大会话', { exact: true }).waitFor()
  await page.getByRole('combobox').selectOption('size')
  assert.ok((await page.locator('article').first().textContent()).includes('大会话'))
  assert.ok((await page.locator('article').last().textContent()).includes('未知大小会话'))
  for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.check()
  await page.getByRole('button', { name: '永久删除所选', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByText(/预计释放.*大小未知/).waitFor()
  assert.equal(await dialog.getByRole('button', {name:'取消',exact:true}).evaluate(el => el === document.activeElement), true)
  await page.keyboard.press('Shift+Tab')
  assert.equal(await dialog.getByRole('button', {name:'确认',exact:true}).evaluate(el => el === document.activeElement), true)
  await page.screenshot({ path: '.agent-tmp/trash-ui/purge-confirm-light.png' })
  await dialog.getByRole('button', { name: '确认', exact: true }).click()
  await page.getByRole('alert').getByText(/fixture file changed/).waitFor()
  assert.equal(await page.locator('article').count(), 1)
  assert.ok((await page.locator('article').textContent()).includes('未知大小会话'))
  await page.getByRole('status').getByText('已永久删除 2 个条目', {exact:true}).waitFor()
  await page.evaluate(() => window.__harness.storageFails(true))
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByText('存储统计失败，会话操作仍可使用', {exact:true}).waitFor()
  assert.equal(await page.getByRole('button', {name:'还原',exact:true}).isEnabled(), true)
  await page.evaluate(() => { window.__harness.storageFails(false); window.__harness.trashFixture(false) })
  // A fresh fixture exercises the actual canvas context menu and shared action.
  await page.reload()
  const card = page.locator('[data-talkmap-session]').first()
  await card.waitFor()
  const canvasId = await card.getAttribute('data-talkmap-session')
  await card.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /删除会话/ }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__harness.recycleCalls().length), 0)
  await page.locator(`[data-talkmap-session="${canvasId}"]`).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: /删除会话/ }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click()
  await page.locator(`[data-talkmap-session="${canvasId}"]`).waitFor({ state: 'detached' })
  assert.equal(await page.locator('[class*="tm_trashNotice"]').count(), 0, 'canvas deletion succeeds silently')
  await page.locator('[data-harness-sidebar]').getByRole('button', {name:'回收站',exact:true}).click()
  await page.getByRole('button', {name:'还原',exact:true}).click()
  await page.locator('[data-harness-sidebar]').getByRole('button', {name:'对话地图',exact:true}).click()
  await page.locator(`[data-talkmap-session="${canvasId}"]`).first().waitFor()
  await page.evaluate(() => window.__harness.recycleBusy(true, 1))
  const busyCard = page.locator('[data-talkmap-session]').first()
  const busyId = await busyCard.getAttribute('data-talkmap-session')
  await busyCard.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /删除会话/ }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click()
  await page
    .getByRole('alertdialog', { name: '停止工作并删除？' })
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await page.locator(`[data-talkmap-session="${busyId}"]`).waitFor({ state: 'detached' })
  assert.ok(
    await page.evaluate(() =>
      window.__harness.recycleCalls().some(e => e.action === 'trash' && e.stopActivity === true),
    ),
  )
  // Successful deletion stays silent; remaining feedback still has a usable lifetime.
  const notices = await browser.newPage({viewport:{width:1100,height:850}})
  notices.on('pageerror', e => errors.push(e.message))
  await notices.clock.install()
  await notices.goto(`http://127.0.0.1:${server.address().port}/test/index.html`)
  await notices.evaluate(() => window.__harness.nativeRows())
  const notice = () => notices.locator('[class*="tm_trashNotice"]')
  const away = async () => {
    await notices.mouse.move(0, 0)
    await notices.locator('[data-harness-sidebar]').getByRole('button', {name:'回收站',exact:true}).focus()
  }
  const beginDelete = async () => {
    const row = notices.locator('[data-row-key]').first()
    const id = await row.getAttribute('data-row-key')
    await row.click({button:'right'})
    await notices.getByRole('menuitem', {name:/删除会话/}).click()
    return id
  }
  const deleteSilently = async () => {
    const id = await beginDelete()
    await notices.getByRole('alertdialog').getByRole('button', {name:'确认',exact:true}).click()
    await notices.locator(`[data-row-key="${id}"]`).waitFor({state:'detached'})
    assert.equal(await notice().count(), 0, 'no success toast or quick-undo popup')
  }
  const restore = async () => {
    await notices.locator('[data-harness-sidebar]').getByRole('button', {name:'回收站',exact:true}).click()
    await notices.getByRole('button', {name:'还原',exact:true}).click()
    await notice().getByText('已还原 1 个条目', {exact:true}).waitFor()
    await away()
  }
  const failDelete = async () => {
    await notices.evaluate(() => window.__harness.recycleBusy(true, 1))
    const id = await beginDelete()
    await notices.getByRole('alertdialog').getByRole('button', {name:'确认',exact:true}).click()
    await notices.getByRole('alertdialog', {name:'停止工作并删除？'}).getByRole('button', {name:'取消',exact:true}).click()
    await notice().getByText(/session running/).waitFor()
    assert.equal(await notices.locator(`[data-row-key="${id}"]`).isVisible(), true)
    assert.equal((await notice().textContent()).includes('移入回收站'), false, 'failed deletion reports errors, not success counts')
    await away()
  }
  await deleteSilently()
  await notices.locator('[data-harness-sidebar]').getByRole('button', {name:'回收站',exact:true}).click()
  await notices.getByRole('button', {name:'还原',exact:true}).waitFor()
  await notices.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
  await notices.screenshot({path:'.agent-tmp/trash-ui/silent-delete-recycle-bin.png'})
  await notices.getByRole('button', {name:'还原',exact:true}).click()
  await notice().getByText('已还原 1 个条目', {exact:true}).waitFor()
  await away()
  await notices.clock.fastForward(4000)
  assert.equal(await notice().isVisible(), true)
  await notice().hover()
  await notices.clock.fastForward(20000)
  assert.equal(await notice().isVisible(), true, 'hover pauses dismissal')
  await notice().getByRole('button').focus()
  await notices.mouse.move(0, 0)
  await notices.clock.fastForward(20000)
  assert.equal(await notice().isVisible(), true, 'keyboard focus pauses dismissal')
  await away()
  await notices.clock.fastForward(6000)
  await notice().waitFor({state:'detached'})
  await deleteSilently()
  await restore()
  await notices.clock.fastForward(3000)
  await failDelete()
  await notices.clock.fastForward(3000)
  assert.equal(await notice().isVisible(), true, 'old timer cannot dismiss a replacement error')
  await notices.clock.fastForward(3000)
  await notice().waitFor({state:'detached'})
  await beginDelete()
  await notices.getByRole('alertdialog').waitFor()
  await notices.clock.fastForward(20000)
  assert.equal(await notices.getByRole('alertdialog').isVisible(), true, 'confirmation dialogs never time out')
  await notices.getByRole('alertdialog').getByRole('button', {name:'取消',exact:true}).click()
  assert.equal(await notice().count(), 0)
  await notices.close()
  // A successful file restoration must not be reported as lost/rolled back
  // when the independent native-list refresh rejects.
  const refreshFailure = await browser.newPage({viewport:{width:1100,height:850}})
  refreshFailure.on('pageerror', e => errors.push(e.message))
  await refreshFailure.goto(`http://127.0.0.1:${server.address().port}/test/index.html`)
  await refreshFailure.evaluate(() => window.__harness.nativeRows())
  await refreshFailure.locator('[data-row-key]').first().click({button:'right'})
  await refreshFailure.getByRole('menuitem', {name:/删除会话/}).click()
  await refreshFailure.getByRole('alertdialog').getByRole('button', {name:'确认',exact:true}).click()
  await refreshFailure.locator('[data-harness-sidebar]').getByRole('button', {name:'回收站',exact:true}).click()
  await refreshFailure.getByRole('button', {name:'还原',exact:true}).waitFor()
  await refreshFailure.evaluate(() => window.__harness.failNativeRefresh(true))
  await refreshFailure.getByRole('button', {name:'还原',exact:true}).click()
  await refreshFailure.getByRole('alert').getByText('会话已还原，但会话列表刷新失败，请刷新页面', {exact:true}).waitFor()
  await refreshFailure.getByText('回收站为空', {exact:true}).waitFor()
  await refreshFailure.getByRole('status').getByText('已还原 1 个条目', {exact:true}).waitFor()
  await refreshFailure.close()
  // Whole-group success is also silent; mixed batches keep only their failure notice.
  await page.reload()
  await page.locator('[data-talkmap-workspace="ws-daily"] [class*="wsFrameLabel"]').click({button:'right'})
  await page.getByRole('menuitem', {name:'删除分组（连同会话）',exact:true}).click()
  await page.getByRole('alertdialog').getByRole('button', {name:'确认',exact:true}).click()
  await page.locator('[data-talkmap-workspace="ws-daily"]').waitFor({state:'detached'})
  assert.equal(await page.locator('[class*="tm_trashNotice"], [class*="tm_toast"]').count(), 0)
  await page.evaluate(() => window.__harness.recycleBusy(true, 1))
  await page.locator('[data-talkmap-workspace="ws-medkit"] [class*="wsFrameLabel"]').click({button:'right'})
  await page.getByRole('menuitem', {name:'删除分组（连同会话）',exact:true}).click()
  await page.getByRole('alertdialog').getByRole('button', {name:'确认',exact:true}).click()
  await page.getByRole('alertdialog', {name:'停止工作并删除？'}).getByRole('button', {name:'取消',exact:true}).click()
  await page.locator('[class*="tm_trashNotice"]').getByText(/session running/).waitFor()
  assert.equal((await page.locator('[class*="tm_trashNotice"]').textContent()).includes('移入回收站'), false)
  // React Flow remeasures the surviving group after the successful members go.
  await page.locator('[data-talkmap-workspace="ws-medkit"]').waitFor()
  assert.ok(await page.evaluate(() => window.__harness.state().global.wsFrames['ws-medkit']))
  assert.ok((await page.evaluate(() => window.__harness.recycleCalls().at(-1))).sessionIds.length > 1)
  assert.deepEqual(errors, [])
  console.log(
    'PASS DSH-owned right click/ellipsis/keyboard menu, delete icon dark/light, cancel/confirm, list deletion, restore, batch purge, silent native/canvas/group deletion, recycle-bin restore, visible failures/partial batches, stop/retry, notice auto-dismiss/hover/focus/reset and persistent confirmation; no page errors',
  )
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
