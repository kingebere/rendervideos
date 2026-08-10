#!/usr/bin/env node
// Step 1 of MAC_DEBUG_PROMPT.md: capability probe + chrome://gpu scrape, in real Chrome.
// Uses the ACTUAL source dimensions (1290x2796) as the brief requires -- the whole
// hypothesis is that VideoToolbox rejects tall portrait dims, so probing at 1920x1080
// would answer the wrong question.
const { chromium } = require('playwright');

const W = Number(process.argv[2] || 1290);
const H = Number(process.argv[3] || 2796);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const out = {};

  await page.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'domcontentloaded' });

  out.basics = await page.evaluate(() => ({
    cores: navigator.hardwareConcurrency,
    dpr: devicePixelRatio,
    coi: crossOriginIsolated,
    ua: navigator.userAgent,
  }));

  out.codecs = await page.evaluate(async ([w, h]) => {
    const r = {};
    const probe = async (label, fn) => { try { r[label] = await fn(); } catch (e) { r[label] = { error: String(e && e.message || e) }; } };
    const dec = (codec) => VideoDecoder.isConfigSupported({ codec, codedWidth: w, codedHeight: h })
      .then(x => ({ supported: x.supported, cfg: x.config && { hw: x.config.hardwareAcceleration } }));
    const enc = (codec, extra = {}) => VideoEncoder.isConfigSupported(Object.assign({ codec, width: w, height: h, bitrate: 12000000 }, extra))
      .then(x => ({ supported: x.supported, cfg: x.config && { hw: x.config.hardwareAcceleration } }));

    await probe('hevcDecode', () => dec('hev1.1.6.L93.B0'));
    await probe('h264Decode', () => dec('avc1.640034'));
    // The brief's prime suspect: AVC High 5.2 at full portrait size.
    await probe('avcHigh52', () => enc('avc1.640034'));
    // Same codec, but explicitly demanding hardware -- if this differs from the above,
    // 'prefer-hardware' was silently resolving to software.
    await probe('avcHigh52_requireHW', () => enc('avc1.640034', { hardwareAcceleration: 'prefer-hardware' }));
    await probe('avcHigh52_requireSW', () => enc('avc1.640034', { hardwareAcceleration: 'prefer-software' }));
    // Alternative levels/profiles VideoToolbox may accept at this size.
    await probe('avcHigh51', () => enc('avc1.640033'));
    await probe('avcHigh50', () => enc('avc1.640032'));
    await probe('avcMain41', () => enc('avc1.4d0029'));
    await probe('avcBaseline41', () => enc('avc1.420029'));
    // Alternative codecs the brief suggests trying.
    await probe('hevcEncode', () => enc('hev1.1.6.L93.B0'));
    await probe('av1Encode', () => enc('av01.0.08M.08'));
    // Landscape-swapped, to test whether it is TALLNESS specifically that is rejected.
    await probe('avcHigh52_swapped', () => VideoEncoder.isConfigSupported({ codec: 'avc1.640034', width: h, height: w, bitrate: 12000000 }).then(x => ({ supported: x.supported })));
    // A safely-small size, as a control.
    await probe('avcHigh52_1080p', () => VideoEncoder.isConfigSupported({ codec: 'avc1.640034', width: 1080, height: 1920, bitrate: 12000000 }).then(x => ({ supported: x.supported })));
    return r;
  }, [W, H]);

  // chrome://gpu -- Playwright cannot script chrome:// pages via evaluate reliably,
  // so scrape rendered text instead.
  try {
    const gpu = await ctx.newPage();
    await gpu.goto('chrome://gpu', { waitUntil: 'domcontentloaded' });
    await gpu.waitForTimeout(2500);
    const txt = await gpu.evaluate(() => document.body.innerText || '');
    out.gpu = txt.split('\n').filter(l => /video decode|video encode|Vulkan|Metal|GPU0|Graphics Backend|Canvas|Chrome.*151|WebGL/i.test(l)).slice(0, 25);
    const ver = await gpu.evaluate(() => {
      const t = document.body.innerText || '';
      const m = /Google Chrome\s*\|?\s*([0-9.]+)/.exec(t) || /Chrome\s+([0-9.]+)/.exec(t);
      return m ? m[1] : null;
    });
    out.chromeVersion = ver;
    await gpu.close();
  } catch (e) { out.gpu = ['scrape failed: ' + String(e && e.message || e)]; }

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error('PROBE FAILED', e); process.exit(1); });
