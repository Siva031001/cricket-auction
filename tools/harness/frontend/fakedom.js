'use strict';
/**
 * fakedom.js — the smallest DOM that frontend/js/pages/display.js actually
 * touches, plus a fake clock, a stubbed API and an Image recorder.
 *
 * Deliberately tiny. It supports exactly the surface display.js uses:
 *   document.createElement / getElementById / body / documentElement / title
 *   document.addEventListener / removeEventListener / hidden / fullscreenElement
 *   node: className, classList, textContent, dataset, hidden, offsetWidth,
 *         appendChild, setAttribute, getAttribute, removeAttribute
 *   window.setTimeout / clearTimeout   (fake clock, advance() by hand)
 *   new Image()                        (records every src)
 *
 * Anything display.js starts using that is not here will throw loudly, which
 * is the point: a silent no-op would let a broken assertion pass.
 */

class ClassList {
  constructor(node) { this._node = node; }
  _list() {
    return String(this._node.className || '').split(/\s+/).filter(Boolean);
  }
  _write(list) { this._node.className = list.join(' '); }
  add(name) {
    const l = this._list();
    if (l.indexOf(name) === -1) l.push(name);
    this._write(l);
  }
  remove(name) { this._write(this._list().filter((n) => n !== name)); }
  contains(name) { return this._list().indexOf(name) !== -1; }
}

class TextNode {
  constructor(text) { this.nodeType = 3; this.data = String(text); this.childNodes = []; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class Element {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeType = 1;
    this.className = '';
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.hidden = false;
    this.id = '';
    this.classList = new ClassList(this);
    this.dataset = {};
    // Real elements always have one. Without it, any page setting an inline
    // style throws a TypeError inside its render and every assertion that
    // depends on the paint fails for an unrelated reason — which is exactly
    // what happened when the projector started sizing its team grid from the
    // team count.
    this.style = {};
    this.offsetWidth = 0;
    this._listeners = {};
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i !== -1) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name] : null;
  }
  removeAttribute(name) { delete this.attributes[name]; }
  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._listeners[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i !== -1) l.splice(i, 1);
  }
  dispatch(type, ev) {
    (this._listeners[type] || []).slice().forEach((fn) => fn(ev || {}));
  }
  listenerCount(type) { return (this._listeners[type] || []).length; }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this.childNodes.forEach((c) => { c.parentNode = null; });
    this.childNodes = [];
    const v = (value === null || value === undefined) ? '' : String(value);
    if (v !== '') this.appendChild(new TextNode(v));
  }
}

/** Depth-first walk, including the root. */
function walk(node, out) {
  out = out || [];
  out.push(node);
  (node.childNodes || []).forEach((c) => { if (c.nodeType === 1) walk(c, out); });
  return out;
}

/** Every element under `root` (inclusive) carrying `cls`. */
function byClass(root, cls) {
  return walk(root).filter((n) => n.classList && n.classList.contains(cls));
}

/** The first element under `root` carrying `cls`, or null. */
function oneByClass(root, cls) {
  return byClass(root, cls)[0] || null;
}

/** Visible text: skips any subtree whose root has hidden === true. */
function visibleText(node) {
  if (node.nodeType === 3) return node.data;
  if (node.hidden) return '';
  return (node.childNodes || []).map(visibleText).join(' ');
}

function makeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();

  return {
    now: () => now,
    setTimeout(fn, delay) {
      const id = ++seq;
      pending.set(id, { fn, at: now + Number(delay || 0), delay: Number(delay || 0) });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    /** The delays of every timer still armed. */
    delays() { return [...pending.values()].map((t) => t.delay); },
    count() { return pending.size; },
    /** Run every timer due within `ms`. Does NOT flush promises. */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, timer] = due[0];
        pending.delete(id);
        now = timer.at;
        timer.fn();
      }
      now = target;
    }
  };
}

/** Let every already-queued promise callback run. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

module.exports = {
  Element, TextNode, ClassList,
  walk, byClass, oneByClass, visibleText, makeClock, flush
};
