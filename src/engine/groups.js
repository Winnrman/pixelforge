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
