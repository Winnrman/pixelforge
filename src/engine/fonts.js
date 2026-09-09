// Fonts.
//
// Only what is installed, and nothing fetched. This app runs offline and
// exports through a canvas, so a web font would mean a network round trip that
// can fail and a render that silently falls back to something else. Every
// family here is one the platform ships; the list is filtered at startup to
// what is genuinely present, so the menu never offers a font that will not draw.

const STACK = ', system-ui, sans-serif'
const SERIF = ', Georgia, serif'
const MONO = ', Consolas, monospace'

export const FONT_CHOICES = [
  { label: 'Inter', stack: `Inter${STACK}`, probe: 'Inter' },
  { label: 'System UI', stack: 'system-ui, sans-serif', probe: null },
  { label: 'Segoe UI', stack: `"Segoe UI"${STACK}`, probe: 'Segoe UI' },
  { label: 'Helvetica', stack: `Helvetica, Arial${STACK}`, probe: 'Helvetica' },
  { label: 'Arial', stack: `Arial${STACK}`, probe: 'Arial' },
  // The poster face. Heavy, condensed, and on essentially every machine.
  { label: 'Arial Black', stack: `"Arial Black", Arial${STACK}`, probe: 'Arial Black' },
  { label: 'Impact', stack: `Impact, "Arial Black"${STACK}`, probe: 'Impact' },
  { label: 'Franklin Gothic', stack: `"Franklin Gothic Medium", Arial${STACK}`, probe: 'Franklin Gothic Medium' },
  { label: 'Tahoma', stack: `Tahoma${STACK}`, probe: 'Tahoma' },
  { label: 'Verdana', stack: `Verdana${STACK}`, probe: 'Verdana' },
  { label: 'Trebuchet MS', stack: `"Trebuchet MS"${STACK}`, probe: 'Trebuchet MS' },
  { label: 'Calibri', stack: `Calibri${STACK}`, probe: 'Calibri' },
  { label: 'Futura', stack: `Futura, "Century Gothic"${STACK}`, probe: 'Futura' },
  { label: 'Century Gothic', stack: `"Century Gothic"${STACK}`, probe: 'Century Gothic' },
  { label: 'Gill Sans', stack: `"Gill Sans", "Gill Sans MT"${STACK}`, probe: 'Gill Sans MT' },
  { label: 'Optima', stack: `Optima${STACK}`, probe: 'Optima' },
  { label: 'Georgia', stack: `Georgia${SERIF}`, probe: 'Georgia' },
  { label: 'Times New Roman', stack: `"Times New Roman"${SERIF}`, probe: 'Times New Roman' },
  { label: 'Garamond', stack: `Garamond${SERIF}`, probe: 'Garamond' },
  { label: 'Palatino', stack: `Palatino, "Palatino Linotype", "Book Antiqua"${SERIF}`, probe: 'Palatino Linotype' },
  { label: 'Baskerville', stack: `Baskerville, "Baskerville Old Face"${SERIF}`, probe: 'Baskerville Old Face' },
  { label: 'Cambria', stack: `Cambria${SERIF}`, probe: 'Cambria' },
  { label: 'Consolas', stack: `Consolas${MONO}`, probe: 'Consolas' },
  { label: 'Courier New', stack: `"Courier New"${MONO}`, probe: 'Courier New' },
  { label: 'Menlo', stack: `Menlo, Monaco${MONO}`, probe: 'Menlo' },
  { label: 'Comic Sans MS', stack: `"Comic Sans MS", cursive`, probe: 'Comic Sans MS' },
  { label: 'Brush Script', stack: `"Brush Script MT", cursive`, probe: 'Brush Script MT' },
  { label: 'Papyrus', stack: `Papyrus, fantasy`, probe: 'Papyrus' },

  // --- display and editorial faces ------------------------------------------
  // Added for cover work, where the face is most of the design. A masthead
  // wants something condensed and heavy, or a high-contrast serif; the general
  // list above has neither. Everything here still ships with Windows or macOS —
  // and the probe below drops whatever is not actually installed, so a machine
  // with only half of them shows only half of them.
  { label: 'Haettenschweiler', stack: `Haettenschweiler, Impact${STACK}`, probe: 'Haettenschweiler' },
  { label: 'Bahnschrift', stack: `Bahnschrift, "DIN Condensed"${STACK}`, probe: 'Bahnschrift' },
  { label: 'Oswald', stack: `Oswald${STACK}`, probe: 'Oswald' },
  { label: 'Bebas Neue', stack: `"Bebas Neue"${STACK}`, probe: 'Bebas Neue' },
  { label: 'Anton', stack: `Anton${STACK}`, probe: 'Anton' },
  { label: 'Stencil', stack: `Stencil, fantasy`, probe: 'Stencil' },
  { label: 'Playbill', stack: `Playbill, fantasy`, probe: 'Playbill' },
  { label: 'Copperplate', stack: `Copperplate, "Copperplate Gothic Light"${STACK}`, probe: 'Copperplate' },
  { label: 'Rockwell', stack: `Rockwell, "Rockwell Nova"${SERIF}`, probe: 'Rockwell' },
  { label: 'Bodoni', stack: `"Bodoni MT", "Bodoni 72", Didot${SERIF}`, probe: 'Bodoni MT' },
  { label: 'Didot', stack: `Didot, "Bodoni MT"${SERIF}`, probe: 'Didot' },
  { label: 'Perpetua', stack: `Perpetua${SERIF}`, probe: 'Perpetua' },
  { label: 'Bookman', stack: `"Bookman Old Style", Bookman${SERIF}`, probe: 'Bookman Old Style' },
  { label: 'Constantia', stack: `Constantia${SERIF}`, probe: 'Constantia' },
  { label: 'Hoefler Text', stack: `"Hoefler Text"${SERIF}`, probe: 'Hoefler Text' },
  { label: 'Charter', stack: `Charter, "Bitstream Charter"${SERIF}`, probe: 'Charter' },
  { label: 'Sitka', stack: `"Sitka Heading", Sitka${SERIF}`, probe: 'Sitka Heading' },
  { label: 'Avenir Next', stack: `"Avenir Next", Avenir${STACK}`, probe: 'Avenir Next' },
  { label: 'Helvetica Neue', stack: `"Helvetica Neue", Helvetica${STACK}`, probe: 'Helvetica Neue' },
  { label: 'Candara', stack: `Candara${STACK}`, probe: 'Candara' },
  { label: 'Corbel', stack: `Corbel${STACK}`, probe: 'Corbel' },
  { label: 'Lucida Sans', stack: `"Lucida Sans", "Lucida Grande"${STACK}`, probe: 'Lucida Sans' },
  { label: 'Segoe UI Light', stack: `"Segoe UI Light", "Segoe UI"${STACK}`, probe: 'Segoe UI Light' },

  // --- written by hand -------------------------------------------------------
  { label: 'Segoe Script', stack: `"Segoe Script", cursive`, probe: 'Segoe Script' },
  { label: 'Segoe Print', stack: `"Segoe Print", cursive`, probe: 'Segoe Print' },
  { label: 'Ink Free', stack: `"Ink Free", cursive`, probe: 'Ink Free' },
  { label: 'Gabriola', stack: `Gabriola, cursive`, probe: 'Gabriola' },
  { label: 'Snell Roundhand', stack: `"Snell Roundhand", cursive`, probe: 'Snell Roundhand' },
  { label: 'Marker Felt', stack: `"Marker Felt", cursive`, probe: 'Marker Felt' },
  { label: 'Chalkduster', stack: `Chalkduster, fantasy`, probe: 'Chalkduster' },
  { label: 'Bradley Hand', stack: `"Bradley Hand", cursive`, probe: 'Bradley Hand' },

  // --- fixed width -----------------------------------------------------------
  { label: 'Cascadia Mono', stack: `"Cascadia Mono", "Cascadia Code"${MONO}`, probe: 'Cascadia Mono' },
  { label: 'Lucida Console', stack: `"Lucida Console"${MONO}`, probe: 'Lucida Console' },
  { label: 'SF Mono', stack: `"SF Mono", Menlo${MONO}`, probe: 'SF Mono' },
]

