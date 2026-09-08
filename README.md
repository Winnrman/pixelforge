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

### Opening a project from the file manager

Double-clicking a `.pfz` used to launch PixelForge and leave it empty. The shell passes the
path as a command-line argument and nothing was reading it, so the window opened on a blank
document while the project sat unopened on disk.

The path is found in `process.argv` at launch, in the `second-instance` event when the app is
already running, and from `open-file` on macOS, which does not use argv for this at all. A
single-instance lock means double-clicking a second project hands it to the window already
open rather than starting a second copy of the app.

It is held until the renderer says it can take it. A path found at launch arrives long before
there is a window to send it to, and a message posted into a window that is still loading is
simply lost — so the renderer asks, and the main process answers with whatever it is holding.
Opening it from there is the same code path as **Open Existing**, so a project opened this way
is in no way a special case once it is loaded.

The installer registers the association itself now (`fileAssociations` in the build config),
so this works on a fresh install rather than only where the association was set by hand.

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
modifier: the row the pointer is over is the row you meant. A drag can promote a clip by at
most **one** track, and the ceiling is fixed when the drag starts — without that, moving onto
the empty row creates that track, which puts a new empty row above it, under the pointer,
which creates another. One upward drag could make tracks for ever.

### Snapping

Butting one clip against another by eye is a pixel hunt, and being a frame out shows as a
flash of whatever is behind. So a drag looks for edges to line up with — every other clip's
start and end, on any track, plus the start of the project and the playhead — and draws a
**red line** at the one it caught.

Both ends of the dragged clip are candidates and the nearest wins, so a clip can be dropped
against the end of the one before it or the start of the one after without the gesture having
to say which was meant. The tolerance is a fixed number of *pixels* converted to time, so it
feels the same whether the project is four seconds or four minutes long. The line only
appears when something is actually in reach: a guide that is always on is not telling you
anything.

Red because it is the one mark on the timeline that means "exactly here" — everything else,
playhead included, is blue.

The guide spans the tracks and stops short of the drop row, for the same reason the playhead
does: a line across an empty drop target reads as something already in it.

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

## Scrolling scales the tracks

At 1x, a second of a ninety-second clip is four pixels, and no amount of care with a mouse
lands on the frame you want. Scroll over the tracks and they stretch; scroll back and they
shrink. There is no zoom control to find because the gesture is the control, and whatever was
under the pointer stays under it — zooming about the left edge slides the thing you were
looking at off the side.

The lanes are sized in pixels and the rows scroll together inside one scroller, so clip
positions stay percentages of their lane and follow without knowing anything about it. The drop
row lives inside that scroller too: a drop target that does not move with the tracks points at
the wrong time the moment they are zoomed.

The listener is attached by hand rather than as an `onWheel` prop, because React registers
wheel listeners as passive — `preventDefault` inside one does nothing and the panel scrolls
away underneath the zoom.

## Right-clicking a clip

The layer context menu already had duplicate, hide, lock, rename and delete; it just could not
be reached from the timeline. Now it can, from a clip or from its audio lane, and it grows the
things only a clip can do: cut at the playhead, join a multiple selection, and mute. Only on
clips — a menu listing things that do not apply is a menu you have to read.

Right-clicking something outside the selection acts on that thing; inside it, on the whole
selection, which is what makes "join these four" one gesture.

## Turning the sound down moved the picture

The transport bar scrubs wherever you press it, so that the space around the track works as
well as the track itself. The controls sitting *on* that bar are not the bar, and only the play
button was excluded — so dragging the volume slider was read as a scrub to wherever the pointer
happened to be along the window. The slider lives at the right-hand end, so turning the volume
down jumped the video to near the end of the timeline and stopped it. Measured: 1022ms to
4067ms, in one frame.

The mute button and the clock had the same problem. All three are controls now, and the bar
still scrubs everywhere else.

There was a second half to it, found by dragging the panel taller: the bar scrubbed on *any*
held-button move that passed over it, wherever the drag began. Dragging the split handle sweeps
the pointer straight across the transport, so making the viewer bigger moved the playhead. A
scrub now has to have *started* on the bar.

It is the kind of bug that reads as something deep — the renderer resetting, the audio graph
restarting — and is neither. The clue was that the playhead landed at 4067ms on a 4000ms
timeline: the playback clock wraps with `% duration` and cannot produce that, but a scrub to an
x-position past the end can.

## One room

