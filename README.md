# PixelForge

A browser image & GIF editor built around one idea: **shaped pixelate/blur overlays that
track an animated GIF frame by frame**, with keyframes so the overlay can move and scale
as the animation plays.

React + Vite, plain JSX, no UI framework. Everything runs client-side — nothing is uploaded.

```bash
npm install
npm run dev        # browser
npm run desktop    # the same app in an Electron window
```

## The core mechanic

An **effect layer** is not a picture — it is a region operator. At render time it reads the
pixels already composited beneath it, transforms them, masks the result to its shape, and
draws it back. Because that happens on every rendered frame, a pixelate circle sitting over
an animated GIF re-pixelates whatever the GIF is currently showing, automatically.

The pixelation grid is snapped to document coordinates rather than to the shape's bounding
box, so blocks stay locked to the image instead of crawling when you drag the overlay.

Effects available: pixelate, gaussian blur, pixel + blur, solid fill, darken, brighten,
desaturate, invert, noise. Each takes any shape (ellipse, rectangle with corner radius,
triangle, diamond, star, or a freehand lasso), any rotation, feathered edges, and an
**Invert** toggle that applies the effect to everything *except* the shape.

## Background removal

Colour keying on image layers, applied at render time — so an animated GIF re-keys itself as
it plays and nothing is baked into the document. Keyed frames are memoised per decoded frame,
taking a 24-frame re-render from ~50ms to ~0.1ms.

**Deliberately not a segmentation model.** No download, no network, no tens of megabytes of
weights. That buys speed and privacy at a real cost: it can only find a background separable
by *colour*. Green screens, flat backdrops, screenshots and flat-shaded GIFs key cleanly. A
subject in a room, especially a near-monochrome one, does not — that needs an ML matte, which
would be a genuine addition rather than a tuning of this.

How it works, and the two things that had to be got right:

- **Classification is strict, softening is on the edge.** The first version let the flood pass
  through anything *partially* background. On a grainy photo that is a near-continuous web of
  "sort of background" pixels, so the flood threaded straight through the subject and shredded
  it into confetti. Background is now a yes/no decision; feathering is applied to the finished
  mask in pixels.
- **The colour metric follows the key's saturation.** Against a green screen, hue should
  dominate so a shadow on the screen still keys while a grey shirt does not. Against a *grey*
  key there is no hue to lean on, and discounting brightness the same way makes a wall and
  skin read as identical. The weighting now scales with how saturated the key colour is.

**Only from the edges** (the default) floods inward from the border, so a colour that also
appears inside the subject survives; **Anywhere** removes it everywhere.

The panel reports how much of the frame is being removed and flags a speckled result, since
that is the signature of a background that is not colour-separable. It deliberately does *not*
claim more than it can know: a colour key cannot tell "removed the background" from "removed
the subject too" — a green screen and a failed key can remove the same 94% of a frame.

Measured on a green-screen fixture with known geometry: **100% of the subject kept, 99.7% of
the background removed.**

### AI mode

When colour cannot separate the scene, a small segmentation model runs **locally on the GPU**
through ONNX Runtime Web. The image never leaves the machine; only the weights are fetched,
once, then cached in IndexedDB.

| model | size | device | good for |
|---|---|---|---|
| **MODNet** (default) | 25.9 MB | WebGPU | people |
| **U²-Netp** | 4.6 MB | CPU | general subjects |

Both are Apache-2.0. U²-Netp is five times smaller but uses a MaxPool with `ceil_mode` that
ONNX Runtime's WebGPU backend has not implemented, so it falls back to the CPU — which is why
there are two. That gap only surfaces when a kernel actually runs, not when the session is
built, so the fallback covers run-time failures as well as setup.

Measured on the near-monochrome fixture, where the colour key keeps only 33% of the subject:

| | subject kept | background removed |
|---|---|---|
| colour key | 0.33 | — |
| MODNet on GPU | **0.99** | **1.00** |

Inference is explicit rather than automatic — it runs per frame and cannot happen inside a
synchronous render, so masks are computed on demand and cached.

### Tracking with a key — measured, and rejected

Using the key's alpha to weight the tracker's correlation sounds obviously right and is not.
Measured against fixtures with known motion:

| | green screen | busy background |
|---|---|---|
| plain correlation | 0.30px | 1.24px |
| keyed, unweighted | 0.30px | 1.03px |
| keyed + subject weights | 0.30px | **39.66px** |

Weighting is neutral where the baseline is already near-perfect and catastrophic where it
matters, because a sparse weight map leaves too few pixels voting. It is not in the code.
Keying the layer first is a mild, honest win on a busy background (1.24 → 1.03px) at roughly
double the runtime — worth doing by hand when it helps, not worth forcing.

## Motion tracking

Put an overlay over the thing you want followed, then **Track from playhead**. It follows the
subject through the footage and writes the result as ordinary position keyframes — editable,
retimable, exportable, exactly like ones you set by hand.

**This is not AI.** It is normalized cross-correlation: a patch of the frame under the layer
becomes a template, and each frame is searched for the offset that best matches it, coarse-to-
fine over a two-level image pyramid. No model, no download, nothing leaves the machine.

Some details that matter:

- It samples the layers *beneath* the overlay, with effect layers excluded. Correlating
  against the composited output would mean tracking our own pixelation, which destroys the
  detail the tracker needs.
- The template eases toward each new match (10%) so the subject can change appearance, while
  every frame is also re-checked against the *original* template to pull back any drift that
  blend introduces. Both numbers were chosen by measuring against a fixture with known motion,
  not by taste.
- Correlation gives a confidence score, so when it loses the subject it stops and says where —
  scrub there, reposition, and track again. Tracking a featureless area is refused outright.
- Results are thinned to the fewest keyframes that stay within a pixel of the raw track, so
  what you get back is still comfortable to hand-edit.
- Optionally follows size as well as position, and can track backwards as well as forwards.

Accuracy on the bundled fixture — a disc on a known path whose appearance changes every frame —
is **1.2px mean, under 5px worst** across a full loop. Real footage with rotation, occlusion or
heavy motion blur will do worse; that is where optical flow, and eventually a learned tracker,
would be the next step.

## Keyframes

Turn on **Add animation tracking** for a layer, then just work. Any property you change from
its current value grows its own animation track automatically, keyed from where it was to
where you put it — nothing else is touched. Change position and it tracks position; change
opacity too and opacity gets its own separate track and its own timeline lane.

You can also click the ◆ beside a single property to animate only that one, without arming
tracking at all.

- Animatable: position, size, rotation, opacity, pixel size, blur radius, feather, effect
  amount, corner radius, and image framing (crop insets, zoom, pan).
- A new track is seeded with the pre-edit value at `0` and the new value at the playhead, so
  one edit produces real motion rather than a static single key.
- **Editing: This key / All keys.** *This key* writes to the key at the playhead. *All keys*
  applies across the whole track — sliders set the same value on every key, while dragging on
  the canvas offsets the entire path so the motion's shape survives.
- The canvas draws the **motion path** as a dashed line with a dot per key.
- Timeline lanes are grouped under the layer name, one per animated property. Drag a diamond
  to retime, click empty lane space to move the playhead, double-click to add a key,
  right-click to delete, `✕` to stop animating that property.
- Per-key easing: linear, ease-in, ease-out, ease-in-out, hold.
- **Box-select.** Drag across empty lane space to draw a band; every key inside it is
  selected, across as many lanes and layers as the band covers. `Shift`/`Ctrl` adds to the
  selection instead of replacing it, and clicking a key does the same. Dragging any key in a
  selection slides the whole group, and `Delete` removes all of them in one undo step.

  Two details that only show up once you use it. Moving a run of keys applies them
  *furthest-first in the direction of travel*, or a key sliding right lands on top of a later
  one that has not moved yet and the run collapses. And dragging a band used to leave the lane
  labels selected as text — harmless in itself, except that the *next* drag then started on
  top of a text selection, which Chrome reads as a native text drag and answers with
  `pointercancel`. The band silently died mid-gesture, every second time. The lanes now
  suppress selection and the drag ends cleanly on a cancelled pointer.

Exported GIFs include the keyframed motion, sampled at the source GIF's own frame boundaries
so original timing is preserved.

## Saving and recovery

**Save** (`Ctrl+S`) keeps the project in this browser — it never writes a file. **Open
Existing…** (`Ctrl+O`) lists what you have saved, with thumbnails, and can also open a `.pfz`
from disk. Only **Export** downloads anything.

Export's **Project** format writes a `.pfz` — a plain ZIP:

```
project.json      document, layers, groups, keyframe tracks, asset manifest
assets/<id>.gif   the exact bytes you imported, untouched
thumbnail.png     preview
```

Originals are stored rather than decoded frames, so the file stays small, the round trip is
lossless, and you can just unzip it to get your media back. Reopening re-decodes the media and
remaps asset ids, so opening a project can never collide with what is already loaded. Dropping
a `.pfz` onto the window opens it. In the toolbar, **Import Media…** brings in images and GIFs.

Separately, the document is **autosaved** on a debounce. If the tab is closed or crashes, the
next launch offers to recover that session. Autosave holds one session and the browser may
evict it — a saved project, or an exported `.pfz`, is the durable copy.

### Automatic backups

Autosave covers a crash. It does not cover the likelier loss: you export a PNG, move on, and
weeks later have the picture and no way back to the layers that made it. Nothing warns you,
because nothing went wrong.

So every save and every export *also* writes a real `.pfz` — assets and all — into the app's
own data folder, and **Open Existing… → Automatic backups** lists them with when and why each
was written. On the desktop they are files under `userData/backups`, findable in a file
manager and surviving the browser profile being cleared; in a browser they go to IndexedDB,
so the safety net is degraded rather than absent.

