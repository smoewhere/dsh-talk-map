/** Shipped bundle against legacy/host-owned row menus, including SlotOutlet's real wrapper. */
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
  assert.ok(await icon.locator('path').count())
  await page.getByRole('menu').screenshot({ path: '.agent-tmp/trash-ui/session-menu-dark.png' })
  await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
  assert.equal(await page.getByRole('menu').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)')
  await page.getByRole('menu').screenshot({ path: '.agent-tmp/trash-ui/session-menu-light.png' })
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  await native().click({ button: 'right' })
  await page.getByRole('menuitem', { name: '原生置顶', exact: true }).waitFor()
  assert.equal(
    await page.evaluate(() => window.__harness.log.filter((l) => l.kind === 'native.more').length),
    1,
    'repeated right click must not toggle the menu closed',
  )
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
  await page
    .locator('[data-harness-sidebar]')
    .getByRole('button', { name: '回收站', exact: true })
    .click()
  await page.getByRole('button', { name: '还原', exact: true }).waitFor()
  assert.ok((await page.locator('article').textContent()).includes(sid))
  await page.screenshot({ path: '.agent-tmp/trash-ui/recycle-bin-dark.png' })
  await page.getByRole('button', { name: '还原', exact: true }).click()
  await native().waitFor()
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
    .getByText(/不可恢复/)
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
  // Teardown removes listeners even if a detached row is still referenced.
  const detached = await page.locator('[data-row-key]').first().elementHandle()
  await page.evaluate(() => window.__harness.nativeRows(false))
  await page.locator('[data-row-key]').first().waitFor({ state: 'detached' })
  assert.equal(await detached.evaluate((el) => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    el.dispatchEvent(e)
    return e.defaultPrevented
  }), false)
  await detached.dispose()
  // 0.2.2-rc.1's native trigger owns right click. The bridge must not intercept
  // React's delegated event or synthesize an ellipsis click on these rows.
  await page.reload()
  await page.evaluate(() => window.__harness.nativeRows(true, 'host'))
  const hostRow = page.locator('[data-row-key]').first()
  await hostRow.click({ button: 'right' })
  await deleteItem.waitFor()
  await hostRow.click({ button: 'right' })
  await deleteItem.waitFor()
  assert.deepEqual(await page.evaluate(() => ({
    opened: window.__harness.log.filter((l) => l.kind === 'native.contextMenu').length,
    toggled: window.__harness.log.filter((l) => l.kind === 'native.more').length,
    selected: window.__harness.log.filter((l) => l.kind === 'native.open').length,
  })), { opened: 2, toggled: 0, selected: 0 })
  await deleteItem.click()
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__harness.recycleCalls().length), 0)
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
  await page.getByRole('status').getByRole('button', { name: '撤销', exact: true }).click()
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
      window.__harness.log.some(
        (e) => e.kind === 'ui.archiveSession' && e.detail.options.stopActivity,
      ),
    ),
  )
  assert.deepEqual(errors, [])
  console.log(
    'PASS legacy outlet/right click/ellipsis/keyboard/teardown, host-owned right click, delete icon dark/light, cancel/confirm, list deletion, restore, batch purge, canvas delete/undo, stop/retry; no page errors',
  )
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
