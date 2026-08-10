#!/usr/bin/env node
// GPU / video-acceleration info via CDP SystemInfo.getInfo.
// chrome://gpu renders an empty body through CDP, but SystemInfo.getInfo is the same
// underlying data -- crucially including videoDecoding/videoEncoding accelerator profiles,
// which is what tells us whether a hardware H.264 ENCODER exists for this frame size.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage();
  const cdp = await browser.newBrowserCDPSession();
  let info;
  try { info = await cdp.send('SystemInfo.getInfo'); }
  catch (e) { console.error('SystemInfo.getInfo failed:', e.message); await browser.close(); process.exit(1); }

  const gpu = info.gpu || {};
  console.log('=== devices ===');
  for (const d of gpu.devices || []) {
    console.log(`  vendor=${d.vendorId} device=${d.deviceId} ${d.vendorString || ''} ${d.deviceString || ''} driver=${d.driverVersion || ''}`);
  }
  console.log('modelName:', info.modelName, '| modelVersion:', info.modelVersion);
  console.log('driverBugWorkarounds:', (gpu.driverBugWorkarounds || []).join(', ') || '(none)');

  const fmt = (arr, label) => {
    console.log(`=== ${label} ===`);
    if (!arr || !arr.length) { console.log('  (none reported -- no hardware acceleration for this category)'); return; }
    for (const p of arr) {
      console.log(`  profile=${p.profile} max=${p.maxResolution && (p.maxResolution.width + 'x' + p.maxResolution.height)} min=${p.minResolution && (p.minResolution.width + 'x' + p.minResolution.height)}${p.encoded !== undefined ? ' encoded=' + p.encoded : ''}`);
    }
  };
  fmt(gpu.videoDecoding, 'videoDecoding (hardware)');
  fmt(gpu.videoEncoding, 'videoEncoding (hardware)');
  fmt(gpu.imageDecoding, 'imageDecoding (hardware)');

  console.log('=== auxAttributes (selected) ===');
  const aux = gpu.auxAttributes || {};
  for (const k of Object.keys(aux)) {
    if (/video|accelerat|gl_renderer|gl_vendor|metal|passthrough|software|sandbox/i.test(k)) {
      console.log(`  ${k} = ${JSON.stringify(aux[k])}`);
    }
  }
  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