Three things make it a net rather than a nuisance:

- **It cannot fail the thing that triggered it.** The write is unawaited and swallows its own
  errors. A backup that could break an export would be worse than no backup.
- **An unchanged document is not written twice**, keyed on an FNV-1a hash of the document
  JSON. Otherwise repeated saves fill the ring with identical copies and push out the older,
  genuinely different ones — exactly backwards.
- **The ring is bounded and prunes the oldest.** That last word did real work: the first
  version stamped names to the second, so a save and an export moments apart collided and the
  filename sort deleted whichever sorted first. Writing 35 backups in a loop kept `Ring 9` and
  deleted `Ring 33`. Names now carry milliseconds plus a monotonic counter.

The main process resolves the path it is asked to read and refuses anything outside the backup
folder — the path arrives from the renderer, so it is not trusted.

## Clips

Until now a layer *was* its asset: shown for the whole document, looping forever. That is
right for an overlay on a GIF and wrong for editing, because cutting, trimming and
arranging all need a layer to say **which part** of its source it plays and **when** it
plays there.

A clip is three numbers:

```
start   where it begins on the document timeline
in      how far into the source it starts playing
out     where in the source it stops
```

Everything follows from those. Its length on the timeline is `(out - in) / speed` — speed
divides, because playing at 2x makes the same source span half the timeline; the clip gets
shorter, not the media. Trimming moves `in` or `out`. Sliding moves `start`. Splitting is
one clip becoming two that share a boundary. Nothing touches the asset, so it is as
non-destructive as the rest of the editor and undo is ordinary undo.

**A layer with no clip behaves exactly as before** — visible throughout, looping. Layers
are not clipped on import. That keeps every existing project working and keeps the "text
over a looping GIF" case, which is what most of this app is for, unchanged.

Three details that are not obvious until something is wrong:

- **The visible span is half-open, `[start, end)`.** Two clips butted together must not
  both draw on the single frame where they meet, which reads as a flash on every cut.
- **A clipped source plays once and does not wrap.** Wrapping would make trimming
  meaningless: the frames you trimmed off would come back around.
- **The two trim handles are not symmetric.** Dragging the right edge only changes how much
  of the source plays. Dragging the left edge must also move `start` by the same amount, or
  the rest of the clip slides along the timeline as you trim and the clip appears to run
  away from the cursor.

Splitting is refused within 40ms of either end. A cut at the very edge produces a
zero-length piece, which is a way of losing footage while appearing to have worked.

### The clip is the filmstrip

The first version of this drew a featureless blue bar you could drag, and a filmstrip of the
same media in the row below it. Two representations of one object, and the bar was the one
you could grab — so trimming was blind. It showed a duration and no pictures, which is the
same complaint as an eraser with no brush ring: you could not see what you were trimming
*to*.

So the strip and the bar are one thing now. A clip is a run of thumbnails sitting on a lane
that spans the document, and the thumbnails cover only what the clip plays. Trim the head
and they re-slice — measured on a 1.44s clip, the first thumbnail moves from 780ms to
1168ms into the source, and the strip covers 248ms of it instead of 600ms.

Drag the body to slide, drag either end to trim, `Ctrl+K` cuts every clip the playhead is
inside, and **Close gaps** lays them end to end in their current order. `Ctrl+K` rather than
a bare `S` because `S` is already the shape tool. Empty lane space still scrubs.

### Tracks

A track is **one integer on a layer**. Not a collection, not a second document structure.

The reason is worth stating, because it is the whole design. The layer array already *is*
stacking order. A track order living beside it would be two answers to "what is in front of
what", and they can disagree — so the timeline and the layers panel would contradict each
other, and you would need to know which one wins. Instead, moving a clip between tracks
**re-sorts the layer array to match**. There is one truth, and the renderer never learns
that tracks exist: not a line of compositing code changed.

Higher track number means further forward, and the rows are drawn front-most at the top —
the way a timeline is read. They are labelled **Track 1, Track 2** and not V1, V2: the
shorthand has to be learned, and the first person to see it read "V1" as *volume* and went
looking for a waveform.

**An imported video arrives as a clip on the first track.** A 164-second MP4 is footage, not
an overlay, and arriving as something that loops forever and cannot be cut is not a sensible
place to start editing it — which is exactly what happened: a long video landed as an
unclipped strip *below* an empty track, outside the structure meant to hold it. A GIF still
arrives unclipped, because in this app a GIF usually is an overlay. Anything unclipped is
now labelled as not being on a track, rather than sitting there looking like a track that
lost its name.

Each clip carries its own file name over its thumbnails. The row label names the *track*, so
without it there was nothing on screen saying which file a clip was.

Only the clips are re-sorted, and only among the slots clips already occupy. A title that
sat in front of the footage stays in front of it when a clip is dragged to another row;
nothing that is not a clip ever moves.

**Nothing creates a track.** There is always one empty row above the top one. Drop something
into it and it becomes real, and a new empty row appears above that — the way a spreadsheet
grows when you type in its last line.

**Nothing creates a clip either.** Dragging from the Media bin onto a track is what makes
one, because the gesture that creates it is the same gesture that says where it goes. The
**Make a clip** button is gone; the Video tab is down to two buttons, Cut at playhead and
Close gaps.

Dropping onto a spot another clip already occupies lands **after** that clip rather than on
top of it. Two clips in the same place means one silently hides the other, and building a
sequence by dragging several things onto one row is the common case — so it does the useful
thing without a mode, a modifier, or anything to press. Sliding a clip on top of another is
still allowed, because refusing a drag is a worse surprise than an overlap you can see.

Dragging a clip up or down moves it between tracks. Same gesture as sliding it sideways, no
modifier: the row the pointer is over is the row you meant.

**What a track does not promise:** the depth order of two clips that overlap *on the same
row*. Clips on one track are arranged in time, not in depth. Move one to another track and
back and it will not return to where it was in that stack — and it should not pretend to.

### Room to work

The timeline was capped at `40%` and sized by its content, so a single clip row was a
sliver at the bottom of the screen. Editing is what the panel is for; the canvas is a
preview of the thing being edited, not the thing itself. With an editing pane open it now
opens at **52% of the editor column** and its top edge drags, remembered in `localStorage`.
The canvas shrinks to fit rather than being covered — it already refits on resize, so this
needed nothing new.

One thing that was quietly broken while building it: the column height was read off a ref
during render, which only works if something happens to re-render after the ref attaches.
It does not on first load, because the timeline returns nothing until the document has
something worth showing — so a mount effect finds no node and never runs again. It is a
callback ref now, which fires when the node actually appears.

Building this exposed an older bug it had been quietly living with: **undo and redo restored
the document but never recomputed the timeline length**. Nothing showed it while a
document's length could not really change, but with clips every bar was suddenly drawn
against a stale scale — a clip at 720ms rendering at the far left of a 720ms timeline.

## Audio

There was no sound because nothing decoded any: audio was handed to ffmpeg at export
and never touched in the app. It is decoded and played now.

**Audio is the clock.** The render loop used to advance time by the wall-clock delta
between animation frames, which is fine when nothing has to agree with it and wrong next
to sound. A dropped video frame is invisible; a gap or a drift in audio is immediately
audible, and a picture sliding out of sync with speech is worse than either. So while
sound is playing, document time is *derived* from `AudioContext.currentTime` rather than
accumulated separately. Measured over 700ms of playback: document 689ms, audio clock
689ms.

Decoding is deferred to the first press of play. A long soundtrack decoded to PCM is
hundreds of megabytes — 816 seconds of stereo 48k is about 313MB — and most projects are
never played with sound at all. The encoded bytes are kept at import so the decode needs
no re-read.

**Clips carry their sound with them**, which falls out of the model rather than needing
anything: the same three numbers that index a frame table index a sound buffer. A clip
starting at 500ms is silent until 500ms; a clip trimmed to 400ms stops at 400ms. An
unclipped layer loops, because its picture does and the two must agree.

Seeking while playing re-cues rather than adjusts — a scheduled `AudioBufferSourceNode`
cannot be moved once started — and only for a jump over 250ms, or every frame of ordinary
playback would restart the sound. Scrubbing while paused is deliberately silent; scrub
audio is a different feature and a poor default.

### Testing sound without listening to it

The player builds its graph against any `BaseAudioContext`, so the tests render *the same
graph* through an `OfflineAudioContext` and measure the samples. A test that built its own
graph would prove nothing about the one that plays. Loudness is measured per 100ms:

| | measured |
|---|---|
| playing | 0.090 peak, all 15 bins above the noise floor |
| muted | exactly 0 |
| half volume | 0.50x the RMS |
| clip starting at 500ms | 5 silent bins, then 0.089 |
| clip trimmed to 400ms | 4 loud bins, then silence |

### The waveform

Drawn along the bottom of the clip, over the thumbnails rather than in a lane of its own —
the clip is one object, and a separate row would put its picture and its sound in two places
that have to be kept lined up by eye.

The file is reduced once to 4096 buckets and every later draw resamples that summary. A
164-second clip has millions of samples and maybe nine hundred pixels to show them in;
summarising per pixel on every redraw would re-read the whole buffer each time the panel is
dragged.

**Peaks, not averages.** The average of a loud symmetric waveform tends to zero, so
averaging draws silence over the loudest passage — the one thing the picture exists to show.

Two things that had to be got right, both found by looking at the result rather than by
reasoning about it:

- **Samples per bucket, not a fixed stride.** Stepping every 8th sample sounds harmless
  until the bucket is short: a 440Hz tone in a 43-sample bucket gives five readings inside
  half a cycle, and the peak comes back as a tenth of the real amplitude.