The editor was a canvas with a timeline tucked underneath it and the media behind a tab. That
is an image editor with a video editor bolted on, and it shows the moment you try to cut
anything: editing is a loop of *look at the shot, drag it onto a track, look again*, and a
whole screen change sat in the middle of that loop.

It is now one room. The bin is beside the picture, the tracks run along the bottom under the
full width of the window rather than under the canvas column, and the inspector stays where it
was. The bin's poster used to be a thin white line. It is drawn at the canvas's measured width, and
the canvas measures zero while the editor is hidden — which is exactly when a card first
appears, because importing takes you to the Media tab. It drew a one-pixel-wide poster and,
having no reason to run again, kept it. It watches its own box now.

**The bin appears when there is something in it** — an empty bin is a place to grab from
with nothing to grab, and its Import button led to the Media tab anyway, which is a button
press to arrive where the other button already goes. Media drags straight from the bin onto a track, or double-clicks onto the canvas. The
Media tab stays, because browsing a hundred photographs and picking one to work on is a
different job that deserves the whole window — it is the image editor's front door now, not
the only way to reach your own footage.

The timeline moved out of the canvas column and became a child of the workspace grid, which is
why it now gets the width of the window. It only ever had the width left over because of where
it sat in the tree.

### A shift that had been hiding a stale test

Arming a tool that has options widens the rail from 52px to 210px, moving everything to its
right — the canvas included — by 158 pixels. `e2e.mjs` cached the canvas position before
arming a tool and clicked with those coordinates, which were therefore always stale. It passed
anyway: the stale point still landed *somewhere* on a canvas that ran to the window edge, so
it drew in the wrong place, and a test that counts layers cannot tell the difference. With the
bin now occupying that strip the same point lands on the bin and the drag is swallowed. The
test reads the geometry at the moment it clicks now, which is what it should always have done.

## A cut is a view, not a new thing

Cutting a clip in two made both halves rebuild their filmstrips, which is work the app already
had the answer to sitting in memory.

Thumbnails were cached by **millisecond**. Both paths that make one resolve the time to a
frame and draw that — so two requests a millisecond apart usually produce the identical
picture, stored twice and made twice. The two halves of a split sample at the centres of their
own slots, which are new times to the millisecond and the same frames, so every picture in a
strip that had just been drawn was thrown away. They are cached by the **frame** they land on
now.

That was not enough, and the way it was measured hid it. A landscape clip split down the
middle gives each half exactly half the slots, so their sample centres land on the identical
instants by arithmetic and everything hits the cache whatever the code does. A **portrait** clip
— narrow thumbnails, so many more slots — cut a third of the way along gets slot counts that do
not divide, and every centre is new. Measured there, with the fix in: the first half drew
*nothing at all*, the second drew half of itself, and fifteen thumbnails were seeked and remade.

What matters is not the frame index but how far off in **time** the nearest picture is, measured
against how much time a slot covers. A thumbnail is one frame standing for the whole span it is
drawn over, so a cached frame less than half a slot away is not an approximation — it is a
picture that was standing for that span a moment ago, at almost the same place on screen. The
strip uses it and does not queue a seek. Searching by frame *index* is what made the first
attempt useless at this scale: twelve frames is four tenths of a second, and the slots were
seconds apart.

Same cut, after: both halves full of pictures a quarter of a second later, and **one** thumbnail
made instead of fifteen.

The video clip also stopped drawing a waveform over its own thumbnails. Sound has its own lane
now, and two pictures of the same thing — one of them painted across the frames it is
competing with for space — is one too many.

### Joining

Cut at playhead had no inverse. Shift-click the pieces and press Join.

It holds itself to being an inverse: same media, same track, touching in time, and continuous
in the source — the second must start in the footage exactly where the first stopped. Anything
else is not a join but a claim that some footage does not exist, and doing it anyway would
silently skip frames or bring back ones that had been trimmed away. It refuses out loud, and
says which of those it is, because "cannot join" on its own is a puzzle: a gap between them, an
overlap (which is a transition, not a cut to undo), or a piece trimmed since the cut.

## Sound on its own track

Volume was a number in the inspector and a waveform painted behind the thumbnails on the video
clip. That is enough to see that there *is* sound and no use at all for doing anything to it:
there is nowhere to put a point, and anything drawn over the pictures fights them. "Bring this
down while she is talking" was not a thing you could do.

