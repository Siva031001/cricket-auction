/**
 * /tmp/reg-harness.js — a tiny fake DOM + stubs for API / UI / ImageTool,
 * so frontend/js/pages/register.js can be driven end to end in plain node
 * with no npm dependency (the repo forbids one).
 *
 * Run:  node /tmp/reg-harness.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

/* ===================================================================== *
 * 1. Minimal DOM
 * ===================================================================== */

let TEXT_NODE_ID = 0;

function TextNode(t) {
  this.nodeType = 3;
  this._text = String(t);
  this.id = 'text' + (TEXT_NODE_ID++);
}
Object.defineProperty(TextNode.prototype, 'textContent', {
  get: function () { return this._text; },
  set: function (v) { this._text = String(v); }
});

function El(tag) {
  this.nodeType = 1;
  this.tagName = String(tag).toUpperCase();
  this.children = [];
  this.attrs = {};
  this.listeners = {};
  this.dataset = {};
  this.style = {};
  this.className = '';
  this.parentNode = null;
  this._text = '';
  this.hidden = false;
  this.disabled = false;
  this.focused = false;
  this.scrolled = false;
}

Object.defineProperty(El.prototype, 'textContent', {
  get: function () {
    if (this.children.length === 0) return this._text;
    return this.children.map(function (c) { return c.textContent; }).join('');
  },
  set: function (v) {
    this.children = [];
    this._text = String(v);
  }
});

El.prototype.appendChild = function (c) {
  if (!c) throw new Error('appendChild(' + c + ') on <' + this.tagName + '>');
  if (this._text) { this.children.push(new TextNode(this._text)); this._text = ''; }
  c.parentNode = this;
  this.children.push(c);
  return c;
};
El.prototype.removeChild = function (c) {
  this.children = this.children.filter(function (x) { return x !== c; });
  return c;
};
El.prototype.remove = function () {
  if (this.parentNode) this.parentNode.removeChild(this);
};
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
El.prototype.getAttribute = function (k) {
  return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
};
El.prototype.hasAttribute = function (k) {
  return Object.prototype.hasOwnProperty.call(this.attrs, k);
};
El.prototype.addEventListener = function (type, fn) {
  (this.listeners[type] = this.listeners[type] || []).push(fn);
};
El.prototype.fire = function (type, ev) {
  (this.listeners[type] || []).forEach(function (fn) { fn(ev || { preventDefault: function () {} }); });
};
El.prototype.click = function () { this.fire('click', { preventDefault: function () {} }); };
El.prototype.focus = function () { this.focused = true; };
El.prototype.scrollIntoView = function () { this.scrolled = true; };
El.prototype.select = function () {};
El.prototype.setSelectionRange = function () {};

/* canvas */
El.prototype.getContext = function () {
  const calls = [];
  this._2d = calls;
  return {
    calls: calls,
    fillStyle: '', font: '', textAlign: '',
    fillRect: function () { calls.push(['fillRect'].concat([].slice.call(arguments))); },
    fillText: function (t) { calls.push(['fillText', String(t)]); },
    measureText: function (t) { return { width: String(t).length * 18 }; }
  };
};
El.prototype.toBlob = function (cb) { this._toBlobCalled = true; cb({ size: 1234, type: 'image/png' }); };
El.prototype.toDataURL = function () { return 'data:image/png;base64,AAAA'; };

const document = {
  body: new El('body'),
  title: '',
  _byId: {},
  createElement: function (t) { return new El(t); },
  createTextNode: function (t) { return new TextNode(t); },
  getElementById: function (id) { return document._byId[id] || null; },
  execCommand: function () { return true; }
};

const appRoot = new El('div');
document._byId.app = appRoot;

/* ---- walkers used by the assertions ---- */
function walk(el, out) {
  out = out || [];
  if (!el || el.nodeType !== 1) return out;
  out.push(el);
  el.children.forEach(function (c) { walk(c, out); });
  return out;
}
function all(root) { return walk(root); }
function byClass(root, cls) {
  return all(root).filter(function (e) {
    return String(e.className || '').split(/\s+/).indexOf(cls) !== -1;
  });
}
function one(root, cls) { return byClass(root, cls)[0] || null; }
function byTag(root, tag) {
  return all(root).filter(function (e) { return e.tagName === tag.toUpperCase(); });
}
function pageText(root) { return (root || appRoot).textContent; }

/* ===================================================================== *
 * 2. Browser globals
 * ===================================================================== */

const timers = [];
const win = {
  setInterval: function (fn, ms) {
    const t = setInterval(fn, ms);
    if (t.unref) t.unref();
    timers.push(t);
    return t;
  },
  clearInterval: function (t) { clearInterval(t); },
  setTimeout: function (fn, ms) {
    const t = setTimeout(fn, ms);
    if (t.unref) t.unref();
    return t;
  }
};

const revoked = [];
const URLShim = {
  createObjectURL: function () { return 'blob:fake-' + Math.random().toString(36).slice(2); },
  revokeObjectURL: function (u) { revoked.push(u); }
};

Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: null },
  writable: true, configurable: true
});
globalThis.document = document;
globalThis.window = win;
globalThis.URL = URLShim;
globalThis.App = { root: appRoot };

/* ===================================================================== *
 * 3. Stubs for the modules other agents own
 * ===================================================================== */

