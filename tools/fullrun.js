#!/usr/bin/env node
// Full-length end-to-end export, timed. No projections -- this runs the real exportZip()
// over the entire 46-minute source with 27 flows (the user-reported scenario) and reports
// measured wall time.
//
// Source is the genuine 2.25GB HEVC original, served by range requests. On an 8GB machine
// Chrome spills large blobs to disk, so this may still work; if the load fails the run
// aborts loudly rather than quietly substituting a re-encode (a re-encode changes codec
// noise, which changes the gate hit rate, which is the thing under test).
//
// Usage: node tools/fullrun.js <srcPath-on-server> <tolerance>
const { chromium } = require('playwright');

const SRC = process.argv[2] || '/_src.MP4';
const TOL = process.argv[3] !== undefined ? process.argv[3] : '4';
const FLOWS = Number(process.argv[4] || 27);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
  await page.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 300000 });
  await page.waitForFunction(() => typeof window.exportZip === 'function', { timeout: 300000 });
  console.log('app loaded, coi=', await page.evaluate(() => crossOriginIsolated), 'tolerance=', TOL, 'flows=', FLOWS);

  const setup = await page.evaluate(async ([src, tol, nflows]) => {
    if (typeof waitForOcrReady === 'function') { try { await waitForOcrReady(300000); } catch (e) {} }
    SB_STATUS_GATE_TOLERANCE = Number(tol);
    const t0 = performance.now();
    const blob = await (await fetch(src)).blob();
    const loadSec = (performance.now() - t0) / 1000;
    const file = new File([blob], 'src.MP4', { type: 'video/mp4' });
    const url = URL.createObjectURL(file);
    const v = await new Promise((res, rej) => {
      const el = document.createElement('video');
      el.preload = 'metadata'; el.muted = true; el.src = url;
      el.onloadedmetadata = () => res(el);
      el.onerror = () => rej(new Error('video load failed'));
      setTimeout(() => rej(new Error('video metadata timeout')), 300000);
    });
    const DUR = v.duration;
    flows.length = 0;
    const ranges = [];
    for (let i = 0; i < nflows; i++) {
      const id = 'fl' + i;
      flows.push({ id, name: 'Flow ' + (i + 1), color: '#48f' });
      const s = i * (DUR / nflows) + 1;
      ranges.push({ flowId: id, start: s, end: s + (DUR / nflows) - 2 });
    }
    videos.length = 0;
    videos.push({
      id: 'v_full', name: file.name, sizeMB: String((blob.size / 1048576).toFixed(0)), duration: DUR,
      source: 'unknown', objectURL: url, originalObjectURL: url, frames: [], extracted: false,
      cutRanges: [], flowRanges: ranges, redactionRanges: [], mimeType: file.type, file,
      codec: 'hevc', needsTranscode: false,
    });
    try { UZIP_STREAM_THRESHOLD = 1; } catch (e) {}
    let written = 0;
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async (x) => { written += (x && x.byteLength) || 0; window.__zipMB = +(written / 1048576).toFixed(1); }, close: async () => {}, abort: async () => {} }) });
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const chk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
    set('exp-appname', 'FullRun'); set('vex-fps', '30'); chk('e-all', true); chk('e-manifest', true);
    window.__done = false; window.__err = null; window.__t0 = performance.now();
    exportZip('all', { keepModal: true }).then(() => { window.__done = true; }).catch(e => { window.__err = String(e && e.stack || e); window.__done = true; });
    return { durationSec: DUR, mb: +(blob.size / 1048576).toFixed(1), loadSec: +loadSec.toFixed(1), flows: ranges.length, w: v.videoWidth, h: v.videoHeight };
  }, [SRC, TOL, FLOWS]);
  console.log('SOURCE', JSON.stringify(setup));

  const started = Date.now();
  while (Date.now() - started < 6 * 60 * 60 * 1000) {
    await page.waitForTimeout(60000);
    const s = await page.evaluate(() => ({
      done: window.__done, err: window.__err, zipMB: window.__zipMB || 0,
      el: (performance.now() - window.__t0) / 1000,
      ui: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 100),
    }));
    console.log(`t=${(s.el / 60).toFixed(1)}min zip=${s.zipMB}MB ${s.done ? 'DONE' : ''} :: ${s.ui}`);
    if (s.done) { if (s.err) console.log('EXPORT ERROR:', s.err.slice(0, 400)); break; }
  }

  const fin = await page.evaluate(() => ({ el: (performance.now() - window.__t0) / 1000, err: window.__err, zipMB: window.__zipMB }));
  console.log('');
  console.log('=== FULL EXPORT RESULT (measured, end to end) ===');
  console.log('source duration : ' + (setup.durationSec / 60).toFixed(1) + ' min (' + setup.mb + ' MB, ' + setup.w + 'x' + setup.h + ')');
  console.log('flows           : ' + setup.flows);
  console.log('gate tolerance  : ' + TOL);
  console.log('TOTAL WALL TIME : ' + (fin.el / 60).toFixed(1) + ' min  (' + (fin.el / 3600).toFixed(2) + ' h)');
  console.log('realtime factor : ' + (fin.el / setup.durationSec).toFixed(2) + 'x');
  console.log('zip written     : ' + fin.zipMB + ' MB');
  if (fin.err) console.log('ERROR: ' + fin.err.slice(0, 300));
  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
