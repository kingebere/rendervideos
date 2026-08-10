#!/usr/bin/env node
// Interleaved, repeated encoder benchmark.
//
// The first pass ran each config once, back to back. On a machine whose CPU_Speed_Limit
// moves under load, sequential single runs confound config with drift -- the later a config
// runs, the different the machine. So: interleave configs round-robin and take the MEDIAN
// of N reps, which makes a slow patch hit every config roughly equally.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'domcontentloaded' });

  const results = await page.evaluate(async () => {
    const FRAMES = 40, REPS = 3;
    const CONFIGS = [
      { name: 'avc prefer-hardware', codec: 'avc1.640034', hw: 'prefer-hardware' },
      { name: 'avc prefer-software', codec: 'avc1.640034', hw: 'prefer-software' },
      { name: 'avc no-preference', codec: 'avc1.640034', hw: 'no-preference' },
      { name: 'avc High5.1 no-pref', codec: 'avc1.640033', hw: 'no-preference' },
      { name: 'hevc no-preference', codec: 'hev1.1.6.L93.B0', hw: 'no-preference' },
      { name: 'hevc prefer-hardware', codec: 'hev1.1.6.L93.B0', hw: 'prefer-hardware' },
    ];
    const W = 1290, H = 2796;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');

    const once = async (cfg) => {
      let encoded = 0, err = null;
      const enc = new VideoEncoder({ output: () => { encoded++; }, error: (e) => { err = String(e && e.message || e); } });
      try { enc.configure({ codec: cfg.codec, width: W, height: H, bitrate: 12000000, framerate: 30, hardwareAcceleration: cfg.hw, latencyMode: 'quality' }); }
      catch (e) { return { ms: null, err: 'configure: ' + String(e && e.message || e) }; }
      for (let i = 0; i < 4; i++) { ctx.fillStyle = `rgb(${i * 9 % 255},40,60)`; ctx.fillRect(0, 0, W, H); const f = new VideoFrame(canvas, { timestamp: i * 33333 }); enc.encode(f); f.close(); }
      await enc.flush();
      const t0 = performance.now();
      for (let i = 0; i < FRAMES; i++) {
        ctx.fillStyle = `rgb(${(i * 11) % 255},${(i * 29) % 255},${(i * 7) % 255})`; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#fff'; ctx.fillRect((i * 17) % W, (i * 23) % H, W / 4, H / 8);
        const f = new VideoFrame(canvas, { timestamp: (i + 10) * 33333 }); enc.encode(f); f.close();
        if (enc.encodeQueueSize > 8) { while (enc.encodeQueueSize > 2) await new Promise(r => setTimeout(r, 1)); }
      }
      await enc.flush();
      const ms = (performance.now() - t0) / FRAMES;
      try { enc.close(); } catch (e) {}
      return { ms, err };
    };

    const samples = {}; CONFIGS.forEach(c => samples[c.name] = []);
    for (let rep = 0; rep < REPS; rep++) {
      for (const cfg of CONFIGS) {
        const r = await once(cfg);
        samples[cfg.name].push(r.ms === null ? { err: r.err } : +r.ms.toFixed(2));
      }
    }
    const med = (a) => { const n = a.filter(x => typeof x === 'number').sort((x, y) => x - y); return n.length ? n[Math.floor(n.length / 2)] : null; };
    return CONFIGS.map(c => ({ name: c.name, samples: samples[c.name], median: med(samples[c.name]) }));
  });

  console.log('config                   median ms/frame   samples');
  for (const r of results) console.log(`${r.name.padEnd(24)} ${String(r.median).padStart(8)}          ${JSON.stringify(r.samples)}`);
  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
