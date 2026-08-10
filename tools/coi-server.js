#!/usr/bin/env node
// Static server for the Mac export profiling run.
//
// WebCodecs work in this app is gated behind crossOriginIsolated, which needs COOP+COEP.
// Under COEP:require-corp every subresource must opt in, so CORP:cross-origin goes on
// every response. The source recording is served from this same origin (/media/...) rather
// than a second port, because a second origin would need its own CORP handling and would
// also taint the canvas -- the tainting that has already broken two measurement runs.
//
// Range support is mandatory here: the source is 2.25GB and the profiler seeks into it.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || process.cwd();
const MEDIA = process.argv[3] || '';
const PORT = Number(process.argv[4] || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.traineddata': 'application/octet-stream',
};

const coi = (res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
};

http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch { urlPath = req.url.split('?')[0]; }

  let file;
  if (urlPath.startsWith('/media/')) {
    if (!MEDIA) { res.writeHead(404); return res.end('no media root'); }
    file = path.join(MEDIA, urlPath.slice('/media/'.length));
    if (!file.startsWith(path.resolve(MEDIA))) { res.writeHead(403); return res.end('denied'); }
  } else {
    file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(path.resolve(ROOT))) { res.writeHead(403); return res.end('denied'); }
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { coi(res); res.writeHead(404); return res.end('not found'); }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    coi(res);
    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (isNaN(start) || start < 0) start = 0;
        if (isNaN(end) || end >= st.size) end = st.size - 1;
        if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, { 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`COI server: root=${ROOT} media=${MEDIA || '(none)'} http://127.0.0.1:${PORT}`);
});
