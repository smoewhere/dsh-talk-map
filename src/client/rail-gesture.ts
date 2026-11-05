/** Pointer intent for the status rail, independent of React and DOM geometry. */
export const RAIL_DRAG_THRESHOLD = 6

interface RailPointer {
  pointerId: number
  clientX: number
  clientY: number
}

export function createRailGesture() {
  let pointer: RailPointer | null = null
  let dragging = false
  let suppressClick = false

  return {
    begin(next: RailPointer): boolean {
      if (pointer !== null) return false
      pointer = next
      dragging = false
      // A new press must work even if the last drag did not dispatch a click.
      suppressClick = false
      return true
    },
    move(next: RailPointer): boolean {
      if (pointer === null || pointer.pointerId !== next.pointerId) return false
      if (Math.hypot(next.clientX - pointer.clientX, next.clientY - pointer.clientY) >= RAIL_DRAG_THRESHOLD) {
        dragging = true
      }
      return dragging
    },
    end(pointerId: number, cancelled = false): { commit: boolean } | null {
      if (pointer === null || pointer.pointerId !== pointerId) return null
      const commit = dragging && !cancelled
      suppressClick = dragging || cancelled
      pointer = null
      dragging = false
      return { commit }
    },
    cancel(): void {
      if (pointer !== null) suppressClick = true
      pointer = null
      dragging = false
    },
    consumeClick(): boolean {
      const suppressed = suppressClick || dragging
      suppressClick = false
      return suppressed
    },
  }
}
