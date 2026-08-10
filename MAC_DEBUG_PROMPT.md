# Mac export-slowness — autonomous debug + fix brief

**Paste this whole file (or point the agent at it after `git pull`) into Claude Code running on the Mac. The agent should do EVERY step itself — set up, reproduce, profile, fix, verify, commit. Do NOT hand manual steps back to the human. Work end to end. MEASURE before changing anything; never claim a speedup you didn't measure.**

---

## The problem

This app is a browser-based iPhone screen-recording editor. The entire app is one large inline HTML+CSS+JS file: `rendervideos/index.html`. Repo: `https://github.com/kingebere/rendervideos` (branch `main`; a Windows fix, commit `c2bdbfe`, is already in — `git pull` first).

Users on **macOS** report a ~48-min iPhone screen recording takes **~7 HOURS** to export (~9× realtime). On a **Windows** box the IDENTICAL code exports a comparable video at **~1.3–1.8× realtime** (a 46-min / 60fps / 2.25GB HEVC file did 82 min). So this is a **macOS-specific performance pathology**, not an app-logic bug. Find which stage balloons on THIS Mac and fix the real bottleneck.

## How the export works (where the time goes)

Entry: `exportZip()` → `renderCombinedSourceEditedVideo()` → **`renderCombinedSourceEditedVideoMediabunny()`** (the fast WebCodecs path). Inner per-frame function: **`renderSampleFrame`**. Four per-frame stages:

1. **decode-draw** — `sample.draw(cleanCtx,...)` (WebCodecs `VideoDecoder` pulls the frame).
2. **status-bar** — erase real status bar + repaint (`eraseSourceStatusbarForComposition`, `removeRecordingIndicator`, `sourceStatusPatchBgs`): heavy `getImageData` + per-pixel CPU.
3. **composite** — draw video into the mockup, aperture clip, island repaint.
4. **encode** — `canvasSource.add(...)` (mediabunny `CanvasSource`, `codec:'avc'`, ~12 Mbps, `hardwareAcceleration:'prefer-hardware'`).

Encoder config is around **`index.html:9595`**. The export retries with `attempts=['prefer-hardware','prefer-software']` around **`index.html:11533`**. See `rendervideos/EXPORT_PERFORMANCE.md` for the full write-up.

## Windows baseline (per-frame ms, for comparison) — 1290×2796 HEVC source

| stage | ms/frame | share |
|---|---|---|
| decode-draw | 0.5 | ~1% |
| **status-bar** | **48.8** | **~90%** |
| composite | 0.4 | ~1% |
| encode (HW AVC) | 4.1 | ~7% |

## Prime suspect (confirm or refute — don't assume)

`'prefer-hardware'` is a **hint, not a guarantee**. macOS VideoToolbox H.264 hardware encoders often **reject tall portrait dimensions** (2532–2796 px tall) → Chrome silently falls back to **software AVC encode** (~4 ms/frame → ~40–80 ms/frame). Software **HEVC decode** on macOS Chrome is also inconsistent. Either or both explains 5× slower.

---

## Do these yourself, in order

### 0. Environment
- `git pull` the repo.
- WebCodecs requires `crossOriginIsolated === true`, which requires COOP/COEP headers. **Write a tiny static server yourself** (Node is fine) that serves `rendervideos/` with: `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: cross-origin`.
- Use **real Google Chrome**, not Chromium (Chromium can't decode HEVC). Drive it yourself with Playwright `channel:'chrome'` (headless:false) so the whole run is scripted and autonomous. Install Playwright if needed.
- You need a **real iPhone HEVC screen recording** to reproduce. Ask the human ONCE for a path to one if none is present; otherwise find one on disk. A few minutes of footage is enough to profile — you do NOT need the full 48 min.

### 1. Capability probe (record the output)
On the loaded app page (confirm `crossOriginIsolated===true` first), evaluate:
```js
console.log('cores', navigator.hardwareConcurrency, 'dpr', devicePixelRatio, 'coi', crossOriginIsolated);
VideoDecoder.isConfigSupported({codec:'hev1.1.6.L93.B0',codedWidth:1290,codedHeight:2796}).then(r=>console.log('HEVC decode', JSON.stringify(r)));
VideoEncoder.isConfigSupported({codec:'avc1.640034',width:1290,height:2796,bitrate:12000000}).then(r=>console.log('AVC High 5.2', JSON.stringify(r)));
```
Use the ACTUAL source width/height. Also read `chrome://gpu` "Video Decode"/"Video Encode" lines and the Chrome version (navigate a tab there and scrape it).

### 2. Per-stage profiler (temporary; remove before commit)
Instrument `renderSampleFrame`. Right after `await output.start();`:
```js
const _pf=(window.__exportProfile={decodeDraw:0,statusbar:0,composite:0,encode:0,frames:0});
```
Inside `renderSampleFrame`:
```js
// top of per-frame body:
let _t=performance.now();
// after `sample.draw(cleanCtx,0,0,clean.width,clean.height);`:
_pf.decodeDraw+=performance.now()-_t;_t=performance.now();
// after the status-bar block (after the sourceStatusPatchBgs / motion-gate block):
_pf.statusbar+=performance.now()-_t;_t=performance.now();
// immediately BEFORE `await canvasSource.add(...)`:
_pf.composite+=performance.now()-_t;_t=performance.now();
// immediately AFTER `await canvasSource.add(...)`:
_pf.encode+=performance.now()-_t;_pf.frames++;
```
Load a real HEVC clip, set an app name, run `exportZip(null)`, let it render a few minutes, read `window.__exportProfile`, compute ms/frame per stage. Interpret vs the Windows table:
- **encode ≫ 4** → software AVC encode (prime suspect)
- **decode-draw ≫ 0.5** → software HEVC decode
- **status-bar ≫ 49** → CPU `getImageData`/pixel throughput

### 3. Fix the bottleneck you measured (not the one you guessed)
- **Software AVC encode:** at the encoder config (`~9595`) and fallback (`~11533`), detect whether the encoder is genuinely hardware and/or whether source dims exceed VideoToolbox H.264 limits. Options, best first: pick an AVC level VideoToolbox accepts; try hardware `hevc`/`av1` via WebCodecs if this Mac supports it; cap encode dimensions to a supported size and scale; at minimum detect the software fallback and expose a faster/lower-res mode + warn. Keep hardware encode engaged if at all possible.
- **Software HEVC decode:** try requesting hardware decode explicitly; consider a one-time transcode-to-H.264 of the source before rendering if software HEVC is unavoidable.
- **Status-bar CPU:** the motion-gate cache (commit `03601c2`) already reuses the status-bar erase across unchanged frames — verify it's active; the base per-pixel cost may just be higher here.

### 4. Verify (mandatory)
Real before/after on the SAME clip: export time AND per-stage ms/frame before vs after. Confirm the OUTPUT is unchanged — mockup applied, 30-flow routing intact, no fallback to raw source clips or WebM. **Remove the profiler instrumentation.** Commit with a message naming the measured stage and the fix; end the body with:
```
Co-Authored-By: Claude <noreply@anthropic.com>
```

### 5. Deliverable
(1) capability probe + `chrome://gpu` results; (2) per-stage ms/frame table Mac vs Windows; (3) the identified bottleneck; (4) the fix + before/after export time on the same clip; (5) confirmation the output is correct; (6) the commit hash.

**Do it all yourself. Only pause to ask the human for a source-video path if you genuinely cannot find one.**
