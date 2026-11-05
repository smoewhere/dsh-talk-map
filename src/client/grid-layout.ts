/**
 * Folder-style slot layout for the board.
 *
 * A workspace frame is a container, not a decoration: its rect is owned by the
 * user (drag the label to move it, drag the edge to resize it) and the cards
 * inside are laid out by THIS module into fixed slots, like home-screen icons.
 * Nothing here touches the store — every function is pure, so the invariants
 * ("never overlap", "reflow when the folder changes width", "compact when a
 * card leaves", "overflow collapses into the last cell") are unit-testable
 * without a browser.
 *
 * Slot ORDER is not decided here: the canvas keeps its own order (insertion
 * order, with an active conversation promoted to the front) and hands this
 * module an ordered list of card ids.
 *
 * Coordinates are flow coordinates (the same space as Card.x/Card.y).
 */
import type { FrameGeometry } from '../shared/model.ts'

export const CARD_W = 224
export const CARD_H = 120
export const GAP_X = 48
export const GAP_Y = 56
export const FRAME_PAD = 32
export const FRAME_LABEL_H = 30

/** Distance from the frame's top edge down to the first row of slots. */
const TOP_INSET = FRAME_PAD + FRAME_LABEL_H

/** A folder always fits at least one column. */
export const MIN_FRAME_WIDTH = CARD_W + FRAME_PAD * 2
/** …and at least one row. */
export const MIN_FRAME_HEIGHT = TOP_INSET + CARD_H + FRAME_PAD

/** Automatic growth stops here; manual frames may hold more slots. */
export const AUTO_FRAME_CARD_LIMIT = 6

export interface Point {
  x: number
  y: number
}

/** How many card columns fit in a frame of this width. */
export function colsForWidth(width: number): number {
  const usable = Math.max(CARD_W, width - FRAME_PAD * 2)
  return Math.max(1, Math.floor((usable + GAP_X) / (CARD_W + GAP_X)))
}

/** How many card rows are fully visible in a frame of this height. */
export function rowsForHeight(height: number): number {
  const usable = Math.max(CARD_H, height - TOP_INSET - FRAME_PAD)
  return Math.max(1, Math.floor((usable + GAP_Y) / (CARD_H + GAP_Y)))
}

/** Slots a frame can show before cards have to collapse into the stack cell. */
export function capacityFor(rect: FrameGeometry): number {
  return colsForWidth(rect.width) * rowsForHeight(rect.height)
}

/** Top-left corner of slot `index` in a frame with this geometry. */
export function slotPoint(rect: FrameGeometry, index: number, cols = colsForWidth(rect.width)): Point {
  const col = index % cols
  const row = Math.floor(index / cols)
  return {
    x: rect.x + FRAME_PAD + col * (CARD_W + GAP_X),
    y: rect.y + TOP_INSET + row * (CARD_H + GAP_Y),
  }
}

/** Height a frame needs for `count` cards at `cols` columns (label band included). */
export function contentHeight(count: number, cols: number): number {
  const rows = Math.max(1, Math.ceil(Math.max(count, 1) / cols))
  return TOP_INSET + rows * CARD_H + (rows - 1) * GAP_Y + FRAME_PAD
}

/**
 * Normalize stored or manually chosen geometry to at least one column and row.
 * Automatic frames additionally use autoFrameRect; keeping these responsibilities
 * separate lets a manual resize retain its chosen overflow capacity.
 */
export function frameRect(stored: FrameGeometry): FrameGeometry {
  return {
    x: stored.x,
    y: stored.y,
    width: Math.max(MIN_FRAME_WIDTH, stored.width),
    height: Math.max(MIN_FRAME_HEIGHT, stored.height),
  }
}

/**
 * Grow right/down only, up to six slots, without pushing neighboring frames.
 * Existing dimensions remain a lower bound, including larger manual sizes.
 * Try narrow grids too so a neighbor on one axis need not block the other.
 */