Sound now gets its own rows under the video ones, one per track. The whole height of a lane is
the volume, so a point has somewhere to be and the line between points is the shape of the fade
you are drawing. Half height is normal, so putting it back is the middle rather than a number
to remember. Click the lane to put a point there, drag one to move it, double-click one to take
it away — and the last one takes the track with it, so a clip with no points is the document it
was before any were put on.

**The points are keyframes.** `volume` became an animatable property like `x` or `opacity`,
which means a point dragged on a lane undoes, eases, copies with the layer, saves into the
project, and shows up in the Keyframes tab beside position and rotation — because it *is* one
of those. A second, parallel system for "audio points" would have been none of that, and would
have needed all of it written again.

The audio graph follows the curve by scheduling it onto each voice's gain node, sampled through
every eased segment so an ease-in-out does not come out as a straight line. Two things move a
voice's gain — what the volume track is doing, and what a transition or fade is doing to it —
and they multiply, because turning a clip down *and* fading it out should be quieter than
either alone.

## Transitions

Every editor makes this a thing you go and fetch: a bin of effects, a drag onto a cut, a
dialog with a duration in it, and then a separate object living at the join that you select,
trim and delete on its own terms. Four concepts for something people describe in one
sentence — "fade this one into that one".

**Here the overlap is the transition.** Drag a clip so it laps over its neighbour on the same
track, and the region where they cover each other is where one becomes the other. Longer
overlap, longer transition. Pull them apart and there is no transition, because there is no
overlap. There is nothing to select, nothing to delete, and no duration field: the timeline
already shows exactly how long it takes, because the length of the lap *is* the length of the
transition.

It follows that a transition with default settings **stores nothing at all**. Two clips
overlapping is a crossfade, and the document is unchanged from the one that described a hard
cut — the arrangement already said it. Only a changed kind is written, on the arriving clip,
which is where it belongs: move that clip and the transition moves, delete it and it goes.

The one control is which kind: crossfade, dip to black, dip to white, and a wipe each way.

### What counts as an overlap

Not everything that covers something else is a transition. The arriving clip has to both
**begin later and end later** than the one it replaces. Two clips dropped at the same spot on
one row, or one sitting entirely inside another, are stacked, not dissolving — that is
something people do by accident and it has always simply drawn one in front of the other.
Dissolving into a clip that ends at the same moment is a dissolve into nothing. An overlap
under 60ms is ignored as well: a frame or two of slop from a drag is not an instruction.

This was not foreseen; it was found. The tracks suite deliberately stacks two clips on one row
to check that raising one to another track changes what is drawn in front, and the first
version of this turned that into a full-length dissolve and broke it. The test was right.

### The arithmetic of a dissolve

The obvious way to crossfade is to draw the outgoing clip at `1 - p` and the incoming at `p`.
It is wrong. The second draw lands *over* the first, so what reaches the canvas is
`B*p + A*(1-p)*(1-p)` — the two never sum to one, and the picture sags dark through the middle
of every dissolve. Leaving the outgoing solid and bringing the incoming up at `p` gives
`A*(1-p) + B*p` exactly.

That only holds if the incoming clip is drawn second, and stacking order is the user's
business, not the transition's. So the renderer orders each pair before drawing. Both clips
are on the same track and overlap in time, so nothing can be between them — the swap is
invisible except for the thing it fixes. The suite checks the dissolve looks identical with
the layers stacked either way.

A dip is not a blend at all but two halves: the outgoing fades into the colour, then the
incoming comes out of it, and neither is ever up at the same time as the other. The colour
goes over the clip's **own box** rather than the whole canvas, so dipping one track to black
does not black out a title on another. A wipe fades nothing — both clips stay solid and the
incoming is uncovered across the frame, which is what makes it read as an edge travelling
rather than two pictures fighting.

### Fades, which are the other half of the ask

A transition needs two clips. A fade needs one: the clip comes up from nothing at its own
start, or goes away at its own end. It is the first and last thing in almost every piece of
video ever cut, and doing it by hand means keyframing opacity twice at times you have to look
up.

Unlike the overlap this cannot be read off the arrangement — a clip's edges say *when* it
starts, not *how* — so it is the one thing here that is genuinely stored: `fade: { in, out }`
in milliseconds. Set by dragging the square handles in the clip's top corners, with the ramp
drawn on the clip so it shows its own shape, the same way the lap shows a transition's.

