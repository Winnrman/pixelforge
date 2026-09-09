// The Media bin, and the rule about what lands on the canvas.
//
// The complaint this exists to fix: dropping ten images made ten layers stacked
// on top of each other, so only the largest was visible. So the checks that
// matter are that a multi-file import creates *no* layers, that the bin holds
// everything, and that a project round-trips media it has never placed.
import { chromium } from 'playwright-core'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/media'
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
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => indexedDB.deleteDatabase('pixelforge'))
await page.reload({ waitUntil: 'networkidle' })

const state = () => page.evaluate(() => {
  const s = window.__pfState()
  return {
    media: s.doc.media.length,
    layers: s.doc.layers.length,
    workspace: s.workspace,
    notice: s.notice?.text || null,
    docW: s.doc.width,
    docH: s.doc.height,
  }
})

// --- even one file into an empty document waits in the bin -----------------------
// There used to be an exception here — the very first item was placed straight
// onto the canvas to keep the quick-start flow. It is gone: an exception is one
// more rule to remember, and "everything goes to Media" is easier to trust.
await page.setInputFiles('.pf-media-input', 'public/test/motion.gif')
await page.waitForFunction(() => window.__pfState().doc.media.length > 0, { timeout: 20000 })
await page.waitForTimeout(400)
const single = await state()
console.log('one file into an empty doc:', JSON.stringify(single))
check('a lone first import goes to the bin, not the canvas', single.layers === 0, `${single.layers} layers`)
check('and it is in the bin', single.media === 1)
check('the bin is opened so it is not lost', single.workspace === 'media', single.workspace)
check('the canvas is left at its default until something is placed',
  single.docW === 960 && single.docH === 640, `${single.docW}x${single.docH}`)

// Placing it is one action, and that is when the canvas takes its size.
await page.evaluate(() => {
  const st = window.__pfState()
  st.placeMedia(st.doc.media, { resizeDocToFirst: true })
})
await page.waitForTimeout(400)
const afterPlace = await state()
check('placing it puts it on the canvas', afterPlace.layers === 1)
check('and the canvas takes its size then', afterPlace.docW === 320 && afterPlace.docH === 200,
  `${afterPlace.docW}x${afterPlace.docH}`)

// --- the actual complaint: many files at once ------------------------------------
await page.evaluate(() => window.__pfState().resetDoc())
await page.waitForTimeout(200)
const many = ['motion.gif', 'greenscreen.gif', 'badloop.gif', 'room.png', 'screencast.gif']
await page.setInputFiles('.pf-media-input', many.map((f) => 'public/test/' + f))
await page.waitForFunction((n) => window.__pfState().doc.media.length === n, many.length, { timeout: 40000 })
await page.waitForTimeout(500)
const bulk = await state()
console.log('five files at once:', JSON.stringify(bulk))
check('all five land in the bin', bulk.media === 5)
check('and none are stacked onto the canvas', bulk.layers === 0, `${bulk.layers} layers`)
check('the app switches to Media so they are not lost', bulk.workspace === 'media', bulk.workspace)
check('and says what it did', /Added 5 to Media/.test(bulk.notice || ''), bulk.notice)

// --- the bin renders what it holds -----------------------------------------------
await page.waitForSelector('.media-card', { timeout: 15000 })
await page.waitForTimeout(900)
const cards = await page.evaluate(() => [...document.querySelectorAll('.media-card')].map((c) => ({
  name: c.querySelector('.media-name')?.textContent,
  kind: c.querySelector('.media-kind')?.textContent,
  dim: c.querySelector('.media-dim')?.textContent,
})))
console.log('cards:', JSON.stringify(cards))
check('one card per item', cards.length === 5)
check('each is labelled with its file', cards.every((c) => /\.(gif|png)$/.test(c.name || '')),
  cards.map((c) => c.name).join(', '))
check('and typed', cards.filter((c) => c.kind === 'GIF').length === 4 &&
  cards.some((c) => c.kind === 'IMG'), cards.map((c) => c.kind).join(','))

// Posters must be real frames, not blank tiles.
const posters = await page.evaluate(() => {
  const out = []
  for (const c of document.querySelectorAll('.media-poster canvas')) {
    const ctx = c.getContext('2d')
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let lit = 0
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 40) lit++
    out.push(Math.round((lit / (d.length / (4 * 97))) * 100))
  }
  return out
})
console.log('poster coverage %:', JSON.stringify(posters))
check('every poster drew an actual frame', posters.length === 5 && posters.every((p) => p > 15),
  posters.join(', '))
await page.screenshot({ path: path.join(OUT, '01-bin.png') })

