#!/usr/bin/env node
/**
 * tools/serve.js — a local dev server for the frontend.
 *
 * WHY THIS EXISTS
 *   The app is static files with a PATH-based router (/organiser/auction, not
 *   #/organiser/auction). Any plain static server returns 404 for those paths,
 *   because no such file exists. In production GitHub Pages serves 404.html,
 *   which bounces the request into index.html — see frontend/404.html.
 *
 *   This server does the same thing locally: unknown paths under BASE_PATH get
 *   index.html, so the router can do its job.
 *
 * WHAT IT DOES NOT DO
 *   It does not serve the backend. The backend is Google Apps Script and only
 *   runs inside Google. Every screen here calls that API, so with no reachable
 *   /exec URL you will see each page's shell and its error state, not live data.
 *   That is still useful for layout, styling and the projector view, and it is
 *   the only way to eyeball the EXIF photo rotation (KNOWN-ISSUES item 1).
 *
 * USAGE
 *   node tools/serve.js            then open the URL it prints
 *   node tools/serve.js 3000       on a different port
 *   npm run serve
 *
 * No dependencies. Node's own http and fs only.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const PORT = Number(process.argv[2]) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/** Read CONFIG.BASE_PATH out of config.js so the two cannot disagree. */
function readBasePath() {
  try {
    const src = fs.readFileSync(path.join(FRONTEND, 'js', 'config.js'), 'utf8');
    const m = src.match(/BASE_PATH:\s*'([^']*)'/);
    return m ? m[1] : '';
  } catch (e) {
    return '';
  }
}

/** Warn if the API URL looks unusable, since every screen depends on it. */
function apiWarning() {
  try {
    const src = fs.readFileSync(path.join(FRONTEND, 'js', 'config.js'), 'utf8');
    const m = src.match(/API_BASE_URL:\s*'([^']*)'/);
    const url = m ? m[1] : '';
    if (!url || /PASTE_YOUR/.test(url)) {
      return 'API_BASE_URL is not set. Every screen will show its "setup needed" banner.';
    }
    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) {
      return 'API_BASE_URL does not look like an Apps Script /exec URL: ' + url;
    }
    return null;
  } catch (e) {
    return 'Could not read js/config.js.';
  }
}

const BASE = readBasePath();

const server = http.createServer(function (req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400).end('Bad request');
    return;
  }

  // Strip BASE_PATH so '/cricket-auction/js/app.js' finds 'frontend/js/app.js'.
  let rel = urlPath;
  if (BASE && (rel === BASE || rel.indexOf(BASE + '/') === 0)) {
    rel = rel.slice(BASE.length) || '/';
  }

  // Resolve inside frontend/ and refuse anything that escapes it.
  const target = path.join(FRONTEND, rel);
  const resolved = path.resolve(target);
  if (resolved !== FRONTEND && resolved.indexOf(FRONTEND + path.sep) !== 0) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(resolved, function (err, st) {
    if (!err && st.isFile()) return send(res, resolved);

    if (!err && st.isDirectory()) {
      const idx = path.join(resolved, 'index.html');
      if (fs.existsSync(idx)) return send(res, idx);
    }

    // The SPA fallback. A real file was not found, so this is a route, not a
    // missing asset — hand over index.html and let the router match it. Assets
    // are excluded so a genuine typo in a script src still shows up as a 404
    // instead of silently returning HTML.
    if (/\.(js|css|png|jpe?g|svg|ico|json|map)$/i.test(rel)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
        .end('Not found: ' + rel + '\n\nThis is an asset path, so it is a real missing file.');
      return;
    }
    send(res, path.join(FRONTEND, 'index.html'));
  });
});

function send(res, file) {
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(500).end('Read error'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // No caching: this is for iterating on the UI.
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}

server.listen(PORT, function () {
  const base = 'http://localhost:' + PORT + (BASE || '');
  console.log('Serving frontend/ on ' + base);
  console.log('  SPA fallback is on, so path routes work locally.\n');

  const warn = apiWarning();
  if (warn) console.log('  WARNING: ' + warn + '\n');

  console.log('  Screens:');
  console.log('    ' + base + '/admin/login');
  console.log('    ' + base + '/admin/dashboard');
  console.log('    ' + base + '/admin/payments');
  console.log('    ' + base + '/admin/players');
  console.log('    ' + base + '/admin/reports');
  console.log('    ' + base + '/admin/audit');
  console.log('    ' + base + '/admin/organisers');
  console.log('    ' + base + '/organiser/dashboard');
  console.log('    ' + base + '/organiser/auction        <- the auction console');
  console.log('    ' + base + '/auction/TRN_x/display?k=TOKEN');
  console.log('    ' + base + '/register/TRN_x');
  console.log('\n  The backend is Apps Script and does not run locally. Without a');
  console.log('  reachable /exec URL you get each page\'s shell and error state,');
  console.log('  not live data. Ctrl+C to stop.');
});