const calls = [];               // every API.call
let apiHandler = null;          // (action, payload) -> Promise

globalThis.API = {
  call: function (action, payload, opts) {
    calls.push({ action: action, payload: payload, opts: opts });
    return Promise.resolve().then(function () { return apiHandler(action, payload); });
  }
};

globalThis.UI = {
  field: function (spec) {
    const wrap = new El('div');
    wrap.className = 'field';
    wrap.spec = spec;

    const label = new El('label');
    label.className = 'field__label';
    label.textContent = spec.label;
    wrap.appendChild(label);

    const input = new El(spec.type === 'select' ? 'select' : 'input');
    input.setAttribute('type', spec.type);
    input.setAttribute('name', spec.name);
    input.value = '';
    input.files = null;
    input.options = spec.options || null;
    wrap.appendChild(input);

    const api = {
      wrap: wrap, input: input, spec: spec, error: null,
      setError: function (m) { api.error = m; wrap.className = 'field field--invalid'; },
      clearError: function () { api.error = null; wrap.className = 'field'; }
    };
    UI._fields[spec.name] = api;
    return api;
  },
  _fields: {},

  banner: function (kind, message) {
    const e = new El('div');
    e.className = 'banner banner--' + kind;
    e.textContent = message;
    return e;
  },

  button: function (label, onClick, opts) {
    const b = new El('button');
    b.className = 'btn' + (opts && opts.variant === 'secondary' ? ' btn--secondary' : '');
    b.textContent = label;
    b.opts = opts || {};
    b.addEventListener('click', function (ev) { onClick(ev); });
    return b;
  },

  spinner: function (label) {
    const e = new El('span');
    e.className = 'spinner';
    e.textContent = label || '';
    return e;
  },

  progress: function () {
    const e = new El('div');
    e.className = 'progress';
    const p = {
      el: e, sets: [], doneCalled: false,
      set: function (n) { p.sets.push(n); e.setAttribute('aria-valuenow', n); },
      done: function () { p.doneCalled = true; }
    };
    UI._lastProgress = p;
    return p;
  },

  money: function (paise) { return '₹' + Math.round(paise / 100); }
};

const imageCalls = [];
globalThis.ImageTool = {
  previewUrl: function () { return URLShim.createObjectURL(); },
  fromFile: function (file, opts) {
    imageCalls.push({ fn: 'fromFile', file: file, opts: opts });
    return Promise.resolve({
      data: 'SHOTBASE64', mime: 'image/jpeg', filename: 'screenshot.jpg',
      width: 1024, height: 768, bytes: 153600
    });
  },
  pair: function (file) {
    imageCalls.push({ fn: 'pair', file: file });
    return Promise.resolve({
      photo: { data: 'PHOTOBASE64', mime: 'image/jpeg', filename: 'photo.jpg', width: 1024, height: 1024, bytes: 148000 },
      photoThumb: { data: 'THUMBBASE64', mime: 'image/jpeg', filename: 'photo-thumb.jpg', width: 320, height: 320, bytes: 25000 }
    });
  }
};

/* ===================================================================== *
 * 4. Load the page under test
 * ===================================================================== */

const SRC = '/Users/raja.t/cricket-auction/frontend/js/pages/register.js';
vm.runInThisContext(fs.readFileSync(SRC, 'utf8') + '\n;globalThis.RegisterPage = RegisterPage;', { filename: SRC });

/* ===================================================================== *
 * 5. Fixtures and helpers
 * ===================================================================== */

const OPEN_TOURNAMENT = {
  tournament_id: 'TRN_k3m9x1qz7f2a',
  name: 'Summer Smash <script>alert(1)</script> 2026',
  description: 'Eight teams. One weekend.',
  rules: 'Line one\nLine two',
  reg_fee: 500,
  reg_fee_display: '₹500',
  logo_url: 'https://drive.example/logo',
  qr_url: 'https://drive.example/qr',
  qr_download_url: 'https://drive.example/qr?dl=1',
  gallery_urls: [],
  upi_id: 'organiser@okhdfcbank',
  contact_name: 'Ravi',
  contact_mobile: '9876543210',
  reg_start: '2026-08-01',
  reg_end: '2026-09-30',
  reg_start_display: '1 Aug 2026',
  reg_end_display: '30 Sep 2026',
  registration_open: true,
  registration_message: ''
};

const CLOSED_TOURNAMENT = Object.assign({}, OPEN_TOURNAMENT, {
  registration_open: false,
  registration_message: 'Registration closed on 31 Aug 2026.'
});

const CTX = { path: '/register/TRN_k3m9x1qz7f2a', params: { tournamentId: 'TRN_k3m9x1qz7f2a' }, query: {}, pattern: '/register/:tournamentId' };

function reset() {
  calls.length = 0;
  imageCalls.length = 0;
  UI._fields = {};
  UI._lastProgress = null;
  appRoot.textContent = '';
  document.body.children = [];
  document.body.dataset = {};
}

/** Let every queued microtask (and a couple of timer ticks) settle. */
function flush(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 6); i++) p = p.then(function () {});
  return p;
}

function submitButton() {
  return byTag(appRoot, 'BUTTON').filter(function (b) {
    return /Submit registration|Submitting/.test(b.textContent);
  })[0] || null;
}

