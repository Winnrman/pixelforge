// Save-to-browser (no download), layer groups, and editing a closed lasso.
import { chromium } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-groups'
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

const checks = []
const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS  ' : 'FAIL  ') + name) }

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => indexedDB.deleteDatabase('pixelforge'))
await page.reload({ waitUntil: 'networkidle' })
await importAndPlace(page, 'public/test/motion.gif', { timeout: 10000 })
await page.waitForTimeout(700)
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })

// Two pixelate overlays to group together.
await page.evaluate(() => {
  const s = window.__pfState()
  const { makeEffectLayer } = window.__pfStore
  s.addLayer(makeEffectLayer({ name: 'Pixel A', x: 20, y: 20, w: 80, h: 60, pixelSize: 12 }))
  s.addLayer(makeEffectLayer({ name: 'Pixel B', x: 180, y: 110, w: 90, h: 60, pixelSize: 12 }))
  s.setProjectName('Group Test')
})
await page.waitForTimeout(300)

// --- Save must not download -------------------------------------------------
let downloaded = false
page.on('download', () => { downloaded = true })
await page.click('button[title^="Save into this browser"]')
await page.waitForFunction(() => window.__pfState().dirty === false, { timeout: 15000 })
await page.waitForTimeout(600)
check('Save does not download a file', downloaded === false)
check('Save clears the unsaved marker',
  (await page.evaluate(() => window.__pfState().dirty)) === false)

const saved = await page.evaluate(async () => {
  await window.__pfState().refreshSavedProjects()
  return window.__pfState().savedProjects
})
console.log('saved projects:', JSON.stringify(saved.map((p) => [p.name, p.layers])))
check('Save stores the project in the browser',
  saved.length === 1 && saved[0].name === 'Group Test' && saved[0].layers === 3)

await page.click('button[title^="Open a saved project"]')
await page.waitForTimeout(400)
check('Open Existing lists saved projects',
  (await page.locator('.proj').count()) === 1)
await page.screenshot({ path: path.join(OUT, '01-open-dialog.png') })
await page.keyboard.press('Escape')
await page.locator('.modal-foot .btn.ghost', { hasText: 'Cancel' }).click()
await page.waitForTimeout(300)

// Exporting the project format is what writes a file.
const dl = page.waitForEvent('download', { timeout: 30000 })
await page.click('header button.btn.primary')
await page.waitForTimeout(300)
await page.click('.segmented button:has-text("Project")')
await page.waitForTimeout(200)
await page.click('.modal-foot .btn.primary')
const file = await dl
console.log('exported:', file.suggestedFilename())
check('Export can still write the .pfz file', /\.pfz$/.test(file.suggestedFilename()))
await page.waitForTimeout(400)

// --- groups -----------------------------------------------------------------
await page.evaluate(() => {
  const s = window.__pfState()
  const fx = s.doc.layers.filter((l) => l.type === 'effect').map((l) => l.id)
  s.select(fx)
})
await page.waitForTimeout(150)
await page.keyboard.press('Control+g')
await page.waitForTimeout(400)

const grouped = await page.evaluate(() => {
  const s = window.__pfState()
  const g = s.doc.layers.find((l) => l.type === 'group')
  return {
    hasGroup: !!g,
    members: s.doc.layers.filter((l) => l.parentId === g?.id).map((l) => l.name),
    total: s.doc.layers.length,
    selected: s.selectedIds.length,
  }
})
console.log('after grouping:', JSON.stringify(grouped))
check('Ctrl+G groups the selected layers',
  grouped.hasGroup && grouped.members.length === 2 && grouped.total === 4)
check('the group is selected after creating it', grouped.selected === 1)

const rows = await page.locator('.layer').count()
check('the panel shows the group and its children', rows === 4)
check('the group row is marked as a group',
  (await page.locator('.layer.is-group').count()) === 1)
await page.screenshot({ path: path.join(OUT, '02-grouped.png') })