**It fades to black**, which is not the same as fading to transparent. The first version
faded opacity, on the reasoning that a lone clip then fades to whatever the canvas is behind
it — black in a video export — and that a title would fade *into* the footage rather than
appear from under a black rectangle. At the start of a video with nothing underneath the two
are indistinguishable, which is why it seemed fine. Put anything under the clip and it is
obviously wrong: fading into the footage is not what "fade to black" means anywhere else.

The black is composited `source-atop` inside a scratch surface holding the clip alone, so it
lands only where the clip has pixels — a cutout fades to black without a black rectangle
appearing around it, and nothing underneath is touched. Painting the layer's box would have
been three lines and wrong for every layer that is not a full rectangle.

Each fade is capped at half its clip, so the two can never cross and no moment is defined by
both ends at once. Clearing both drops the field rather than leaving `{in: 0, out: 0}` behind,
so a clip with no fades is the same document it was before anyone touched the handles.

### When a fade and a transition meet

Fade a clip, then drag its neighbour over it. Both now attenuate the same clip over the same
instants — and applying both does not fade harder, it breaks the frame. A dissolve holds
together only because the outgoing clip stays solid while the incoming comes up; dimming the
outgoing as well leaves the pair summing to less than one, and the picture goes translucent,
which over a canvas with nothing behind it is **black**. Measured on the canvas it was alpha
191 of 255 through the middle of the overlap.

So a transition supersedes the fade at that edge, for exactly as long as it lasts. The fade is
not changed or cleared — pull the clips apart and it does its job again. The sound follows the
same rule, or a crossfade dips.

### Cutting a faded clip in two

`splitClips` clones the layer for the right-hand half, which copied the whole fade to both:
the left one then faded out at the cut and the right one faded in there, putting a dip to
nothing in the middle of continuous footage, twice, for no reason the timeline explained.

A fade belongs to the outside edges of a run, so the left half keeps the fade in, the right
half keeps the fade out, and each drops the one that would land at the cut. Both are re-capped
as well, since both halves are shorter than what they came from.

### Two clips of one video

Splitting a clip and lapping the halves asks for two different frames of the same video at the
same instant — and there is one decoder run per asset, which only goes forwards. `primeVideo`
asked for each position in turn, so the two tore that run down and rebuilt it by turns. Sitting
still on one frame, that measured **14 decoder restarts and 2860 chunks decoded** where one
run needs one restart and about two hundred.

The positions wanted from one asset are now collected first, and the run is started at the
earliest and fed far enough forward to reach the latest — for a crossfade the two are adjacent
in the source, so that span is the length of the overlap. Never further than the cache can
hold: past that the far frames evict the near ones as they arrive, and both clips get served
nothing instead of one being served its nearest.

Worth stating plainly: this was found by measuring, not by reproducing a black frame. The
report it came from — overlapping two clips turning the picture black while the sound played
on — has not been reproduced, and the check that guards it here passes with the fix reverted.
The decoder churn was real and is fixed; whether it was *the* cause is not established.

### The sound crosses too

A picture that dissolves under a hard audio cut is the thing that sounds broken — it is the
cut you hear, not the dissolve you see, that gives it away. Each voice's gain node gets the
ramp scheduled on it, so this costs nothing per frame and works the same in an offline render
as through the speakers.

A clip's own fades go through the same machinery, combined with any transition it is part of
by taking whichever is quieter — both are attenuations, and a clip that is fading in *and*
dissolving in should not come out louder than either would give alone.

A clip in the middle of a run is the outgoing half of one transition and the incoming half of
the next, so the curve is a list of points rather than one ramp: keying it by layer would have
kept one and lost the other, leaving a clip that fades in and then never fades out. Dropping
the playhead inside a transition picks the curve up at its current value instead of restarting
it, and a dip holds silence through the middle rather than crossing, because a picture that
has gone to black with the sound still running is a mistake rather than a style.

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

## Photo mounts

The collage prints tilted cards with a white border and a soft shadow. That is a property of
a *layer*, not of the collage — `frame: { insets, color, shadow, radius }` — so putting one
around a single image is the same code. **Media → Polaroid** places the picked images already
mounted and tilted; the Inspector's **Mount** control switches any layer between None, an
even Border, and a Polaroid afterwards, and adjusts the border, card colour and shadow.

The rule that makes it feel right: **the card grows around the picture, the picture does not
shrink inside the card.** Nothing about a photo should change because something was put
around it. So mounting reads where the picture currently sits, and resizes and repositions
the layer box so the picture stays exactly where it was, at exactly the size it was —
including when switching between mounts, which would otherwise shave a little off the photo
each time.

