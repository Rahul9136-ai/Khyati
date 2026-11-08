// Don't lose a change made just before leaving the page.
//
// Saves are debounced (a change goes to the server ~0.6–0.8 s after it's made).
// Each sync registers here:
//   * the tab is hidden (switching tabs, minimising, starting to close): save now;
//   * the page is closing (pagehide): `beacon` sends what's pending with
//     keepalive requests, which finish even after the page is gone;
//   * still unsaved when someone tries to leave (beforeunload): the browser's
//     "Changes you made may not be saved" prompt appears.
export interface Saver {
  /** Something isn't saved on the server yet. */
  pending: () => boolean
  /** Save now (the page is still alive). */
  flush: () => Promise<void> | void
  /** Last chance while the page closes: fire-and-forget keepalive requests. */
  beacon?: () => void
}

const savers = new Set<Saver>()
let installed = false

const anyPending = () => [...savers].some((s) => { try { return s.pending() } catch { return false } })

function install() {
  if (installed || typeof window === "undefined") return
  installed = true
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") for (const s of savers) void s.flush()
  })
  window.addEventListener("pagehide", () => {
    for (const s of savers) { try { if (s.pending()) s.beacon?.() } catch { /* never block leaving */ } }
  })
  window.addEventListener("beforeunload", (e) => {
    if (!anyPending()) return
    for (const s of savers) void s.flush()
    e.preventDefault()
    e.returnValue = "" // shows the browser's own "changes may not be saved" prompt
  })
}

/** Register a saver; returns a function that unregisters it. */
export function guardLeaving(saver: Saver): () => void {
  install()
  savers.add(saver)
  return () => { savers.delete(saver) }
}

/** For tests. */
export const hasPendingSaves = anyPending