function fakeFile(name) { return { name: name, size: 4000000, type: 'image/jpeg' }; }

function pick(fieldName, file) {
  const f = UI._fields[fieldName];
  f.input.files = [file];
  f.input.fire('change');
}

function fillValidForm() {
  UI._fields.name.input.value = "Raj Kumar D'Souza";
  UI._fields.dob.input.value = '1998-04-12';
  UI._fields.role.input.value = 'BATSMAN';
  UI._fields.style.input.value = 'LEFT';
  UI._fields.mobile.input.value = '9876543210';
  UI._fields.upiRef.input.value = 'utr123456789';
  pick('photo', fakeFile('me.jpg'));
  pick('screenshot', fakeFile('pay.png'));
}

/* ===================================================================== *
 * 6. Tests
 * ===================================================================== */

const results = [];
function ok(name) { results.push('  PASS  ' + name); }

function runTests() {
  return Promise.resolve()

  /* ---------------- 1. Loading spinner ---------------- */
    .then(function () {
      reset();
      let resolveLoad;
      apiHandler = function () { return new Promise(function (r) { resolveLoad = r; }); };
      RegisterPage.render(CTX);

      assert.strictEqual(document.body.dataset.route, 'register', 'body data-route');
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].action, 'tournament.getPublic');
      assert.deepStrictEqual(calls[0].payload, { tournamentId: 'TRN_k3m9x1qz7f2a' });
      assert.ok(one(appRoot, 'reg-loading'), 'spinner region rendered');
      assert.strictEqual(one(appRoot, 'reg-loading').getAttribute('aria-live'), 'polite');
      ok('1. loading state: spinner + one getPublic call with the URL id');
      return flush().then(function () { resolveLoad(OPEN_TOURNAMENT); return flush(); });
    })

  /* ---------------- 2. Load failure + retry ---------------- */
    .then(function () {
      reset();
      apiHandler = function () {
        return Promise.reject({ code: 'NETWORK', message: 'Could not reach the server. Check the internet connection and try again.' });
      };
      RegisterPage.render(CTX);
      return flush().then(function () {
        assert.ok(/Could not load this page/.test(pageText()), 'error heading');
        assert.ok(/Could not reach the server/.test(pageText()), 'server message surfaced');
        const banner = one(appRoot, 'banner banner--error') ||
          all(appRoot).filter(function (e) { return /banner--error/.test(e.className); })[0];
        assert.ok(banner && banner.getAttribute('role') === 'alert', 'error banner is role=alert');
        assert.strictEqual(byTag(appRoot, 'FORM').length, 0, 'no form on the error state');

        const retry = byTag(appRoot, 'BUTTON').filter(function (b) { return b.textContent === 'Try again'; })[0];
        assert.ok(retry, 'retry button present');

        calls.length = 0;
        apiHandler = function () { return Promise.resolve(OPEN_TOURNAMENT); };
        retry.click();
        return flush();
      }).then(function () {
        assert.strictEqual(calls.length, 1, 'retry re-issued getPublic');
        assert.ok(byTag(appRoot, 'FORM').length === 1, 'retry rendered the form');
        ok('2. load failure: message + role=alert + working Try again button');
      });
    })

  /* ---------------- 3. Closed state ---------------- */
    .then(function () {
      reset();
      apiHandler = function () { return Promise.resolve(CLOSED_TOURNAMENT); };
      RegisterPage.render(CTX);
      return flush().then(function () {
        const text = pageText();
        assert.ok(/Registration is closed/.test(text), 'closed heading');
        assert.ok(text.indexOf('Registration closed on 31 Aug 2026.') !== -1, 'registration_message verbatim');
        assert.strictEqual(byTag(appRoot, 'FORM').length, 0, 'NO form is rendered when closed');
        assert.strictEqual(byTag(appRoot, 'INPUT').length, 0, 'no inputs when closed');
        assert.strictEqual(Object.keys(UI._fields).length, 0, 'UI.field never called when closed');
        assert.ok(text.indexOf(CLOSED_TOURNAMENT.name) !== -1, 'tournament name shown');
        // untrusted name went through textContent, so it is data not markup
        assert.ok(text.indexOf('<script>') !== -1, 'name kept as literal text (textContent)');
        ok('3. closed state: reason shown, form suppressed entirely');
      });
    })

  /* ---------------- 4. Open form: structure ---------------- */
    .then(function () {
      reset();
      apiHandler = function () { return Promise.resolve(OPEN_TOURNAMENT); };
      RegisterPage.render(CTX);
      return flush().then(function () {
        const names = Object.keys(UI._fields);
        assert.deepStrictEqual(names,
          ['name', 'dob', 'role', 'style', 'mobile', 'photo', 'screenshot', 'upiRef'],
          'all eight fields, in the DESIGN §6 order');

        names.forEach(function (n) {
          assert.strictEqual(UI._fields[n].spec.required, true, n + ' is required');
          assert.ok(UI._fields[n].spec.label, n + ' has a label');
        });

        assert.deepStrictEqual(
          UI._fields.role.spec.options.map(function (o) { return o.value; }),
          ['BATSMAN', 'BOWLER', 'ALL_ROUNDER']);
        assert.deepStrictEqual(
          UI._fields.style.spec.options.map(function (o) { return o.value; }),
          ['LEFT', 'RIGHT']);
        assert.deepStrictEqual(
          UI._fields.style.spec.options.map(function (o) { return o.label; }),
          ['Left handed', 'Right handed'], 'plain wording, not jargon');

        assert.strictEqual(UI._fields.photo.input.getAttribute('accept'), 'image/*');
        assert.strictEqual(UI._fields.screenshot.input.getAttribute('accept'), 'image/*');
        assert.strictEqual(UI._fields.mobile.input.getAttribute('inputmode'), 'numeric');

        /* payment block */
        const qr = one(appRoot, 'reg-qr__img');
        assert.ok(qr && qr.src === OPEN_TOURNAMENT.qr_url, 'QR image rendered');
        assert.ok(/QR code/.test(qr.alt), 'QR has a real alt');

        const dl = byTag(appRoot, 'A').filter(function (a) { return a.textContent === 'Download QR Code'; })[0];
        assert.ok(dl, 'Download QR Code control');
        assert.strictEqual(dl.href, OPEN_TOURNAMENT.qr_download_url, 'uses qr_download_url');
        assert.ok(dl.hasAttribute('download'), 'download attribute set');

        const upi = one(appRoot, 'reg-upi__value');
        assert.strictEqual(upi.textContent, 'organiser@okhdfcbank');
        const copyBtn = byTag(appRoot, 'BUTTON').filter(function (b) { return /Copy UPI id/.test(b.textContent); })[0];
        assert.ok(copyBtn, 'Copy UPI id button');

        assert.ok(/pay in your own UPI app first/i.test(pageText()), 'says the app does not take payment');
        assert.ok(/₹500/.test(pageText()), 'fee shown from reg_fee_display');

        const errHost = one(appRoot, 'reg-form__error');
        assert.strictEqual(errHost.getAttribute('aria-live'), 'assertive');
        assert.strictEqual(errHost.getAttribute('role'), 'alert');
        assert.strictEqual(one(appRoot, 'reg-form__progress').getAttribute('aria-live'), 'polite');

        assert.ok(submitButton(), 'submit button');
        ok('4. open form: 8 fields, enum values, QR + download + copy UPI, aria-live regions');
      });
    })

  /* ---------------- 5. Client validation blocks the request ---------------- */
    .then(function () {
      reset();
      apiHandler = function () { return Promise.resolve(OPEN_TOURNAMENT); };
      RegisterPage.render(CTX);
      return flush().then(function () {
        calls.length = 0;
        submitButton().click();
        return flush();
      }).then(function () {
        assert.strictEqual(calls.length, 0, 'player.register NOT called with an empty form');
        assert.strictEqual(UI._fields.name.error, 'Please enter your full name.');
        assert.strictEqual(UI._fields.dob.error, 'Please check the date of birth.');
        assert.strictEqual(UI._fields.mobile.error, 'Enter a 10-digit mobile number.');
        assert.strictEqual(UI._fields.photo.error, 'Please upload a clear photo.');
        assert.strictEqual(UI._fields.screenshot.error, 'Please upload your payment screenshot.');
        assert.ok(UI._fields.role.error && UI._fields.style.error && UI._fields.upiRef.error);
        assert.ok(/Please check the highlighted answers below/.test(one(appRoot, 'reg-form__error').textContent));
        assert.ok(UI._fields.name.input.focused, 'focus moved to the first bad field');
        assert.strictEqual(submitButton().disabled, false, 'submit stays usable after a client error');

        /* one bad field only -> that exact message in the banner */
        UI._fields.name.input.value = 'A';                        // too short
        UI._fields.dob.input.value = '1998-04-12';
        UI._fields.role.input.value = 'BATSMAN';
        UI._fields.style.input.value = 'RIGHT';
        UI._fields.mobile.input.value = '9876543210';
        UI._fields.upiRef.input.value = 'UTR123456';
        pick('photo', fakeFile('me.jpg'));
        pick('screenshot', fakeFile('pay.png'));
        return flush();
      }).then(function () {
        calls.length = 0;
        submitButton().click();
        return flush();
      }).then(function () {
        assert.strictEqual(calls.length, 0, 'still blocked on the single bad name');
        assert.ok(/Please enter your full name/.test(one(appRoot, 'reg-form__error').textContent));

        /* bad mobile shape */
        UI._fields.name.input.value = 'Raj Kumar';
        UI._fields.mobile.input.value = '1234567890';             // must start 6-9
        submitButton().click();
        return flush();
      }).then(function () {
        assert.strictEqual(calls.length, 0, 'bad mobile blocked');
        assert.strictEqual(UI._fields.mobile.error, 'Enter a 10-digit mobile number.');

        /* bad UPI ref */
        UI._fields.mobile.input.value = '9876543210';
        UI._fields.upiRef.input.value = 'ab-1';                   // too short + symbol
        submitButton().click();
        return flush();
      }).then(function () {
        assert.strictEqual(calls.length, 0, 'bad upiRef blocked');
        assert.ok(/6 to 35 letters and numbers/.test(UI._fields.upiRef.error));

        /* age out of range: 4 years old at reg_end */
        UI._fields.upiRef.input.value = 'UTR123456';
        UI._fields.dob.input.value = '2022-01-01';
        submitButton().click();
        return flush();
      }).then(function () {
        assert.strictEqual(calls.length, 0, 'under-age blocked');
        assert.strictEqual(UI._fields.dob.error, 'Please check the date of birth.');
        ok('5. client validation: every rule from CONTRACTS-PHASE1 §3 blocks the POST');
      });
    })

  /* ---------------- 6. Image resize, preview, size label ---------------- */
    .then(function () {
      reset();
      apiHandler = function () { return Promise.resolve(OPEN_TOURNAMENT); };
      RegisterPage.render(CTX);
      return flush().then(function () {
        pick('photo', fakeFile('me.jpg'));
        pick('screenshot', fakeFile('pay.png'));
        return flush();
      }).then(function () {
        assert.strictEqual(imageCalls.length, 2);
        assert.strictEqual(imageCalls[0].fn, 'pair', 'profile photo uses ImageTool.pair (one decode)');
        assert.strictEqual(imageCalls[1].fn, 'fromFile', 'screenshot uses ImageTool.fromFile');
        assert.deepStrictEqual(imageCalls[1].opts, { maxEdge: 1024, quality: 0.8 });

        const caps = byClass(appRoot, 'reg-preview__caption--ok');
        assert.strictEqual(caps.length, 2, 'both previews report ready');
        assert.ok(/169 KB/.test(caps[0].textContent), 'photo+thumb size shown: ' + caps[0].textContent);
        assert.ok(/150 KB/.test(caps[1].textContent), 'screenshot size shown: ' + caps[1].textContent);

        const imgs = byClass(appRoot, 'reg-preview__img');
        assert.strictEqual(imgs.length, 2);
        assert.strictEqual(imgs[0].hidden, false, 'thumbnail is visible');
        assert.ok(/^data:image\/jpeg;base64,THUMBBASE64$/.test(imgs[0].src), 'preview swapped to the resized bytes');
        ok('6. images: pair for photo, fromFile for screenshot, thumbnail + resized size shown');
      });
    })

  /* ---------------- 7. Happy submit: payload shape + double-press guard ---- */
    .then(function () {
      reset();
      let registerResolve;
      apiHandler = function (action) {
        if (action === 'tournament.getPublic') return Promise.resolve(OPEN_TOURNAMENT);
        if (action === 'player.register') return new Promise(function (r) { registerResolve = r; });
        return Promise.resolve({});
      };
      RegisterPage.render(CTX);
      return flush().then(function () {
        fillValidForm();
        return flush();
      }).then(function () {
        calls.length = 0;
        const btn = submitButton();
        btn.click();
        btn.click();          // the double tap that creates duplicate players
        btn.click();
        return flush();
      }).then(function () {
        const regs = calls.filter(function (c) { return c.action === 'player.register'; });
        assert.strictEqual(regs.length, 1, 'THREE presses produced exactly ONE player.register');

        const p = regs[0].payload;
        assert.deepStrictEqual(Object.keys(p).sort(),
          ['dob', 'mobile', 'name', 'photo', 'photoThumb', 'role', 'screenshot', 'style', 'tournamentId', 'upiRef'].sort());
        assert.strictEqual(p.tournamentId, 'TRN_k3m9x1qz7f2a');
        assert.strictEqual(p.name, "Raj Kumar D'Souza");
        assert.strictEqual(p.dob, '1998-04-12');
        assert.strictEqual(p.role, 'BATSMAN');
        assert.strictEqual(p.style, 'LEFT');
        assert.strictEqual(p.mobile, '9876543210');
        assert.strictEqual(p.upiRef, 'UTR123456789', 'upiRef normalised to upper case');

        ['photo', 'photoThumb', 'screenshot'].forEach(function (k) {
          assert.deepStrictEqual(Object.keys(p[k]).sort(), ['data', 'filename', 'mime'],
            k + ' carries exactly {data,mime,filename} (CONTRACTS-PHASE1 §1)');
        });
        assert.strictEqual(p.photo.data, 'PHOTOBASE64');
        assert.strictEqual(p.photoThumb.data, 'THUMBBASE64');
        assert.strictEqual(p.screenshot.data, 'SHOTBASE64');

        const btn = submitButton();
        assert.strictEqual(btn.disabled, true, 'submit disabled while in flight');
        assert.strictEqual(btn.textContent, 'Submitting…');
        assert.strictEqual(btn.getAttribute('aria-busy'), 'true');

        assert.ok(UI._lastProgress, 'UI.progress() mounted');
        assert.ok(UI._lastProgress.sets.length >= 1, 'progress bar was given a value');
        assert.ok(/Sending your registration/.test(one(appRoot, 'reg-form__progress').textContent));
        ok('7. submit: exact §1 payload, enum wire values, one POST from three taps, progress shown');

        registerResolve({
          player_id: 'PLY_k3m9x1qz7f2a', serial_no: 27, name: "Raj Kumar D'Souza",
          tournament_name: OPEN_TOURNAMENT.name, registered_at_display: '30 Aug 2026, 4:12 pm'
        });
        return flush();
      })

  /* ---------------- 8. Confirmation screen ---------------- */
        .then(function () {
          const text = pageText();
          const serial = one(appRoot, 'reg-done__serial');
          assert.ok(serial, 'serial element present');
          assert.strictEqual(serial.textContent, '27');
          assert.ok(/You are registered/.test(text));
          assert.ok(text.indexOf("Raj Kumar D'Souza") !== -1, 'player name');
          assert.ok(text.indexOf(OPEN_TOURNAMENT.name) !== -1, 'tournament name');
          assert.ok(text.indexOf('Please save this number. It will be used during the auction.') !== -1,
            'the exact required line');
          assert.ok(text.indexOf('30 Aug 2026, 4:12 pm') !== -1, 'registered_at_display');
          assert.strictEqual(byTag(appRoot, 'FORM').length, 0, 'form gone');
          assert.ok(!/register again/i.test(text), 'NO "register again" link');
          assert.strictEqual(UI._lastProgress.doneCalled, true, 'progress closed out');

          const saveBtn = byTag(appRoot, 'BUTTON').filter(function (b) { return b.textContent === 'Save as image'; })[0];
          assert.ok(saveBtn, 'Save as image button');

          saveBtn.click();
          ok('8. confirmation: huge serial, name, tournament, save line, Save as image, no re-register link');
        });
    })

  /* ---------------- 9. Save as image really draws ---------------- */
    .then(function () {
      // Exercise the canvas path directly and inspect what was drawn.
      const drawn = [];
      const realCreate = document.createElement;
      let seenCanvas = null;
      document.createElement = function (t) {
        const e = realCreate(t);
        if (String(t).toLowerCase() === 'canvas') seenCanvas = e;
        return e;
      };
      RegisterPage._saveAsImage({ serial: '27', name: 'Raj Kumar', tournament: 'Summer Smash 2026', registeredAt: '30 Aug 2026' });
      document.createElement = realCreate;

      assert.ok(seenCanvas, 'a canvas was created');
      assert.strictEqual(seenCanvas.width, 1080);
      assert.strictEqual(seenCanvas.height, 1350);
      assert.strictEqual(seenCanvas._toBlobCalled, true, 'toBlob used to build the file');
      const texts = seenCanvas._2d.filter(function (c) { return c[0] === 'fillText'; })
        .map(function (c) { return c[1]; }).join(' | ');
      assert.ok(texts.indexOf('27') !== -1, 'serial drawn');
      assert.ok(texts.indexOf('Raj') !== -1, 'name drawn');
      assert.ok(/Please save this number/.test(texts), 'save line drawn');
      ok('9. Save as image: 1080x1350 canvas with serial, name and the save line, toBlob download');
    })

  /* ---------------- 10. DUPLICATE_MOBILE keeps everything ---------------- */
    .then(function () {
      reset();
      apiHandler = function (action) {
        if (action === 'tournament.getPublic') return Promise.resolve(OPEN_TOURNAMENT);
        if (action === 'player.register') {
          return Promise.reject({
            code: 'DUPLICATE_MOBILE',
            message: 'A registration already exists for this mobile number. Please contact the tournament organiser.'
          });
        }
        return Promise.resolve({});
      };
      RegisterPage.render(CTX);
      return flush().then(function () {
        fillValidForm();
        return flush();
      }).then(function () {
        submitButton().click();
        return flush();
      }).then(function () {
        /* every single field still filled in */
        assert.strictEqual(UI._fields.name.input.value, "Raj Kumar D'Souza");
        assert.strictEqual(UI._fields.dob.input.value, '1998-04-12');
        assert.strictEqual(UI._fields.role.input.value, 'BATSMAN');
        assert.strictEqual(UI._fields.style.input.value, 'LEFT');
        assert.strictEqual(UI._fields.mobile.input.value, '9876543210');
        assert.strictEqual(UI._fields.upiRef.input.value, 'utr123456789');
        assert.strictEqual(byTag(appRoot, 'FORM').length, 1, 'the same form is still on screen');

        /* and the two resized images are still held, so nothing is re-picked */
        assert.strictEqual(imageCalls.length, 2, 'no image was re-encoded');
        const caps = byClass(appRoot, 'reg-preview__caption--ok');
        assert.strictEqual(caps.length, 2, 'both previews still showing "Ready to send"');

        assert.ok(/A registration already exists for this mobile number/.test(
          one(appRoot, 'reg-form__error').textContent), "server's own message surfaced");
        assert.ok(/A registration already exists/.test(UI._fields.mobile.error), 'error attached to the mobile field');
        assert.ok(UI._fields.mobile.input.focused, 'focus taken to the field to fix');

        const btn = submitButton();
        assert.strictEqual(btn.disabled, false, 'submit re-enabled so they can retry');
        assert.strictEqual(btn.textContent, 'Submit registration', 'label restored');

        /* fix and resubmit: goes straight through with no re-picking */
        let sent = null;
        apiHandler = function (action, payload) {
          if (action === 'player.register') {
            sent = payload;
            return Promise.resolve({ player_id: 'PLY_x', serial_no: 28, name: payload.name, tournament_name: OPEN_TOURNAMENT.name, registered_at_display: 'now' });
          }
          return Promise.resolve(OPEN_TOURNAMENT);
        };
        UI._fields.mobile.input.value = '9812345678';
        btn.click();
        return flush();
      }).then(function () {
        assert.ok(one(appRoot, 'reg-done__serial'), 'second attempt reached the confirmation');
        assert.strictEqual(one(appRoot, 'reg-done__serial').textContent, '28');
        assert.strictEqual(imageCalls.length, 2, 'still no image re-encoded on the retry');
        ok('10. DUPLICATE_MOBILE: all eight answers and both resized images kept, retry succeeds');
      });
    })

  /* ---------------- 11. DUPLICATE_UPI_REF ---------------- */
    .then(function () {
      reset();
      apiHandler = function (action) {
        if (action === 'tournament.getPublic') return Promise.resolve(OPEN_TOURNAMENT);
        return Promise.reject({ code: 'DUPLICATE_UPI_REF', message: 'This UPI reference number has already been used.' });
      };
      RegisterPage.render(CTX);
      return flush().then(function () { fillValidForm(); return flush(); })
        .then(function () { submitButton().click(); return flush(); })
        .then(function () {
          assert.strictEqual(UI._fields.upiRef.error, 'This UPI reference number has already been used.');
          assert.ok(UI._fields.upiRef.input.focused);
          assert.strictEqual(UI._fields.upiRef.input.value, 'utr123456789', 'still filled');
          assert.strictEqual(UI._fields.photo.input.files.length, 1, 'photo still chosen');
          assert.strictEqual(submitButton().disabled, false);
          ok('11. DUPLICATE_UPI_REF: message on the upiRef field, nothing cleared');
        });
    })

  /* ---------------- 12. REGISTRATION_CLOSED mid-form ---------------- */
    .then(function () {
      reset();
      apiHandler = function (action) {
        if (action === 'tournament.getPublic') return Promise.resolve(OPEN_TOURNAMENT);
        return Promise.reject({ code: 'REGISTRATION_CLOSED', message: 'Registration closed on 31 Aug 2026.' });
      };
      RegisterPage.render(CTX);
      return flush().then(function () { fillValidForm(); return flush(); })
        .then(function () { submitButton().click(); return flush(); })
        .then(function () {
          assert.strictEqual(byTag(appRoot, 'FORM').length, 0, 'the doomed form is removed');
          assert.ok(/Registration is closed/.test(pageText()));
          assert.ok(pageText().indexOf('Registration closed on 31 Aug 2026.') !== -1);
          ok('12. REGISTRATION_CLOSED at submit: form replaced by the closed state');
        });
    })

  /* ---------------- 13. Generic server error ---------------- */
    .then(function () {
      reset();
      apiHandler = function (action) {
        if (action === 'tournament.getPublic') return Promise.resolve(OPEN_TOURNAMENT);
        return Promise.reject({ code: 'SYSTEM_BUSY', message: 'The system is busy. Please try again in a moment.' });
      };
      RegisterPage.render(CTX);
      return flush().then(function () { fillValidForm(); return flush(); })
        .then(function () { submitButton().click(); return flush(); })
        .then(function () {
          assert.ok(/The system is busy/.test(one(appRoot, 'reg-form__error').textContent), 'server message shown verbatim');
          assert.strictEqual(submitButton().disabled, false, 'retry possible');
          assert.strictEqual(UI._fields.name.input.value, "Raj Kumar D'Souza", 'fields kept on any error');
          ok('13. any server rejection: its own message shown, form intact, submit re-enabled');
        });
    })

  /* ---------------- 14. player.checkMobile on blur ---------------- */
    .then(function () {
      reset();
      let checkCount = 0;
      apiHandler = function (action, payload) {
        if (action === 'tournament.getPublic') return Promise.resolve(OPEN_TOURNAMENT);
        if (action === 'player.checkMobile') {
          checkCount++;
          assert.deepStrictEqual(payload, { tournamentId: 'TRN_k3m9x1qz7f2a', mobile: '9876543210' });
          return Promise.resolve({ taken: true });
        }
        return Promise.resolve({});
      };
      RegisterPage.render(CTX);
      return flush().then(function () {
        UI._fields.mobile.input.value = '12345';        // invalid: no call
        UI._fields.mobile.input.fire('blur');
        return flush();
      }).then(function () {
        assert.strictEqual(checkCount, 0, 'no call for an invalid number');

        UI._fields.mobile.input.value = '9876543210';
        UI._fields.mobile.input.fire('blur');
        return flush();
      }).then(function () {
        assert.strictEqual(checkCount, 1);
        assert.ok(/A registration already exists/.test(UI._fields.mobile.error), 'early warning shown');

        UI._fields.mobile.input.fire('blur');            // same number again
        return flush();
      }).then(function () {
        assert.strictEqual(checkCount, 1, 'not re-checked for the same number');

        const check = calls.filter(function (c) { return c.action === 'player.checkMobile'; })[0];
        assert.deepStrictEqual(check.opts, { retryBusy: false }, 'courtesy call opts out of the busy backoff');
        ok('14. checkMobile: fires once on a valid number, warns early, skips repeats');
      });
    })

  /* ---------------- 15. checkMobile failure never blocks ---------------- */
    .then(function () {
      reset();
      let registered = false;
      apiHandler = function (action, payload) {
        if (action === 'tournament.getPublic') return Promise.resolve(OPEN_TOURNAMENT);
        if (action === 'player.checkMobile') return Promise.reject({ code: 'RATE_LIMITED', message: 'nope' });
        if (action === 'player.register') {
          registered = true;
          return Promise.resolve({ player_id: 'PLY_y', serial_no: 5, name: payload.name, tournament_name: 'T', registered_at_display: 'now' });
        }
        return Promise.resolve({});
      };
      RegisterPage.render(CTX);
      return flush().then(function () {
        fillValidForm();
        UI._fields.mobile.input.fire('blur');
        return flush();
      }).then(function () {
        assert.strictEqual(UI._fields.mobile.error, null, 'a failed courtesy check shows nothing');
        submitButton().click();
        return flush();
      }).then(function () {
        assert.strictEqual(registered, true, 'submission went through despite the failed check');
        assert.strictEqual(one(appRoot, 'reg-done__serial').textContent, '5');
        ok('15. checkMobile failure is treated as unknown and never blocks submission');
      });
    })

  /* ---------------- 16. Submit while an image is still encoding ---------------- */
    .then(function () {
      reset();
      let releaseImage;
      globalThis.ImageTool.pair = function () {
        return new Promise(function (r) {
          releaseImage = function () {
            r({ photo: { data: 'P', mime: 'image/jpeg', filename: 'p.jpg', bytes: 1000 },
                photoThumb: { data: 'T', mime: 'image/jpeg', filename: 't.jpg', bytes: 200 } });
          };
        });
      };
      apiHandler = function (action) {
        if (action === 'tournament.getPublic') return Promise.resolve(OPEN_TOURNAMENT);
        return Promise.resolve({ player_id: 'PLY_z', serial_no: 9, name: 'x', tournament_name: 'T', registered_at_display: 'now' });
      };
      RegisterPage.render(CTX);
      return flush().then(function () {
        UI._fields.name.input.value = 'Raj Kumar';
        UI._fields.dob.input.value = '1998-04-12';
        UI._fields.role.input.value = 'BOWLER';
        UI._fields.style.input.value = 'RIGHT';
        UI._fields.mobile.input.value = '9876543210';
        UI._fields.upiRef.input.value = 'UTR999888';
        pick('photo', fakeFile('me.jpg'));            // still encoding
        pick('screenshot', fakeFile('pay.png'));
        return flush();
      }).then(function () {
        calls.length = 0;
        submitButton().click();
        return flush();
      }).then(function () {
        assert.strictEqual(calls.filter(function (c) { return c.action === 'player.register'; }).length, 0,
          'no half-formed payload sent');
        assert.ok(/still being prepared/.test(UI._fields.photo.error), 'told to wait, not to re-pick');
        releaseImage();
        return flush();
      }).then(function () {
        submitButton().click();
        return flush();
      }).then(function () {
        assert.strictEqual(one(appRoot, 'reg-done__serial').textContent, '9', 'goes through once encoding finishes');
        ok('16. submit during encoding: blocked with "please wait", succeeds after');
      });
    })

  /* ---------------- 17. Missing tournament id ---------------- */
    .then(function () {
      reset();
      apiHandler = function () { throw new Error('should not be called'); };
      RegisterPage.render({ path: '/register/', params: {}, query: {}, pattern: '/register/:tournamentId' });
      return flush().then(function () {
        assert.strictEqual(calls.length, 0, 'no pointless request');
        assert.ok(/registration link is incomplete/.test(pageText()));
        ok('17. missing tournamentId: clear message, no request');
      });
    })

  /* ---------------- 18. Copy UPI id ---------------- */
    .then(function () {
      reset();
      let copied = null;
      globalThis.navigator.clipboard = { writeText: function (t) { copied = t; return Promise.resolve(); } };
      apiHandler = function () { return Promise.resolve(OPEN_TOURNAMENT); };
      RegisterPage.render(CTX);
      return flush().then(function () {
        byTag(appRoot, 'BUTTON').filter(function (b) { return /Copy UPI id/.test(b.textContent); })[0].click();
        return flush();
      }).then(function () {
        assert.strictEqual(copied, 'organiser@okhdfcbank');
        assert.ok(/Copied/.test(one(appRoot, 'reg-upi__status').textContent), 'confirmation shown');

        /* clipboard refused -> execCommand fallback -> still reports success */
        globalThis.navigator.clipboard = { writeText: function () { return Promise.reject(new Error('denied')); } };
        byTag(appRoot, 'BUTTON').filter(function (b) { return /Copy UPI id/.test(b.textContent); })[0].click();
        return flush();
      }).then(function () {
        assert.ok(/Copied/.test(one(appRoot, 'reg-upi__status').textContent), 'fallback path worked');

        /* both refused -> a manual instruction, never silence */
        globalThis.navigator.clipboard = null;
        document.execCommand = function () { return false; };
        byTag(appRoot, 'BUTTON').filter(function (b) { return /Copy UPI id/.test(b.textContent); })[0].click();
        return flush();
      }).then(function () {
        assert.ok(/Press and hold/.test(one(appRoot, 'reg-upi__status').textContent), 'manual fallback text');
        document.execCommand = function () { return true; };
        ok('18. Copy UPI id: clipboard API, execCommand fallback, manual instruction as last resort');
      });
    });
}

runTests().then(function () {
  console.log(results.join('\n'));
  console.log('\nALL ' + results.length + ' SCENARIOS PASSED');
  process.exit(0);
}).catch(function (e) {
  console.log(results.join('\n'));
  console.error('\nFAILED: ' + (e && e.message));
  console.error(e && e.stack);
  process.exit(1);
});