- **Out of range is silence, not the nearest bucket.** Clamping the index smears the last
  moment of the file across everything past the end, drawing a steady tone over a span with
  no sound in it at all.

**Quiet files are scaled up**, capped at 8x. Plenty of real footage is quiet — phone audio, a
distant mic — and at true scale it draws as a flat line, which is exactly the material whose
shape you most need to see. The cap matters: without one, a file containing only room tone
is amplified into a dense band that looks like continuous speech.

Decoding is normally deferred to the first press of play, but a waveform is wanted before
that, so a clip on screen asks for its own soundtrack.

The fixture is deliberately shaped rather than a constant tone: `beeps.mp4` is 400ms on,
600ms off, four times over. A constant tone looks like a solid block whether the peaks are
right, wrong, or smeared from a neighbouring bucket. Alternating makes it testable — the
loud columns come back at 0.69 and above, the silent ones at exactly 0.

### What is not built

There is still no mixer: no per-clip gain, no fades, no separate audio track, nothing summed
with automation. Master volume and mute are the whole of it, and export still muxes the
original audio through ffmpeg untouched, so the volume set for previewing does not reach an
exported file.

### What is still missing for this to be an editor

Being honest about the gap. Clips are the model; these are not built:

- **Ripple edits.** Deleting a clip leaves a hole; `Close gaps` is the blunt instrument.
- **Audio tracks.** Sound follows its clip, but there is no row for it of its own.
- **A mixer.** Sound plays and is drawn, but there is no per-clip gain or fade.
- **Transitions.** Two clips can butt together but not dissolve.

## Why long videos used to stutter

A 48,000-frame clip played badly, and the reason was not decode speed.

Reaching an arbitrary frame in an inter-coded video means decoding from the keyframe
before it, because every other frame is a difference against what came before. The
original code did that honestly and then threw the result away: it started a fresh
decoder for each request, decoded from the keyframe up to the frame it wanted, kept only
the frames from the requested one onward, and closed the decoder. Twenty-four frames
later it did the whole thing again, from the same keyframe.

With a 250-frame keyframe interval that is an average of ~125 frames decoded per 24
frames displayed. It also scanned the entire sample table twice per call to find that
keyframe — 96,000 iterations on a 48,000-frame clip, at playback rates.

Measured on a 720p clip with a 250-frame GOP, playing 600 frames:

| | before | after |
|---|---|---|
| samples decoded | 3,014 | 619 |
| decode work per frame shown | 5.0x | 1.0x |
| decode work actually kept | 20% | 97% |
| decoder restarts | 24 | 1 |
| sample-table scans | 57,600 | 0 |
| wall clock | 2,207ms | 559ms |

Three changes, in order of how much they mattered.

**The decoder stays open and is fed forwards.** A *run* is a decoder plus a cursor into
the sample table. As the playhead advances the run is fed more samples; it is only torn
down when it genuinely cannot serve the request.

**Every decoded frame is kept**, including the ones between the keyframe and the frame
that was asked for. They cost exactly as much to produce as the wanted one, and
discarding them was most of the waste.

**The two lookups are precomputed at import** — `syncBefore[p]`, the keyframe to start
from, and `maxDecode[p]`, the last sample in decode order needed to cover frame `p`. Both
are running maxima taken in presentation order, which is what the scans were computing
the long way round. They differ from each other because B-frames make decode order and
presentation order disagree.

### The part that was subtle

Deciding when a run *cannot* serve a request took three attempts, and the wrong answers
were each worse than no optimisation at all.

Comparing against where the run *began* looks right and is not: a frame decoded earlier
may since have been evicted, leaving a run that will never produce it again and a seek
that hangs on a frame that never arrives.

Restarting whenever a keyframe lies ahead of the cursor is also wrong, because during
ordinary playback the playhead crosses keyframes the cursor has not reached yet — that
version restarted 17 times in 400 frames.

What settles it is that the feed cursor being ahead of the playhead does not mean the
frame is unreachable; it means the frame is still in the decoder's queue. Telling
"already emitted, since evicted" from "fed, still in flight" needs the highest frame the
run has actually output:

```js
const stalled = !cached && run.next > need && run.lastOut >= want
const cheaper = !cached && run.next < asset.syncBefore[want]
```

`stalled` means this run can never produce the frame. `cheaper` means restarting at the
keyframe is less work than decoding forward from here. Without the `lastOut` term, a
playhead moving faster than the decoder is indistinguishable from an unreachable frame,
and the run is rebuilt on every frame it is briefly behind on — which is the one thing
guaranteed to keep it behind.

Export keeps a separate path. It flushes, so it needs a decoder of its own, and the
streaming run is closed first: two decoders competing for the same hardware frame slots
is how the pool runs dry.

`bench-video.mjs` reports these numbers for any file — `npm run bench:video -- path.mp4`.

## Printing

A PNG is dimensionless. It carries a pixel count and nothing about how big those
pixels are meant to be, so print software guesses — usually 72 or 96 dpi — and a
sticker exported at 1181px arrives as a 12-inch sticker unless someone corrects it at
the other end.

Export's **Size by → Print size** asks for the physical width, the unit and the
resolution instead, and works backwards to the pixel count: 100mm at 300dpi is 1181px.
It is a separate mode rather than another way to drive the scale slider because at
300dpi the equivalent scale is a four-figure percentage, which is not a number anyone
wants to reason about.

The resolution is then written into the file as a **`pHYs` chunk**, stating pixels per
metre, which every print pipeline reads. Canvas cannot be told a resolution — `toBlob`
always produces a file with no physical size at all — so the chunk is inserted after
encoding, immediately after `IHDR` where the spec puts it, replacing any `pHYs` already
present rather than writing a second one. Two would be invalid and readers disagree
about which wins.

`test-dpi.mjs` checks this against a real PNG produced by something other than the
module itself, and recomputes every chunk CRC with an independent implementation — a
writer and a reader that agree with each other can still both be wrong, and a bad CRC
is the kind of thing most viewers ignore silently and the print shop does not.

Other formats carry no such field. GIF has no concept of physical size, and the panel
says so rather than implying the setting does something.

## Canvas size

Resizing the canvas is changing the frame, not the picture in it. That is the default
(**Content: Leave**) and it means exactly what it says — not one layer moves or changes size.

It did not used to. The old resize scaled every layer by the width and height factors
*independently*: `x * sx, y * sy, w * sx, h * sy`. Change only the height and `sx` is 1 while
`sy` is not, so everything in the document stretched vertically. Asking for a taller canvas is
not asking for taller people. Growing the canvas now adds room; shrinking it crops.

The other two modes exist because scaling the content *with* the canvas is sometimes what you
want — but uniformly, about the canvas centre, so nothing is ever distorted:

| | what it does |
|---|---|
| **Leave** | nothing at all to the layers |
| **Fit** | scales until all the content is inside the new canvas |
| **Fill** | scales until it covers, cropping the overflow |

Keyframed motion is carried along by the same transform. Position needs the offset as well as
the factor — scaling a moving layer about the canvas centre has to move its whole path, not
just stretch that path about the origin, or the animation drifts away from where the layer now
sits.

**Aspect** links the two dimensions, so editing one carries the other. The ratio is read from
the document *before* each edit rather than being stored, so a run of edits cannot compound
rounding error into a slowly drifting shape.

**Crop to fill now** is the one-shot version: it scales the artwork where it currently sits
until it covers the canvas, and centres it. Unlike the resize modes it works from the content
bounds, so it is useful without touching the canvas size at all — which is the usual case,
since the content being too small is not a resize.

## Still images can animate too

A project made only of stills has no frames, so there is nothing to key against. The document
therefore carries its own **Timeline** length (under Document); asking to animate anything in a
still-only project sets it to 3s automatically. Export then samples at a steady frame rate
rather than pretending two keyframes are two frames.

## Layer identity

Layer ids carry a random suffix. A plain counter was not enough: it restarts on page load,
while a restored session or an opened project keeps the ids it was saved with, so the next
import re-issued one. Two layers then shared an identity and behaved as a single layer —
selecting, dragging, editing or deleting either one hit both.

Documents arriving from outside the session are also repaired on load: duplicate ids are
reassigned and any parent link that no longer resolves to a real group is dropped, so a
project saved while the bug existed does not carry it back in.

Clicking empty space in the layers panel clears the selection, as does `Esc`. A layer filling
the canvas leaves no empty canvas to click, so the panel has to offer the way out.

## Snapping

Dragging a layer compares its left / centre / right and top / centre / bottom against the
canvas edges and centre. The nearest match inside the tolerance wins, the drag is nudged onto
it, and a guide is drawn — magenta for a centre line, dashed blue for an edge. Each axis is
decided independently, so a layer can lock to the vertical centre while staying free
horizontally, and a multi-layer selection snaps as one box so relative spacing survives.

The tolerance is in *screen* pixels, so the pull feels the same at 20% zoom and 400%. Hold
**Alt** to place something just off a guide.

## Groups

Select layers and press `Ctrl+G` to group them; `Ctrl+Shift+G` ungroups. Handy for keeping a
pile of pixelate overlays together.

Hiding a group hides everything inside it, its opacity multiplies with each child's own, and
locking it locks the contents. Deleting a group takes its contents with it, and undo brings
the whole thing back. Drag a layer onto a group row to move it in, or onto empty space in the
panel to lift it back out.

The document stays a flat, bottom-to-top array — a group is just an entry with
`type: 'group'`, and membership is a `parentId`. Members are kept contiguous and directly
above their group entry, so array order still equals paint order and the panel tree cannot
disagree with what is actually in front.

