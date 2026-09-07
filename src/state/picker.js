// The eyedropper's handshake.
//
// A colour control asks for a sample and gets one back. That is a *callback*,
// and callbacks do not belong in the document store: the store is serialised
// into projects and autosaves, and a function is the one thing that cannot
// survive that trip.
//
// So the pending request lives here, beside the store rather than inside it,
// and the store keeps only the flag the interface needs to render — which tool
// is active, and that a pick is in progress.

let pending = null

/**
 * Asks for the next sampled colour.
 *
 * `restore` is the tool to return to afterwards, so picking a colour from a
 * control does not silently leave the eyedropper selected — you asked for one
 * colour, not for a mode.
 */
export function requestPick(apply, restore = null) {
  pending = { apply, restore }
}

/** Whether something is waiting for a colour. */
export const pickPending = () => !!pending

/** The tool to go back to once a pick lands, if any. */
export const pickRestore = () => pending?.restore || null

/**
 * Hands a sampled colour to whatever asked for it, and clears the request.
 *
 * Returns whether anyone was waiting, so the caller can tell a targeted pick
 * from someone simply using the eyedropper on its own.
 */
export function deliverPick(hex) {
  if (!pending) return false
  const { apply } = pending
  pending = null
  try {
    apply(hex)
  } catch (err) {
    console.error('[pixelforge] colour pick failed', err)
  }
  return true
}

/** Abandons a request — the tool changed, or Escape was pressed. */
export function cancelPick() {
  pending = null
}
