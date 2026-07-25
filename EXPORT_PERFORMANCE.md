# Export Performance — findings, benchmarks, and how to debug the Mac slowdown

Purpose: everything needed to investigate why the same video exports **much slower on macOS than on Windows** (a 30‑min video takes ~1 hour on Mac). The Windows optimizations below did NOT translate to Mac. Pull this on the Mac, run the profiler, and compare the per‑stage numbers.

---

## TL;DR of the problem

- Windows: a 98.8s HEVC clip exports in ~129s; a 34‑min clip in ~47min (~1.36× realtime).
- Mac: a 30‑min video takes ~1 hour (~2× realtime) — the Windows wins aren't showing up.
- We do NOT yet know which stage is slow on Mac. **The single most useful next step is to run the per‑stage profiler (below) on the Mac and compare the ms/frame breakdown to the Windows baseline.** Don't guess — measure.

---

## How the export renders (where the time goes)

Entry: `exportZip()` → `renderCombinedSourceEditedVideo()` → **`renderCombinedSourceEditedVideoMediabunny()`** (the fast WebCodecs path; `index.html`). It decodes every source frame via mediabunny (WebCodecs `VideoDecoder`), runs per‑frame CPU compositing, and encodes via mediabunny `CanvasSource` (`codec:'avc'`, `hardwareAcceleration:'prefer-hardware'`, ~12 Mbps). The inner per‑frame function is **`renderSampleFrame`**.

Per‑frame stages:
1. **decode‑draw** — `sample.draw(cleanCtx,...)` (the WebCodecs decode happens as the sink is pulled).
2. **status‑bar processing** — `eraseSourceStatusbarForComposition` (erase real status bar + patch), `removeRecordingIndicator`, keyboard blur, `sourceStatusPatchBgs`. Heavy `getImageData` + per‑pixel work on the source‑resolution frame.
3. **composite** — draw video into the mockup, aperture clip, frame layer, island repaint.
4. **encode** — `canvasSource.add(...)` (hardware AVC encode).

---

## Windows baseline (measured) — Intel i7‑7700HQ, 8 threads, 16 GB, Win10 19045, Chrome, Node v24

98.8s HEVC source (1290×2796), 2963 output frames @30fps. Render ≈ 54 ms/frame. Per‑frame breakdown BEFORE the motion‑gate optimization:

| Stage | ms/frame | share |
|---|---|---|
| decode‑draw | 0.5 | ~1% |
| **status‑bar** | **48.8** | **~90%** |
| composite | 0.4 | ~1% |
| encode (HW AVC) | 4.1 | ~7% |

Status‑bar sub‑breakdown (ms/frame): `eraseStatusRecordingArtifacts` ~16.5, `fillStatusPatch` ~15.4, `detectStatusLeftIndicatorRect` ~4.8, `sourceStatusPatchBgs` ~3.3, `removeRecordingIndicator` ~2.7, band snapshot ~2.7, median ~2.6, keyboard ~0.9.

**On Windows the bottleneck is CPU status‑bar pixel work, NOT decode/encode.** Encode is only ~4 ms/frame (hardware AVC working). Decode is negligible per frame.

### Optimizations already landed (Windows-measured)
- `willReadFrequently:true` on the `clean` canvas — stops every `getImageData` stalling on a GPU→CPU sync (was the ~2× win, 8.7→34 fps).
- Reuse one status‑bar snapshot canvas + copy only the band (was allocating a full ~3.6 MP canvas/frame).
- Motion‑gate the status‑bar removal (commit `03601c2`): hash a downscaled top‑band tile; reuse the cached erase when unchanged. Benchmarked 173.6s→129.3s (25.5% faster) on a motion‑heavy clip; pixel‑identical output. Calmer content gains more.
- JPEG q92 screenshots instead of PNG.

---

## Why Mac may differ — hypotheses to test (in rough priority)

