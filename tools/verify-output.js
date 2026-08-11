#!/usr/bin/env node
// Step 4 of MAC_DEBUG_PROMPT.md: prove the gate fix did not change the OUTPUT.
//
// Exports the same clip twice through the real exportZip() path -- once with the gate
// disabled (SB_STATUS_GATE_TOLERANCE=-1, i.e. the original always-analyse behaviour) and
// once with it enabled -- capturing the produced ZIP bytes both times. The two ZIPs are
// written to disk so their contents (master MP4, manifest, flow routing) can be compared
// and the video frames diffed with ffmpeg.
//
// Usage: node tools/verify-output.js <clip> <tolerance> <outfile>
const { chromium } = require('playwright');
const fs = require('fs');

const CLIP = process.argv[2] || 'verify15.mp4';
const TOL = process.argv[3] === undefined ? '4' : process.argv[3];
const OUT = process.argv[4] || `/tmp/out_${TOL}.zip`;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 200)));
  await page.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => typeof window.exportZip === 'function', { timeout: 180000 });

  await page.evaluate(async ([clip, tol]) => {
    if (typeof waitForOcrReady === 'function') { try { await waitForOcrReady(120000); } catch (e) {} }
    SB_STATUS_GATE_TOLERANCE = Number(tol);
    const blob = await (await fetch('/media/' + clip)).blob();
    const file = new File([blob], clip, { type: 'video/mp4' });
    const url = URL.createObjectURL(file);
    const v = await new Promise((res, rej) => { const el = document.createElement('video'); el.preload = 'auto'; el.muted = true; el.src = url; el.onloadedmetadata = () => res(el); el.onerror = () => rej(new Error('load')); });
    const DUR = v.duration;
    // 3 flows so flow routing is exercised, not just a single passthrough range.
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
    window.__done = false; window.__err = null;
    exportZip('all', { keepModal: true }).then(() => { window.__done = true; }).catch(e => { window.__err = String(e && e.stack || e); window.__done = true; });
  }, [CLIP, TOL]);

  const t0 = Date.now();
  while (Date.now() - t0 < 20 * 60 * 1000) {
    await page.waitForTimeout(10000);
    const s = await page.evaluate(() => ({ done: window.__done, err: window.__err, n: (window.__chunks || []).length, ui: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 90) }));
    process.stdout.write(`  chunks=${s.n} ${s.done ? 'DONE' : ''} ${s.ui}\n`);
    if (s.done) { if (s.err) console.log('EXPORT ERROR:', s.err.slice(0, 400)); break; }
  }

  const size = await page.evaluate(() => (window.__chunks || []).reduce((a, c) => a + c.length, 0));
  console.log('zip bytes:', size);
  const fd = fs.openSync(OUT, 'w');
  const count = await page.evaluate(() => (window.__chunks || []).length);
  for (let i = 0; i < count; i++) {
    const arr = await page.evaluate((i) => window.__chunks[i], i);
    fs.writeSync(fd, Buffer.from(arr));
  }
  fs.closeSync(fd);
  console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');

  const meta = await page.evaluate(() => window.__lastExportMeta || null);
  if (meta) console.log('export meta:', JSON.stringify(meta));
  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