// --- placing from the bin ----------------------------------------------------------
await page.click('.media-card')
await page.waitForTimeout(150)
const oneSelected = await page.evaluate(() => document.querySelectorAll('.media-card.sel').length)
check('clicking a card selects it', oneSelected === 1)

await page.keyboard.down('Control')
await page.click('.media-grid .media-slot:nth-child(2) .media-card')
await page.click('.media-grid .media-slot:nth-child(3) .media-card')
await page.keyboard.up('Control')
const threeSelected = await page.evaluate(() => document.querySelectorAll('.media-card.sel').length)
check('ctrl-click adds to the selection', threeSelected === 3, String(threeSelected))

await page.click('.media-head .btn.primary')
await page.waitForTimeout(500)
const placed = await state()
console.log('after Add to canvas:', JSON.stringify(placed))
check('three placed layers', placed.layers === 3, `${placed.layers}`)
check('the bin keeps them', placed.media === 5)
check('and it returns to the editor', placed.workspace === 'editor')

// Placed together they must be reachable, not perfectly stacked.
const spread = await page.evaluate(() => {
  const ls = window.__pfState().doc.layers
  return {
    xs: ls.map((l) => Math.round(l.x)),
    distinct: new Set(ls.map((l) => Math.round(l.x) + ',' + Math.round(l.y))).size,
  }
})
console.log('placed positions:', JSON.stringify(spread))
check('several at once are stepped, not stacked', spread.distinct === 3, JSON.stringify(spread.xs))

// --- double-click is the shortcut ----------------------------------------------
await page.evaluate(() => window.__pfState().setWorkspace('media'))
await page.waitForSelector('.media-card', { timeout: 10000 })
await page.dblclick('.media-grid .media-slot:nth-child(4) .media-card')
await page.waitForTimeout(400)
const dbl = await state()
check('double-clicking a card places it', dbl.layers === 4, `${dbl.layers} layers`)
check('and switches back to the editor', dbl.workspace === 'editor')

// --- the "on canvas" marker ------------------------------------------------------
await page.evaluate(() => window.__pfState().setWorkspace('media'))
await page.waitForSelector('.media-card', { timeout: 10000 })
await page.waitForTimeout(300)
const used = await page.evaluate(() => document.querySelectorAll('.media-used').length)
check('cards already on the canvas are marked', used === 4, `${used} marked`)

// --- removing from the bin --------------------------------------------------------
const unusedIdx = await page.evaluate(() => {
  const slots = [...document.querySelectorAll('.media-slot')]
  return slots.findIndex((s) => !s.querySelector('.media-used'))
})
await page.click(`.media-grid .media-slot:nth-child(${unusedIdx + 1}) .media-card`)
await page.click('.media-head .btn.ghost:has-text("Remove")')
await page.waitForTimeout(300)
const removed = await state()
console.log('after removing an unused item:', JSON.stringify(removed))
check('removing an unused item takes it out of the bin', removed.media === 4, `${removed.media}`)
check('and leaves the canvas alone', removed.layers === 4)

// Removing something a layer uses must warn rather than break the canvas.
await page.click('.media-grid .media-slot:nth-child(1) .media-card')
await page.click('.media-head .btn.ghost:has-text("Remove")')
await page.waitForTimeout(300)
const removedUsed = await state()
console.log('after removing one in use:', JSON.stringify(removedUsed))
check('removing one still in use does not delete the layer', removedUsed.layers === 4)
check('and it says so', /still using it/.test(removedUsed.notice || ''), removedUsed.notice)

// --- workspace switching ------------------------------------------------------------
await page.evaluate(() => window.__pfState().setWorkspace('editor'))
await page.waitForTimeout(200)
const tabs = await page.evaluate(() => ({
  labels: [...document.querySelectorAll('.ws-tabs button')].map((b) => b.textContent.trim()),
  on: document.querySelector('.ws-tabs button.on')?.textContent.trim(),
  editorVisible: !document.querySelector('.workspace')?.hidden,
  mediaMounted: !!document.querySelector('.media-view'),
}))
console.log('tabs:', JSON.stringify(tabs))
check('the top bar carries both workspaces', tabs.labels.length === 2, tabs.labels.join(' | '))
// Compared against the live count rather than a literal: two items were removed
// above, and a hardcoded number here just goes stale.
const binCount = (await state()).media
check('the bin count is shown', tabs.labels[1] === `Media ${binCount}`,
  `${tabs.labels[1]} with ${binCount} in the bin`)
check('the editor is the one on screen', tabs.editorVisible && !tabs.mediaMounted)

