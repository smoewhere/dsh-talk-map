/**
 * Pure-function checks for the slot layout (no browser, no build):
 *   node test/grid.test.mjs
 *
 * Invariants the UI relies on: fixed non-overlapping slots, width/height decide
 * the grid, overflow collapses into ONE stack cell, order is whatever the
 * canvas hands over.
 */
import assert from 'node:assert/strict'
import {
  AUTO_FRAME_CARD_LIMIT, CARD_H, CARD_W, GAP_X, GAP_Y, MIN_FRAME_HEIGHT, MIN_FRAME_WIDTH,
  autoFrameRect, capacityFor, colsForWidth, contentHeight, frameRect, layoutFor, readingOrder, rowsForHeight,
  slotIndexAt, slotPoint, visibleCount,
} from '../src/client/grid-layout.ts'

const rect = (width, height) => frameRect({ x: 0, y: 0, width, height })
const card = (cardId, x, y) => ({ cardId, x, y })

let checks = 0
function ok(name, fn) {
  fn()
  checks += 1
  console.log(`  ok ${name}`)
}

ok('columns follow width', () => {
  assert.equal(colsForWidth(MIN_FRAME_WIDTH), 1)
  assert.equal(colsForWidth(MIN_FRAME_WIDTH + CARD_W + GAP_X), 2)
  assert.equal(colsForWidth(832), 3)
  assert.equal(colsForWidth(1248), 4)
  assert.equal(colsForWidth(10), 1, 'a tiny folder still fits one column')
})

ok('rows follow height', () => {
  assert.equal(rowsForHeight(MIN_FRAME_HEIGHT), 1)
  assert.equal(rowsForHeight(MIN_FRAME_HEIGHT + CARD_H + GAP_Y), 2)
  assert.equal(rowsForHeight(10), 1, 'a tiny folder still fits one row')
})

ok('capacity = columns x rows', () => {
  assert.equal(capacityFor(rect(832, contentHeight(2, 3))), 3)
  assert.equal(capacityFor(rect(832, contentHeight(5, 3))), 6)
  assert.equal(capacityFor(rect(MIN_FRAME_WIDTH, MIN_FRAME_HEIGHT)), 1)
})

ok('slots never overlap, and stay inside the box', () => {
  for (const width of [MIN_FRAME_WIDTH, 560, 832, 1248]) {
    for (const rows of [1, 2, 3]) {
      const geometry = rect(width, contentHeight(rows * colsForWidth(width), colsForWidth(width)))
      const cols = colsForWidth(geometry.width)
      const points = Array.from({ length: rows * cols }, (_, i) => slotPoint(geometry, i, cols))
      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
          const a = points[i], b = points[j]
          const overlap = a.x < b.x + CARD_W && b.x < a.x + CARD_W && a.y < b.y + CARD_H && b.y < a.y + CARD_H
          assert.equal(overlap, false, `overlap at ${width}px row ${rows}: ${i}-${j}`)
        }
      }
      const last = points.at(-1)
      assert.ok(last.x + CARD_W <= geometry.x + geometry.width, 'slot overflows folder width')
      assert.ok(last.y + CARD_H <= geometry.y + geometry.height + 1, 'slot overflows folder height')
    }
  }
})

ok('layout follows the order it is given', () => {
  const geometry = rect(832, contentHeight(3, 3))
  const layout = layoutFor(geometry, ['b', 'a', 'c'])
  assert.deepEqual(layout['b'], slotPoint(geometry, 0))
  assert.deepEqual(layout['a'], slotPoint(geometry, 1))
  assert.deepEqual(layout['c'], slotPoint(geometry, 2))
})

ok('cards past the capacity still get coordinates (for a later grow)', () => {
  const geometry = rect(832, contentHeight(1, 3))
  const layout = layoutFor(geometry, ['a', 'b', 'c', 'd', 'e'])
  assert.equal(Object.keys(layout).length, 5)
  assert.equal(layout['e'].y, slotPoint(geometry, 4).y, 'the fifth card keeps a stable slot')
})