## Lasso, cut and mask

The lasso is a selection tool, not a brush. **Click to plot points**, or press and drag to
trace freehand — the same tool does both. Click the first point, double-click, or press Enter
to close; Backspace drops the last point, Esc cancels. A closed outline shows marching ants
and a bar of actions:

| | |
|---|---|
| **Copy to layer** | duplicate just that region onto a new layer, original untouched |
| **Cut to layer** | move that region onto a new layer and leave a hole behind |
| **Mask** | keep only what is inside the outline |
| **Erase** | remove what is inside |
| **Pixelate** | drop an overlay shaped like the outline |

A closed outline stays editable: drag a point to move it, click a hollow midpoint to insert
one, right-click a point to remove it (three is the minimum).

Cut-outs are non-destructive. A layer carries an optional `mask` — a polygon in layer-relative
coordinates plus an `invert` flag and feather — so cutting sets an inverted mask on the
original and a normal one on the new piece. Nothing is re-encoded, undo reverses it in one
step, masked GIF layers keep animating, and the mask follows the layer when you move, resize
or rotate it. A masked layer is also only clickable where it is visible, so stacked cut-outs
do not steal each other's clicks.

One layer holds one mask; a second lasso action replaces the first rather than compounding it.

## Framing: animated crop, zoom and pan

Image layers carry a **Framing** section — crop insets (top/right/bottom/left), zoom and pan —
and all of it is keyframable, so a GIF can shrink to a new height or push in as it plays.

The distinction that matters: animating a layer's **height** stretches the image, because the
same source is squeezed into a shorter box. Crop insets shrink the destination rect *and* the
sampled source rect by the same fraction, so the part you keep stays pixel-for-pixel identical
and the rest simply goes away — a reveal, not a squash. There is a test asserting exactly
that, including that it differs from the squash you would get from animating height.

Zoom shrinks the sampled window about its centre while the layer box stays put, so the content
scales up in place; pan slides that window and stops at the image edge rather than sampling
past it. Nothing is re-encoded — it all resolves to one `drawImage` source rect per frame, so
it stays exact and works frame-by-frame on animated GIFs.

## Cropping

Cropping trims each image layer to the part that survives: the layer box becomes the visible
region and a normalized source sub-rect (`layer.src`) narrows to match. So width and height
read true afterwards, corner radius rounds the *cropped* shape, and nothing spills outside
the canvas. No pixels are re-encoded — the sub-rect just changes which part of the original
asset is sampled, which keeps it non-destructive, exact under undo, and per-frame correct for
animated GIFs.

Rotated layers, and layers whose position or size is keyframed, are translated only. For
those the visible region is not an axis-aligned slice of the source, so trimming would be
wrong rather than merely approximate.

## MP4 import

Drop in an `.mp4` and it behaves like any other layer — overlays, keyframes, tracking, masks
and export all work on it unchanged.

The rest of the app assumes `renderDocument(ctx, doc, t)` is synchronous and that every frame
is in memory. That is fine for a GIF; ten seconds of 1080p30 as raw bitmaps is about 2.5GB.
So video splits the two:

- **Timing is read up front** by demuxing with `mp4box` — every frame's presentation time,
  with nothing decoded. That is all the timeline, keyframe sampling and export planner need.
- **Pixels are decoded on demand** through WebCodecs into a cache bounded by a pixel budget
  (~96M pixels, so ~46 frames of 1080p). `frameAt` is synchronous and returns the nearest
  frame it has, so a scrub shows a neighbour for a moment rather than going blank. Export
  calls `awaitVideo` first and gets the exact frame, so it stays frame-accurate.

Three details that are easy to get wrong, and were:

- **Samples must be fed in decode order, not presentation order.** With B-frames those differ,
  and a decoder handed presentation-ordered input fails with a bare "Decoding error". The
  sample table stays in decode order; presentation order is a separate index.
- **The first composition time is not zero.** B-frame reordering pushes it forward — 83ms for
  this fixture — and players hide that with the container's edit list. The timeline is rebased
  so frame zero sits at t=0, otherwise every seek lands two frames early.
- **Decoded frames must be released immediately.** A `VideoFrame` holds a slot in a small,
  hardware-backed pool — around a dozen at 1080p. Collecting frames and converting them after
  `flush()` exhausts the pool, the decoder stops emitting, and `flush()` never resolves: the
  import hangs on a blank canvas with nothing in the console. Each frame is now drawn out with
  `transferToImageBitmap` and closed inside the output callback.

The codec is checked with `isConfigSupported` before decoding, so an unsupported file says so
instead of silently producing nothing. Requires WebCodecs, so Chrome or Edge. Audio is ignored
for now.

## The desktop build

Electron **is** Chromium, so it does not make canvas work faster or give the renderer more
memory. Three things it does give, and they are the reasons this exists:

