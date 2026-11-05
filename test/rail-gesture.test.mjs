import assert from 'node:assert/strict'
import test from 'node:test'
import { createRailGesture, RAIL_DRAG_THRESHOLD } from '../src/client/rail-gesture.ts'

const point = (clientX = 20, clientY = 30, pointerId = 1) => ({ clientX, clientY, pointerId })

// A click opens only when consumeClick is false; sorting commits only when end.commit is true.
test('stationary press stays clickable and does not commit a reorder', () => {
  const gesture = createRailGesture()
  assert.equal(gesture.begin(point()), true)
  assert.deepEqual(gesture.end(1), { commit: false })
  assert.equal(gesture.consumeClick(), false)
})

test('small pointer jitter stays clickable', () => {
  const gesture = createRailGesture()
  gesture.begin(point())
  assert.equal(gesture.move(point(23, 34)), false)
  assert.deepEqual(gesture.end(1), { commit: false })
  assert.equal(gesture.consumeClick(), false)
})

for (const [direction, x, y] of [
  ['down', 20, 30 + RAIL_DRAG_THRESHOLD],
  ['up', 20, 30 - RAIL_DRAG_THRESHOLD],
  ['right', 20 + RAIL_DRAG_THRESHOLD, 30],
  ['left', 20 - RAIL_DRAG_THRESHOLD, 30],
  ['diagonal', 25, 35],
]) {
  test(`${direction} movement at or above the threshold commits and suppresses the trailing click`, () => {
    const gesture = createRailGesture()
    gesture.begin(point())
    assert.equal(gesture.move(point(x, y)), true)
    assert.deepEqual(gesture.end(1), { commit: true })
    assert.equal(gesture.consumeClick(), true)
    assert.equal(gesture.consumeClick(), false)
  })
}

test('distance is measured from the press rather than each tiny movement', () => {
  const gesture = createRailGesture()
  gesture.begin(point())
  for (let delta = 1; delta < RAIL_DRAG_THRESHOLD; delta += 1) {
    assert.equal(gesture.move(point(20, 30 + delta)), false)
  }
  assert.equal(gesture.move(point(20, 30 + RAIL_DRAG_THRESHOLD)), true)
})

test('returning to the starting point remains a drag and cannot open a session', () => {
  const gesture = createRailGesture()
  gesture.begin(point())
  assert.equal(gesture.move(point(20, 60)), true)
  assert.equal(gesture.move(point()), true)
  assert.deepEqual(gesture.end(1), { commit: true })
  assert.equal(gesture.consumeClick(), true)
})

test('an unrelated pointer cannot start, move, or finish the active gesture', () => {
  const gesture = createRailGesture()
  gesture.begin(point())
  assert.equal(gesture.begin(point(100, 100, 2)), false)
  assert.equal(gesture.move(point(100, 100, 2)), false)
  assert.equal(gesture.end(2), null)
  assert.equal(gesture.move(point(20, 40)), true)
  assert.deepEqual(gesture.end(1), { commit: true })
})

for (const dragging of [false, true]) {
  test(`pointercancel ${dragging ? 'during drag' : 'before threshold'} neither commits nor opens`, () => {
    const gesture = createRailGesture()
    gesture.begin(point())
    if (dragging) gesture.move(point(20, 80))
    assert.deepEqual(gesture.end(1, true), { commit: false })
    assert.equal(gesture.consumeClick(), true)
    assert.equal(gesture.end(1), null)
    assert.equal(gesture.move(point(20, 80)), false)
  })
}

test('window blur cancels and clears the active pointer', () => {
  const gesture = createRailGesture()
  gesture.begin(point())
  gesture.move(point(20, 80))
  gesture.cancel()
  assert.equal(gesture.end(1), null)
  assert.equal(gesture.consumeClick(), true)
  assert.equal(gesture.begin(point()), true)
  assert.deepEqual(gesture.end(1), { commit: false })
  assert.equal(gesture.consumeClick(), false)
})

test('the next press opens even when the previous drag emitted no click', () => {
  const gesture = createRailGesture()
  gesture.begin(point())
  gesture.move(point(20, 80))
  gesture.end(1)
  gesture.begin(point())
  gesture.end(1)
  assert.equal(gesture.consumeClick(), false)
})

test('idle move and end events do not suppress a keyboard or assistive click', () => {
  const gesture = createRailGesture()
  assert.equal(gesture.move(point()), false)
  assert.equal(gesture.end(1), null)
  assert.equal(gesture.consumeClick(), false)
})