// The editor stays mounted behind the bin so the canvas keeps its state, which
// means it has to be genuinely hidden — `display: flex` on .workspace overrides
// the browser's own [hidden] rule, and the two views stacked because of it.
await page.evaluate(() => window.__pfState().setWorkspace('media'))
await page.waitForSelector('.media-view', { timeout: 10000 })
await page.waitForTimeout(250)
const stacking = await page.evaluate(() => {
  const ws = document.querySelector('.workspace')
  const mv = document.querySelector('.media-view')
  return {
    editorDisplay: getComputedStyle(ws).display,
    editorHeight: Math.round(ws.getBoundingClientRect().height),
    mediaHeight: Math.round(mv.getBoundingClientRect().height),
    viewport: window.innerHeight,
  }
})
console.log('stacking:', JSON.stringify(stacking))
check('the editor is not merely marked hidden but actually hidden',
  stacking.editorDisplay === 'none' && stacking.editorHeight === 0,
  `${stacking.editorDisplay}, ${stacking.editorHeight}px tall`)
check('so the bin gets the whole window',
  stacking.mediaHeight > stacking.viewport * 0.7,
  `${stacking.mediaHeight} of ${stacking.viewport}px`)
await page.evaluate(() => window.__pfState().setWorkspace('editor'))
await page.waitForTimeout(200)

await page.keyboard.press('m')
await page.waitForTimeout(250)
check('M opens the bin', (await state()).workspace === 'media')
await page.keyboard.press('m')
await page.waitForTimeout(250)
check('and M closes it again', (await state()).workspace === 'editor')

// The canvas must survive the round trip rather than re-fitting.
const zoomBefore = await page.evaluate(() => window.__pfState().view.zoom)
await page.evaluate(() => window.__pfState().setWorkspace('media'))
await page.waitForTimeout(200)
await page.evaluate(() => window.__pfState().setWorkspace('editor'))
await page.waitForTimeout(300)
const zoomAfter = await page.evaluate(() => window.__pfState().view.zoom)
check('switching away and back does not disturb the view', zoomBefore === zoomAfter,
  `${zoomBefore} -> ${zoomAfter}`)

// --- a project must carry media it has never placed ------------------------------
await page.evaluate(() => window.__pfState().resetDoc())
await page.waitForTimeout(200)
await page.setInputFiles('.pf-media-input', ['public/test/motion.gif', 'public/test/room.png'])
await page.waitForFunction(() => window.__pfState().doc.media.length === 2, { timeout: 30000 })
await page.evaluate(() => window.__pfState().placeMedia([window.__pfState().doc.media[0]]))
await page.waitForTimeout(400)
const beforeSave = await state()
console.log('before save:', JSON.stringify(beforeSave))
check('one placed, one only in the bin', beforeSave.layers === 1 && beforeSave.media === 2)

const roundTrip = await page.evaluate(async () => {
  const s = window.__pfState()
  const blob = await window.__pfProject.packProject(s.doc, { time: 0, name: 'MediaTest' })
  const file = new File([blob], 'MediaTest.pfz', { type: 'application/zip' })
  const out = await window.__pfProject.unpackProject(file)
  return {
    bytes: blob.size,
    layers: out.doc.layers.length,
    media: out.doc.media.length,
    missing: out.missing,
    // Reopened assets get fresh ids; the bin must point at those, not the old ones.
    resolves: out.doc.media.every((id) => !!window.__pfAssets.getAsset(id)),
    layerResolves: out.doc.layers.every((l) => l.type !== 'image' || !!window.__pfAssets.getAsset(l.assetId)),
  }
})
console.log('round trip:', JSON.stringify(roundTrip))
check('the unplaced item is written into the project', roundTrip.media === 2, `${roundTrip.media}`)
check('nothing went missing', roundTrip.missing.length === 0, JSON.stringify(roundTrip.missing))
check('the bin points at the reopened assets', roundTrip.resolves)
check('and so do the layers', roundTrip.layerResolves)
check('the placed layer came back', roundTrip.layers === 1)

await page.evaluate(() => window.__pfState().setWorkspace('media'))
await page.waitForTimeout(600)
await page.screenshot({ path: path.join(OUT, '02-after-place.png') })

// --- free space imports -------------------------------------------------------------
// Reaching for the Import button is work; the empty area is the obvious target,
// and it has to be one in both states of the bin.
await page.evaluate(() => window.__pfState().resetDoc())
await page.waitForTimeout(250)
await page.evaluate(() => window.__pfState().setWorkspace('media'))
await page.waitForSelector('.media-empty', { timeout: 10000 })
const emptyCue = await page.evaluate(() => {
  const el = document.querySelector('.media-empty')
  return {
    clickable: el.classList.contains('clickable'),
    cursor: getComputedStyle(el).cursor,
    cue: document.querySelector('.media-empty .media-cue')?.textContent || null,
    role: el.getAttribute('role'),
  }
})
console.log('empty bin:', JSON.stringify(emptyCue))
check('an empty bin is itself the import target', emptyCue.clickable && emptyCue.role === 'button')
check('and it looks clickable', emptyCue.cursor === 'pointer', emptyCue.cursor)
check('with a cue saying so', /click anywhere/i.test(emptyCue.cue || ''), emptyCue.cue)