Placing is the exception, and deliberately so. A photo that already filled the frame would
gain a border entirely off-canvas, and clicking Polaroid would appear to do nothing. Placing
is the moment a size gets chosen, so `placeMounted` fits the finished card to the canvas at
92% — a little under, because a tilted card clips its own corners otherwise.

## One door for media

Media is added in the **Media** tab and nowhere else.

The editor used to take a drop too, and its empty canvas said *"Drop an image, GIF or video
to start"*. But importing has always put files in the bin and switched you there, so the
editor's version was a longer route to the same place wearing the clothes of a shortcut: drop
on the canvas, land in Media, click back to the canvas.

So the canvas no longer offers to take files, and a file dragged over the editor raises
nothing at all. It points at the bin instead, and clicking it goes there. The flow is the one
it always really was:

```
Media -> add -> send to the canvas
```

Pasting still works anywhere, because a paste is a deliberate act rather than a piece of
signposting that can mislead.

## Finding an edge

Two things needed the same missing piece, and neither had it: a magnetic lasso needs the
cheapest path along a boundary between where it last settled and where the pointer is, and
the AI selection needs to pull its outline onto the real edge, because a matte predicted at
512px lands near the boundary rather than on it.

**Colour gradients, not luminance.** Converting to grey first is the usual shortcut and it
throws away exactly the edges that matter on artwork in one hue. A green creature against a
green background is a strong colour boundary at nearly constant brightness. Measured on the
fixture built for this: two colours at luma 87 and 79 — a difference you would struggle to
see — give a gradient of **0.91** across the seam, where a luminance map finds essentially
nothing. Sobel runs per channel and takes the strongest.

### The magnetic lasso

Drag roughly around a subject and the outline finds the boundary itself. Between the last
settled point and the pointer it runs Dijkstra over the pixel grid, each step costing little
where the gradient is strong, confined to a corridor around the two ends — the path cannot
be helped by pixels far off to one side, and searching a whole image on every pointer move
would not feel live. A binary heap, because a linear scan for the next node turns this into
minutes.

Everything past the last anchor is provisional and recomputed on every move, so the path can
change its mind as you go rather than being stuck with the first route it found. It settles
an anchor every ~90 screen pixels; without that the search area grows until it is the whole
picture and the lasso stops keeping up.

Measured against an ellipse whose boundary is known exactly, asked for between two points
deliberately 12px *outside* it, the error along the path reads:

```
12, 4, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 10, 12
```

It starts where the pointer was, converges onto the boundary within two points, rides it at
0–1px, and returns to the far end. Mean error along the middle: **0.4px**. The ends stay
where they were asked to be, which is the point — a rough drag starts wherever your hand was.

Where there is genuinely no edge it runs straight rather than wandering after one that is
not there, and those points can be dragged afterwards like any others.

### The AI selection sees better

Two changes, both aimed at the same failure: a subject the model is only half sure about.

**Hysteresis instead of one cutoff**, as edge detection has used for forty years and for the
same reason. A single threshold on an unconfident matte either shreds the subject into
islands or floods into the background, and no value does neither. So the region grows through
anything plausible — half the confident threshold — and is kept only if enough of it is
material the model was actually confident about. A region that is *all* uncertain is the
model declining to answer, and spreading that over the picture is worse than saying so.

**The outline is snapped to real edges.** Each vertex moves to the strongest gradient within
a few pixels, which is the difference between an outline that looks traced and one that looks
approximate. Points with no real edge nearby are left where the model put them: on fur or
motion blur the strongest thing in reach is noise, and snapping to noise is worse than a soft
outline.

### A clock that stops must not stop the picture

Found while testing this, unrelated to it, and worth its own note. Audio is the clock during
playback — but a context that fails to start on a machine with no output device, or sits
suspended, then freezes the playhead while claiming to play. If the audio clock stops
advancing for 300ms, time goes back to counting frames.

Giving up is permanent for the rest of that run, deliberately. A clock that recovers for a
moment is worse than one that never worked: it is behind by then, so following it again drags
the playhead backwards and the two clocks fight until time crawls. A fresh cue gets a clean
slate.

## Cropping a picture, versus cropping the canvas

Two different things were called crop, and neither of them cropped a picture.

The **crop tool** resized the *document*. The **Framing → Crop** sliders moved a window over
the image without moving the layer, so the box kept its full width around a smaller
picture — "it keeps the same width while showing less" — with nothing to press to make it
stick. Between them there was no way to crop an image at all, which is the first thing
anyone tries.

