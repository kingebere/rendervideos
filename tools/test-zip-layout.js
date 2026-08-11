#!/usr/bin/env node
// Proves the per-flow duplication fix, using the case that caused the 8GB report:
// several flows ALL covering the whole clip, so every frame is claimed by every flow.
// Before the fix each image was written once per flow (N copies); after, once total.
//
// Also re-checks the exported VIDEO stream hash, because the screenshot dedup was edited
// inside renderSampleFrame -- a mistake there would drop frames from the video itself.
const { chromium } = require('playwright');
const fs = require('fs');

const CLIP = process.argv[2] || 'real12.mp4';
const NFLOWS = Number(process.argv[3] || 5);
const OUT = process.argv[4] || '/tmp/layout.zip';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
  await page.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 300000 });
  await page.waitForFunction(() => typeof window.exportZip === 'function', null, { timeout: 300000 });

  await page.evaluate(async ([clip, n]) => {
    if (typeof waitForOcrReady === 'function') { try { await waitForOcrReady(180000); } catch (e) {} }
    const blob = await (await fetch('/media/' + clip)).blob();
    const file = new File([blob], clip, { type: 'video/mp4' });
    const url = URL.createObjectURL(file);
    const v = await new Promise((res, rej) => { const el = document.createElement('video'); el.preload='auto'; el.muted=true; el.src=url; el.onloadedmetadata=()=>res(el); el.onerror=()=>rej(new Error('load')); });
    const DUR = v.duration;
    flows.length = 0;
    const ranges = [];
    // Every flow spans the ENTIRE clip -> every frame belongs to every flow.
    for (let i = 0; i < n; i++) { const id = 'ov' + i; flows.push({ id, name: 'Flow ' + (i+1), color: '#48f' }); ranges.push({ flowId: id, start: 0, end: DUR }); }
    videos.length = 0;
    videos.push({ id:'v_ov', name:file.name, sizeMB:'1', duration:DUR, source:'unknown', objectURL:url, originalObjectURL:url, frames:[], extracted:false, cutRanges:[], flowRanges:ranges, redactionRanges:[], mimeType:file.type, file, codec:'hevc', needsTranscode:false });
    try { UZIP_STREAM_THRESHOLD = 1; } catch (e) {}
    window.__chunks = [];
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async (x) => { const b = x && x.buffer ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : new Uint8Array(x); window.__chunks.push(Array.from(b)); }, close: async()=>{}, abort: async()=>{} }) });
    const set=(id,val)=>{const el=document.getElementById(id);if(el)el.value=val;};
    const chk=(id,val)=>{const el=document.getElementById(id);if(el)el.checked=val;};
    set('exp-appname','Layout'); set('vex-fps','30'); chk('e-all',true); chk('e-manifest',true); chk('e-csv',true);
    window.__done=false; window.__err=null;
    exportZip('all',{keepModal:true}).then(()=>{window.__done=true;}).catch(e=>{window.__err=String(e&&e.stack||e);window.__done=true;});
  }, [CLIP, NFLOWS]);

  const t0 = Date.now();
  while (Date.now() - t0 < 30 * 60 * 1000) {
    await page.waitForTimeout(15000);
    const s = await page.evaluate(() => ({ done: window.__done, err: window.__err, n: (window.__chunks||[]).length }));
    process.stdout.write(`  chunks=${s.n} ${s.done ? 'DONE' : ''}\n`);
    if (s.done) { if (s.err) { console.log('EXPORT ERROR:', s.err.slice(0,400)); process.exit(1); } break; }
  }
  const count = await page.evaluate(() => (window.__chunks||[]).length);
  const fd = fs.openSync(OUT, 'w');
  for (let i = 0; i < count; i++) fs.writeSync(fd, Buffer.from(await page.evaluate(i => window.__chunks[i], i)));
  fs.closeSync(fd);
  console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes', '| flows:', NFLOWS);
  await browser.close();
})().catch(e => { console.error('FAILED', String(e).slice(0,300)); process.exit(1); });
