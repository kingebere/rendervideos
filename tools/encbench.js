#!/usr/bin/env node
// Decisive test for the brief's prime suspect.
//
// isConfigSupported() reports the CONFIG is valid, and 'prefer-hardware' is only a hint --
// neither proves a hardware encoder is actually used. So encode real frames and compare
// throughput between prefer-hardware and prefer-software at the true source size. If the
// two are indistinguishable, 'prefer-hardware' is silently resolving to software.
// A known-good small size is included as a control: if HW works at 1080p but not at
// 1290x2796, the limit is the tall portrait dimension, exactly as the brief predicts.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'domcontentloaded' });

  const results = await page.evaluate(async () => {
    const FRAMES = 60;
    const run = async (w, h, hw, codec = 'avc1.640034') => {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      let encoded = 0, errors = null;
      const enc = new VideoEncoder({
        output: () => { encoded++; },
        error: (e) => { errors = String(e && e.message || e); },
      });
      try {
        enc.configure({ codec, width: w, height: h, bitrate: 12000000, framerate: 30, hardwareAcceleration: hw, latencyMode: 'quality' });
      } catch (e) { return { w, h, hw, codec, configError: String(e && e.message || e) }; }

      // Warm up so first-frame setup cost is not counted.
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = `rgb(${i * 7 % 255},${i * 13 % 255},90)`; ctx.fillRect(0, 0, w, h);
        const f = new VideoFrame(canvas, { timestamp: i * 33333 });
        enc.encode(f); f.close();
      }
      await enc.flush();
      encoded = 0;

      const t0 = performance.now();
      for (let i = 0; i < FRAMES; i++) {
        // Vary content so the encoder cannot trivially skip work.
        ctx.fillStyle = `rgb(${(i * 11) % 255},${(i * 29) % 255},${(i * 7) % 255})`;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#fff';
        ctx.fillRect((i * 17) % w, (i * 23) % h, w / 4, h / 8);
        const f = new VideoFrame(canvas, { timestamp: (i + 10) * 33333 });
        enc.encode(f); f.close();
        // Bound the queue so we measure encode throughput, not just submission.
        if (enc.encodeQueueSize > 8) { while (enc.encodeQueueSize > 2) await new Promise(r => setTimeout(r, 1)); }
      }
      await enc.flush();
      const ms = performance.now() - t0;
      enc.close();
      return { w, h, hw, codec, frames: FRAMES, totalMs: +ms.toFixed(1), msPerFrame: +(ms / FRAMES).toFixed(2), encoded, errors };
    };

    const out = [];
    out.push(await run(1290, 2796, 'prefer-hardware'));
    out.push(await run(1290, 2796, 'prefer-software'));
    out.push(await run(1290, 2796, 'no-preference'));
    out.push(await run(1080, 1920, 'prefer-hardware'));
    out.push(await run(1080, 1920, 'prefer-software'));
    out.push(await run(1280, 720, 'prefer-hardware'));
    out.push(await run(1280, 720, 'prefer-software'));
    return out;
  });

  console.log('size        hwHint            ms/frame   frames  err');
  for (const r of results) {
    if (r.configError) { console.log(`${r.w}x${r.h}  ${r.hw}  CONFIG ERROR: ${r.configError}`); continue; }
    console.log(`${String(r.w + 'x' + r.h).padEnd(11)} ${String(r.hw).padEnd(17)} ${String(r.msPerFrame).padStart(8)}   ${r.encoded}   ${r.errors || ''}`);
  }
  console.log('\nraw:', JSON.stringify(results));
  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