**The crop tool now crops what is selected.** With an image selected the box opens on that
image and Enter crops it; with nothing selected it opens on the whole canvas and crops that,
as before. Starting on the thing it will act on is the whole signal — no mode to choose —
and the tool rail names it: *"Enter to crop room.png"*.

The work was already written. `cropLayer(l, rect, { reorigin: false })` is what a document
crop does to each layer minus the part that moves everything into the new document's
coordinates, and it already handled flips and an existing sub-rect. It was simply that no
gesture reached it.

**Framing keeps its insets, and gains a Trim to crop.** The insets stay a moving window
because they are *keyframable*: a crop that resized its own layer would drag the subject
around as it animated, which is the opposite of what a framing move is for. So they are left
alone, and a button that appears only when a layer is actually cropped bakes them — the
window becomes the layer's source rect, the drawn rectangle becomes its box, and the insets
are spent rather than left stacked on top of the new box. It refuses on animated framing,
because freezing one frame of a moving window throws the move away.

Both stay non-destructive: cropping moves a sub-rect over the asset, it does not make a
smaller bitmap, so one undo brings the whole frame back.

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

Two one-shot buttons sit under those, and they move opposite things — which is the whole
difference between them, so they are named for it:

- **Shrink canvas to fit content** moves the *canvas*: it shrinks onto whatever is on it, so
  empty space goes away. This is the one to reach for after cropping a picture and finding
  the canvas still its old size with a gap where the trimmed part used to be. It is a
  document crop to the content's own bounds — rotation-aware, or a tilted layer would have
  its corners cut off by a box drawn round the untilted rectangle.
- **Scale content to fill canvas** moves the *content*: the artwork is scaled where it sits
  until it covers the canvas, cropping the overflow.

The first of those was missing, and its absence was easy to mistake for the second
misbehaving: reaching for the only button there and watching the artwork scale when what you
wanted was the frame to close in.

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

## Three tools for an empty rail

The rail had move, crop, pixelate, lasso, shape, text, eraser and pan — everything to
*arrange* a picture and almost nothing to work on the pixels in one. Three were picked, on
one rule: each had to be something reached for often enough to earn a permanent slot, and
each had to work without a manual.

### The eyedropper

There are colour controls all over the app — text, sticker border, Polaroid card, shape
fill, canvas background — and until now the only way to set one was to know a hex code.
Sampling reads the **composited document**, not a layer's source, so what you pick is what
you can see: over a 50% white square on red it gives the blend, not either layer.

Every colour box grew a pipette. Pressing it takes up the eyedropper, and the next sample
lands in *that* box and hands back the tool you were holding — asking for one colour should
not leave you in a different mode. Escape abandons the request, and an abandoned request
does not fire into the next colour sampled.

The pending callback lives beside the store rather than in it. The store is serialised into
projects and autosaves, and a function is the one thing that cannot survive that trip.

**The loupe came second, and should have come first.** Sampling was per-pixel from the
start, but the *cursor* is not: below about a 4x zoom a document pixel is smaller than the
crosshair sitting on top of it, so picking the pixel you actually mean is guesswork and you
find out what you got only after you have got it. The glass shows fifteen document pixels
across with the one that would be taken outlined in the middle, drawn nearest-neighbour —
a smoothed magnifier would invent colours that are not in the picture and cannot be picked
— with the hex on a pill underneath, because the number is the thing being chosen and
reading it off the swatch afterwards is a step too late. The block is pulled from the
composited document canvas, the same surface and the same rounding a click samples, so what
the loupe shows and what lands in the swatch cannot disagree.

It shows nine pixels across rather than the fifteen it started with. At fifteen each cell was
eight screen pixels, which is not enough to pick the outlined one out at a glance — and a
neighbourhood you cannot read is not worth the width it costs. Nine on a wider glass is about
eighteen pixels a cell, and the centre box reads immediately.

The first version drew nine white lines straight out across the picture. `save()` and
`restore()` carry the transform and the styles but **not** the current path, so the rim stroke
after the clip was restored was stroking whatever path had been built last — the grid — rather
than the circle that opened the clip. Laying the arc down again fixed it. Worth writing down
because it looks like a clipping bug and is not one.

### Selecting by colour