ok('overflow spends one slot on the stack cell', () => {
  assert.equal(visibleCount(3, 3), 3, 'exactly fits: everything shows')
  assert.equal(visibleCount(3, 4), 2, 'one over: two cards + the stack cell')
  assert.equal(visibleCount(3, 9), 2)
  assert.equal(visibleCount(1, 1), 1, 'a single-slot folder shows its one card')
  assert.equal(visibleCount(1, 5), 0, 'a single-slot folder that overflows IS the stack cell')
  assert.equal(visibleCount(6, 2), 2)
})

ok('reading order is row-major', () => {
  const cards = [card('d', 0, 200), card('b', 300, 0), card('a', 0, 0), card('c', 300, 200)]
  assert.deepEqual(readingOrder(cards), ['a', 'b', 'd', 'c'])
})

ok('reading order survives a promotion rewrite', () => {
  const geometry = rect(832, contentHeight(1, 3))
  const promoted = ['e', 'a', 'b', 'c', 'd']
  const layout = layoutFor(geometry, promoted)
  const back = readingOrder(Object.entries(layout).map(([cardId, point]) => card(cardId, point.x, point.y)))
  assert.deepEqual(back, promoted)
})

ok('slotIndexAt maps a point to the slot under it', () => {
  const geometry = rect(832, contentHeight(2, 3))
  assert.equal(slotIndexAt(geometry, { x: geometry.x + 40, y: geometry.y + 70 }), 0)
  assert.equal(slotIndexAt(geometry, { x: geometry.x + 32 + CARD_W + GAP_X + 10, y: geometry.y + 62 + 10 }), 1)
  assert.equal(slotIndexAt(geometry, { x: geometry.x + 40, y: geometry.y + 62 + CARD_H + GAP_Y + 10 }), 3, 'next row')
})

ok('a folder never renders below one column / one row — and does not grow to fit', () => {
  const tiny = frameRect({ x: 0, y: 0, width: 40, height: 10 })
  assert.equal(tiny.width, MIN_FRAME_WIDTH)
  assert.equal(tiny.height, MIN_FRAME_HEIGHT)
  const roomy = frameRect({ x: 0, y: 0, width: 900, height: 700 })
  assert.deepEqual(roomy, { x: 0, y: 0, width: 900, height: 700 }, 'the user size is respected as-is')
})

const autoBase = { x: -120, y: 75, width: MIN_FRAME_WIDTH, height: MIN_FRAME_HEIGHT }
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width
  && a.y < b.y + b.height && b.y < a.y + a.height

ok('automatic frames grow for two, three and six cards in readable grids', () => {
  for (const [count, cols, rows] of [[2, 2, 1], [3, 3, 1], [6, 3, 2]]) {
    const grown = autoFrameRect(autoBase, count)
    assert.equal(colsForWidth(grown.width), cols, `${count} cards: columns`)
    assert.equal(rowsForHeight(grown.height), rows, `${count} cards: rows`)
    assert.equal(capacityFor(grown), count)
    assert.equal(grown.x, autoBase.x)
    assert.equal(grown.y, autoBase.y)
  }
})

ok('automatic growth is bounded for seven cards and arbitrarily large counts', () => {
  assert.equal(AUTO_FRAME_CARD_LIMIT, 6)
  const bounded = autoFrameRect(autoBase, AUTO_FRAME_CARD_LIMIT)
  for (const count of [7, 100, 1_000_000, Number.MAX_SAFE_INTEGER, Infinity]) {
    assert.deepEqual(autoFrameRect(autoBase, count), bounded, `count ${count}`)
  }
})

ok('empty and single-card automatic frames keep the minimum manual clamp', () => {
  const tiny = { x: 40, y: -20, width: 1, height: 1 }
  for (const count of [0, 1]) assert.deepEqual(autoFrameRect(tiny, count), frameRect(tiny))
})