// A file input opening is the observable effect, so the click is watched for it
// rather than for a dialog the harness cannot see.
const opensPicker = await page.evaluate(() => new Promise((res) => {
  const input = document.querySelector('.pf-media-input-2')
  const onClick = (e) => { e.preventDefault(); input.removeEventListener('click', onClick); res(true) }
  input.addEventListener('click', onClick)
  document.querySelector('.media-empty').click()
  setTimeout(() => res(false), 400)
}))
check('clicking the empty bin opens the file picker', opensPicker)

// With items in it, blank space deselects first and imports second — with a
// selection live, "deselect" is the obvious meaning of a click on nothing.
await page.setInputFiles('.pf-media-input', ['public/test/motion.gif', 'public/test/room.png'])
await page.waitForFunction(() => window.__pfState().doc.media.length === 2, { timeout: 30000 })
await page.waitForSelector('.media-card', { timeout: 10000 })
await page.click('.media-card')
await page.waitForTimeout(150)
const twoStage = await page.evaluate(() => new Promise((res) => {
  const grid = document.querySelector('.media-grid')
  const input = document.querySelector('.pf-media-input-2')
  let opened = 0
  const onClick = (e) => { e.preventDefault(); opened++ }
  input.addEventListener('click', onClick)
  const blank = () => {
    const r = grid.getBoundingClientRect()
    // Well below the last row, so the target really is the grid itself.
    grid.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: r.left + r.width - 8, clientY: r.bottom - 8,
    }))
  }
  blank()
  // React has not re-rendered yet at this point, so the DOM is read after a
  // tick rather than synchronously — otherwise this measures the state before
  // the click, not after it.
  setTimeout(() => {
    const first = { selected: document.querySelectorAll('.media-card.sel').length, opened }
    blank()
    setTimeout(() => {
      input.removeEventListener('click', onClick)
      res({ first, second: { selected: document.querySelectorAll('.media-card.sel').length, opened } })
    }, 200)
  }, 200)
}))
console.log('blank clicks with a selection:', JSON.stringify(twoStage))
check('the first click on blank space deselects rather than importing',
  twoStage.first.selected === 0 && twoStage.first.opened === 0, JSON.stringify(twoStage.first))
check('and the next one opens the picker', twoStage.second.opened === 1,
  JSON.stringify(twoStage.second))

// --- an emptied document returns to the default canvas -------------------------------
await page.evaluate(() => window.__pfState().setWorkspace('editor'))
await page.evaluate(() => {
  const st = window.__pfState()
  st.placeMedia([st.doc.media[1]], { resizeDocToFirst: true })
})
await page.waitForTimeout(400)
const sized = await state()
console.log('with a portrait photo placed:', JSON.stringify({ w: sized.docW, h: sized.docH }))
check('the canvas takes the media size while it is there',
  sized.docW === 240 && sized.docH === 320, `${sized.docW}x${sized.docH}`)

await page.evaluate(() => {
  const st = window.__pfState()
  st.removeLayers(st.doc.layers.map((l) => l.id))
})
await page.waitForTimeout(400)
const emptied = await state()
console.log('after removing every layer:', JSON.stringify({ w: emptied.docW, h: emptied.docH }))
check('an emptied document goes back to the default canvas',
  emptied.docW === 960 && emptied.docH === 640, `${emptied.docW}x${emptied.docH}`)
check('and the media is still in the bin', emptied.media === 2)

// An empty canvas must not be draggable either — the same reason the wheel does
// not zoom one.
const panLocked = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setTool('hand')
  const before = { ...window.__pfState().view }
  const c = document.querySelector('.stage canvas')
  const r = c.getBoundingClientRect()
  const opts = { bubbles: true, button: 0, clientX: r.left + 100, clientY: r.top + 100, pointerId: 1 }
  c.dispatchEvent(new PointerEvent('pointerdown', opts))
  window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: r.left + 240, clientY: r.top + 200 }))
  window.dispatchEvent(new PointerEvent('pointerup', opts))
  await new Promise((res) => setTimeout(res, 200))
  const after = window.__pfState().view
  window.__pfState().setTool('move')
  return { before: [Math.round(before.panX), Math.round(before.panY)], after: [Math.round(after.panX), Math.round(after.panY)] }
})
console.log('hand drag on an empty canvas:', JSON.stringify(panLocked))
check('an empty canvas cannot be dragged around',
  panLocked.before[0] === panLocked.after[0] && panLocked.before[1] === panLocked.after[1],
  `${panLocked.before} -> ${panLocked.after}`)

