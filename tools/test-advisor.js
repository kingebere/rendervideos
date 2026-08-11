// Deterministic test of the export speed advisor. Drives exportSpeedWatch with a synthetic
// clock so the thermal-drop branch can be exercised without waiting for a real slow export.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await p.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 300000 });
  await p.waitForFunction(() => typeof exportSpeedWatch === 'function', null, { timeout: 300000 });

  const r = await p.evaluate(() => {
    const out = {};
    const toasts = [];
    const realToast = window.toast;
    window.toast = (i, m) => { toasts.push(i + ' ' + m.slice(0, 60)); };

    // Fake the clock so elapsed time is controllable.
    const realNow = performance.now.bind(performance);
    let fake = 0;
    performance.now = () => fake;

    resetExportSpeedWatch();
    // Feed steady 1.0x progress for 3 minutes (a sample every 15s), then a hard 5x slowdown.
    let fakeDone = 0;
    const step = (dtSec, outSec) => { fake += dtSec * 1000; fakeDone += outSec; return exportSpeedWatch(fakeDone, 2760); };
    out.early = exportSpeedWatch(0, 2760);
    let last = '';
    for (let i = 0; i < 12; i++) last = step(15, 15);   // 180s wall, 180s output => 1.0x
    out.steady = last;
    out.toastsAfterSteady = toasts.length;
    for (let i = 0; i < 12; i++) last = step(15, 3);    // 180s wall, 36s output => 0.2x
    out.slow = last;
    out.toastsAfterSlow = toasts.slice();
    performance.now = realNow;
    window.toast = realToast;
    return out;
  });

  console.log('early (no progress) ETA :', JSON.stringify(r.early));
  console.log('warmup ETA             :', JSON.stringify(r.warmup));
  console.log('baseline ETA           :', JSON.stringify(r.baseline));
  console.log('steady ETA             :', JSON.stringify(r.steady));
  console.log('toasts while steady    :', r.toastsAfterSteady, '(expect 0)');
  console.log('slow ETA               :', JSON.stringify(r.slow));
  console.log('toasts after slowdown  :', JSON.stringify(r.toastsAfterSlow));
  console.log('pageerrors             :', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('FAILED', String(e).slice(0, 300)); process.exit(1); });
