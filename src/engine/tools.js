// The tools, in the order they sit in the rail.
//
// One list, because there were two: the rail drew the buttons and the keyboard
// handler kept its own map of letters. Two lists describing one set of things
// drift — a tool added to one and forgotten in the other is a button with no
// shortcut, or a shortcut for a button nobody can find.
//
// Each tool carries both of its keys. The letter is the mnemonic, and it is what
// every other editor uses; the digit is the position in the rail, which is what
// you reach for when you are looking at the rail rather than remembering it.
// `1` is the selector for the same reason it is first: getting back to plain
// selection is the most common thing anybody asks of a tool bar.
//
// There are more tools than digits. The last two keep their letters alone rather
// than pushing the count into two-key territory, and they are the two you reach
// for least — the eyedropper hands itself back when it is done, and panning has
// the space bar.

/** Tools that paint with a round brush, so they want a size and a hardness. */
export const BRUSH_TOOLS = new Set(['erase', 'mask', 'clone'])

// One note on the icons: they are single paths stroked with round caps, and the
// rail gives every one of them the same treatment. A dash array is not available
// to a shared path, so the mask's dashed box is written out as twelve segments —
// three to a side, with the corners left solid, which is what stops it reading
// as the crop tool's brackets.
export const TOOLS = [
  // Bounding box deliberately centred on the 24x24 viewBox (x 5.5-18.5,
  // y 2.5-22): the original arrow measured 4-15 by 2-19, which sat visibly
  // up and to the left of every other icon in the rail.
  { id: 'move', key: 'V', digit: '1', label: 'Move / select', icon: 'M5.5 2.5 L5.5 20.5 L10 16 L13 22 L15.6 20.8 L12.7 15.1 L18.5 15.1 Z' },
  { id: 'crop', key: 'C', digit: '2', label: 'Crop', icon: 'M6 2 V15 A1 1 0 0 0 7 16 H20 M2 6 H15 A1 1 0 0 1 16 7 V20' },
  { id: 'effect', key: 'P', digit: '3', label: 'Pixel / blur overlay', icon: null },
  { id: 'lasso', key: 'L', digit: '4', label: 'Lasso select — click to plot points, or drag to trace', icon: 'M4 14 C2 9 6 3 12 3 C18 3 21 8 18 12 C16 15 10 15 9 18 C8 20 10 21 11 20' },
  { id: 'shape', key: 'S', digit: '5', label: 'Shape', icon: 'M3 3 H12 V12 H3 Z M9 9 A6 6 0 1 0 21 9 A6 6 0 1 0 9 9' },
  { id: 'text', key: 'T', digit: '6', label: 'Text', icon: 'M4 4 H20 M12 4 V20 M8 20 H16' },
  { id: 'mask', key: 'B', digit: '7', label: 'Mask — brush the cut-out edge, or edit its outline', icon: 'M3.5 3.5 H7.2 M10.2 3.5 H13.8 M16.8 3.5 H20.5 M20.5 3.5 V7.2 M20.5 10.2 V13.8 M20.5 16.8 V20.5 M20.5 20.5 H16.8 M13.8 20.5 H10.2 M7.2 20.5 H3.5 M3.5 20.5 V16.8 M3.5 13.8 V10.2 M3.5 7.2 V3.5' },
  { id: 'erase', key: 'E', digit: '8', label: 'Erase — paint away part of a layer', icon: 'M8.5 20 H20 M3.6 16.4 l8-8 a1.5 1.5 0 0 1 2.1 0 l4.9 4.9 a1.5 1.5 0 0 1 0 2.1 l-4.6 4.6 H9.2 l-5.6 -5.6 a1.5 1.5 0 0 1 0 -2.1 Z' },
  { id: 'clone', key: 'K', digit: '9', label: 'Clone stamp — copy one part of a picture over another', icon: 'M9 3 h6 a2 2 0 0 1 2 2 v1 a3 3 0 0 0 3 3 v2 H4 V9 a3 3 0 0 0 3 -3 V5 a2 2 0 0 1 2 -2 z M9 11 v4 a3 3 0 0 0 3 3 v3' },
  { id: 'wand', key: 'W', digit: '0', label: 'Select by colour', icon: 'M4 20 L14 10 M12.5 8.5 l3 3 M17 3 l1 2.2 l2.2 1 l-2.2 1 l-1 2.2 l-1 -2.2 l-2.2 -1 l2.2 -1 z M6 4 l0.6 1.4 l1.4 0.6 l-1.4 0.6 l-0.6 1.4 l-0.6 -1.4 l-1.4 -0.6 l1.4 -0.6 z' },
  { id: 'eyedrop', key: 'I', digit: null, label: 'Pick a colour from the picture', icon: 'M18.5 2.6 a2 2 0 0 1 2.9 2.9 l-2.2 2.2 l1 1 l-1.6 1.6 l-1 -1 l-8 8 l-4 1 l1 -4 l8 -8 l-1 -1 l1.6 -1.6 l1 1 z' },
  { id: 'hand', key: 'H', digit: null, label: 'Pan', icon: 'M6 11 V6 a1.5 1.5 0 0 1 3 0 v5 V4 a1.5 1.5 0 0 1 3 0 v7 V5 a1.5 1.5 0 0 1 3 0 v6 V8 a1.5 1.5 0 0 1 3 0 v7 a6 6 0 0 1 -6 6 h-2 a5 5 0 0 1 -4 -2 l-3 -4 a1.5 1.5 0 0 1 2.5 -2 z' },
]

/**
 * Every key that arms a tool, lowercased, mapped to the tool it arms.
 *
 * Built from the list rather than written out beside it, so a tool cannot end up
 * with a button and no shortcut — or with a shortcut that arms the wrong one.
 */
export const TOOL_KEYS = TOOLS.reduce((map, t) => {
  map[t.key.toLowerCase()] = t.id
  if (t.digit) map[t.digit] = t.id
  return map
}, {})

/** What a key press arms, or nothing if that key belongs to something else. */
export const toolForKey = (key) => TOOL_KEYS[String(key ?? '').toLowerCase()] || null

/** Both keys for a tool, as they are written in a tooltip. */
export const keyHint = (tool) => (tool?.digit ? `${tool.key} or ${tool.digit}` : tool?.key || '')