// --- deleting layers must not empty the bin ----------------------------------------
// Removing a layer is not the same as removing the material it was made from.
// The bin is the only place media leaves the project.
await page.evaluate(() => window.__pfState().resetDoc())
await page.waitForTimeout(200)
await page.setInputFiles('.pf-media-input', ['public/test/motion.gif', 'public/test/room.png'])
await page.waitForFunction(() => window.__pfState().doc.media.length === 2, { timeout: 30000 })
await page.evaluate(() => {
  const st = window.__pfState()
  st.placeMedia(st.doc.media, { resizeDocToFirst: true })
})
await page.waitForTimeout(500)
await page.evaluate(() => {
  const st = window.__pfState()
  st.removeLayers(st.doc.layers.map((l) => l.id))
})
await page.waitForTimeout(400)
const afterDelete = await state()
console.log('after deleting every layer:', JSON.stringify(afterDelete))
check('deleting every layer empties the canvas', afterDelete.layers === 0)
check('but leaves the media bin alone', afterDelete.media === 2, `${afterDelete.media} still in the bin`)

// ...and it has to survive a reload. This is where it actually broke: the
// autosave refused to keep a project that had media but no layers, which is
// exactly the state you are in right after importing.
await page.waitForTimeout(2600) // let the 1.2s autosave debounce land
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
const offered = await page.evaluate(() => !!document.querySelector('.recovery .btn.primary'))
check('a project with media but no layers is still offered for recovery', offered)
if (offered) {
  await page.click('.recovery .btn.primary')
  await page.waitForFunction(() => window.__pfState().doc.media.length > 0, { timeout: 30000 })
  await page.waitForTimeout(600)
}
const recovered = await page.evaluate(() => {
  const st = window.__pfState()
  return {
    media: st.doc.media.length,
    layers: st.doc.layers.length,
    // Reopening re-imports assets with fresh ids; the bin has to follow them.
    resolves: st.doc.media.every((id) => !!window.__pfAssets.getAsset(id)),
  }
})
console.log('after reload and restore:', JSON.stringify(recovered))
check('the media comes back', recovered.media === 2, `${recovered.media}`)
check('and points at the re-imported assets, not dead ids', recovered.resolves)
check('the canvas is still empty, as it was left', recovered.layers === 0)

// The narrower case that was silently broken: a bin full of imports that were
// never placed at all was never written to the autosave, so a reload lost the
// lot without a word.
await page.evaluate(() => window.__pfState().resetDoc())
await page.waitForTimeout(300)
await page.setInputFiles('.pf-media-input', ['public/test/badloop.gif', 'public/test/greenscreen.gif'])
await page.waitForFunction(() => window.__pfState().doc.media.length === 2, { timeout: 30000 })
const neverPlaced = await state()
check('imports that were never placed leave the canvas empty',
  neverPlaced.layers === 0 && neverPlaced.media === 2)
await page.waitForTimeout(2600)
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
const offered2 = await page.evaluate(() => !!document.querySelector('.recovery .btn.primary'))
check('a bin that has never been placed is still recoverable', offered2)
if (offered2) {
  await page.click('.recovery .btn.primary')
  await page.waitForFunction(() => window.__pfState().doc.media.length > 0, { timeout: 30000 })
  await page.waitForTimeout(500)
}
const back = await state()
console.log('unplaced imports after a reload:', JSON.stringify(back))
check('and every unplaced import comes back', back.media === 2, `${back.media}`)

// --- collage ----------------------------------------------------------------------
await page.evaluate(() => window.__pfState().resetDoc())
await page.waitForTimeout(200)
const photos = Array.from({ length: 12 }, (_, i) =>
  `public/test/photos/photo-${String(i + 1).padStart(2, '0')}.png`)
await page.setInputFiles('.pf-media-input', photos)
await page.waitForFunction(() => window.__pfState().doc.media.length === 12, { timeout: 60000 })
await page.waitForTimeout(600)

