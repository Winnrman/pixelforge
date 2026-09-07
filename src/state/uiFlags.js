// Tiny non-reactive channel for cross-component UI state that must not trigger
// React renders. Currently just used to keep space-drag panning from also
// firing the space-bar play/pause shortcut.
export const uiFlags = { panned: false }
