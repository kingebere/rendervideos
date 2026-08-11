#!/usr/bin/env node
// Gate-tile build: cost vs detection quality.
//
// The gate downscales the 1290x308 source band to a 192x48 tile every frame purely to decide
// whether work can be skipped. Measured at ~36.7ms/frame -- a quarter of the status-bar stage
// spent deciding, before any actual work. drawImage with smoothing does an area-average over
// all ~397k band pixels; with smoothing off it point-samples only the 9216 tile pixels.
//
// Point-sampling is far cheaper but noisier (no averaging to suppress codec noise), so it may
// need a higher tolerance to keep the hit rate. Measure BOTH cost and hit rate together --
// a cheaper tile that halves the hit rate is a loss.
//
// Reference semantics match the shipped gate: compare against the tile captured when the
// cache was last built, not the previous frame.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 180000 });

  const out = await page.evaluate(async () => {
    const blob = await (await fetch('/media/verify15.mp4')).blob();
    const v = document.createElement('video');
    v.src = URL.createObjectURL(blob); v.muted = true; v.preload = 'auto';
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('load')); });
    const W = v.videoWidth, H = v.videoHeight;
    const bandH = Math.max(1, Math.ceil(H * 0.11));
    const full = document.createElement('canvas'); full.width = W; full.height = H;
    const fctx = full.getContext('2d', { willReadFrequently: true });
    const seek = (t) => new Promise(r => { v.onseeked = () => r(); v.currentTime = t; });

    const variants = [
      { name: 'smooth 192x48 (current)', tw: 192, th: 48, smooth: true },
      { name: 'nearest 192x48', tw: 192, th: 48, smooth: false },
      { name: 'nearest 96x24', tw: 96, th: 24, smooth: false },
      { name: 'smooth 96x24', tw: 96, th: 24, smooth: true },
      { name: 'nearest 64x16', tw: 64, th: 16, smooth: false },
    ];
    for (const va of variants) {
      va.c = document.createElement('canvas'); va.c.width = va.tw; va.c.height = va.th;
      va.ctx = va.c.getContext('2d', { willReadFrequently: true });
      va.ctx.imageSmoothingEnabled = va.smooth;
      va.ms = 0; va.tiles = [];
    }

    const FRAMES = 200;
    for (let i = 0; i < FRAMES; i++) {
      await seek(i / 30);
      fctx.drawImage(v, 0, 0, W, H);
      for (const va of variants) {
        const t0 = performance.now();
        va.ctx.imageSmoothingEnabled = va.smooth;
        va.ctx.drawImage(full, 0, 0, W, bandH, 0, 0, va.tw, va.th);
        const d = va.ctx.getImageData(0, 0, va.tw, va.th).data;
        const tile = new Uint8Array(va.tw * va.th);
        for (let k = 0, p = 0; k < d.length; k += 4, p++) tile[p] = (d[k] * 77 + d[k + 1] * 150 + d[k + 2] * 29) >> 8;
        va.ms += performance.now() - t0;
        va.tiles.push(tile);
      }
    }

    // Hit rate under reference semantics, per tolerance.
    const TOLS = [2, 4, 8, 12, 20];
    const res = [];
    for (const va of variants) {
      const row = { name: va.name, msPerFrame: +(va.ms / FRAMES).toFixed(2), hits: {} };
      for (const tol of TOLS) {
        let ref = null, hit = 0, maxDrift = 0;
        for (const tile of va.tiles) {
          if (!ref) { ref = tile; continue; }
          let mx = 0;
          for (let p = 0; p < tile.length; p++) { const dd = Math.abs(tile[p] - ref[p]); if (dd > mx) { mx = dd; if (mx > tol) break; } }
          if (mx > tol) ref = tile; else { hit++; if (mx > maxDrift) maxDrift = mx; }
        }
        row.hits['t' + tol] = { hitPct: +(100 * hit / (va.tiles.length - 1)).toFixed(1), maxDrift };
      }
      res.push(row);
    }
    return { W, H, bandH, frames: FRAMES, res };
  });

  console.log(`source ${out.W}x${out.H} band=${out.bandH} frames=${out.frames}`);
  for (const r of out.res) {
    const h = Object.entries(r.hits).map(([k, v]) => `${k}:${v.hitPct}%(d${v.maxDrift})`).join('  ');
    console.log(`${r.name.padEnd(24)} ${String(r.msPerFrame).padStart(7)} ms/frame   ${h}`);
  }
  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