const collage = await page.evaluate(() => {
  const st = window.__pfState()
  const ids = st.doc.media
  st.makeCollage(ids, { seed: 3, shape: 'mixed' })
  const after = window.__pfState()
  const cards = after.doc.layers.filter((l) => l.type === 'image')
  return {
    width: after.doc.width,
    height: after.doc.height,
    background: after.doc.background,
    cards: cards.length,
    groups: after.doc.layers.filter((l) => l.type === 'group').length,
    allGrouped: cards.every((l) => !!l.parentId),
    framed: cards.filter((l) => l.frame?.on).length,
    // A source that is already the mount's shape needs no crop, so the two
    // square fixtures are expected to come through whole.
    cropped: cards.filter((l) => l.src && (l.src.w < 1 || l.src.h < 1)).length,
    // A photo needs cropping when its own shape differs from the mount it was
    // given — with mixed mounts that is not the same as "not square", since a
    // 4:3 photo lands in a 4:3 mount and comes through whole.
    needCrop: cards.filter((l) => {
      const a = window.__pfAssets.getAsset(l.assetId)
      const ins = l.frame?.insets || { l: 0, r: 0, t: 0, b: 0 }
      const mountAR = (l.w * (1 - ins.l - ins.r)) / (l.h * (1 - ins.t - ins.b))
      return Math.abs(a.width / a.height - mountAR) > 0.01
    }).length,
    squashed: cards.filter((l) => {
      const a = window.__pfAssets.getAsset(l.assetId)
      // Visible source shape must match the drawn photo shape, or it is stretched.
      const ins = l.frame?.insets || { l: 0, r: 0, t: 0, b: 0 }
      const photoW = l.w * (1 - ins.l - ins.r)
      const photoH = l.h * (1 - ins.t - ins.b)
      const srcAR = (l.src.w * a.width) / (l.src.h * a.height)
      return Math.abs(srcAR - photoW / photoH) > 0.02
    }).length,
    tilted: cards.filter((l) => Math.abs(l.rotation) > 0.2).length,
    distinctAngles: new Set(cards.map((l) => l.rotation.toFixed(4))).size,
    bottomHeavy: cards.every((l) => l.frame.insets.b > l.frame.insets.t * 2.5),
    workspace: after.workspace,
    heroes: cards.filter((l) => / \(centre\)$/.test(l.name)).length,
    // The centre piece must be the biggest and the last drawn, or it is buried.
    heroBiggest: (() => {
      const hero = cards.find((l) => / \(centre\)$/.test(l.name))
      if (!hero) return false
      const rest = cards.filter((l) => l !== hero)
      return hero.w > Math.max(...rest.map((l) => l.w))
        && after.doc.layers.indexOf(hero) > Math.max(...rest.map((l) => after.doc.layers.indexOf(l)))
    })(),
    mountShapes: new Set(cards.map((l) => (l.w / l.h).toFixed(2))).size,
    overlapping: cards.filter((a) => cards.some((b) => b !== a
      && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)).length,
    // Layer order is stacking order. If it came out matching the grid reading
    // order, the pile would shingle uniformly down and to the right.
    rasterOrder: cards.every((l, i, arr) => i === 0
      || arr[i - 1].y < l.y - 1 || (Math.abs(arr[i - 1].y - l.y) <= 1 && arr[i - 1].x <= l.x)),
    widthSpread: Math.round(
      ((Math.max(...cards.map((l) => l.w)) - Math.min(...cards.map((l) => l.w)))
        / Math.max(...cards.map((l) => l.w))) * 100),
  }
})
console.log('collage:', JSON.stringify(collage))
check('a collage is one layer per photo', collage.cards === 12, `${collage.cards}`)
check('gathered into a group so it moves as one', collage.groups === 1 && collage.allGrouped)
check('every card is mounted', collage.framed === 12, `${collage.framed}`)
check('the mount is bottom-heavy, which is what makes it a Polaroid', collage.bottomHeavy)
check('every card is tilted, each by its own amount',
  collage.tilted >= 10 && collage.distinctAngles === 12,
  `${collage.tilted} tilted, ${collage.distinctAngles} distinct angles`)
check('cards overlap rather than sitting in a grid of islands',
  collage.overlapping > 8, `${collage.overlapping} of 12 lap over a neighbour`)
check('and they are laid down in a shuffled pile, not raster order',
  collage.rasterOrder === false)
check('sizes vary, so it does not read as a tiling',
  collage.widthSpread > 5, `${collage.widthSpread}% spread`)
check('there is exactly one centre piece', collage.heroes === 1, `${collage.heroes}`)
check('it is the largest card and the last one laid down', collage.heroBiggest)
check('mixed mounts really are mixed', collage.mountShapes >= 3,
  `${collage.mountShapes} distinct card shapes`)
check('every photo that needs cropping is cropped',
  collage.cropped === collage.needCrop && collage.needCrop > 0,
  `${collage.cropped} cropped of ${collage.needCrop} that are not already square`)
check('and none is squashed — the visible crop matches the mount exactly',
  collage.squashed === 0, `${collage.squashed} stretched`)
check('the canvas is resized to fit the grid',
  collage.width === 1800 && collage.height > 1000, `${collage.width}x${collage.height}`)
