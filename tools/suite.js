#!/usr/bin/env node
// Consolidated measurement suite -- ONE Chrome launch for all of it.
//
// Launching a fresh Chrome per script was itself degrading the machine: each launch drags
// macOS Gatekeeper through signature checks (tccd + syspolicyd were burning ~70% CPU
// between them) and timed-out runs leak browser processes. Load average climbed 84 -> 372
// across the session, which corrupts exactly the timings being measured. One launch, one
// page, every measurement sequential.
//
// Usage: node tools/suite.js
const { chromium } = require('playwright');
const fs = require('fs');

const S = '/private/tmp/claude-501/-Users-mac-Documents-rendervideos/44932aa7-8e1e-45ab-a8ad-c489cda31689/scratchpad';
const CLIP = process.argv[2] || 'verify15.mp4';
const TOLS = (process.argv[3] || '4,8,12').split(',');

async function exportOnce(page, clip, tol) {
  await page.evaluate(async ([clip, tol]) => {
    if (typeof waitForOcrReady === 'function') { try { await waitForOcrReady(180000); } catch (e) {} }
    SB_STATUS_GATE_TOLERANCE = Number(tol);
    const blob = await (await fetch('/media/' + clip)).blob();
    const file = new File([blob], clip, { type: 'video/mp4' });
    const url = URL.createObjectURL(file);
    const v = await new Promise((res, rej) => { const el = document.createElement('video'); el.preload = 'auto'; el.muted = true; el.src = url; el.onloadedmetadata = () => res(el); el.onerror = () => rej(new Error('load')); });
    const DUR = v.duration;
    flows.length = 0;
    const ranges = [];
    for (let i = 0; i < 3; i++) { const id = 'fv' + i; flows.push({ id, name: 'Flow ' + (i + 1), color: '#48f' }); ranges.push({ flowId: id, start: i * (DUR / 3), end: (i + 1) * (DUR / 3) }); }
    videos.length = 0;
    videos.push({ id: 'v_ver', name: file.name, sizeMB: '1', duration: DUR, source: 'unknown', objectURL: url, originalObjectURL: url, frames: [], extracted: false, cutRanges: [], flowRanges: ranges, redactionRanges: [], mimeType: file.type, file, codec: 'hevc', needsTranscode: false });
    try { UZIP_STREAM_THRESHOLD = 1; } catch (e) {}
    window.__chunks = [];
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async (x) => { const b = x && x.buffer ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : new Uint8Array(x); window.__chunks.push(Array.from(b)); }, close: async () => {}, abort: async () => {} }) });
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const chk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
    set('exp-appname', 'Verify'); set('vex-fps', '30'); chk('e-all', true); chk('e-manifest', true);
    window.__done = false; window.__err = null; window.__t0 = performance.now();
    exportZip('all', { keepModal: true }).then(() => { window.__done = true; }).catch(e => { window.__err = String(e && e.stack || e); window.__done = true; });
  }, [clip, tol]);

  const t0 = Date.now();
  while (Date.now() - t0 < 40 * 60 * 1000) {
    await page.waitForTimeout(15000);
    const s = await page.evaluate(() => ({ done: window.__done, err: window.__err, n: (window.__chunks || []).length, el: (performance.now() - window.__t0) / 1000 }));
    process.stdout.write(`   tol=${tol} chunks=${s.n} ${s.el.toFixed(0)}s ${s.done ? 'DONE' : ''}\n`);
    if (s.done) { if (s.err) { console.log('   EXPORT ERROR:', s.err.slice(0, 300)); return null; } break; }
  }
  const renderSec = await page.evaluate(() => (performance.now() - window.__t0) / 1000);
  const count = await page.evaluate(() => (window.__chunks || []).length);
  const out = `${S}/suite_tol${tol}.zip`;
  const fd = fs.openSync(out, 'w');
  for (let i = 0; i < count; i++) fs.writeSync(fd, Buffer.from(await page.evaluate((i) => window.__chunks[i], i)));
  fs.closeSync(fd);
  console.log(`   wrote ${out} (${fs.statSync(out).size} bytes, ${renderSec.toFixed(1)}s)`);
  return out;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 200)));
  await page.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => typeof window.exportZip === 'function', { timeout: 180000 });
  console.log('app loaded, coi=', await page.evaluate(() => crossOriginIsolated));

  for (const t of TOLS) {
    console.log('=== export @ tolerance ' + t + ' ===');
    await exportOnce(page, CLIP, t);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => typeof window.exportZip === 'function', { timeout: 180000 });
  }

  console.log('\n=== gate hit rates on this clip ===');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => typeof window.exportZip === 'function', { timeout: 180000 });
  const tb = await page.evaluate(async (CLIPNAME) => {
    const blob = await (await fetch('/media/' + CLIPNAME)).blob();
    const v = document.createElement('video');
    v.src = URL.createObjectURL(blob); v.muted = true; v.preload = 'auto';
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('load')); });
    const W = v.videoWidth, H = v.videoHeight, bandH = Math.max(1, Math.ceil(H * 0.11));
    const full = document.createElement('canvas'); full.width = W; full.height = H;
    const fctx = full.getContext('2d', { willReadFrequently: true });
    const seek = (t) => new Promise(r => { v.onseeked = () => r(); v.currentTime = t; });
    const variants = [
      { name: 'smooth 192x48 (current)', tw: 192, th: 48, smooth: true },
      { name: 'nearest 192x48', tw: 192, th: 48, smooth: false },
      { name: 'nearest 96x24', tw: 96, th: 24, smooth: false },
      { name: 'nearest 64x16', tw: 64, th: 16, smooth: false },
    ];
    for (const va of variants) {
      va.c = document.createElement('canvas'); va.c.width = va.tw; va.c.height = va.th;
      va.ctx = va.c.getContext('2d', { willReadFrequently: true });
      va.ms = 0; va.tiles = [];
    }
    const FRAMES = 150;
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
    return variants.map(va => {
      const row = { name: va.name, msPerFrame: +(va.ms / FRAMES).toFixed(2), hits: {} };
      for (const tol of [4, 8, 12, 20]) {
        let ref = null, hit = 0, maxDrift = 0;
        for (const tile of va.tiles) {
          if (!ref) { ref = tile; continue; }
          let mx = 0;
          for (let p = 0; p < tile.length; p++) { const dd = Math.abs(tile[p] - ref[p]); if (dd > mx) { mx = dd; if (mx > tol) break; } }
          if (mx > tol) ref = tile; else { hit++; if (mx > maxDrift) maxDrift = mx; }
        }
        row.hits['t' + tol] = +(100 * hit / (va.tiles.length - 1)).toFixed(1);
      }
      return row;
    });
  }, CLIP);
  console.log('variant                   ms/frame    hit% @ t4/t8/t12/t20');
  for (const r of tb) console.log(`${r.name.padEnd(24)} ${String(r.msPerFrame).padStart(7)}    ${r.hits.t4}/${r.hits.t8}/${r.hits.t12}/${r.hits.t20}`);
  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