/**
 * Whether a family is really installed.
 *
 * `document.fonts.check` reports optimistically for local families in several
 * browsers, so this measures instead: a string is drawn in the candidate with a
 * deliberately different fallback behind it, and if the width matches the
 * fallback in *every* case the candidate never took effect.
 */
const PROBE = 'MWimwq0123@#%&WMlliI'
let ctx = null

function widthIn(family, size = 72) {
  if (!ctx) ctx = document.createElement('canvas').getContext('2d')
  ctx.font = `${size}px ${family}`
  return ctx.measureText(PROBE).width
}

export function isInstalled(family) {
  if (!family) return true
  // Three fallbacks, because a candidate that happens to match one of them by
  // coincidence would otherwise be judged missing.
  const bases = ['monospace', 'serif', 'sans-serif']
  return bases.some((base) => {
    const fallback = widthIn(base)
    const test = widthIn(`"${family}", ${base}`)
    return Math.abs(test - fallback) > 0.5
  })
}

let cached = null

/** The families actually present, in the order above. Measured once. */
export function availableFonts() {
  if (cached) return cached
  cached = FONT_CHOICES.filter((f) => !f.probe || isInstalled(f.probe))
  return cached
}

/** The label for a stack, so the menu can show what is selected. */
export function labelForStack(stack) {
  return FONT_CHOICES.find((f) => f.stack === stack)?.label || 'Custom'
}