check('a backdrop is set so white mounts have something to sit on',
  collage.background === '#17171c', collage.background)
check('and it drops you back in the editor', collage.workspace === 'editor')

// Now the pixels: white mounts on a dark ground, and photos inside them.
const shot = await page.evaluate(() => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let white = 0
  let backdrop = 0
  let colour = 0
  let n = 0
  for (let i = 0; i < d.length; i += 4 * 37) {
    n++
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]]
    if (r > 225 && g > 220 && b > 215) white++
    else if (r < 40 && g < 40 && b < 45) backdrop++
    else if (Math.max(r, g, b) - Math.min(r, g, b) > 60) colour++
  }
  // Is the top-left corner backdrop? With a margin it must be.
  const corner = ctx.getImageData(4, 4, 1, 1).data
  return {
    whitePct: Math.round((white / n) * 100),
    backdropPct: Math.round((backdrop / n) * 100),
    colourPct: Math.round((colour / n) * 100),
    corner: [corner[0], corner[1], corner[2]],
  }
})
console.log('collage pixels:', JSON.stringify(shot))
check('the mounts are visibly there', shot.whitePct > 6, `${shot.whitePct}% white`)
check('the photos are visibly there', shot.colourPct > 40, `${shot.colourPct}% saturated`)
// Cards overlap by default, so most of the backdrop is covered — what is left
// is the margin. Too much and the overlap is not working; none at all and the
// margin has collapsed.
// Mixed mounts leave a little more backdrop than uniform ones, because a
// portrait and a landscape card cannot tile however much they overlap. Around
// a quarter reads as deliberate dark space between prints; much more than that
// and the overlap has stopped working.
check('the backdrop is mostly covered but still frames the pile',
  shot.backdropPct > 2 && shot.backdropPct < 35, `${shot.backdropPct}%`)
check('the corner is backdrop, so nothing is clipped at the edge',
  shot.corner[0] < 40 && shot.corner[2] < 50, JSON.stringify(shot.corner))
await page.screenshot({ path: path.join(OUT, '03-collage.png') })

// Every card stays an ordinary layer — that is the point of building it this way.
const editable = await page.evaluate(() => {
  const st = window.__pfState()
  const card = st.doc.layers.find((l) => l.type === 'image')
  const before = { x: card.x, rot: card.rotation }
  st.updateLayer(card.id, { x: card.x + 40, rotation: 0 })
  const after = window.__pfState().doc.layers.find((l) => l.id === card.id)
  const others = window.__pfState().doc.layers.filter((l) => l.type === 'image' && l.id !== card.id)
  return {
    moved: Math.round(after.x - before.x),
    straightened: after.rotation === 0 && before.rot !== 0,
    othersUntouched: others.every((l) => Math.abs(l.rotation) > 0 || l.rotation === 0),
    count: others.length,
  }
})
console.log('editing one card:', JSON.stringify(editable))
check('a card can be moved and straightened like any layer',
  editable.moved === 40 && editable.straightened, JSON.stringify(editable))
check('and the other eleven are untouched', editable.count === 11)

// --- media is added in one place, and only there -------------------------------------
// The editor used to take a drop as well, but importing has always put files in
// the bin and switched you there — so the editor's version was a longer route
// to the same place, wearing the clothes of a shortcut.
const oneDoor = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  st.setWorkspace('editor')
  await new Promise((r) => setTimeout(r, 300))

  const fire = (type) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' }))
    const ev = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true })
    window.dispatchEvent(ev)
    return ev.defaultPrevented
  }
  const editorTakesIt = fire('dragover')
  const editorVeil = !!document.querySelector('.drop-veil')

  window.__pfState().setWorkspace('media')
  await new Promise((r) => setTimeout(r, 300))
  const binTakesIt = fire('dragover')
  await new Promise((r) => setTimeout(r, 100))
  const binVeil = !!document.querySelector('.drop-veil')
  return { editorTakesIt, editorVeil, binTakesIt, binVeil }
})
console.log('who accepts a drop:', JSON.stringify(oneDoor))
check('the editor does not accept dropped media', oneDoor.editorTakesIt === false)
check('and shows no invitation to', oneDoor.editorVeil === false)
check('the media bin does accept it', oneDoor.binTakesIt === true)
check('and says so', oneDoor.binVeil === true)

