// Shared bits for the browser suites.

/**
 * Imports files and puts them on the canvas.
 *
 * Imports land in the media bin rather than the canvas, so anything that wants
 * a layer has to place it. Kept here so that rule lives in one place instead of
 * being spelled out in every suite.
 */
export async function importAndPlace(page, files, opts = {}) {
  const { timeout = 20000, selector = '.pf-media-input' } = opts
  const list = Array.isArray(files) ? files : [files]
  const before = await page.evaluate(() => window.__pfState().doc.media.length)
  await page.setInputFiles(selector, files)
  await page.waitForFunction(
    (want) => window.__pfState().doc.media.length >= want,
    before + list.length,
    { timeout },
  )
  await page.evaluate((n) => {
    const s = window.__pfState()
    s.placeMedia(s.doc.media.slice(-n), { resizeDocToFirst: s.doc.layers.length === 0 })
  }, list.length)
  await page.waitForFunction(
    (n) => window.__pfState().doc.layers.length >= n,
    list.length,
    { timeout },
  )
}
