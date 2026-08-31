// Boots the real frontend in a fake DOM, in the exact order index.html loads it,
// and reports the first thing that throws. Approximates what a browser does.
const fs = require('fs'), vm = require('vm'), path = require('path');
const FE = path.resolve(__dirname, '..', 'frontend');

// Load order straight from index.html, so this cannot drift from reality.
const html = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);

class El {
  constructor(t) {
    this.tagName = String(t).toUpperCase(); this.nodeType = 1; this.className = '';
    this.childNodes = []; this.parentNode = null; this.attributes = {}; this.dataset = {};
    this.style = {}; this.hidden = false; this.id = ''; this.value = ''; this.files = [];
    this.disabled = false; this.checked = false; this.type = ''; this.name = '';
    this._l = {};
    this.classList = {
      _n: this,
      add(c) { const l = String(this._n.className).split(/\s+/).filter(Boolean); if (!l.includes(c)) l.push(c); this._n.className = l.join(' '); },
      remove(c) { this._n.className = String(this._n.className).split(/\s+/).filter((x) => x && x !== c).join(' '); },
      contains(c) { return String(this._n.className).split(/\s+/).includes(c); }
    };
  }
  appendChild(c) { if (!c) throw new Error('appendChild(null) on <' + this.tagName + '>'); c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c) { return this.appendChild(c); }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i > -1) this.childNodes.splice(i, 1); return c; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  hasAttribute(k) { return k in this.attributes; }
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  removeEventListener() {}
  dispatchEvent() { return true; }
  click() {}
  focus() {}
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes = []; if (v !== '' && v != null) { const t = new El('#text'); t.nodeType = 3; t._txt = String(v); Object.defineProperty(t, 'textContent', { get: () => t._txt }); this.childNodes.push(t); } }
}

const doc = new El('document');
const body = new El('body');
const appRoot = new El('div'); appRoot.id = 'app';
body.appendChild(appRoot);
doc.body = body;
doc.documentElement = new El('html');
doc.createElement = (t) => new El(t);
doc.createTextNode = (t) => { const n = new El('#text'); n.nodeType = 3; n._txt = String(t); Object.defineProperty(n, 'textContent', { get: () => n._txt }); return n; };
doc.getElementById = (id) => (id === 'app' ? appRoot : null);
doc.querySelector = () => null;
doc.querySelectorAll = () => [];
doc.addEventListener = () => {};
doc.getElementsByTagName = () => [];
doc.title = '';
doc.activeElement = null;

const store = {};
const ctx = {
  console, JSON, Math, Date, Promise, Object, Array, String, Number, Boolean,
  Error, RegExp, Set, Map, isNaN, isFinite, parseInt, parseFloat, undefined,
  encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
  document: doc,
  navigator: { userAgent: 'probe' },
  location: { pathname: '/cricket-auction/admin/login', search: '', hash: '', origin: 'http://localhost:8080', href: 'http://localhost:8080/cricket-auction/admin/login' },
  history: { pushState() {}, replaceState() {} },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  fetch: () => Promise.reject(new Error('probe: no network')),
  URL: class { constructor(u, b) { const s = String(u); this.pathname = s.split('?')[0].replace(/^https?:\/\/[^/]+/, ''); this.searchParams = { get: () => null }; } },
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  Image: class { set src(v) { this._s = v; } },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  matchMedia: () => ({ matches: false, addEventListener() {} })
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.window.setTimeout = setTimeout;
ctx.window.clearTimeout = clearTimeout;
ctx.addEventListener = () => {};
ctx.removeEventListener = () => {};
ctx.dispatchEvent = () => true;
ctx.scrollTo = () => {};
ctx.alert = () => {};
vm.createContext(ctx);

let failed = 0;
for (const rel of scripts) {
  const file = path.join(FE, rel);
  if (!fs.existsSync(file)) { console.log('MISSING  ' + rel); failed++; continue; }
  try {
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: rel });
    console.log('loaded   ' + rel);
  } catch (e) {
    console.log('THROWS   ' + rel + '\n         ' + e.message);
    failed++;
  }
}

// Now do what DOMContentLoaded does.
console.log('\n--- App.init() ---');
try {
  vm.runInContext('App.init();', ctx);
  console.log('App.init() ok');
  console.log('body.data-route =', body.dataset.route);
  const txt = appRoot.textContent.replace(/\s+/g, ' ').trim();
  console.log('#app rendered ' + txt.length + ' chars: ' + txt.slice(0, 160));
  if (!txt.length) { console.log('\n*** #app IS EMPTY — this is the blank page ***'); failed++; }
} catch (e) {
  console.log('App.init() THREW: ' + e.message);
  console.log((e.stack || '').split('\n').slice(1, 5).join('\n'));
  failed++;
}
process.exit(failed ? 1 : 0);