// The empty canvas points at the bin instead of pretending to be one.
const hero = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  st.setWorkspace('editor')
  st.setTool('move')
  await new Promise((r) => setTimeout(r, 350))
  const el = document.querySelector('.hero')
  const text = el?.textContent || ''
  el?.click()
  await new Promise((r) => setTimeout(r, 300))
  return {
    text,
    title: el?.getAttribute('title') || '',
    went: window.__pfState().workspace,
  }
})
console.log('empty canvas:', JSON.stringify({ title: hero.title, went: hero.went }))
check('the empty canvas no longer offers to take files',
  !/drop an image/i.test(hero.text) && !/choose files/i.test(hero.text),
  hero.text.slice(0, 60))
check('it points at Media instead', /Media/.test(hero.text), hero.text.slice(0, 90))
check('and clicking it goes there', hero.went === 'media', hero.went)

// --- a poster you can recognise -----------------------------------------------------
// A poster covers its card and crops the overflow, so a tall picture in a wide
// tile is scaled by its *width*. Asking for the thumbnail by the box's height
// gave a 720x1606 clip one twenty-one pixels wide, stretched across the whole
// tile — the blockiness this measures.
//
// Measured as detail rather than as a size: a picture of fine vertical stripes
// survives being downscaled honestly and turns to mush when it is blown up from
// nothing, and counting the stripes that made it says which happened.
const detail = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  await new Promise((r) => setTimeout(r, 300))
  // Portrait, like a phone clip. The stripes are wide enough that even the
  // small bin poster can resolve them honestly — measuring detail the poster
  // could never show whatever the code did would measure aliasing, not the bug.
  const c = document.createElement('canvas')
  c.width = 720
  c.height = 1606
  const g = c.getContext('2d')
  g.fillStyle = '#101010'
  g.fillRect(0, 0, c.width, c.height)
  g.fillStyle = '#f0f0f0'
  for (let x = 0; x < c.width; x += 60) g.fillRect(x, 0, 30, c.height)
  const blob = await new Promise((r) => c.toBlob(r))
  await st.addImages([new File([blob], 'stripes.png', { type: 'image/png' })])
  await new Promise((r) => setTimeout(r, 1200))

  // Two readings along the middle of a poster. The stripe count says the picture
  // is there at all; the *softness* says whether it was drawn at its own size or
  // blown up from a smaller one. Only the second can tell them apart — a count
  // survives being upscaled perfectly well, it just goes blurry, which is the
  // whole complaint.
  const measure = (canvas) => {
    if (!canvas || !canvas.width) return { stripes: 0, soft: 0, w: 0 }
    const g2 = canvas.getContext('2d', { willReadFrequently: true })
    const row = g2.getImageData(0, Math.round(canvas.height / 2), canvas.width, 1).data
    let runs = 0
    let last = null
    let soft = 0
    for (let x = 0; x < canvas.width; x++) {
      const v = row[x * 4]
      const lit = v > 128
      if (last !== null && lit !== last) runs++
      last = lit
      // Neither ink nor paper: a pixel part-way up a ramp between two stripes.
      // A sharp edge has one of these; a stretched one has as many as it was
      // stretched by.
      if (v > 40 && v < 215) soft++
    }
    return { stripes: runs, soft, w: canvas.width }
  }

  window.__pfState().setWorkspace('media')
  await new Promise((r) => setTimeout(r, 900))
  const card = document.querySelector('.media-card canvas')
  const inView = measure(card)

  window.__pfState().setWorkspace('editor')
  await new Promise((r) => setTimeout(r, 900))
  const pool = document.querySelector('.media-pool canvas, .pool-card canvas, .rail-media canvas')
    || [...document.querySelectorAll('canvas')].find((n) => n.closest('.media-pool'))
  const inBin = measure(pool)
  return { inView, inBin }
})
console.log('poster detail:', JSON.stringify(detail))
// Twelve stripes is twenty-three light/dark crossings, and both posters are wide
// enough to show every one of them.
check('the Media tab poster shows the whole picture',
  detail.inView.stripes >= 16, `${detail.inView.stripes} stripes across ${detail.inView.w}px`)
// And drawn at its own size rather than stretched from a smaller one. Sized by
// the box's height, the bin's thumbnail came back twenty-one pixels wide and
// was blown up more than fourfold — every edge in it a soft ramp instead of an
// edge, which is what "low-res" looks like when you measure it.
const blur = (m) => m.soft / Math.max(1, m.stripes)
check('with edges rather than ramps, so it was not blown up',
  blur(detail.inView) < 1.6, `${blur(detail.inView).toFixed(2)} soft pixels per edge`)
if (detail.inBin.w) {
  check('and the bin poster beside the canvas is drawn the same way',
    detail.inBin.stripes >= 16 && blur(detail.inBin) < 1.6,
    `${detail.inBin.stripes} stripes, ${blur(detail.inBin).toFixed(2)} soft pixels per edge`)
}
await page.screenshot({ path: path.join(OUT, '20-poster-detail.png') })

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