- **ffmpeg.** Real H.264 output with audio, instead of `MediaRecorder` capturing the canvas
  in real time — see [MP4 export](#mp4-export). It is *detected*, not bundled — shipping it
  would add ~80MB and licensing questions — and everything that needs it degrades to a clear
  message when it is missing. (Importing HEVC/ProRes/MKV still goes through WebCodecs and so
  is still limited to what Chromium decodes; routing import through ffmpeg too is the
  obvious next step, and is not done.)
- **A real filesystem.** Batch export writes a folder of results directly. The browser has no
  such thing, so it gets one zip instead.
- **Native inference.** `onnxruntime-node` with CUDA is a straight upgrade over WebGPU for the
  matte model, with no kernel gaps to fall back from. Not wired up yet; the shell is what
  makes it possible.

Nothing in `src/` knows it is running under Electron. The only surface is
[`desktop.js`](src/engine/desktop.js), and every function in it works in a plain browser —
saving becomes a download, opening becomes a file input, a batch becomes a zip. The web build
stays a first-class target rather than a stale fork.

Two details worth keeping:

- The app is served over a custom `app://` scheme, **not** `file://`. ONNX Runtime asks for
  `/ort/*.wasm` by absolute path, which under `file://` resolves to the drive root and 404s.
  A real scheme also gives the renderer an origin, which IndexedDB (autosave) requires.
- The default Electron menu binds Ctrl+C/Ctrl+V to native copy/paste roles, which would shadow
  the editor's own layer copy/paste. Those entries are simply left out — Chromium still handles
  clipboard shortcuts inside text inputs without them.

```bash
npm run desktop         # dev server + Electron, hot reload
npm run desktop:run     # production build in an Electron window
npm run desktop:build   # installer + portable exe, then verifies both
npm run verify:package  # smoke-test an already-built package
```

### Icons

`npm run make:icons` builds everything from `logo.png` in the project root:

```
build/icon.ico       256, 128, 64, 48, 32, 16 — Windows, and the installer
build/icon.png       512 — macOS and Linux
public/favicon.png   64 — the browser tab, and the mark in the top bar
```

Windows wants all those sizes in one `.ico`. The shell picks 16px for a tree view, 32px
for the taskbar and 256px for large tiles, and picks badly if the size it wants is absent
and has to be resampled from whatever is. Vista and later accept PNG-compressed entries
inside an `.ico`, which is what the script writes — smaller than the old BMP-with-AND-mask
form and lossless at every size.

Scaling uses lanczos rather than the default bilinear: at 32px and below, bilinear turns
the sprocket holes down the stem of the P into mush.

### Packaging

`desktop:build` produces two artifacts under `release/`, ~119MB each:

| | |
|---|---|
| `PixelForge-Setup-0.1.0.exe` | NSIS installer, per-user, choosable install directory |
| `PixelForge-0.1.0-portable.exe` | single file, runs without installing |

Both targets emit `.exe`, so they need distinct `artifactName`s — with the default the
second silently overwrote the first and only the portable build survived. `publish` is
null: there is no update server, and generating update metadata for one that does not
exist crashes the build.

Nothing under `node_modules` is packaged. Vite bundles the renderer into `dist/`, and the
main process requires only Electron built-ins (`electron`, `path`, `fs/promises`,
`child_process`), so shipping the dependency tree adds 25MB of nothing. Test fixtures are
excluded too.

**A dev server running on Windows breaks the build.** Vite's file watcher opens handles on
`release/` as electron-builder writes it, and the staging directory can then never be
renamed — the build dies with `EPERM ... rename 'win-unpacked.tmp'` and the cause is
nowhere in the message. `release/`, `dist/` and the screenshot folders are in
`server.watch.ignored` now.

`verify-package.mjs` launches the built `.exe` under Playwright and checks the things that
only packaging can break: that it serves over `app://`, that the ONNX runtime `.wasm` files
resolve (they are requested by absolute path and fail silently until someone clicks Remove
background), that the preload bridge is present, that backups land in the app's own data
folder, that test fixtures did not ship, and that the dev-only `window.__pf*` handles are
stripped from a shipped build. It skips cleanly when nothing has been built.

One caution when writing such a check: the `app://` handler falls back to `index.html` for
any path it cannot find, so *everything* answers 200. Asserting a 404 to prove a file is
absent proves nothing — the fixture check reads the first three bytes and asks whether they
say `GIF`.

**ffmpeg is not bundled.** MP4 export shells out to whatever is on `PATH`, or `PF_FFMPEG`.
Everything else — GIF, PNG, WebM, the matting models — is self-contained.

There is no code-signing certificate, so Windows SmartScreen will warn on first run.

## Text behind the subject

The background-removal mask was already there, so this needed no new rendering at all. The
photo is left whole underneath, a text layer goes on top of it, and a **second copy of the
same image** sits above the text with the matte switched on. Both copies share one asset, so
they share the mask cache: the model runs once and the effect costs one extra draw. The three
are grouped so they move together, and each is an ordinary layer afterwards.

## Sticker mode

Given a cutout, the border is made by stamping the silhouette around a circle rather than by
a distance transform — at these radii the difference is invisible and it runs on the GPU
instead of per-pixel in JS. The shadow is cast from the *silhouette*, not the artwork, so it
takes the shape of the sticker rather than the shape of the subject inside it.

The border lives outside the artwork, so both the source and destination rects grow by the
padding. Growing the source rect by `2*pad` while leaving its origin alone is what keeps the
subject registered exactly where it was — the test measures magenta coverage at three radii
and asserts 100% at r=38, 0% at r=20 and r=52.

**The border is grown from the finished alpha**, which is less obvious than it sounds. It has
to be the background key, the lasso mask *and* the erase strokes together, because the border
is a dilation of whatever is actually left. The first version read only the background key,
and the mask and erase were applied later, downstream — so erased pixels were gone from the
picture but still present in the shape the border was traced from. Erasing into a subject left
the border sitting where the subject used to be, and a layer cut out purely by lasso got no
border at all, despite the panel offering that as a way to enable sticker mode.

The cutout is now baked in asset space before the dilation, and `withMask` skips the layer
afterwards — re-applying the mask downstream would shave off the very border that
deliberately extends beyond the artwork. Measured on a keyed fixture, erasing a band through
the subject: border pixels inside the gap **0 → 962**, and the total border **shrinks
3768→2588 with the bug, grows 3768→4794 with the fix**, because cutting a subject in two adds
outline rather than removing it. A lasso-only cutout goes **0 → 6976**.

`STICKER_PRESETS` carries the current published platform sizes (Telegram 512, Discord emoji
128, Slack 128, WhatsApp 512). A size that is merely close gets rejected on upload. They are
defined but **not yet wired into Export** — the panel says so rather than implying otherwise.

## Motion trails

Echoes are resolved from the *unresolved* layer at earlier times, so they follow the real
keyframed motion — a track, a hand-animated move or a playing clip — without any extra setup.
They are painted oldest first so newer ones sit on top, and drawn through `paintLayer` rather
than the main loop so a trail can never spawn its own.

Before the start of the timeline nothing has happened yet, so the trail builds up rather than
wrapping round to the end.

On an image with the background removed it trails the cutout; without one it trails the whole
frame, rectangle and all. The UI says so rather than silently producing a mess.

## Cinemagraph

Two ordinary draws: the whole layer painted at one frozen instant, then the lasso-masked
region alone repainted live on top. Both the mask machinery and the frame sampling already
existed. Measured on the green-screen fixture, the masked half changes by 29.25 mean levels
between two times and the frozen half by **0.000**.

It refuses to turn on without a mask, rather than silently freezing everything.

## Loop repair

A remap, not a re-encode — switching it off restores the original clip exactly.

- **Ping-pong** plays forward then backward, excluding both endpoints so the turnarounds do
  not stutter on a doubled frame. The index sequence for a 6-frame clip is exactly
  `[0,1,2,3,4,5,4,3,2,1]`.
- **Crossfade** dissolves the tail into the head. The reported duration *shrinks* by the
  crossfade length, because those tail frames are consumed by the blend — that is the part
  people get wrong.
- **Trim** drops the last few frames when an earlier one already matches the start, which
  keeps every remaining frame pixel-exact instead of dissolving anything.

### The seam metric had to be rewritten

The first version scored the seam as the mean absolute difference between the last frame and
the first. That reads plausibly and is quietly useless: a mean is dominated by *how much of
the frame* moves, so a small subject travelling against a static background produces a tiny
absolute seam even when the jump is glaring. A disc crossing an entire frame measured **1.8%**
and was reported as "this already loops".

The fix is to judge the seam against the clip's **own** typical frame-to-frame change. The
question is not "how different are these two frames" but "is the wrap a bigger jump than an
ordinary frame step". The same fixtures now measure ~1.1x for a clip that loops and 3.3x for
one that does not, and the message says so: *"the wrap jumps 3.3x further than an ordinary
frame step"*. The crossfade length follows the overshoot rather than the raw error.

## Retro looks

Palette quantisation with real dithering, exposed as a layer effect. Applied last in the draw,
so it also colours a cutout and its sticker border.

Nearest-colour uses a per-palette `Int16Array(32768)` memo keyed on 5-bit-per-channel RGB,
filled lazily and kept warm across frames. Error diffusion is serpentine Floyd–Steinberg, and
`dither1bit` diffuses against the actual luma of the ink/paper pair — which is what makes
brightness preservation hold for tinted pairs, not just black and white.

Measured on a 640x480 frame: 1-bit 3.4ms, Game Boy 2.9ms, VHS 4.8ms, halftone 11.0ms, C64
2.6ms, NES 2.6ms. Halftone is the only one needing a full frame copy (the screens sample the
original while overwriting it), which is why it costs ~3x the others.

Two honest notes. Mean brightness after 1-bit dithering drifts **0.298/255** against the input,
where a plain threshold on the same ramp drifts 2.005 — that gap is the proof the diffusion
works. And VHS does *not* leave luma untouched at default settings: scanline darkening moves
mean |ΔY| to 11.3 by design. With scanlines off it is 0.114, which is just YCbCr round-trip
rounding. The test measures it both ways rather than picking the flattering one.

## Follow the cursor

For screen recordings. The pointer is found by frame differencing — a screen recording is
mostly static, so *motion* is the honest signal — rejecting blobs too large to be a cursor and
bailing entirely when more than a quarter of the frame changed, since that is a scroll or a
cut rather than a pointer.

The path is then smoothed with a critically-damped spring and a **dead zone**: the camera does
not move at all while the pointer stays within ~26px of where it already is. The dead zone
matters more than the smoothing for how it feels — following every small movement is nauseating
even when the following is perfectly smooth.

Zoom has two styles, and **Stay in** is the default because it is what a screen recording
usually wants: the camera opens already zoomed and stays there, pulling out only to cross the
screen, because you cannot follow a whip pan at 2× and have it be watchable. **In on dwell**
is the cautious opposite — out by default, pushing in only where the pointer settles.

Coming back in needs a clearly slower pointer than going out did (520 px/s against 900). One
threshold on its own leaves the camera pumping whenever the pointer drifts across it. Measured
on the fixture: **Stay in** gives 2.00× at the start, 2.00× through a drift and 1.14× across a
flick; **In on dwell** gives 1.00 / 1.36 / 1.06 on the same path.

Whichever style, the output is ordinary keyframes — box-select the ones you do not want and
delete them. Keys are thinned Douglas–Peucker style at
0.01 zoom units and ~0.004 of the frame: the fixture emits 25 zoom keys for 84 frames, and
replaying the thinned track reproduces the dense one to 0.009 zoom units.

Detection runs on a copy downscaled to 960px wide. It is frame differencing, so the signal
survives the resize intact and it costs roughly a tenth as much.

**Where it is weak, honestly.** It cannot see a pointer that is not moving — frame differencing
has literally no signal — so it holds the last position with decaying confidence rather than
reporting null. Its centroid bias assumes a light pointer on a darker background, so a light
theme costs it accuracy. And a distractor that both looks like a pointer blob and appears near
the last known position can still beat the speed and similarity gating. When it finds a cursor
in fewer than 15% of frames it changes nothing and says why, rather than inventing a camera
move.

## Batch apply

The document is a recipe. One image layer is nominated as the slot; for each input file that
layer's asset is swapped and everything else — overlays, text, effects, the cutout settings,
the palette — stays exactly as it is. `docForAsset` returns a plain document with no store
involvement, so a batch never disturbs what is open and a failure part-way through leaves the
editor untouched.

Three fit modes. `cover` and `contain` keep the canvas size, so every overlay stays where it
was placed — that is what makes a batch look consistent. `native` resizes the canvas per image
and scales the overlays by the same factor, for inputs that vary in size. Neither distorts the
image: the test asserts the aspect ratio is preserved to within 0.01.

One bad file is reported by name and does not abandon the other twenty-nine.

On the desktop the outputs are written straight into a chosen folder. In the browser there is
no folder to write to, so they are collected into a single zip — and `saveBlob` has an explicit
`silent` mode for exactly this, because without it a thirty-file batch would fire thirty
downloads.

## MP4 export

Runs a local ffmpeg, so it is desktop-only — the browser build says so and points at
WebM, which it can record itself.

Frames are pushed into ffmpeg's **stdin** one PNG at a time rather than staged on disk. A
90s 1080p export is a few thousand frames: as PNGs that is several gigabytes of
intermediate for a file that ends up a few dozen megabytes, and as raw RGBA over IPC it is
8MB per frame. Every write is awaited and the main process honours `stdin`'s backpressure,
so a fast renderer paces itself to the encoder instead of memory climbing until something
gives.

Three details that are easy to get wrong:

- **It is constant frame rate.** MP4 players expect CFR and the per-frame delays a GIF
  carries have no clean equivalent, so the document is sampled at a fixed interval. GIF is
  still the export that preserves original timing, and the dialog says which is which
  rather than implying the source timing survived untouched.
- **`yuv420p` requires even dimensions.** A 33% scale of 320×200 is 105.6×66, which is odd
  once rounded and which ffmpeg simply refuses. `scale=trunc(iw/2)*2:trunc(ih/2)*2` handles
  it; the test exports at 33% and asserts both dimensions came out even.
- **H.264 has no alpha**, so a transparent document is flattened onto the matte rather than
  exported with black where the alpha was.

### Audio

If the document contains a video layer, its original soundtrack can be muxed back in — the
imported bytes are still held, so they are parked in a temp file and passed as a second
input. `-map 1:a:0?` makes the stream optional, so a silent source is not an error.

A layer that has been **retimed** (speed, time offset) or loop-repaired is offered with the
reason it cannot be used: the picture moved and the sound did not, so the original track
would drift. It is not silently dropped and not silently misaligned.

The test builds its own fixture with ffmpeg — a 440Hz tone over a colour-cycling clip —
then exports with and without audio and probes both files: `aac` present in one, absent in
the other, same duration either way.

## The Video tab

The bottom bar has tabs now: **Keyframes** and **Video**. The video tab is a filmstrip per
animated layer.

Thumbnails are 44px tall, a few kilobytes each, and that matters more than it sounds. The
video decoder keeps a *pixel-budgeted* LRU of full frames for playback; pulling twenty
spread-out full frames out of a 90s clip would evict everything the playhead needs. Each
thumbnail is downscaled the moment it arrives and kept in its own cache, which never
expires because it costs so little to hold.

Everything lands on a single `<canvas>` per row rather than N `<img>` elements — a strip is
redrawn on every resize, and swapping fifty DOM nodes each time a panel moves is far more
work than one `drawImage` loop.

They arrive in two passes. Anything already cached is painted immediately, so a strip that
has been seen before appears whole; then the gaps fill in one at a time. Video decoding is
deliberately **not** started while the clip is playing — the decoder's frame budget belongs
to the playhead, and a strip that fills in a moment later costs nothing. A GIF's frames are
already decoded, so that restriction does not apply to them.

Slots are spaced by how many thumbnails fit across the lane, not by the clip's frame count:
a 2000-frame video and a 12-frame GIF both want about one thumbnail per thumbnail-width of
screen. Each is sampled at the *centre* of its slot, so it represents the span it is drawn
over rather than its leading edge. The strip is in document time, so retiming a layer
redraws it against the new timing — the test offsets a layer by 400ms and asserts 9 of 10
slots changed.

The checker pattern behind the canvas is deliberate: a gap reads as "not decoded yet"
rather than as a black frame in the footage.


## Media

Imports land in a bin, not on the canvas. Dropping ten photos used to make ten layers
stacked on top of each other where only the largest was visible — which is the problem the
bin exists to solve.

The rule, in full: **everything imported goes to Media**, always. Nothing reaches the
canvas until you pick it and press **Add to canvas**, or double-click it. Several placed at
once are stepped rather than stacked, so they are all reachable.

There was briefly an exception — the very first item into an empty document went straight to
the canvas, to keep the "drop something to start" flow. It is gone. An exception is one more
rule to remember, and "everything goes to Media" is easier to trust than "everything except
sometimes". The browser suites carry a shared `importAndPlace` helper for the same reason:
the rule is stated once rather than re-spelled in every file.

The bin lives on the document (`doc.media`), not beside it, so it saves, loads and undoes
with everything else. Two consequences worth stating:

- `usedAssets()` counts a bin entry as a reference. Something imported but never placed is
  still your material, and dropping it on save would quietly lose work you can see on
  screen.
- Reopening a project re-imports assets with **fresh ids**, so the bin is remapped the same
  way the layers are. Skipping that would leave it pointing at ids from whichever session
  wrote the file.

Removing from the bin is not a way to break the canvas: layers already using an item keep
working and keep it in the saved project, and the notice says how many still do. The reverse
holds too — **deleting a layer never touches the bin.** Throwing away something you made is
not the same as throwing away the material you made it from, and the bin is the only place
media leaves a project.

That last rule took three fixes, because three separate places treated "has layers" as
"has work":

- `readSnapshot` refused to return a project with no layers, which is exactly the state you
  are in immediately after importing.
- The autosave in `App.jsx` skipped writing at all when the canvas was empty — so a bin full
  of imports was never persisted, and deleting the last layer left the newest state
  unrecorded, meaning a reload came back to an *older* snapshot.
- `restoreSnapshot` remapped layer asset ids but not the bin, so what did come back pointed
  at ids from the session that saved it.

The remapping is now a single `remapAssets` shared by project files and autosave, since
having two copies is what let them drift.

`normalizeDoc` also folds every layer's asset into the bin on load, so a project saved
before the bin existed opens with its media visible rather than an empty shelf.

The editor is **hidden, not unmounted**, while the bin is open — the canvas keeps its size,
zoom and decoded frames, so switching back is instant. That needs `.workspace[hidden] {
display: none }` explicitly: `display: flex` overrides the browser's own `[hidden]` rule,
and without it the two views stack. The test asserts the hidden editor really is 0px tall.

## Collage

Pick media, press **Collage**, and it arranges everything into a grid of tilted photo
mounts. The layout maths lives in [`collage.js`](src/engine/collage.js) with no DOM in
sight, so it is checked as geometry rather than by eye — 74 assertions covering crops,
tilts, grids, overlap, coverage, mixed mounts, the centre piece and edge cases.

Every card comes out as an **ordinary image layer**. Nudge one, straighten it, recrop it,
delete it — the rest stay where they are. A collage of thirty photos is thirty layers in a
group, not a picture of a collage.

Details that make it look right rather than merely correct:

- **The mount is drawn by the renderer, not stacked underneath.** A `frame` on an image
  layer paints the card and insets the photo, so it inherits the rotation, scale, opacity
  and shadow for free. As separate shape layers it would be sixty layers to keep in step.
- **A Polaroid is not an even border.** The bottom is ~3× the other sides, which is the
  whole reason it reads as a Polaroid rather than a picture frame. The card is therefore
  never the photo's shape, and the grid has to be planned on the card — the test asserts the
  card aspect comes out below 1 for a square photo.
- **Photos are cropped to fill their mount, never squashed.** The crop is the existing
  non-destructive source window, so any card can be reframed afterwards. The test measures
  the visible source aspect against the drawn photo aspect and asserts zero stretched.
- **Tilt comes from a seed, not from chance.** `Math.random` would re-roll every angle on
  each render, undo and reload. It is hashed from the photo's index and the collage seed
  instead; **Re-tilt** picks a new seed.
- **Cards overlap by default.** Spacing runs from a gap, through flush, to overlap
  (`gap` below zero draws the card larger than its cell). Overlapping lifts canvas coverage
  from 68% to 87% on the test fixture — far less backdrop showing, which is what makes it
  read as a pile of photographs rather than a contact sheet.
- **Sizes vary and the pile is shuffled.** A few percent of size variation is most of what
  separates a pile from a tiling. And with overlap, layer order *is* stacking order, so the
  cards are dealt in a seeded shuffle — strict index order shingles the whole thing down and
  to the right in one visible direction.
- **The margin is solved, not guessed.** Overlap, size variation and tilt all push the outer
  cards past their cell, and the margin has to cover all three. The cell size depends on the
  margin and vice versa, so substituting one into the other gives `cellW = canvasW /
  (columns + 2·need)` directly. The test rotates all four corners of all thirty cards at
  three extreme settings and asserts nothing crosses the boundary. A *negative* margin is
  honoured as asked — letting the outer cards bleed off the edge is a look, not a mistake.
- **A centre piece.** One card is printed large and moved to the top of the pile, rather
  than being given a cell of its own — the collage already overlaps, so a big card lying
  over its neighbours is the look, and carving a hole out of the grid would make everything
  else reflow whenever the hero changed. `auto` picks an *interior* cell nearest the middle;
  an edge cell would have to be clamped back in and stop looking centred. Its scale is capped
  so it fits: a rotated w×h card spans `w·cos + h·sin`, which gives the largest scale that
  still fits the canvas directly. Without that cap, 3.5× on a small grid produced a card
  bigger than the canvas — and once it is bigger, clamping its centre cannot help.
- **Mixed portrait and landscape mounts.** Each photo's mount snaps to the nearest of 3:4,
  1:1 and 4:3 rather than keeping its exact source ratio, which is what makes a mixed wall
  read as a set of prints instead of an accident — and stops one panorama becoming a card
  five cells wide. Cards of differing shapes are matched by **area**, not fitted inside their
  cell: fitting leaves a portrait card narrower than its cell with a band of backdrop down
  each side, which is the opposite of what the overlap is for.
- **Column count is solved, not searched blindly.** For N cards of aspect `a` on a W×H
  canvas the balanced count is `sqrt(N·W / (H·a))`, then scored against how many cells the
  last row would waste — a grid that fits perfectly but leaves half a row empty usually
  looks worse than a slightly off one that is full. A short last row is centred.


## Trimming to the subject

Removing a background leaves a full-frame layer that is mostly transparent, so the handles,
snapping and rotation pivot are all nowhere near the thing you can see. **Trim the layer to
the subject** shrinks the box to what the matte actually keeps — the same tight layer a
lasso cut-out produces.

It goes through the existing non-destructive source window rather than baking anything, so
one undo brings the whole frame back. Two details:

- **The subject must not move.** The new window's position inside the old one is carried
  across as the same fractions of the destination rect, and because rotation pivots on the
  layer's centre, moving the box moves the pivot — so the new centre is carried around the
  old one by the same angle. The test renders the document before and after and asserts the
  images are identical: **0 of 64000 pixels differ.**
- **On a clip the box is the union across sampled frames.** A subject that walks across the
  shot must not walk out of its own layer. Twelve samples, not every frame: a 2000-frame
  video does not need exhaustive measurement to find the box its subject stays inside.

## AI select

In the lasso tool, turn on **AI select** and click the subject. The segmentation model's
mask is traced into an **ordinary editable lasso** — drag the points, add and remove them,
then Copy, Cut, Mask, Erase or Pixelate exactly as with a hand-drawn one. Measured on the
room fixture: 63 points in 56ms, with the model already loaded.

Being plain about the limit: **this is not click-anything segmentation.** The model decides
what counts as foreground; the click only chooses *which piece* of that foreground to take.
Clicking a lamp in the background will not select the lamp — and the app says so rather than
selecting something arbitrary.

The tracing ([`trace.js`](src/engine/trace.js)) is pure and DOM-free, with 51 assertions:

- **Marching squares on the pixel-corner lattice, not Moore-neighbour tracing.** Moore
  walks pixel *centres*, losing half a pixel all the way round — a 2% area shortfall on a
  100px square, worse on small regions, and a single-pixel region degenerates to a dot.
  Corner tracing encloses whole pixels, so the shoelace area equals the pixel count
  *exactly* (10000/10000, 5025/5025, 4255/4255).
- **Douglas–Peucker on a closed ring**, cut at two anchors rather than treated as an open
  path — running open-path DP on a ring measures vertices against a chord that is not an
  edge, and a whole far-side arc can collapse into it.
- **Smoothing is area-compensated.** A bare 4-point square at full strength otherwise loses
  75% of its area, because every vertex pulls toward the centroid. A lasso creeping inside
  the subject is worse than a jagged one.
- **Holes are filled before tracing**, because a segmentation mask of a person routinely has
  a gap between arm and torso and a contour that dives into it makes no sense as a selection.
  The background flood is 8-connected — the dual of the 4-connected foreground — or a
  diagonal pixel chain is both a wall and not a wall.
- **Over-budget polygons are re-simplified, not truncated.** The ring closes implicitly, so
  slicing the tail off would draw a chord straight across the subject.

Known weaknesses, since they are real: holes are filled rather than represented (a lasso has
no even-odd sub-paths, so a genuinely donut-shaped subject comes back solid); the mask is
hard-thresholded, so the soft alpha the model produces for hair collapses to a binary edge
and AI select reads harder than the matte cutout does; and there is no morphological open
before tracing, so a genuinely speckled mask gives a ragged contour that simplification only
partly tames.


## Small things that were wrong

Three fixes worth recording, because each was a case of the app knowing something it
was not showing:

- **A cut-out looked exactly like the layer it came from.** Text-behind produces two copies
  of one photo with the same name, one masked; in the list they were identical rows. A
  masked layer now gets its own thumbnail — a bust on a checker ground, the checkers saying
  "transparent" and the silhouette saying "subject only" — and a `CUT` badge. It follows
  the layer's state rather than being decided at creation, so toggling the matte toggles the
  icon.
- **Deleting every layer left the canvas at the size of media that was gone**, so an empty
  document showed a portrait rectangle floating in the middle of the screen with nothing in
  it and no way to tell why. An emptied document now returns to the default canvas and
  refits — and, like the wheel, dragging does nothing on an empty one, since panning a blank
  checkerboard only strands it off-screen.
- **Free space is now the import target.** The empty bin and the empty canvas are both
  clickable, with a cue that brightens on hover. With items in the bin, blank space does
  double duty: with a selection live, "deselect" is the obvious meaning of a click on
  nothing, so the first click clears and the second opens the picker. On the canvas the hero
  only takes clicks under the move tool — with a drawing tool selected the canvas has to stay
  reachable, because adding text or a shape to an empty document is a real thing to want.

## Text

**Fonts** are a real list now — there was no picker at all before, so `font` was set and
never changed. Everything offered is a family the platform ships: this app runs offline and
draws through a canvas, and a web font would mean a network round trip that can fail and a
render that silently falls back. Availability is *measured*, not assumed — `document.fonts.
check` reports optimistically for local families, so each candidate is drawn against three
different fallbacks and judged by whether the width moves. A font that is not installed
never appears in the menu.

**The box fits the text.** A text layer auto-sizes by default: type more and it grows, delete
and it shrinks, change the size or the font and it re-measures. It grows from its anchor —
a left-aligned box keeps its left edge, a centred one keeps its centre — so it does not
crawl away from where you put it. Height always follows the line count, wrapped or not, so
a box can never clip its own text. Dragging a resize handle switches the layer to a fixed
width, at which point the width becomes a wrap width instead; that is the moment you have
said you want that width kept.

**The menu is a specimen sheet.** Each family is set in itself, and the closed control takes
the selected family too — reading the word "Consolas" in the UI font tells you nothing about
what you are choosing. Native `<option>` styling does this without a custom dropdown, so the
menu stays a real select with keyboard behaviour intact.

**Double-click to edit in place.** A real caret inside a canvas would mean reimplementing
selection, IME and accessibility from scratch, so a transparent textarea is placed over the
layer instead, matched to its font, size, colour, alignment and rotation. It reads as editing
in place because it *is* in the same place — what you see while typing is the layer with a
caret in it, not a box floating over the artwork.

The canvas **stops drawing that layer** while it is being edited. Both drawing it meant seeing
the text twice, a pixel or two apart, which looks exactly like a duplicate layer and was
reported as one. Only the preview is affected; an export renders the document as it really is.
Measured: 192 bright pixels in the text's band while editing (selection chrome) against 49113
once the editor closes.

## Outline through the subject

The poster effect: solid letters where nothing covers them, and just their outline where the
cut-out subject passes in front.

It is one text layer, not two. `outlineAbove` makes `renderDocument` do a **second pass**,
stroking the same letters with no fill. Over the solid text the stroke is the same colour and
disappears; over whatever is covering the text, the stroke is all that survives. Two copies of
the text would have worked too and would have needed keeping in step every time you retyped
it.

**The outline follows the letter's silhouette, not its glyph paths.** `strokeText` strokes
every contour a glyph is built from, and many faces build a letter out of overlapping pieces
— an A as two diagonals and a crossbar. Stroking that draws the seams where the pieces meet,
and the A comes out looking like three outlined bars rather than one outlined A.

Filling has no such problem: overlapping contours merge. So the letters are filled into a
scratch surface, that silhouette is dilated by stamping it around a circle, and the original
is punched back out. What is left is a single clean ring around the merged shape, whatever
the font is made of. The outline sits just *outside* the letter, so a letter that switches to
outline keeps the width it had rather than shrinking inside its own stroke.

**Where the change happens is a choice.** By default the outline follows the covering edge
exactly, so a letter it crosses comes out part solid and part outline — the classic look.
**Switch whole letters** does the other thing: coverage is judged per glyph, so a letter is
either wholly solid or wholly outlined and the change happens at the gap between letters. The
covering layers are rendered once, each glyph's box is sampled on a 6×6 grid, and a letter
more than a third hidden is left out of the fill pass and drawn as a complete outline in the
second. Glyph positions come from measuring progressive substrings, so kerning survives.

**It names the layer it draws above**, and the dropdown lists **every** layer, not only the
ones stacked above the text. Naming one that sits *below* it would otherwise do nothing —
there would be nothing in front to show through — so instead the text's fill is pulled down
and drawn just before that layer. Being covered is the point of the setting, and demanding
the layers be reordered first would make it a lie for half the list. `'all'` still means
everything, and the older `true` still means `'all'`, so a project saved before the dropdown
existed does not quietly lose its outline.

Worth being plain about, because it is not obvious: on ordinary text with nothing in front of
it, this does **nothing at all**, and that is correct — there is nothing covering the letters
for the outline to show through. The panel says so.

Turned on by default when text-behind builds the sandwich, since it is the reason to reach for
it. The one visible side effect is that stroking the solid letters makes them marginally
bolder — same colour, a rim's worth of pixels — which the test measures rather than glosses
over.

## Masking shrink-wraps

Cutting one person out of a photo used to leave a layer that still measured the whole photo,
which puts the handles, the rotation pivot and the snapping nowhere near the thing you can
see. **Mask** now trims the box to what is left — so AI select gives you a layer the size of
the object it selected.

`trimToSubject` learned about lasso masks, not just mattes, and one detail matters: mask
points are fractions of the **layer box**, so shrinking the box without rebasing them slides
the mask across the picture. Both boxes share a rotation, so the conversion is done in the
unrotated frame where it is just a change of origin and scale. The test masks, photographs,
trims, photographs again and asserts **0 of 64000 pixels differ** — the trim moves nothing,
it only changes what the box measures.

Erase keeps its box, because what remains is everything *except* the outline and is still the
size of the original.

**Text-behind is the exception, and has to be.** The sandwich needs the whole photograph
underneath, so masking from the Text behind button skips the trim and the *cut-out copy* is
shrink-wrapped afterwards instead. Trimming both would crop the photograph down to the person
standing in it — which is what it did until it was reported.

**The eraser refits when a stroke ends**, not while it is being painted: a box jumping under
the brush mid-drag is unusable, and the brush is a fraction of the box width so it would
change size as you went. Erasing into an edge shrinks the box to what is left; a hole in the
middle touches no edge and changes nothing. The visible extent is *measured by rendering the
layer*, because a matte, a mask and erase strokes only combine in the compositor. Mask points
and erase strokes are both fractions of the box, so both are rebased onto the new one, and
each stroke's stored size is rescaled so it still covers the same pixels. The test asserts
0 of 76800 pixels move.

## The eraser

Paint away part of a layer — mostly for cleaning up what a background removal got wrong,
which no automatic matte gets perfect. Press **E**, drag on the selected layer, hold
**Alt** to paint it back.

Strokes are kept as **points, not pixels**. Everything else here is non-destructive and
resolution-independent, and a baked eraser would be the one thing you could not undo
cleanly, could not scale with the layer, and that would put a full-size alpha channel in
every save. Points are normalised against the layer box — the same convention the lasso
mask uses — so a stroke follows its layer when it is moved, resized or rotated. The test
moves and doubles the layer and asserts the hole goes with it.

Three details:

- **One drag is one undo.** History is pushed when a stroke starts, not per point. An
  eraser that took fifty undos to reverse would be unusable.
- **Points closer together than a fraction of the brush are dropped as you paint** — a slow
  drag would otherwise store hundreds of them a pixel apart. Measured: 41 sub-threshold
  moves store 4 points.
- **There is a ring at the cursor.** The brush is a fraction of the *layer* width, so the
  same setting is a different number of pixels on every layer and there is no way to know
  what is about to go. The ring is sized against whichever layer the stroke would land on,
  drawn dark-under-light so it reads on any image, and turns green in restore mode. With no
  layer under the cursor it goes hollow and dim rather than vanishing — a cursor that
  disappears is worse than one that says "not here".
- **Restore is a second pass, not a negative stroke.** "Put back what an earlier stroke
  removed" cannot be expressed in one pass over a single alpha channel, so the layer is
  drawn again into a second surface and stencilled down to the restore strokes.

Erasing wraps the mask rather than the other way round: the mask decides the shape, the
eraser then takes bites out of what is left. That needed its own scratch surfaces — a
feathered mask inside an erased layer would otherwise have drawn into the very canvas being
composited from.

## Two ways to put text behind

The original route was: remove background, then a button in the inspector. That was too
narrow — reaching for the lasso and expecting to put something behind what you just
outlined is the more natural order, and **AI select** already produces exactly the mask it
needs.

So it now accepts either kind of cut-out, and the outline bar has a **Text behind** button:
lasso the subject (or AI-select it in one click), press it, done. The lower copy shows the
whole photo, the upper copy keeps whichever isolation is in play, and the text goes between.

## Two interaction bugs

- **Reordering a layer raised the import veil and left it there.** Dragging a row is an
  HTML5 drag too, and the handler engaged on any drag at all — then never cleared, because
  `dragleave` only fired with a null `relatedTarget`, which an in-app drag never produces.
  It now checks the drag actually carries files, and clears on `dragend` regardless.
- **Clicking your own selection handed you whatever overlapped it.** The move tool always
  took the topmost layer under the pointer, so a layer above the one you were working on
  would steal the drag. A click inside the current selection now keeps it; stacking order
  is decided in the layers panel, not by accident mid-drag. Shift-click still reaches
  through.

The second of those exposed a bad test of my own: a synthetic `PointerEvent` has no active
pointer, so `setPointerCapture` throws and aborts the handler before it selects anything —
the first version of the check passed without exercising the code at all. It drives real
mouse input now.

## Export names

The export dialog opens with a **File name** field, seeded from the project name, with the
extension shown inside the field so it is obviously not editable — it follows the format
you pick. The button says what it is about to write (`Export beach-trip.gif`), so the name
is in front of you at the moment you commit rather than discovered afterwards.

Before this, every image and video export was written as `pixelforge.gif` regardless of the
project, and a project nobody had renamed went out as `Untitled` with no opportunity to fix
it. Three details:

- **A still-unnamed export says so**, in the dialog, before it is written.
- **Illegal characters are replaced, not dropped.** `\ / : * ? " < > |` and control
  characters become dashes — a name that silently loses letters is harder to recognise
  afterwards than one with dashes in it.
- **"Rename the project to match" is on by default**, because the real problem is not one
  badly named file, it is that the *next* export would be Untitled too.

## Window chrome

The desktop build draws its own title bar. On Windows and Linux the frame is dropped
entirely (`frame: false`) and the top bar supplies minimise / maximise / close; on macOS the
traffic lights are kept and inset, because replacing them looks wrong and breaks muscle
memory.

Two things that bite here:

- The whole bar is `-webkit-app-region: drag`, so **everything interactive has to opt back
  out** with `no-drag` — buttons, the project name field, the workspace tabs. Without that
  they move the window instead of responding.
- The maximise glyph is driven by window **events**, not by the click that caused it. The
  state changes without the app asking: a double-click on the drag region, Win+Up, or a
  window manager. The test maximises from the main process and asserts the button flips to
  Restore.
- **The unsaved-changes guard cannot live in the renderer.** A `beforeunload` handler raises
  the "leave site?" prompt in a browser; in Electron it cancels the window close and shows
  *nothing at all*, so the X button silently stopped working the moment anything was edited.
  The renderer now mirrors its dirty flag to the main process, which owns the `close` event
  and raises a real dialog. The test dispatches a `beforeunload` and asserts nothing cancels
  it, which is the regression itself rather than a proxy for it.

Electron test runs get their own profile via `PF_USER_DATA`. Two instances sharing the
default `userData` fight over the IndexedDB lock, and the symptom is an `indexedDB.open()`
that never fires success *or* error — which is exactly what happened the first time these
tests ran while the app was open.


## GIF handling

GIFs are decoded in-house (`src/engine/gif.js`) — a dependency-free GIF87a/89a decoder with
LZW, interlacing, transparency and all four disposal methods, producing fully composited RGBA
frames. That means frame-accurate scrubbing and export in every browser, rather than relying
on `ImageDecoder` (which is used as a fallback for animated WebP/APNG where available).

Export writes GIFs through `gifenc` in a Web Worker, streaming one frame at a time so memory
stays bounded. Frame delays come from the union of every animated layer's real frame
boundaries plus any keyframe times, with sub-20ms gaps merged so total duration matches the
source exactly. PNG (current frame) and WebM (real-time capture) are also available.

## Everything else

Layers with drag-to-reorder, rename, lock, hide, blend modes and opacity · per-image
adjustments (brightness, contrast, saturation, hue, blur, grayscale, sepia, invert) with
presets · text layers with wrapping, outline and alignment ·
vector shape layers · transform handles with rotation, `Shift` to constrain, `Alt` to resize
from center · undo/redo · drag-and-drop or paste to import · copy/cut/paste layers · a
right-click menu on the layers panel (duplicate, clipboard, restack, hide, lock, rename,
delete).

### Keys

| | |
|---|---|
| `V` `C` `P` `L` `S` `T` `H` | move, crop, pixel overlay, lasso, shape, text, pan |
| `Space` | play / pause (hold + drag to pan) |
| `Ctrl+S` / `Ctrl+O` | save project / open project |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | copy / cut / paste layers |
| `Ctrl+G` / `Ctrl+Shift+G` | group / ungroup layers |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `Ctrl+D` / `Delete` | duplicate / delete layer |
| `[` `]` | move layer down / up the stack |
| arrows | nudge (`Shift` for 10px) |
| wheel / `Ctrl`+wheel | zoom about the cursor |

## Layout

```
src/engine/     gif.js        GIF decoder
                video.js      MP4 demux, on-demand WebCodecs decode
                assets.js     decoded-bitmap registry (kept out of undo history)
                shapes.js     shape paths, rotated bounds, hit testing
                effects.js    region effects + masking/feathering
                keyframes.js  interpolation, key CRUD
                render.js     compositor, frame lookup, export frame timing
                exporters.js  PNG / GIF / WebM
                gifWorker.js  streaming GIF encoder
                project.js    .pfz pack / unpack
                autosave.js   IndexedDB saved projects + crash recovery
                groups.js     group tree, folded visibility and opacity
                tracker.js    NCC motion tracking, keyframe thinning
                matte.js      colour-key background removal
src/state/      store.js      zustand document + history
                snap.js       alignment snapping and guides
src/components/ CanvasStage, Timeline, LayersPanel, Inspector, ToolRail, TopBar,
                ExportDialog, OpenDialog, LassoBar, LayerContextMenu
```

## Tests

Browser smoke tests drive the real UI in Chrome via Playwright and assert on actual rendered
pixels — that a pixelate block is flat, that its neighbour differs, that the region changes
across GIF frames, and that a keyframed overlay physically travels across the exported GIF.
The project suite saves a `.pfz`, reloads into a clean session, reopens it and asserts the
document renders **pixel-identically** at every sampled time.

Twenty-nine browser suites (**667 checks**), three Electron suites (**77 checks** — the shell
itself and MP4 export, which can only run where ffmpeg exists), and five DOM-free unit
suites under plain node — `test-retro.mjs`, `test-loop.mjs`, `test-cursor.mjs`,
`test-collage.mjs`, `test-trace.mjs` — for the parts that are pure maths and deserve testing
without a browser at all. **1028 checks** in total.

```bash
npm run dev        # in one terminal
npm test           # in another
npm run test:units # no browser needed
npm run test:desktop  # builds, then boots the Electron shell
```

`npm run make:testgif` regenerates every fixture in `public/test/`:

| fixture | what it is for |
| --- | --- |
| `motion.gif` / `motion.mp4` | a disc on a known path — tracking, keyframes, scrubbing |
| `hd.mp4` | 1080p, one keyframe — the WebCodecs frame-pool regression |
| `greenscreen.gif` | noisy green field with a same-colour patch *inside* the subject |
| `room.png` | a busy multi-coloured background, where a colour key should fail |
| `badloop.gif` | a disc walking left to right, so the seam is a real jump |
| `screencast.gif` | a fake screen recording: dwell, fast flick, dwell, plus a blinking caret |
| `withaudio.mp4` | H.264 plus a 440Hz AAC tone, for the audio-muxing path |
| `photos/*.png` | a dozen photos in mixed aspect ratios — tall, wide and square — so the collage's crop-to-fill has something to get wrong |

Fixtures are built to have traps in them. `greenscreen.gif` hides a patch of the exact
background colour inside the subject, so a global key drops it and a connectivity-aware one
keeps it. `screencast.gif` includes a blinking caret, which is the classic false positive for
motion-based cursor detection.
