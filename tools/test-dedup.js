// Verifies the export screenshot dedup: identical frames must compare similar, genuinely
// different content must not, and a status-bar-only change (clock tick) must NOT count as
// a change -- that last one is why the sample excludes the top/bottom of the frame.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await p.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 300000 });
  await p.waitForFunction(() => typeof shotDedupSample === 'function', null, { timeout: 300000 });

  const r = await p.evaluate(() => {
    const SENS = 5;
    const mk = (draw) => { const c = document.createElement('canvas'); c.width = 1290; c.height = 2796;
      const x = c.getContext('2d'); x.fillStyle = '#f0e9d8'; x.fillRect(0, 0, 1290, 2796); draw(x); return c; };
    const base = mk(x => { x.fillStyle = '#333'; for (let i = 0; i < 14; i++) x.fillRect(120, 500 + i * 130, 900, 60); });
    const sameAgain = mk(x => { x.fillStyle = '#333'; for (let i = 0; i < 14; i++) x.fillRect(120, 500 + i * 130, 900, 60); });
    // Only the status bar area differs (a clock tick) -- must still read as duplicate.
    const clockTick = mk(x => { x.fillStyle = '#333'; for (let i = 0; i < 14; i++) x.fillRect(120, 500 + i * 130, 900, 60);
      x.fillStyle = '#000'; x.fillRect(90, 40, 160, 50); });
    // Content scrolled -- must read as different.
    const scrolled = mk(x => { x.fillStyle = '#333'; for (let i = 0; i < 14; i++) x.fillRect(120, 380 + i * 130, 900, 60); });
    // Whole new screen -- must read as different.
    const other = mk(x => { x.fillStyle = '#204080'; x.fillRect(0, 300, 1290, 2000); });

    const s = (c) => shotDedupSample(c);
    return {
      identical: similar(s(base), s(sameAgain), SENS),
      clockTickOnly: similar(s(base), s(clockTick), SENS),
      scrolled: similar(s(base), s(scrolled), SENS),
      differentScreen: similar(s(base), s(other), SENS),
    };
  });

  const check = (name, got, want) => console.log(`${want === got ? 'PASS' : 'FAIL'}  ${name}: got ${got}, want ${want}`);
  check('identical frames -> duplicate', r.identical, true);
  check('status-bar clock tick only -> still duplicate', r.clockTickOnly, true);
  check('content scrolled -> NOT duplicate', r.scrolled, false);
  check('different screen -> NOT duplicate', r.differentScreen, false);
  console.log('pageerrors:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('FAILED', String(e).slice(0, 300)); process.exit(1); });