The AI lasso finds *subjects*, which is exactly why it is no help with a flat background, a
sky, a logo, or one panel of a screenshot: it is answering a different question. The wand
answers the plain one — take everything that looks like what I clicked — and returns an
ordinary lasso, so Copy, Cut, Mask, Erase and Pixelate all work on it unchanged.

Distance is weighted towards green because the eye is, so one tolerance setting behaves
roughly the same across hues. Alpha is part of the comparison: a transparent pixel is not
the same colour as an opaque one that happens to share its RGB, which matters the moment
you use it on a layer that has already been cut out.

**The option that was deliberately not built** is "contiguous". A lasso is a single closed
outline, so a selection scattered across a picture has nowhere to go. The tool takes the
region the click is inside and says so, rather than offering a checkbox whose result it
cannot carry. The same limit runs the other way: click a background that wraps around a
disc and the disc comes back inside the selection, because one outline has no holes. That
is stated in the test rather than left to be discovered.

### The clone stamp

Paint over a watermark, a blemish or a stray object with a piece of the picture from
somewhere else. Alt-click sets the source, then paint.

Strokes are points and an offset, never pixels — the same choice as the eraser, and for
the same three reasons: cloning stays undoable in one step, it scales with its layer
instead of staying at the pixel positions it was painted at, and a saved project does not
grow by a full-size copy of the image. Halve the layer and the repair halves with it.

The offset is fixed when a stroke *begins*, not tracked per point. A source that moved with
the brush would smear rather than copy. It is fixed per stroke rather than per session, so
lifting the pointer and painting again continues the same relationship instead of resetting
it.

Rendering nests inside the eraser and the mask, innermost of the three: the layer is drawn
into a scratch surface, that surface is drawn back shifted by the offset, stencilled down
to the stroke, and laid over the original. One surface per stroke rather than one for all
of them, because strokes with different offsets sample different places and cannot share a
stencil.

**The bug that cost the most** was a single sign. The offset is stored as *source minus
destination*; drawing the picture at that offset moves the destination onto the source —
exactly backwards. With a source up and to the left of the mark, it sampled off the edge of
the picture and painted nothing at all, which reads identically to "the tool is not wired
up". The test said the stroke was recorded, the offset was right, undo worked, and the mark
was still there; two probes were needed to place the fault inside `paintClone` rather than
anywhere in the four layers of wiring around it.

## Two things that could only be done once

Two features, built years apart in the same afternoon's worth of code, had the same shape of
bug: each stored *the* thing where it needed to store *a list of* things. Both were found by
using the app rather than by a test, which is the honest summary of how they got in.

### Erasing a second region put the first one back

The lasso's Erase wrote the layer's **mask**, inverted — keep everything except this outline.
That is a perfectly good description of erasing one region, and a layer has exactly one mask,
so erasing a second region silently filled in the first. The same flaw sat behind Cut, where
the hole the piece left was written the same way: cut two pieces out of a photo and the first
hole healed over while its cut-out layer still floated above it.

Erase regions are now **strokes**, in the same list the eraser brush already paints into.
Nothing had to learn a new shape: they accumulate, undo one region at a time, can be painted
back with a restore stroke, scale and rotate with the layer, save into the project, get baked
by the sticker cutout, and show up in the "Erased" panel beside anything drawn with the brush.
A region carries no width — a lasso does not have a brush size, and giving it one would spread
the cut past the line that was drawn.

The mask is still what **Mask** uses, and that is right: keeping only what is inside an
outline genuinely is one shape, and it is the operation that trims the layer box down to what
is left.

### The second "pixelate everything except this" covered the first

An inverted effect layer means *treat everything except this shape*, so it claims the whole
canvas — and two of them claim it twice. Adding a second one to keep a second face clear
re-covered the first, and the only way to keep two things visible was to draw a single
outline that wrapped around both, which is not a shape anybody wants to draw with a mouse.

So the "everything else" layer now yields: an inverted effect leaves alone the territory
every other effect layer on screen has claimed — a window another inverted layer is holding
open, or a region a plain effect is already treating. Effects stack by union, and protecting
one more thing is one more shape rather than a redraw. Three windows work the same way as
two, because it is a union rather than a case for two.

A plain pixelate is not a window and still pixelates what it covers, including inside
someone's window: asking for a region to be pixelated is not ambiguous, and the layer that
should give way is the one whose whole definition is "everywhere else".

### Actions you could not reach

