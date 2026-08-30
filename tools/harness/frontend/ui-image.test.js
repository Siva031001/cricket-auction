/**
 * Node harness for frontend/js/ui.js and frontend/js/image.js.
 *
 * Lives in /tmp on purpose: package.json says "There is no npm test", the
 * frontend has no build step, and the brief said to write only the two
 * source files into the repo.
 *
 * Stubs a minimal DOM whose elements record tagName, attributes, textContent
 * and children, then loads both files with `vm` (they are plain globals, not
 * modules, exactly as index.html loads them).
 */

'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = '/Users/raja.t/cricket-auction/frontend/js';

/* ------------------------------------------------------------------ *
 * Tiny assert layer
 * ------------------------------------------------------------------ */
let pass = 0;
const failures = [];

function ok(cond, what) {
  if (cond) { pass++; return; }
  failures.push(what);
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  failures.push(what + '\n      expected ' + e + '\n      actual   ' + a);
}
function section(name) { console.log('\n--- ' + name + ' ---'); }

/* ------------------------------------------------------------------ *
 * Minimal DOM
 * ------------------------------------------------------------------ */

class Node_ {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = {};
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.style = {};
    this.dataset = {};
    this._text = null;          // set only when textContent was assigned
    this._listeners = {};
    this.hidden = false;
    this.disabled = false;
  }

  get textContent() {
    if (this._text !== null) return this._text;
    return this.children.map(function (c) {
      return (typeof c === 'string') ? c : c.textContent;
    }).join('');
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }

  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, k)
      ? this.attributes[k] : null;
  }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); }
  removeAttribute(k) { delete this.attributes[k]; }

  appendChild(c) {
    if (this._text !== null) { this.children = [this._text]; this._text = null; }
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  insertBefore(c, ref) {
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    c.parentNode = this;
    return c;
  }

  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatch(type, ev) {
    (this._listeners[type] || []).slice().forEach(function (fn) {
      fn(ev || { type: type, target: this, preventDefault() {}, stopPropagation() {} });
    }, this);
  }

  focus() { sandboxDocument.activeElement = this; }

  /** Depth-first search by class name, for assertions. */
  find(cls) {
    if (String(this.className).split(/\s+/).indexOf(cls) !== -1) return this;
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }
}

class TextNode {
  constructor(t) { this.data = String(t); }
  get textContent() { return this.data; }
  find() { return null; }
}

/* --- canvas + ctx recorders ---------------------------------------- */
const canvasLog = [];

class CanvasNode extends Node_ {
  constructor() {
    super('canvas');
    this.width = 0;
    this.height = 0;
    this._ctx = {
      calls: [],
      fillStyle: '',
      imageSmoothingEnabled: false,
      imageSmoothingQuality: '',
      fillRect(...a) { this.calls.push(['fillRect', ...a]); },
      setTransform(...a) { this.calls.push(['setTransform', ...a]); },
      drawImage(...a) { this.calls.push(['drawImage', a[0] && a[0].__tag, ...a.slice(1)]); }
    };
    canvasLog.push(this);
  }
  getContext() { return this._ctx; }
  toDataURL(mime, quality) {
    this.toDataURLArgs = [mime, quality];
    this.sizeAtEncode = [this.width, this.height];
    // "ABCDE" -> base64 with padding, so _base64Bytes has something to chew on
    const b64 = Buffer.from('ABCDE').toString('base64');   // QUJDREU=
    return 'data:' + mime + ';base64,' + b64;
  }
}

class DialogNode extends Node_ {
  constructor() { super('dialog'); this.open = false; }
  showModal() { this.open = true; this.__showModalCalled = true; }
  close() { this.open = false; this.__closeCalled = true; }
}

const sandboxDocument = {
  activeElement: null,
  createElement(tag) {
    const t = String(tag).toLowerCase();
    if (t === 'canvas') return new CanvasNode();
    if (t === 'dialog') return new DialogNode();
    return new Node_(t);
  },
  createTextNode(t) { return new TextNode(t); },
  addEventListener(type, fn) { (this._l = this._l || {})[type] = (this._l[type] || []).concat(fn); },
  removeEventListener(type, fn) {
    const l = (this._l || {})[type] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  },
  dispatchKey(ev) { ((this._l || {}).keydown || []).slice().forEach(function (fn) { fn(ev); }); },
  body: new Node_('body')
};

/* --- image / bitmap / URL stubs ------------------------------------ */
const stub = {
  createImageBitmapCalls: [],
  bitmapSize: { width: 400, height: 300 },
  bitmapClosed: 0,
  objectUrls: { created: 0, revoked: 0 }
};

