// Layer groups.
//
// The document stays a flat, bottom-to-top array — that is what the renderer and
// the z-order operations already understand. A group is just another entry with
// `type: 'group'`, and membership is a `parentId` on each child. Group entries
// draw nothing themselves; they contribute visibility, opacity and locking to
// their descendants.
//
// Members are kept contiguous and immediately above their group entry, so array
// order still equals paint order and the panel can show the tree without lying
// about what is in front of what.

export const isGroup = (l) => l.type === 'group'

export function byId(layers) {
  const m = new Map()
  for (const l of layers) m.set(l.id, l)
  return m
}

/** Group entries containing `layer`, innermost first. */
export function ancestors(layers, layer, index = byId(layers)) {
  const out = []
  let p = layer?.parentId
  let guard = 0
  while (p && guard++ < 32) {
    const g = index.get(p)
    if (!g) break
    out.push(g)
    p = g.parentId
  }
  return out
}

/**
 * Per-layer visibility and opacity once groups are folded in. Computed once per
 * render rather than walking the parent chain for every layer.
 */
export function resolveGroups(layers) {
  const index = byId(layers)
  const visible = new Map()
  const opacity = new Map()
  const locked = new Map()
  for (const l of layers) {
    let vis = l.visible !== false
    let op = 1
    let lock = !!l.locked
    for (const g of ancestors(layers, l, index)) {
      if (g.visible === false) vis = false
      if (g.locked) lock = true
      op *= g.opacity ?? 1
    }
    visible.set(l.id, vis)
    opacity.set(l.id, op)
    locked.set(l.id, lock)
  }
  return { visible, opacity, locked }
}

/** Every descendant id of a group, at any depth. */
export function descendantIds(layers, groupId) {
  const out = []
  const walk = (id) => {
    for (const l of layers) {
      if (l.parentId !== id) continue
      out.push(l.id)
      if (isGroup(l)) walk(l.id)
    }
  }
  walk(groupId)
  return out
}

/** Ids of a set of layers plus everything inside any groups among them. */
export function withDescendants(layers, ids) {
  const out = new Set(ids)
  for (const id of ids) {
    const l = layers.find((x) => x.id === id)
    if (l && isGroup(l)) for (const d of descendantIds(layers, id)) out.add(d)
  }
  return [...out]
}

/**
 * What a click on a layer selects, given how far into the groups you have gone.
 *
 * Clicking a word of a title selects the title, not the word. That is the only
 * way a group is a thing you can pick up: otherwise every click reaches straight
 * through to whatever is under the pointer and the group exists in the layers
 * panel and nowhere else.
 *
 * Going deeper is a second gesture — double-click enters the group, and from
 * then on clicks inside it reach one level further in. `entered` is that group,
 * and a click outside it starts again from the top.
 */
export function clickTarget(layers, layer, entered = null) {
  if (!layer) return null
  const chain = ancestors(layers, layer)     // parent first, outermost last
  if (!chain.length) return layer.id
  const idx = entered ? chain.findIndex((g) => g.id === entered) : -1
  // Outside whatever we are inside: the outermost group is the thing.
  if (idx < 0) return chain[chain.length - 1].id
  // Inside it: the child of it that leads down to what was clicked.
  return idx === 0 ? layer.id : chain[idx - 1].id
}

/** Whether `id` is `group` or sits inside it. */
export function isInside(layers, id, group) {
  if (!group || !id) return false
  if (id === group) return true
  const l = layers.find((x) => x.id === id)
  return ancestors(layers, l).some((g) => g.id === group)
}

export const childrenOf = (layers, id) => layers.filter((l) => (l.parentId || null) === (id || null))

/**
 * The layers panel shows top-first, so children are listed above their group
 * entry and reversed within it.
 */
export function buildTree(layers, parentId = null, depth = 0) {
  const rows = []
  for (const l of [...childrenOf(layers, parentId)].reverse()) {
    rows.push({ layer: l, depth })
    if (isGroup(l) && !l.collapsed) rows.push(...buildTree(layers, l.id, depth + 1))
  }
  return rows
}

/**
 * Reorders `layers` so every group's members sit directly above it. Called
 * after grouping or moving layers between groups so paint order and the panel
 * tree cannot drift apart.
 */
export function normalize(layers) {
  const out = []
  const emit = (parentId) => {
    for (const l of layers) {
      if ((l.parentId || null) !== (parentId || null)) continue
      out.push(l)
      if (isGroup(l)) emit(l.id)
    }
  }
  emit(null)
  // Anything whose parent vanished falls back to the top level.
  if (out.length !== layers.length) {
    const seen = new Set(out.map((l) => l.id))
    for (const l of layers) if (!seen.has(l.id)) out.push({ ...l, parentId: null })
  }
  return out
}