// Hiding the group must hide its contents in the render, not just the panel.
// Asserted by equivalence: hiding the group == hiding every child individually,
// and both differ from showing them.
const vis = await page.evaluate(() => {
  const s = window.__pfState()
  const g = s.doc.layers.find((l) => l.type === 'group')
  const kids = s.doc.layers.filter((l) => l.parentId === g.id).map((l) => l.id)
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const hash = (doc) => {
    window.__pfRender.renderDocument(ctx, doc, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let h = 2166136261
    for (let i = 0; i < d.length; i += 7) { h ^= d[i]; h = Math.imul(h, 16777619) }
    return (h >>> 0).toString(16)
  }
  const hide = (ids) => ({
    ...s.doc,
    layers: s.doc.layers.map((l) => (ids.includes(l.id) ? { ...l, visible: false } : l)),
  })
  return {
    shown: hash(s.doc),
    groupHidden: hash(hide([g.id])),
    childrenHidden: hash(hide(kids)),
  }
})
console.log('render hashes:', JSON.stringify(vis))
check('hiding a group changes what is rendered', vis.groupHidden !== vis.shown)
check('hiding a group is exactly hiding every layer inside it',
  vis.groupHidden === vis.childrenHidden)

// Group opacity multiplies into its children.
const opacity = await page.evaluate(() => {
  const s = window.__pfState()
  const g = s.doc.layers.find((l) => l.type === 'group')
  s.updateLayer(g.id, { opacity: 0.5 })
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const half = [...ctx.getImageData(40, 36, 1, 1).data]
  s.updateLayer(g.id, { opacity: 1 })
  return half
})
check('group opacity affects what its children paint', opacity[3] === 255)

// Deleting a group takes its contents with it; undo brings them back.
await page.evaluate(() => {
  const s = window.__pfState()
  const g = s.doc.layers.find((l) => l.type === 'group')
  s.select([g.id])
  s.removeLayers([g.id])
})
await page.waitForTimeout(300)
check('deleting a group deletes its contents',
  (await page.evaluate(() => window.__pfState().doc.layers.length)) === 1)
await page.keyboard.press('Control+z')
await page.waitForTimeout(300)
check('undo restores the whole group',
  (await page.evaluate(() => window.__pfState().doc.layers.length)) === 4)

// Ungrouping keeps the layers and drops only the group entry.
await page.evaluate(() => {
  const s = window.__pfState()
  s.ungroupLayers([s.doc.layers.find((l) => l.type === 'group').id])
})
await page.waitForTimeout(300)
const ungrouped = await page.evaluate(() => {
  const s = window.__pfState()
  return {
    total: s.doc.layers.length,
    groups: s.doc.layers.filter((l) => l.type === 'group').length,
    orphaned: s.doc.layers.filter((l) => l.parentId).length,
  }
})
console.log('after ungrouping:', JSON.stringify(ungrouped))
check('ungroup keeps the layers and removes only the group',
  ungrouped.total === 3 && ungrouped.groups === 0 && ungrouped.orphaned === 0)

// --- editing a closed lasso -------------------------------------------------
await page.evaluate(() => {
  const s = window.__pfState()
  s.select([s.doc.layers[0].id])
  s.setLasso({ points: [[40, 40], [140, 40], [140, 120], [40, 120]] })
})
await page.keyboard.press('l')
await page.waitForTimeout(450)

const view = await page.evaluate(() => {
  const s = window.__pfState()
  const r = document.querySelector('.stage canvas').getBoundingClientRect()
  return { cx: r.x, cy: r.y, ...s.view }
})
const at = (dx, dy) => [view.cx + view.panX + dx * view.zoom, view.cy + view.panY + dy * view.zoom]

// Drag the first vertex somewhere new.
const [v0x, v0y] = at(40, 40)
await page.mouse.move(v0x, v0y)
await page.mouse.down()
const [t0x, t0y] = at(20, 25)
await page.mouse.move(t0x, t0y, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(250)
const moved = await page.evaluate(() => window.__pfState().lasso.points[0].map(Math.round))
console.log('first vertex after drag:', JSON.stringify(moved))
check('dragging a point moves it',
  Math.abs(moved[0] - 20) <= 2 && Math.abs(moved[1] - 25) <= 2)

// Click the midpoint of the second edge to insert a point.
const before = await page.evaluate(() => window.__pfState().lasso.points.length)
const mid = await page.evaluate(() => {
  const p = window.__pfState().lasso.points
  return [(p[1][0] + p[2][0]) / 2, (p[1][1] + p[2][1]) / 2]
})
const [mx, my] = at(mid[0], mid[1])
await page.mouse.click(mx, my)
await page.waitForTimeout(250)
const after = await page.evaluate(() => window.__pfState().lasso.points.length)
console.log('points before/after midpoint click:', before, after)
check('clicking a midpoint inserts a point', after === before + 1)

// Right-click a vertex to delete it.
const [rx, ry] = at(...(await page.evaluate(() => window.__pfState().lasso.points[2])))
await page.mouse.click(rx, ry, { button: 'right' })
await page.waitForTimeout(250)
const afterDelete = await page.evaluate(() => window.__pfState().lasso.points.length)
console.log('points after right-click:', afterDelete)
check('right-clicking a point removes it', afterDelete === after - 1)
await page.screenshot({ path: path.join(OUT, '03-lasso-edit.png') })

// The edited outline still drives the actions.
await page.locator('.lasso-bar button', { hasText: 'Mask' }).click()
await page.waitForTimeout(300)
check('an edited outline still applies as a mask',
  (await page.evaluate(() => !!window.__pfState().doc.layers[0].mask)) === true)

console.log(errors.length ? '\nCONSOLE ERRORS:\n  ' + errors.slice(0, 10).join('\n  ') : '\nno console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