const sandbox = {
  console,
  document: sandboxDocument,
  window: { setTimeout },
  setTimeout,
  Promise,
  URL: {
    createObjectURL() { stub.objectUrls.created++; return 'blob:stub-' + stub.objectUrls.created; },
    revokeObjectURL() { stub.objectUrls.revoked++; }
  },
  Image: class {
    constructor() { this.__tag = 'img'; this.style = {}; this.naturalWidth = 0; this.naturalHeight = 0; }
    set src(v) {
      this._src = v;
      if (!v) return;
      const self = this;
      setTimeout(function () {
        self.naturalWidth = stub.bitmapSize.width;
        self.naturalHeight = stub.bitmapSize.height;
        if (self.onload) self.onload();
      }, 0);
    }
    get src() { return this._src; }
  },
  createImageBitmap(file, opts) {
    stub.createImageBitmapCalls.push(opts);
    return Promise.resolve({
      __tag: 'bitmap',
      width: stub.bitmapSize.width,
      height: stub.bitmapSize.height,
      close() { stub.bitmapClosed++; }
    });
  },
  HTMLDialogElement: function () {},
  DataView,
  ArrayBuffer,
  Uint8Array,
  FileReader: undefined,
  isFinite,
  Math,
  Number,
  String,
  JSON,
  Object,
  Array,
  Buffer
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// `const UI = {...}` is a lexical binding, not a global property, so export it
// explicitly. The browser does not need this — index.html loads these as
// classic scripts sharing one script scope.
vm.runInContext(
  fs.readFileSync(path.join(SRC, 'ui.js'), 'utf8') + '\n;globalThis.UI = UI;',
  sandbox, { filename: 'ui.js' });
vm.runInContext(
  fs.readFileSync(path.join(SRC, 'image.js'), 'utf8') + '\n;globalThis.ImageTool = ImageTool;',
  sandbox, { filename: 'image.js' });

const UI = sandbox.UI;
const ImageTool = sandbox.ImageTool;

/* ================================================================== *
 * 1. UI.money — must match backend/Util.gs formatINR exactly
 * ================================================================== */
(function () {
  section('UI.money vs backend Util.formatINR');

  // These are the exact assertions in backend/Tests.gs lines 739-750.
  const cases = [
    [500, '₹500'],
    [75000, '₹75,000'],
    [1000000, '₹10,00,000'],
    [0, '₹0'],
    [1000, '₹1,000'],
    [100000, '₹1,00,000'],
    [10000000, '₹1,00,00,000']
  ];
  cases.forEach(function (c) {
    eq(UI.money(c[0]), c[1], 'money(' + c[0] + ')');
  });

  eq(UI.money(-1000), '-₹1,000', 'money(-1000) negative form');
  eq(UI.money('75000'), '₹75,000', 'money accepts a numeric string');
  eq(UI.money('75,000'), '₹75,000', 'money strips existing commas');
  eq(UI.money('abc'), '₹0', 'money(non-numeric) -> zero');
  eq(UI.money(null), '₹0', 'money(null) -> zero');
  eq(UI.money(499.6), '₹500', 'money rounds like the server');

  // Cross-check against a literal re-implementation of the server routine,
  // over a wide range, so this cannot drift silently.
  function serverFormatINR(n) {
    let num = (typeof n === 'number') ? n : Number(String(n).trim().replace(/,/g, ''));
    if (!isFinite(num)) num = 0;
    num = Math.round(num);
    const negative = num < 0;
    const digits = String(Math.abs(num));
    let grouped;
    if (digits.length <= 3) grouped = digits;
    else {
      const last3 = digits.slice(-3);
      const rest = digits.slice(0, -3);
      grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
    }
    return (negative ? '-₹' : '₹') + grouped;
  }
  let drift = 0;
  for (let i = 0; i < 4000; i++) {
    const n = Math.floor(Math.random() * 1e9);
    if (UI.money(n) !== serverFormatINR(n)) { drift++; }
  }
  eq(drift, 0, '4000 random amounts all match the server routine');
})();

/* ================================================================== *
 * 2. UI.field
 * ================================================================== */
(function () {
  section('UI.field');

  const f = UI.field({
    label: 'Mobile number', name: 'mobile', type: 'tel',
    required: true, hint: '10 digits, starts 6-9', inputmode: 'numeric'
  });

  const label = f.wrap.find('field__label');
  ok(label !== null, 'field emits a .field__label');
  ok(f.input.id && f.input.id.length > 0, 'input has an id');
  eq(label.getAttribute('for'), f.input.id, 'label[for] is wired to input.id');
  eq(label.tagName, 'LABEL', 'the label really is a <label>');
  eq(f.input.tagName, 'INPUT', 'tel renders an <input>');
  eq(f.input.type, 'tel', 'type is passed through');
  eq(f.input.name, 'mobile', 'name is set');
  eq(f.input.required, true, 'required is set');
  eq(f.input.getAttribute('aria-required'), 'true', 'aria-required is set');
  eq(f.input.getAttribute('inputmode'), 'numeric', 'inputmode is plumbed through');
  ok(label.textContent.indexOf('Mobile number') === 0, 'label text is present');
  ok(label.textContent.indexOf('(required)') !== -1,
    'required is a WORD for screen readers, not just the * glyph');

  const hint = f.wrap.find('field__hint');
  ok(hint !== null, 'hint is emitted');
  eq(hint.textContent, '10 digits, starts 6-9', 'hint text');

  const err = f.wrap.find('field__error');
  ok(err !== null, 'error slot exists before any error');
  eq(err.getAttribute('aria-live'), 'polite', 'error slot is aria-live=polite');
  eq(err.hidden, true, 'error slot starts hidden');

  const describedBy = f.input.getAttribute('aria-describedby').split(' ');
  ok(describedBy.indexOf(hint.id) !== -1, 'aria-describedby includes the hint id');
  ok(describedBy.indexOf(err.id) !== -1, 'aria-describedby includes the error id');

  // --- setError / clearError
  ok(f.input.getAttribute('aria-invalid') === null, 'aria-invalid absent initially');
  f.setError('Enter a 10-digit mobile number.');
  eq(f.input.getAttribute('aria-invalid'), 'true', 'setError toggles aria-invalid on');
  eq(err.hidden, false, 'setError reveals the error slot');
  ok(err.textContent.indexOf('Enter a 10-digit mobile number.') !== -1,
    'setError shows the message');
  ok(err.textContent.indexOf('Error:') !== -1,
    'error carries the word "Error", not colour alone (DESIGN §51)');
  ok(f.wrap.className.indexOf('field--invalid') !== -1, 'wrap gains field--invalid');

  f.clearError();
  eq(f.input.getAttribute('aria-invalid'), null, 'clearError removes aria-invalid');
  eq(err.hidden, true, 'clearError re-hides the slot');
  eq(err.textContent, '', 'clearError empties the slot');
  eq(f.wrap.className, 'field', 'clearError removes field--invalid cleanly');

  // --- ids must be unique across fields
  const g = UI.field({ label: 'Mobile number', name: 'mobile', type: 'tel' });
  ok(g.input.id !== f.input.id, 'two fields with the same name get different ids');
  eq(g.wrap.find('field__label').getAttribute('for'), g.input.id,
    'second field label[for] wired to its own id');

  // --- every supported type
  eq(UI.field({ label: 'A', name: 'a', type: 'text' }).input.tagName, 'INPUT', 'type text');
  eq(UI.field({ label: 'A', name: 'a', type: 'date' }).input.type, 'date', 'type date');
  eq(UI.field({ label: 'A', name: 'a', type: 'number' }).input.type, 'number', 'type number');
  eq(UI.field({ label: 'A', name: 'a', type: 'textarea' }).input.tagName, 'TEXTAREA', 'type textarea');
  eq(UI.field({ label: 'A', name: 'a', type: 'select' }).input.tagName, 'SELECT', 'type select');

  const file = UI.field({ label: 'Photo', name: 'photo', type: 'file' });
  eq(file.input.tagName, 'INPUT', 'type file is an input');
  eq(file.input.getAttribute('accept'), 'image/*',
    'file defaults to accept="image/*" (CONTRACTS-PHASE1 §5.7)');
  ok(file.wrap.className.indexOf('field--file') !== -1, 'file wrap gets field--file');

  // --- select options, both shapes
  const sel = UI.field({
    label: 'Role', name: 'role', type: 'select', required: true,
    options: ['BATSMAN', 'BOWLER', 'ALL_ROUNDER']
  });
  eq(sel.input.children.length, 4, 'select gets a placeholder plus 3 options');
  eq(sel.input.children[0].value, '', 'placeholder option has an empty value');
  eq(sel.input.children[0].disabled, true, 'placeholder is disabled on a required select');
  eq(sel.input.children[1].value, 'BATSMAN', 'string option value');
  eq(sel.input.children[1].textContent, 'BATSMAN', 'string option label');

  const sel2 = UI.field({
    label: 'Style', name: 'style', type: 'select', placeholderOption: '',
    options: [{ value: 'RIGHT_HAND', label: 'Right hand' }]
  });
  eq(sel2.input.children.length, 1, 'placeholderOption:"" omits the placeholder');
  eq(sel2.input.children[0].value, 'RIGHT_HAND', 'object option value');
  eq(sel2.input.children[0].textContent, 'Right hand', 'object option label');
})();

/* ================================================================== *
 * 3. UI.banner
 * ================================================================== */
(function () {
  section('UI.banner');
  const e = UI.banner('error', 'A registration already exists for this mobile number.');
  eq(e.className, 'banner banner--error', 'error banner classes');
  eq(e.getAttribute('role'), 'alert', 'error banner interrupts with role=alert');
  ok(e.textContent.indexOf('A registration already exists') !== -1, 'error message present');
  ok(e.textContent.indexOf('Error:') !== -1, 'error banner carries the word "Error"');
  const mark = e.find('banner__mark');
  ok(mark !== null, 'error banner has a glyph');
  eq(mark.getAttribute('aria-hidden'), 'true', 'glyph is decorative only');

  const s = UI.banner('success', 'Registered.');
  eq(s.className, 'banner banner--success', 'success banner classes');
  eq(s.getAttribute('role'), 'status', 'success banner does not interrupt');
  ok(s.textContent.indexOf('Success:') !== -1, 'success banner carries the word');

  const i = UI.banner('info', 'Registration opens on 1 Aug 2026.');
  eq(i.className, 'banner banner--info', 'info banner classes');
  eq(UI.banner('nonsense', 'x').className, 'banner banner--info', 'unknown kind -> info');
})();

/* ================================================================== *
 * 4. UI.button — the double-submission guard
 * ================================================================== */
(async function () {
  section('UI.button busyLabel');

  let calls = 0;
  let releaseIt;
  const inFlight = new Promise(function (r) { releaseIt = r; });

  const btn = UI.button('Submit registration', function () {
    calls++;
    return inFlight;
  }, { variant: 'primary', busyLabel: 'Submitting…' });

  eq(btn.tagName, 'BUTTON', 'button is a <button>');
  eq(btn.type, 'button', 'type=button so a stray Enter cannot submit a form');
  eq(btn.className, 'btn btn--primary', 'variant class');
  eq(btn.textContent, 'Submit registration', 'label before click');
  eq(btn.disabled, false, 'enabled before click');

  btn.dispatch('click');

  eq(calls, 1, 'onClick ran once');
  eq(btn.disabled, true, 'DISABLED while the submit is in flight');
  eq(btn.getAttribute('aria-busy'), 'true', 'aria-busy set while in flight');
  eq(btn.textContent, 'Submitting…', 'label swapped to busyLabel');
  ok(btn.className.indexOf('btn--busy') !== -1, 'btn--busy class applied');
  eq(btn.dataset.busy, '1', 'busy flag set synchronously');

  // The whole point: a second tap during the upload must do nothing.
  btn.dispatch('click');
  btn.dispatch('click');
  eq(calls, 1, 'THREE taps, ONE submit — no duplicate registration');

  releaseIt('done');
  await new Promise(function (r) { setTimeout(r, 0); });

  eq(btn.disabled, false, 'restored: enabled again');
  eq(btn.textContent, 'Submit registration', 'restored: original label');
  eq(btn.getAttribute('aria-busy'), null, 'restored: aria-busy cleared');
  eq(btn.className, 'btn btn--primary', 'restored: btn--busy removed');
  eq(btn.dataset.busy, undefined, 'restored: busy flag cleared');

  btn.dispatch('click');
  eq(calls, 2, 'clickable again after it settles');

  // --- a REJECTED submit must also restore, or a retry is impossible
  let rejectIt;
  const failing = new Promise(function (_, rj) { rejectIt = rj; });
  const b2 = UI.button('Save', function () { return failing; }, { busyLabel: 'Saving…' });
  b2.dispatch('click');
  eq(b2.disabled, true, 'disabled during a submit that will fail');
  rejectIt({ code: 'DUPLICATE_MOBILE', message: 'x' });
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(b2.disabled, false, 'restored after a REJECTED submit, so retry works');
  eq(b2.textContent, 'Save', 'label restored after rejection');

  // --- a handler that throws synchronously must not wedge the button
  const b3 = UI.button('Boom', function () { throw new Error('sync'); }, { busyLabel: 'Working…' });
  try { b3.dispatch('click'); } catch (e) { /* re-thrown on purpose */ }
  eq(b3.disabled, false, 'restored after a synchronous throw');
  eq(b3.textContent, 'Boom', 'label restored after a synchronous throw');

  // --- no busyLabel: plain pass-through
  let plain = 0;
  const b4 = UI.button('Cancel', function () { plain++; }, { variant: 'secondary' });
  eq(b4.className, 'btn btn--secondary', 'secondary variant');
  b4.dispatch('click');
  b4.dispatch('click');
  eq(plain, 2, 'without busyLabel the button is an ordinary button');
})().then(runProgressAndDialogTests).then(runImageTests).then(report);

/* ================================================================== *
 * 5. UI.spinner and UI.progress
 * ================================================================== */
async function runProgressAndDialogTests() {
  section('UI.spinner / UI.progress');

  const sp = UI.spinner('Uploading photo…');
  eq(sp.className, 'spinner', 'spinner class');
  eq(sp.getAttribute('role'), 'status', 'spinner is role=status');
  eq(sp.getAttribute('aria-live'), 'polite', 'spinner is a live region');
  eq(sp.find('spinner__mark').getAttribute('aria-hidden'), 'true',
    'spinner glyph is decorative');
  eq(sp.find('spinner__label').textContent, 'Uploading photo…', 'spinner label text');
  eq(UI.spinner().find('spinner__label').textContent, 'Loading…', 'spinner default label');

  const p = UI.progress('Uploading');
  eq(p.el.className, 'progress', 'progress wrapper class');
  eq(p.bar.tagName, 'PROGRESS', 'a REAL <progress> element');
  eq(p.bar.max, 100, 'progress max=100');
  eq(p.bar.value, 0, 'progress starts at 0');
  eq(p.bar.getAttribute('aria-label'), 'Uploading', 'progress has an aria-label');
  const plabel = p.el.find('progress__label');
  eq(plabel.textContent, 'Uploading 0%', 'accessible text alternative present');
  eq(plabel.getAttribute('aria-live'), 'polite', 'text alternative is a live region');

  p.set(40);
  eq(p.bar.value, 40, 'set(40) moves the bar');
  eq(plabel.textContent, 'Uploading 40%', 'set(40) updates the text');
  p.set(-5);   eq(p.bar.value, 0,   'set clamps below 0');
  p.set(500);  eq(p.bar.value, 100, 'set clamps above 100');
  p.set('60'); eq(p.bar.value, 60,  'set accepts a numeric string');
  p.set(NaN);  eq(p.bar.value, 0,   'set(NaN) -> 0, never undefined');
  p.done();
  eq(p.bar.value, 100, 'done() fills the bar');
  eq(plabel.textContent, 'Done', 'done() updates the text');

  /* ============================================================== *
   * 6. UI.confirmDialog
   * ============================================================== */
  section('UI.confirmDialog');

  // --- dismissal by Escape resolves FALSE
  {
    sandboxDocument.body.children = [];
    const promise = UI.confirmDialog({
      title: 'Reopen registration?', body: 'Players will be able to register again.',
      confirmLabel: 'Reopen'
    });

    const dlg = sandboxDocument.body.children[0];
    eq(dlg.tagName, 'DIALOG', 'native <dialog> used where supported');
    eq(dlg.__showModalCalled, true, 'showModal() called, not window.confirm');
    ok(dlg.getAttribute('aria-labelledby') === dlg.find('dialog__title').id,
      'aria-labelledby points at the title');
    ok(dlg.getAttribute('aria-describedby') === dlg.find('dialog__body').id,
      'aria-describedby points at the body');
    eq(dlg.find('dialog__title').textContent, 'Reopen registration?', 'title text');
    const actions = dlg.find('dialog__actions');
    eq(actions.children[0].textContent, 'Reopen', 'confirm button uses confirmLabel');
    eq(actions.children[1].textContent, 'Cancel', 'cancel button present');
    ok(sandboxDocument.activeElement === actions.children[0], 'confirm is focused on open');

    let prevented = 0;
    sandboxDocument.dispatchKey({
      key: 'Escape',
      preventDefault() { prevented++; },
      stopPropagation() {}
    });
    eq(await promise, false, 'ESCAPE resolves FALSE');
    ok(prevented > 0, 'Escape is preventDefault-ed so it cannot also close a parent');
    eq(dlg.__closeCalled, true, 'dialog.close() called');
    eq(sandboxDocument.body.children.length, 0, 'dialog removed from the DOM on close');
  }

  // --- cancel button resolves FALSE
  {
    sandboxDocument.body.children = [];
    const promise = UI.confirmDialog({ title: 'Delete?' });
    const dlg = sandboxDocument.body.children[0];
    dlg.find('dialog__actions').children[1].dispatch('click');
    eq(await promise, false, 'cancel button resolves FALSE');
  }

  // --- backdrop click resolves FALSE
  {
    sandboxDocument.body.children = [];
    const promise = UI.confirmDialog({ title: 'Delete?' });
    const dlg = sandboxDocument.body.children[0];
    dlg.dispatch('click', { target: dlg, preventDefault() {}, stopPropagation() {} });
    eq(await promise, false, 'backdrop click resolves FALSE');
  }

  // --- native cancel event resolves FALSE
  {
    sandboxDocument.body.children = [];
    const promise = UI.confirmDialog({ title: 'Delete?' });
    const dlg = sandboxDocument.body.children[0];
    dlg.dispatch('cancel', { preventDefault() {}, stopPropagation() {} });
    eq(await promise, false, 'native cancel event resolves FALSE');
  }

  // --- confirm resolves TRUE, exactly once
  {
    sandboxDocument.body.children = [];
    const promise = UI.confirmDialog({ title: 'Reopen?', danger: true });
    const dlg = sandboxDocument.body.children[0];
    const actions = dlg.find('dialog__actions');
    eq(actions.children[0].className, 'btn btn--danger', 'danger:true styles the confirm');
    actions.children[0].dispatch('click');
    actions.children[1].dispatch('click');    // a late tap must not flip it
    eq(await promise, true, 'confirm resolves TRUE and settles only once');
  }

  // --- focus trap: Tab cycles between the two buttons and never escapes
  {
    sandboxDocument.body.children = [];
    const promise = UI.confirmDialog({ title: 'Trap?' });
    const dlg = sandboxDocument.body.children[0];
    const [confirmBtn, cancelBtn] = dlg.find('dialog__actions').children;

    sandboxDocument.dispatchKey({ key: 'Tab', shiftKey: false, preventDefault() {}, stopPropagation() {} });
    ok(sandboxDocument.activeElement === cancelBtn, 'Tab moves confirm -> cancel');
    sandboxDocument.dispatchKey({ key: 'Tab', shiftKey: false, preventDefault() {}, stopPropagation() {} });
    ok(sandboxDocument.activeElement === confirmBtn, 'Tab WRAPS cancel -> confirm, never leaves');
    sandboxDocument.dispatchKey({ key: 'Tab', shiftKey: true, preventDefault() {}, stopPropagation() {} });
    ok(sandboxDocument.activeElement === cancelBtn, 'Shift+Tab wraps backwards');

    cancelBtn.dispatch('click');
    await promise;
  }

  // --- fallback path when <dialog> is unsupported
  {
    const savedHDE = sandbox.HTMLDialogElement;
    sandbox.HTMLDialogElement = undefined;
    sandboxDocument.body.children = [];
    const promise = UI.confirmDialog({ title: 'Old Safari?' });
    const dlg = sandboxDocument.body.children[0];
    eq(dlg.tagName, 'DIV', 'fallback uses a <div>, not <dialog>');
    ok(dlg.className.indexOf('dialog--fallback') !== -1, 'fallback carries dialog--fallback');
    eq(dlg.getAttribute('role'), 'dialog', 'fallback sets role=dialog');
    eq(dlg.getAttribute('aria-modal'), 'true', 'fallback sets aria-modal');
    sandboxDocument.dispatchKey({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    eq(await promise, false, 'fallback: Escape resolves FALSE');
    sandbox.HTMLDialogElement = savedHDE;
  }

  // --- listener hygiene: nothing left bound after all of the above
  eq(((sandboxDocument._l || {}).keydown || []).length, 0,
    'every dialog removed its document keydown listener');
}

/* ================================================================== *
 * 7. ImageTool
 * ================================================================== */
async function runImageTests() {
  section('ImageTool guards');

  function mkFile(name, type, size, bytes) {
    const buf = bytes || new Uint8Array(0).buffer;
    return {
      name: name, type: type, size: size,
      slice() { return this; },
      arrayBuffer() { return Promise.resolve(buf); }
    };
  }

  async function rejects(p, what) {
    try {
      await p;
      failures.push(what + ' — resolved, expected a rejection');
    } catch (e) {
      ok(e && e.code === 'VALIDATION_FAILED',
        what + ' — rejects with code VALIDATION_FAILED (got ' + (e && e.code) + ')');
      ok(typeof e.message === 'string' && e.message.length > 10,
        what + ' — carries a usable message: "' + (e && e.message) + '"');
      return e;
    }
  }

  await rejects(ImageTool.fromFile(mkFile('cv.pdf', 'application/pdf', 1024)),
    'non-image (application/pdf)');
  await rejects(ImageTool.fromFile(mkFile('notes.txt', 'text/plain', 10)),
    'non-image (text/plain)');
  await rejects(ImageTool.fromFile(mkFile('a.exe', '', 10)),
    'empty mime with a non-image extension');
  await rejects(ImageTool.fromFile(mkFile('empty.jpg', 'image/jpeg', 0)),
    'zero-byte file');
  await rejects(ImageTool.fromFile(null), 'null file');
  await rejects(ImageTool.fromFile(undefined), 'undefined file');

  const over = await rejects(
    ImageTool.fromFile(mkFile('huge.jpg', 'image/jpeg', 26 * 1024 * 1024)),
    'oversized file (26 MB > 25 MB cap)');
  ok(over.message.indexOf('26.0 MB') !== -1,
    'oversize message names the actual size: "' + over.message + '"');
  ok(over.message.indexOf('25.0 MB') !== -1, 'oversize message names the limit');

  // Just under the cap must NOT be rejected by the guard.
  eq(ImageTool._checkFile(mkFile('ok.jpg', 'image/jpeg', 25 * 1024 * 1024 - 1)), null,
    'a file just under the cap passes the guard');
  eq(ImageTool._checkFile(mkFile('DSC_1.JPG', '', 1000)), null,
    'empty mime + .JPG extension is accepted (some Android pickers)');
  eq(ImageTool._checkFile(mkFile('x.heic', 'image/heic', 1000)), null,
    'HEIC accepted as input (re-encoded to JPEG on the way out)');

  // previewUrl throws, synchronously, with the same shape.
  try {
    ImageTool.previewUrl(mkFile('cv.pdf', 'application/pdf', 10));
    failures.push('previewUrl(non-image) — did not throw');
  } catch (e) {
    eq(e.code, 'VALIDATION_FAILED', 'previewUrl(non-image) throws {code,message}');
  }
  const beforeUrls = stub.objectUrls.created;
  const url = ImageTool.previewUrl(mkFile('p.jpg', 'image/jpeg', 100));
  ok(typeof url === 'string' && url.indexOf('blob:') === 0, 'previewUrl returns an object URL');
  eq(stub.objectUrls.created, beforeUrls + 1, 'previewUrl created exactly one object URL');

  /* -------------------------------------------------------------- *
   * JPEG header parser — the EXIF / SOF logic, tested on real bytes
   * -------------------------------------------------------------- */
  section('ImageTool.parseJpegHeader');

  /**
   * Build a JPEG head: SOI, an EXIF APP1 with the given orientation, then an
   * SOF0 declaring the given stored width/height, then SOS.
   */
  function jpegHead(orientation, w, h, bigEndian) {
    const b = [];
    const u16 = function (n) { b.push((n >> 8) & 0xFF, n & 0xFF); };

    b.push(0xFF, 0xD8);                                  // SOI

    if (orientation !== null) {
      // TIFF block: bom(2) 42(2) ifd0offset(4) count(2) entry(12) next(4) = 26
      const tiff = [];
      const t16 = function (n) {
        if (bigEndian) tiff.push((n >> 8) & 0xFF, n & 0xFF);
        else tiff.push(n & 0xFF, (n >> 8) & 0xFF);
      };
      const t32 = function (n) {
        if (bigEndian) tiff.push((n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF);
        else tiff.push(n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF);
      };
      if (bigEndian) tiff.push(0x4D, 0x4D); else tiff.push(0x49, 0x49);
      t16(42);
      t32(8);                       // IFD0 starts 8 bytes into the TIFF block
      t16(1);                       // one entry
      t16(0x0112); t16(3); t32(1); t16(orientation); t16(0);   // Orientation
      t32(0);                       // no next IFD

      b.push(0xFF, 0xE1);
      u16(2 + 6 + tiff.length);
      b.push(0x45, 0x78, 0x69, 0x66, 0x00, 0x00);        // "Exif\0\0"
      Array.prototype.push.apply(b, tiff);
    }

    b.push(0xFF, 0xC0);                                  // SOF0
    u16(8 + 3 * 3);
    b.push(8);                                           // precision
    u16(h); u16(w);                                      // height THEN width
    b.push(3);
    for (let i = 0; i < 3; i++) b.push(1 + i, 0x11, 0);

    b.push(0xFF, 0xDA, 0x00, 0x02);                      // SOS
    return new Uint8Array(b).buffer;
  }

  let hdr = ImageTool.parseJpegHeader(jpegHead(6, 4000, 3000, true));
  eq(hdr.orientation, 6, 'big-endian EXIF orientation 6 read correctly');
  eq(hdr.rawWidth, 4000, 'SOF stored width read correctly');
  eq(hdr.rawHeight, 3000, 'SOF stored height read correctly');

  hdr = ImageTool.parseJpegHeader(jpegHead(8, 1600, 1200, false));
  eq(hdr.orientation, 8, 'little-endian EXIF orientation 8 read correctly');
  eq(hdr.rawWidth, 1600, 'SOF width, little-endian file');

  hdr = ImageTool.parseJpegHeader(jpegHead(1, 800, 600, true));
  eq(hdr.orientation, 1, 'orientation 1 read as 1');
  eq(hdr.rawWidth, 800, 'SOF width still found when orientation is 1');

  hdr = ImageTool.parseJpegHeader(jpegHead(null, 800, 600, true));
  eq(hdr.orientation, 1, 'no EXIF segment -> orientation defaults to 1');
  eq(hdr.rawWidth, 800, 'SOF width found with no EXIF segment');

  eq(ImageTool.parseJpegHeader(new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer),
    { orientation: 1, rawWidth: 0, rawHeight: 0 }, 'a PNG magic number parses as "unknown"');
  eq(ImageTool.parseJpegHeader(new Uint8Array([]).buffer),
    { orientation: 1, rawWidth: 0, rawHeight: 0 }, 'empty buffer is safe');
  eq(ImageTool.parseJpegHeader(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF]).buffer),
    { orientation: 1, rawWidth: 0, rawHeight: 0 }, 'truncated APP1 is safe (no throw)');

  // A DHT marker sits inside the 0xC0-0xCF range and must NOT be read as SOF.
  {
    const b = [0xFF, 0xD8, 0xFF, 0xC4, 0x00, 0x05, 1, 2, 3, 0xFF, 0xDA, 0x00, 0x02];
    eq(ImageTool.parseJpegHeader(new Uint8Array(b).buffer).rawWidth, 0,
      'DHT (0xFFC4) is not mistaken for a frame header');
  }

  /* -------------------------------------------------------------- *
   * fromFile — canvas is stubbed, so this checks the CALL SHAPE
   * -------------------------------------------------------------- */
  section('ImageTool.fromFile call shape and options plumbing');

  const bigJpeg = jpegHead(1, 4000, 3000, true);

  // --- default options, landscape 4000x3000, no rotation outstanding
  stub.createImageBitmapCalls.length = 0;
  stub.bitmapClosed = 0;
  stub.bitmapSize = { width: 4000, height: 3000 };
  canvasLog.length = 0;

  let out = await ImageTool.fromFile(mkFile('IMG_4821.JPG', 'image/jpeg', 4100000, bigJpeg));

  eq(stub.createImageBitmapCalls.length, 1, 'exactly ONE decode for fromFile');
  eq(stub.createImageBitmapCalls[0], { imageOrientation: 'from-image' },
    'createImageBitmap asked for imageOrientation:"from-image"');
  eq(stub.bitmapClosed, 1, 'the ImageBitmap was close()d — no leaked pixel buffer');

  eq(canvasLog.length, 1, 'one canvas created');
  eq(canvasLog[0].sizeAtEncode, [1024, 768], 'resized to maxEdge 1024 (4000x3000 -> 1024x768)');
  eq(canvasLog[0].toDataURLArgs, ['image/jpeg', 0.8],
    'default output is JPEG at quality 0.8 (CONTRACTS-PHASE1 §1)');
  eq([canvasLog[0].width, canvasLog[0].height], [0, 0],
    'canvas zeroed after use — backing store freed');

  const ctx = canvasLog[0]._ctx;
  eq(ctx.calls[0], ['fillRect', 0, 0, 1024, 768],
    'white fill before drawing, so a transparent PNG does not go black in JPEG');
  eq(ctx.fillStyle, '#FFFFFF', 'the fill is white');
  eq(ctx.imageSmoothingQuality, 'high', 'high-quality downscale requested');
  eq(ctx.calls[1], ['setTransform', 1, 0, 0, 1, 0, 0], 'identity transform when orientation is 1');
  eq(ctx.calls[2], ['drawImage', 'bitmap', 0, 0, 1024, 768], 'drawImage covers the whole canvas');

  eq(out.mime, 'image/jpeg', 'mime is read back from the data URL, not assumed');
  eq(out.width, 1024, 'reported width');
  eq(out.height, 768, 'reported height');
  eq(out.filename, 'IMG_4821.jpg', 'filename keeps the stem, gains the real extension');

  // THE contract detail: base64 with no data: prefix.
  eq(out.data, Buffer.from('ABCDE').toString('base64'), 'data is the raw base64 payload');
  ok(out.data.indexOf('data:') === -1, 'data carries NO "data:" prefix');
  ok(out.data.indexOf(',') === -1, 'data carries no comma, i.e. no data-URL header at all');
  ok(out.data.indexOf('base64') === -1, 'data carries no ";base64" marker');
  ok(/^[A-Za-z0-9+/]+={0,2}$/.test(out.data), 'data is pure base64 alphabet');
  eq(Buffer.from(out.data, 'base64').toString(), 'ABCDE',
    'data round-trips through a base64 decoder, like Utilities.base64Decode will');
  eq(out.bytes, 5, 'bytes = the DECODED size ("ABCDE" is 5 bytes), not the base64 length');
  ok(out.bytes < out.data.length, 'bytes is smaller than the base64 string, as it must be');

  // --- never upscale
  stub.bitmapSize = { width: 300, height: 200 };
  canvasLog.length = 0;
  out = await ImageTool.fromFile(mkFile('small.jpg', 'image/jpeg', 9000, jpegHead(1, 300, 200, true)));
  eq([out.width, out.height], [300, 200], 'a 300x200 image is NOT upscaled to 1024');

  // --- maxEdge and quality plumbing
  stub.bitmapSize = { width: 4000, height: 3000 };
  canvasLog.length = 0;
  out = await ImageTool.fromFile(mkFile('s.jpg', 'image/jpeg', 100000, bigJpeg),
    { maxEdge: 320, quality: 0.5 });
  eq(canvasLog[0].sizeAtEncode, [320, 240], 'maxEdge:320 honoured');
  eq(canvasLog[0].toDataURLArgs, ['image/jpeg', 0.5], 'quality:0.5 honoured');

  // --- keepPng: the QR code path
  stub.bitmapSize = { width: 512, height: 512 };
  canvasLog.length = 0;
  out = await ImageTool.fromFile(mkFile('upi-qr.png', 'image/png', 40000), { keepPng: true });
  eq(canvasLog[0].toDataURLArgs[0], 'image/png',
    'keepPng:true on a PNG stays PNG — a JPEG-recompressed QR can be unscannable');
  eq(out.mime, 'image/png', 'reported mime is PNG');
  eq(out.filename, 'upi-qr.png', 'PNG keeps the .png extension');
  eq(canvasLog[0]._ctx.calls[0][0], 'setTransform',
    'no white fill for PNG output — transparency is preserved');

  canvasLog.length = 0;
  out = await ImageTool.fromFile(mkFile('shot.jpg', 'image/jpeg', 40000, jpegHead(1, 512, 512, true)),
    { keepPng: true });
  eq(canvasLog[0].toDataURLArgs[0], 'image/jpeg',
    'keepPng on a JPEG input still outputs JPEG (never inflate a photo into PNG)');

  // --- an invalid quality falls back to the contract default
  canvasLog.length = 0;
  await ImageTool.fromFile(mkFile('q.jpg', 'image/jpeg', 40000, jpegHead(1, 512, 512, true)),
    { quality: 5 });
  eq(canvasLog[0].toDataURLArgs[1], 0.8, 'out-of-range quality falls back to 0.8');

  /* -------------------------------------------------------------- *
   * EXIF orientation: the dimension cross-check
   * -------------------------------------------------------------- */
  section('ImageTool EXIF orientation cross-check');

  // (a) Browser IGNORED the tag: bitmap comes back at the STORED size.
  stub.bitmapSize = { width: 4000, height: 3000 };
  canvasLog.length = 0;
  out = await ImageTool.fromFile(
    mkFile('portrait.jpg', 'image/jpeg', 4000000, jpegHead(6, 4000, 3000, true)));
  eq([out.width, out.height], [768, 1024],
    'orientation 6 + un-rotated bitmap -> output is PORTRAIT, not sideways');
  eq(canvasLog[0]._ctx.calls[1], ['setTransform', 0, 1, -1, 0, 768, 0],
    'the orientation-6 quarter-turn matrix is applied');
  eq(canvasLog[0]._ctx.calls[2], ['drawImage', 'bitmap', 0, 0, 1024, 768],
    'drawImage box is swapped inside the rotated frame');

  // (b) Browser APPLIED the tag: bitmap comes back already swapped.
  stub.bitmapSize = { width: 3000, height: 4000 };
  canvasLog.length = 0;
  out = await ImageTool.fromFile(
    mkFile('portrait.jpg', 'image/jpeg', 4000000, jpegHead(6, 4000, 3000, true)));
  eq([out.width, out.height], [768, 1024], 'output is portrait either way');
  eq(canvasLog[0]._ctx.calls[1], ['setTransform', 1, 0, 0, 1, 0, 0],
    'no SECOND rotation when the browser already did it (this is the bug the '
    + 'cross-check exists to avoid)');

  // (c) Orientation 8, browser ignored it.
  stub.bitmapSize = { width: 4000, height: 3000 };
  canvasLog.length = 0;
  await ImageTool.fromFile(mkFile('p8.jpg', 'image/jpeg', 4000000, jpegHead(8, 4000, 3000, true)));
  eq(canvasLog[0]._ctx.calls[1], ['setTransform', 0, -1, 1, 0, 0, 1024],
    'the orientation-8 matrix is applied');

  /* -------------------------------------------------------------- *
   * pair() — one decode, two sizes
   * -------------------------------------------------------------- */
  section('ImageTool.pair');

  stub.createImageBitmapCalls.length = 0;
  stub.bitmapClosed = 0;
  stub.bitmapSize = { width: 4000, height: 3000 };
  canvasLog.length = 0;

  const both = await ImageTool.pair(mkFile('IMG_9001.jpg', 'image/jpeg', 4200000, bigJpeg));

  eq(stub.createImageBitmapCalls.length, 1,
    'pair() decodes the 4 MB photo exactly ONCE, not twice');
  eq(stub.bitmapClosed, 1, 'the single bitmap is released once');
  eq(canvasLog.length, 2, 'two canvases, one per size');
  eq(canvasLog[0].sizeAtEncode, [1024, 768], 'photo is 1024 on the long edge');
  eq(canvasLog[1].sizeAtEncode, [320, 240], 'photoThumb is 320 on the long edge');
  eq(canvasLog.map(function (c) { return [c.width, c.height]; }), [[0, 0], [0, 0]],
    'both canvases zeroed afterwards');

  eq(Object.keys(both).sort(), ['photo', 'photoThumb'], 'pair returns {photo, photoThumb}');
  eq([both.photo.width, both.photo.height], [1024, 768], 'photo dimensions');
  eq([both.photoThumb.width, both.photoThumb.height], [320, 240], 'photoThumb dimensions');
  eq(both.photo.filename, 'IMG_9001.jpg', 'photo filename');
  eq(both.photoThumb.filename, 'IMG_9001_thumb.jpg', 'photoThumb filename is distinct');
  ok(both.photo.data.indexOf('data:') === -1, 'photo.data has no data: prefix');
  ok(both.photoThumb.data.indexOf('data:') === -1, 'photoThumb.data has no data: prefix');
  eq([both.photo.mime, both.photoThumb.mime], ['image/jpeg', 'image/jpeg'], 'both are JPEG');

  // Both entries carry the full transport shape the server expects.
  ['data', 'mime', 'filename', 'width', 'height', 'bytes'].forEach(function (k) {
    ok(Object.prototype.hasOwnProperty.call(both.photo, k), 'photo has "' + k + '"');
    ok(Object.prototype.hasOwnProperty.call(both.photoThumb, k), 'photoThumb has "' + k + '"');
  });

  await rejects(ImageTool.pair(mkFile('cv.pdf', 'application/pdf', 100)),
    'pair() guards the same way fromFile does');

  /* -------------------------------------------------------------- *
   * Fallback decode path (no createImageBitmap — Safari 14 and older)
   * -------------------------------------------------------------- */
  section('ImageTool <img> fallback (Safari <= 14)');

  const savedCIB = sandbox.createImageBitmap;
  sandbox.createImageBitmap = undefined;
  stub.bitmapSize = { width: 4000, height: 3000 };
  stub.objectUrls.created = 0;
  stub.objectUrls.revoked = 0;
  canvasLog.length = 0;

  out = await ImageTool.fromFile(mkFile('old.jpg', 'image/jpeg', 3000000, jpegHead(6, 4000, 3000, true)));
  eq([out.width, out.height], [768, 1024], 'fallback path also produces a portrait result');
  eq(canvasLog[0]._ctx.calls[2][1], 'img', 'the fallback drew an <img>, not an ImageBitmap');
  eq(stub.objectUrls.created, 1, 'fallback created one object URL');
  eq(stub.objectUrls.revoked, 1, 'fallback REVOKED it — no leak per re-pick');
  ok(out.data.indexOf('data:') === -1, 'fallback output still has no data: prefix');

  sandbox.createImageBitmap = savedCIB;

  /* -------------------------------------------------------------- *
   * Helpers
   * -------------------------------------------------------------- */
  section('ImageTool helpers');
  eq(ImageTool._splitDataUrl('data:image/png;base64,QUJD'), { mime: 'image/png', data: 'QUJD' },
    '_splitDataUrl strips the whole header');
  eq(ImageTool._splitDataUrl('not a data url'), { mime: '', data: '' }, '_splitDataUrl is safe on junk');
  eq(ImageTool._base64Bytes('QUJDREU='), 5, '_base64Bytes handles one pad char');
  eq(ImageTool._base64Bytes('QUJDRA=='), 4, '_base64Bytes handles two pad chars');
  eq(ImageTool._base64Bytes('QUJD'), 3, '_base64Bytes handles no padding');
  eq(ImageTool._base64Bytes(''), 0, '_base64Bytes handles empty');
  eq(ImageTool._baseName('/some/path/My Photo (1).JPEG'), 'My_Photo_1', '_baseName sanitises');
  eq(ImageTool._baseName('../../etc/passwd'), 'passwd', '_baseName drops directory traversal');
  eq(ImageTool._baseName('..\\..\\win\\file.jpg'), 'file', '_baseName drops backslash paths');
  eq(ImageTool._baseName('...'), 'image', '_baseName on all-dots falls back');
  eq(ImageTool._baseName('a'.repeat(200) + '.jpg'), 'a'.repeat(60), '_baseName caps the length');
  eq(ImageTool._baseName(''), 'image', '_baseName never returns empty');
  eq(ImageTool.formatBytes(4194304), '4.0 MB', 'formatBytes MB');
  eq(ImageTool.formatBytes(153600), '150 KB', 'formatBytes KB');
}

/* ------------------------------------------------------------------ */
function report() {
  console.log('\n============================================');
  console.log('passed:  ' + pass);
  console.log('failed:  ' + failures.length);
  if (failures.length) {
    console.log('\nFAILURES');
    failures.forEach(function (f, i) { console.log('  ' + (i + 1) + '. ' + f); });
    process.exitCode = 1;
  } else {
    console.log('ALL GREEN');
  }
}

process.on('unhandledRejection', function (e) {
  console.error('\nUNHANDLED REJECTION:', e);
  process.exitCode = 1;
});