The lasso's action bar is anchored under the outline, which is fine until the outline reaches
the bottom of the picture — and a full-height image puts it there every time. The buttons then
sat below the stage, half cut off by the window. It now flips above the outline when there is
no room beneath, slides along rather than hanging off either side, and centres itself when the
bar is wider than the stage, which is the only thing left to do at that point.

The position is measured after layout and written straight to the node rather than into state:
the correction depends on the size of the thing being positioned, and feeding a measurement
back into a render that changes the measurement is how a loop starts.

Finding this turned up a second thing. `panX`/`panY` is the document's **top-left** in stage
coordinates, so a document point on screen is `pan + doc * zoom`. Two tests had written that
mapping around the canvas centre instead, which double-counts the pan — and passed anyway,
because their fixtures were split left from right at full height, so an error in y could not
change the answer. Both now use the mapping the stage actually uses.

## Two clipboards

Copy and paste looked broken: Ctrl+C on a layer, Ctrl+V, and nothing appeared. What was
actually happening is that there are two clipboards, and the wrong one kept winning.

Layers copied in the app go into the store. The operating system has its own clipboard, and
pasting a screenshot straight in is a real feature that reads from it. The paste handler tried
the system clipboard first and fell back to the layers — which is fine right up until the
system clipboard has something in it, which on a real machine it almost always does. A
screenshot taken an hour ago beat a layer copied a second ago, and went on beating it for as
long as it sat there. The picture went quietly into Media, the canvas did not change, and the
whole thing read as copy and paste simply not working.

The rule that was wanted all along is **whatever you copied last**. There is no way to ask the
system clipboard when it was filled, so the only way to know an in-app copy is the more recent
of the two is to make it the system clipboard's contents as well: copying layers now writes
`PixelForge — 2 layers copied` to it. A file being there *again* afterwards is then proof that
something newer replaced it, so pasting a screenshot still works, and works for the right
reason rather than by being unconditionally first.

If that write is refused — no permission, or a context where the clipboard API is not there —
the copy records that it failed and paste prefers the layers, which is the safer half of the
trade: the in-app copy is the one the user definitely just made.

The claim lives in `copyLayers` rather than in the keyboard handler, because the layer context
menu has Copy and Cut items too and a rule that only holds for the keyboard is not a rule.

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
| `V` `C` `P` `L` `S` `T` `E` | move, crop, pixel overlay, lasso, shape, text, erase |
| `K` `W` `I` `H` | clone stamp, colour select, eyedropper, pan |
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

Forty-two browser suites (**935 checks**), two Electron suites (**70 checks** — the shell
itself and MP4 export, which can only run where ffmpeg exists), and nine DOM-free unit
suites under plain node — `test-retro.mjs`, `test-loop.mjs`, `test-cursor.mjs`,
`test-collage.mjs`, `test-trace.mjs`, `test-dpi.mjs`, `test-clips.mjs`, `test-edges.mjs`,
`test-transitions.mjs` —
for the parts that are pure maths and deserve testing without a browser at all. **1404
checks** in total.

One check had to be rewritten rather than kept: the DPI suite asserted that the same
document exported at 300 and at 600 came out the same number of bytes, on the reasoning that
only the chunk should differ. It does only differ by the chunk — but five exports of one
document at one resolution measure 1535199, 1535199, 1535195, 1535195, 1535195, because
Chrome's rasterisation of a five-times upscale is not bit-reproducible. The check was
testing the browser's canvas. It now stamps *one* export twice and compares those, which is
the claim it was always trying to make.

```bash
npm run dev           # in one terminal
npm test              # in another — the lot, in about a minute
npm run test:changed  # only the suites your edits could have broken
npm run test:units    # no browser needed
npm run test:desktop  # builds, then boots the Electron shell
```

### Running them

Thirty-eight browser suites chained with `&&`, one at a time, each booting its own Chrome,
came to about twelve minutes — long enough that you stop running it, and a suite you stop
running is worth nothing.

They now run **at once**. Every suite drives its own browser against the same dev server and
writes to its own screenshot folder, so nothing is shared and there was never anything to
serialise. Eight at a time on twenty cores: **53 seconds** for all 1271 checks, against twelve
minutes.

`--changed` runs fewer still. It maps the files git reports against a table of which suites
could possibly notice — the eraser does not need the MP4 export suite's opinion. A file the
table has not been taught about runs **everything**, because guessing narrowly there is how a
suite stops being trusted, and editing a suite runs that suite.

`--jobs=1` puts it back to one at a time, which is what you want when a failure might be the
concurrency rather than the code.

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