1. **HEVC decode path.** The source is HEVC. On Windows, Chrome decodes via Media Foundation (often hardware). On macOS, Chrome uses VideoToolbox — but HEVC hardware decode support in Chrome/WebCodecs on Mac is inconsistent and can silently fall to **software decode**, which is far slower per frame. If Mac's `decode‑draw` (or the sink pull) is much higher than Windows' ~0.5 ms/frame, this is it. **Check `VideoDecoder.isConfigSupported` for the source codec and whether decode is hardware.**
2. **Hardware AVC encode.** `hardwareAcceleration:'prefer-hardware'` — if VideoToolbox HW encode isn't engaged, mediabunny may fall to **software AVC encode**, which would blow up the ~4 ms/frame encode. Check whether the encoder is actually hardware on Mac.
3. **`getImageData` / canvas readback speed.** The status‑bar stage is `getImageData`‑heavy. `willReadFrequently` behavior and CPU‑side pixel throughput differ by platform/GPU/browser build. If Mac's `status‑bar` ms/frame is much higher than Windows' 37–49, the CPU pixel work is the problem there too — the motion‑gate helps but the base cost may be higher.
4. **GPU acceleration disabled / different GPU.** If Chrome on the Mac has GPU accel off (or a weaker iGPU), canvas draws + encode suffer. Check `chrome://gpu`.
5. **Retina/backing‑store scaling.** If any canvas gets a devicePixelRatio‑scaled backing store on Retina, per‑pixel work multiplies. Verify canvas sizes are the source resolution, not ×2.
6. **Thermal throttling / power** on laptops during a 1‑hour export.

---

## How to profile on the Mac (do this first)

Add this instrumentation to `renderSampleFrame` in `index.html` (remove before committing). It splits the four stages so you can compare directly to the Windows table above.

Right after `await output.start();` (just before `let renderedFrames=0;`):
```js
const _pf=(window.__exportProfile={decodeDraw:0,statusbar:0,composite:0,encode:0,frames:0});
```
Inside `renderSampleFrame`, wrap the stages:
```js
// at the very top of the per-frame body:
let _t=performance.now();
// after `sample.draw(cleanCtx,0,0,clean.width,clean.height);`:
_pf.decodeDraw+=performance.now()-_t;_t=performance.now();
// after the status-bar block (after `const bg=sourceStatusPatchBgs(...)` / the motion-gate block):
_pf.statusbar+=performance.now()-_t;_t=performance.now();
// immediately BEFORE `await canvasSource.add(...)`:
_pf.composite+=performance.now()-_t;_t=performance.now();
// immediately AFTER `await canvasSource.add(...)`:
_pf.encode+=performance.now()-_t;_pf.frames++;
```
Then run an export and read `window.__exportProfile` in the console. Compute ms/frame = stage / frames. **Compare each stage to the Windows table.** The stage that is disproportionately larger on Mac is the culprit:
- decode‑draw much higher → HEVC software decode (hypothesis 1).
- encode much higher → software AVC encode (hypothesis 2).
- status‑bar much higher → CPU pixel/`getImageData` throughput (hypothesis 3/4/5).

Also capture, once, at export start:
```js
console.log('cores', navigator.hardwareConcurrency, 'dpr', devicePixelRatio, 'coi', crossOriginIsolated);
VideoDecoder.isConfigSupported({codec:'hev1.1.6.L93.B0',codedWidth:1290,codedHeight:2796}).then(r=>console.log('hevc decode', r));
```
And check `chrome://gpu` (Video Decode/Encode lines) and Chrome version.

### Test harness (same one used on Windows)
`D:\finaltest\` on Windows has a reusable setup (on Mac, adapt paths): a tiny Node static server serving this dir with headers `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: cross-origin` (required for `crossOriginIsolated`/WebCodecs), and a Playwright script driving **real Chrome** (`channel:'chrome'` — bundled Chromium can't decode HEVC). Or just load the app in Chrome and export manually while watching the console profiler. Kick off `exportZip(null)` and read `window.__exportProfile` when it resolves. Do NOT poll in a tight loop.

---

## Notes / gotchas
- `cleanCtx` is created `willReadFrequently:true` — keep it that way; without it every `getImageData` stalls.
- The motion‑gate signature is a downscaled 192×48 tile hash; if a fast status‑bar element ever lags, enlarge the tile. It's per‑source (`job.src._sbBandCanvas` etc.).
- Preview is paused at export start (`vid-main.pause()`) so its compositing RAF doesn't compete with the render.
- Screenshots are captured during the render (no second decode pass) only when no frames were pre‑extracted; JPEG q92.

## Environment (Windows box these numbers came from)
CPU Intel i7‑7700HQ @2.8GHz, 8 threads · 16 GB RAM · Windows 10 (19045) · Chrome (channel `chrome`) · Node v24.14.1.
Fill in the Mac equivalents (CPU/chip, RAM, macOS version, Chrome version, `chrome://gpu` video lines) when you profile.
