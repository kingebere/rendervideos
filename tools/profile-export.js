#!/usr/bin/env node
// Step 2 of MAC_DEBUG_PROMPT.md: drive a REAL export and read the per-stage profile.
//
// Runs the genuine exportZip() path (not an isolated micro-benchmark) so all four stages
// are measured under identical machine conditions -- the only way to compare their shares
// on a box whose clock speed drifts. Renders a bounded number of frames, then reads
// window.__exportProfile.
//
// Usage: node tools/profile-export.js [clipName] [renderSeconds]
const { chromium } = require('playwright');

const CLIP = process.argv[2] || 'prof90.mp4';
const RUN_S = Number(process.argv[3] || 240);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (/error|fail|fallback|software|denied/i.test(t)) console.log('  [page]', t.slice(0, 200)); });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));

  await page.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.exportZip === 'function', { timeout: 60000 });
  console.log('app loaded, coi =', await page.evaluate(() => crossOriginIsolated));

  const setup = await page.evaluate(async (clip) => {
    if (typeof waitForOcrReady === 'function') { try { await waitForOcrReady(120000); } catch (e) {} }
    const blob = await (await fetch('/media/' + clip)).blob();
    const file = new File([blob], clip, { type: 'video/mp4' });
    const url = URL.createObjectURL(file);
    const v = await new Promise((res, rej) => {
      const el = document.createElement('video');
      el.preload = 'auto'; el.muted = true; el.src = url;
      el.onloadedmetadata = () => res(el); el.onerror = () => rej(new Error('video load failed'));
    });
    const DUR = v.duration;
    flows.length = 0; flows.push({ id: 'f1', name: 'Flow 1', color: '#48f' });
    const vid = {
      id: 'v_prof', name: file.name, sizeMB: String((blob.size / 1048576).toFixed(0)), duration: DUR,
      source: 'unknown', objectURL: url, originalObjectURL: url, frames: [], extracted: false,
      cutRanges: [], flowRanges: [{ flowId: 'f1', start: 0, end: DUR }], redactionRanges: [],
      mimeType: file.type, file, codec: 'hevc', needsTranscode: false,
    };
    videos.length = 0; videos.push(vid);
    // Swallow the ZIP so disk I/O is not part of the measurement.
    try { UZIP_STREAM_THRESHOLD = 1; } catch (e) {}
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }) });
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const chk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
    set('exp-appname', 'MacProfile'); set('vex-fps', '30');
    chk('e-all', true);
    window.__done = false; window.__err = null;
    window.__t0 = performance.now();
    exportZip('all', { keepModal: true }).then(() => { window.__done = true; }).catch(e => { window.__err = String(e && e.stack || e); window.__done = true; });
    return { duration: DUR, mb: +(blob.size / 1048576).toFixed(1), w: v.videoWidth, h: v.videoHeight };
  }, CLIP);
  console.log('source:', JSON.stringify(setup));

  const deadline = Date.now() + RUN_S * 1000;
  let last = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(15000);
    const s = await page.evaluate(() => ({
      pf: window.__exportProfile ? Object.assign({}, window.__exportProfile) : null,
      done: window.__done, err: window.__err,
      ui: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 110),
    }));
    if (s.pf && s.pf.frames) {
      const f = s.pf.frames;
      last = s.pf;
      console.log(`frames=${f}  decodeDraw=${(s.pf.decodeDraw / f).toFixed(2)}  statusbar=${(s.pf.statusbar / f).toFixed(2)}  composite=${(s.pf.composite / f).toFixed(2)}  encode=${(s.pf.encode / f).toFixed(2)}  gate=${s.pf.gateHit}/${s.pf.gateHit + s.pf.gateMiss}`);
    } else {
      console.log('  (no frames yet)', s.ui);
    }
    if (s.done) { console.log('export finished/errored:', s.err ? s.err.slice(0, 300) : 'ok'); break; }
  }

  const final = await page.evaluate(() => ({ pf: window.__exportProfile, done: window.__done, err: window.__err, elapsed: (performance.now() - window.__t0) / 1000 }));
  if (final.pf && final.pf.frames) {
    const f = final.pf.frames, p = final.pf;
    const tot = (p.decodeDraw + p.statusbar + p.composite + p.encode) / f;
    console.log('\n=== PER-STAGE ms/frame (Mac) ===');
    const row = (n, v) => console.log(`${n.padEnd(13)} ${(v / f).toFixed(2).padStart(8)}   ${(100 * (v / f) / tot).toFixed(1)}%`);
    row('decode-draw', p.decodeDraw); row('status-bar', p.statusbar); row('composite', p.composite); row('encode', p.encode);
    console.log(`${'TOTAL'.padEnd(13)} ${tot.toFixed(2).padStart(8)}   frames=${f}  wall=${final.elapsed.toFixed(1)}s`);
    const gh=p.gateHit||0, gm=p.gateMiss||0;
    if(gh+gm) console.log(`gate hits ${gh}/${gh+gm} = ${(100*gh/(gh+gm)).toFixed(1)}%`);
    console.log('RAW ' + JSON.stringify(final.pf));
  } else console.log('NO PROFILE DATA', JSON.stringify(final).slice(0, 300));
  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
