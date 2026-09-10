// Margins and columns.
//
// A cover is built on a grid. Layers already snap to each other and to the
// canvas, which lines things up with *whatever happens to be nearby* — and that
// is the difference between elements placed and elements composed. A margin
// says where the page stops, and columns say where a line of type may begin and
// end, so a masthead, a standfirst and a picture all agree without any of them
// having been dragged onto any of the others.
//
// Deliberately three numbers. A grid with a settings panel is a grid nobody sets
// up; a margin, a number of columns and the space between them is the whole of
// what a page layout needs, and every line below falls out of them.

export const defaultGrid = () => ({
  on: false,
  margin: 48,
  columns: 3,
  gutter: 24,
  rows: 0,      // 0 = none. Horizontal divisions, for a cover with bands.
})

/**
 * The lines a grid puts on a document, in document coordinates.
 *
 * `x` carries the margins and every column edge; `y` carries the margins and any
 * rows. Column edges come in pairs — the start and end of each column — because
 * a block of type is set *within* a column, and the far side of a gutter is
 * where the next one starts rather than where this one ends.
 */
export function gridLines(doc, grid) {
  const g = { ...defaultGrid(), ...(grid || {}) }
  const out = { x: [], y: [], columns: [] }
  if (!g.on || !doc?.width || !doc?.height) return out

  const m = Math.max(0, Math.min(g.margin || 0, doc.width / 2 - 1, doc.height / 2 - 1))
  const left = m
  const right = doc.width - m
  const top = m
  const bottom = doc.height - m
  out.x.push(left, right)
  out.y.push(top, bottom)

  const n = Math.max(1, Math.round(g.columns || 1))
  const gut = Math.max(0, g.gutter || 0)
  const inner = right - left
  // Every gutter but the outer two: three columns have two gaps between them.
  const colW = (inner - gut * (n - 1)) / n
  if (colW > 0.5) {
    for (let i = 0; i < n; i++) {
      const x0 = left + i * (colW + gut)
      out.columns.push({ x: x0, w: colW })
      if (i > 0) out.x.push(x0)
      if (i < n - 1) out.x.push(x0 + colW)
    }
  }

  const rows = Math.max(0, Math.round(g.rows || 0))
  if (rows > 1) {
    const rowH = (bottom - top) / rows
    for (let i = 1; i < rows; i++) out.y.push(top + i * rowH)
  }

  return {
    x: [...new Set(out.x.map((v) => Math.round(v * 100) / 100))],
    y: [...new Set(out.y.map((v) => Math.round(v * 100) / 100))],
    columns: out.columns,
  }
}

/** Whether a document has a grid worth drawing or snapping to. */
export const hasGrid = (doc) => !!doc?.grid?.on