export function autoFrameRect(
  stored: FrameGeometry,
  count: number,
  obstacles: readonly FrameGeometry[] = [],
): FrameGeometry {
  const base = frameRect(stored)
  const target = Math.max(1, Math.min(AUTO_FRAME_CARD_LIMIT, Math.ceil(count) || 1))
  if (capacityFor(base) >= target) return base

  const preferredCols = Math.min(3, target)
  const originalOverlaps = obstacles.map(obstacle => overlapArea(base, obstacle))
  let best = base
  let bestCapacity = Math.min(target, capacityFor(base))
  // A small area premium favors a readable horizontal grid over a tall stack.
  // Substantially smaller grids can still win (e.g. four cards in two columns).
  const cost = (rect: FrameGeometry) => rect.width * rect.height
    * (1 + 0.1 * Math.max(0, preferredCols - colsForWidth(rect.width)))
  let bestCost = cost(base)

  for (let cols = 1; cols <= preferredCols; cols += 1) {
    const width = Math.max(base.width, MIN_FRAME_WIDTH + (cols - 1) * (CARD_W + GAP_X))
    const actualCols = colsForWidth(width)
    const maxRows = Math.ceil(target / actualCols)
    for (let rows = 1; rows <= maxRows; rows += 1) {
      const candidate = {
        x: base.x,
        y: base.y,
        width,
        height: Math.max(base.height, contentHeight(rows * actualCols, actualCols)),
      }
      // Check the whole candidate, including diagonal neighbors. If old data
      // already overlaps, allow it to remain but never deepen that overlap.
      if (obstacles.some((obstacle, index) => overlapArea(candidate, obstacle) > originalOverlaps[index])) continue
      const capacity = Math.min(target, capacityFor(candidate))
      const candidateCost = cost(candidate)
      if (capacity > bestCapacity || (capacity === bestCapacity && candidateCost < bestCost)) {
        best = candidate
        bestCapacity = capacity
        bestCost = candidateCost
      }
    }
  }
  return best
}

function overlapArea(a: FrameGeometry, b: FrameGeometry): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return width * height
}

/** Which slot a point falls on — a hit-test helper for callers, not an order. */
export function slotIndexAt(rect: FrameGeometry, point: Point): number {
  const cols = colsForWidth(rect.width)
  const col = clamp(Math.round((point.x - rect.x - FRAME_PAD) / (CARD_W + GAP_X)), 0, cols - 1)
  const row = Math.max(0, Math.round((point.y - rect.y - TOP_INSET) / (CARD_H + GAP_Y)))
  return row * cols + col
}

/**
 * Slot position for every card, in the order it was given. Cards past
 * `capacity` still get coordinates (the slots after the visible grid), so a
 * folder that is enlarged later brings them back without extra bookkeeping.
 */
export function layoutFor(rect: FrameGeometry, orderedIds: readonly string[]): Record<string, Point> {
  const cols = colsForWidth(rect.width)
  const out: Record<string, Point> = {}
  orderedIds.forEach((cardId, index) => {
    out[cardId] = slotPoint(rect, index, cols)
  })
  return out
}

/** How many cards render normally once the overflow cell takes the last slot. */
export function visibleCount(capacity: number, total: number): number {
  if (total <= capacity) return total
  // One slot is spent on the stack cell, so the grid shows one card fewer —
  // and when the folder only fits ONE card, that slot is the stack itself
  // (otherwise the second card would spill outside the frame).
  return Math.max(0, capacity - 1)
}

export interface PlacedCard {
  cardId: string
  x: number
  y: number
}

/**
 * Reading order of the current arrangement: top row first, left to right. The
 * canvas derives its slot order from this, which is what makes a manual drag
 * persist and what a promotion rewrites.
 */
export function readingOrder(cards: readonly PlacedCard[]): string[] {
  return [...cards]
    .sort((a, b) => (a.y - b.y) || (a.x - b.x) || a.cardId.localeCompare(b.cardId))
    .map(card => card.cardId)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