ok('automatic growth never shrinks stored dimensions or moves the origin', () => {
  const stored = { x: 420, y: -350, width: 620, height: 280 }
  const before = { ...stored }
  const grown = autoFrameRect(stored, 6)
  assert.ok(grown.width >= stored.width)
  assert.ok(grown.height >= stored.height)
  assert.ok(capacityFor(grown) >= 6)
  assert.deepEqual({ x: grown.x, y: grown.y }, { x: stored.x, y: stored.y })
  assert.deepEqual(stored, before, 'the input is not mutated')
  const roomy = { ...stored, width: 1400, height: 950 }
  assert.deepEqual(autoFrameRect(roomy, 1000), roomy, 'existing large frames are retained')
  assert.ok(capacityFor(frameRect(roomy)) > AUTO_FRAME_CARD_LIMIT, 'manual capacity remains unrestricted')
})

ok('a neighbor on the right switches automatic growth to one column', () => {
  const neighbor = { x: autoBase.x + autoBase.width, y: autoBase.y, width: 1000, height: 1500 }
  const before = { ...neighbor }
  const grown = autoFrameRect(autoBase, 6, [neighbor])
  assert.equal(colsForWidth(grown.width), 1)
  assert.equal(rowsForHeight(grown.height), 6)
  assert.equal(overlaps(grown, neighbor), false, 'touching edges are legal')
  assert.deepEqual(neighbor, before, 'the neighbor is not pushed or resized')
  assert.equal(grown.x, autoBase.x)
  assert.equal(grown.y, autoBase.y)
})

ok('a neighbor below allows horizontal growth but caps available slots', () => {
  const neighbor = { x: autoBase.x, y: autoBase.y + autoBase.height, width: 1500, height: 1000 }
  const grown = autoFrameRect(autoBase, 6, [neighbor])
  assert.equal(colsForWidth(grown.width), 3)
  assert.equal(rowsForHeight(grown.height), 1)
  assert.equal(capacityFor(grown), 3, 'the remaining cards must collapse')
  assert.equal(overlaps(grown, neighbor), false)
  assert.equal(grown.height, autoBase.height)
})

ok('automatic growth checks diagonal neighbors against the complete candidate', () => {
  const diagonal = { x: autoBase.x + 600, y: autoBase.y + 250, width: 1000, height: 1500 }
  const grown = autoFrameRect(autoBase, 6, [diagonal])
  assert.equal(colsForWidth(grown.width), 2)
  assert.equal(rowsForHeight(grown.height), 3)
  assert.equal(capacityFor(grown), 6)
  assert.equal(overlaps(grown, diagonal), false, 'a right/below neighbor cannot be skipped')
})

ok('blocked growth retains the largest available partial capacity', () => {
  const obstacles = [
    { x: autoBase.x + autoBase.width, y: autoBase.y, width: 1000, height: 1500 },
    { x: autoBase.x, y: autoBase.y + contentHeight(3, 1), width: 1500, height: 1000 },
  ]
  const grown = autoFrameRect(autoBase, 6, obstacles)
  assert.equal(colsForWidth(grown.width), 1)
  assert.equal(rowsForHeight(grown.height), 3)
  assert.equal(capacityFor(grown), 3)
  for (const obstacle of obstacles) assert.equal(overlaps(grown, obstacle), false)
})

ok('frames enclosed on all sides keep their original geometry', () => {
  const obstacles = [
    { x: autoBase.x - 100, y: autoBase.y - 100, width: 100, height: 1500 },
    { x: autoBase.x - 100, y: autoBase.y - 100, width: 1500, height: 100 },
    { x: autoBase.x + autoBase.width, y: autoBase.y, width: 100, height: 1500 },
    { x: autoBase.x, y: autoBase.y + autoBase.height, width: 1500, height: 100 },
  ]
  assert.deepEqual(autoFrameRect(autoBase, 6, obstacles), autoBase)
})

ok('old overlapping geometry is retained without deepening the overlap', () => {
  const neighbor = { x: autoBase.x + 100, y: autoBase.y + 50, width: 1000, height: 1000 }
  assert.deepEqual(autoFrameRect(autoBase, 6, [neighbor]), autoBase)
  const contained = { x: autoBase.x + 10, y: autoBase.y + 10, width: 30, height: 30 }
  assert.deepEqual(autoFrameRect(autoBase, 6, [contained]), autoFrameRect(autoBase, 6),
    'growth that does not increase an existing overlap remains possible')
})

console.log(`\ngrid-layout: ${checks} checks passed`)
