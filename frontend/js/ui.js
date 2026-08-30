/**
 * ui.js — the shared widget kit. `UI`.
 *
 * Implements CONTRACTS-PHASE1.md §4. Mobile-first per DESIGN.md §12 (§49),
 * colour-is-never-the-only-signal per DESIGN.md §8 (§51).
 *
 *   UI.field({label, name, type, required, hint, options})
 *                                  -> {wrap, input, setError, clearError}
 *   UI.banner(kind, message)       -> HTMLElement   kind: 'error'|'success'|'info'
 *   UI.button(label, onClick, {variant, busyLabel})  -> HTMLButtonElement
 *   UI.spinner(label)              -> HTMLElement
 *   UI.progress()                  -> {el, set(pct), done()}
 *   UI.money(rupees)               -> "₹500"
 *   UI.confirmDialog({title, body, confirmLabel})    -> Promise<boolean>
 *
 * Vanilla JS, no framework, no build step, no CDN, no web font
 * (CONTRACTS.md §15). Everything is document.createElement and textContent.
 * innerHTML appears nowhere in this file and must never be added: every label
 * and message here can carry a tournament name from the sheet or an error
 * string from the server, and both are untrusted (CONTRACTS-PHASE1.md §4).
 *
 * ===========================================================================
 * CSS CLASS NAMES EMITTED BY THIS FILE
 *
 * This module does not own frontend/css/app.css. It only sets class names.
 * The list below is the complete, exact set it can produce, for whoever owns
 * the stylesheet.
 *
 * ALREADY DEFINED in app.css — reused unchanged, nothing to do:
 *   field  field__label  field__hint  field__error  field--invalid
 *   input  select  textarea
 *   btn  btn--secondary
 *   banner  banner--error
 *   visually-hidden
 *
 * NEW — these need rules adding:
 *   field--file            file input row (native control, needs the 48px box)
 *   field__required        the "*" after a required label. Inherits --danger.
 *   input--file            <input type="file">, 48px min-height, full width
 *
 *   banner--success        green surface, matching banner--error's weight
 *   banner--info           neutral/accent surface
 *   banner__mark           the leading glyph. aria-hidden, so it is purely
 *                          visual; the text alternative is a sibling
 *                          .visually-hidden span. NOT colour alone (§51).
 *
 *   btn--primary           explicit form of the default .btn look
 *   btn--danger            destructive confirm action
 *   btn--busy              set while an async onClick is in flight; pair with
 *                          .btn[disabled], which already exists
 *
 *   spinner                inline-flex row, 48px min-height
 *   spinner__mark          the spinning glyph, aria-hidden. MUST be wrapped in
 *                          @media (prefers-reduced-motion: reduce) — app.css
 *                          section 10 already zeroes animations globally, so
 *                          this is covered as long as it uses `animation`.
 *   spinner__label         the text beside it
 *
 *   progress               wrapper
 *   progress__bar          the real <progress> element
 *   progress__label        the percentage as text, for screen readers and for
 *                          browsers that render <progress> as a thin line
 *
 *   dialog                 the <dialog> (or the div fallback)
 *   dialog--fallback       only on the non-<dialog> path; needs position:fixed,
 *                          inset:0 centring and its own scrim
 *   dialog__box            inner panel, so the fallback can centre it
 *   dialog__title          h2
 *   dialog__body           p
 *   dialog__actions        button row; confirm first in the DOM
 *
 * Also set, not classes:
 *   <body> is never touched here. Pages own document.body.dataset.route.
 * ===========================================================================
 */

/* eslint-disable no-unused-vars */
const UI = {

  /** Bumped for every generated id, so label[for] can never collide. */
  _seq: 0,

  /**
   * @param {string} prefix
   * @return {string} a document-unique id
   */
  _id: function (prefix) {
    UI._seq += 1;
    return String(prefix || 'ui') + '-' + UI._seq;
  },

  /**
   * createElement with a class and text in one call. textContent only.
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   * @return {HTMLElement}
   */
  _el: function (tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  },

  /**
   * Text that only a screen reader gets. Used to give every icon a word, so
   * meaning never rests on a glyph or a colour (DESIGN.md §8 / §51).
   * @param {string} text
   * @return {HTMLElement}
   */
  _srOnly: function (text) {
    return UI._el('span', 'visually-hidden', text);
  },

  /* ================================================================== *
   * UI.money
   * ================================================================== */

  /**
   * Format whole rupees with Indian digit grouping: last three digits, then
   * pairs.
   *
   *     500      -> "₹500"
   *     1000     -> "₹1,000"
   *     75000    -> "₹75,000"
   *     100000   -> "₹1,00,000"
   *     1000000  -> "₹10,00,000"
   *     10000000 -> "₹1,00,00,000"
   *     0        -> "₹0"
   *
   * THIS IS A DELIBERATE PORT of Util.formatINR in backend/Util.gs, right down
   * to the regex, and it is verified against the same numbers that
   * backend/Tests.gs asserts. It must stay identical.
   *
   * The server sends `reg_fee: 500` AND `reg_fee_display: "₹500"` in the same
   * response (CONTRACTS-PHASE1.md §2). If this function grouped differently,
   * one screen would say "₹10,00,000" and the next "₹1,000,000" for the same
   * amount, and a player would reasonably conclude the fee had changed.
   *
   * toLocaleString('en-IN') is not used, for the same reason the server does
   * not: support is uneven and a wrong currency separator is worse than a
   * hand-rolled one that is always right.
   *
   * @param {number|string} rupees  whole rupees. NOT paise — the field name in
   *        the CONTRACTS-PHASE1 §4 signature comment says "paise", but the
   *        worked example in that same line is 500 -> "₹500" and the server's
   *        reg_fee is an integer number of rupees (§2). Rupees it is.
   *        Non-numeric input formats as "₹0".
   * @return {string}
   */
  money: function (rupees) {
    let num = (typeof rupees === 'number')
      ? rupees
      : Number(String(rupees === null || rupees === undefined ? '' : rupees)
        .trim().replace(/,/g, ''));

    if (!isFinite(num)) num = 0;
    num = Math.round(num);

    const negative = num < 0;
    const digits = String(Math.abs(num));

    let grouped;
    if (digits.length <= 3) {
      grouped = digits;
    } else {
      const last3 = digits.slice(-3);
      const rest = digits.slice(0, -3);
      // A comma before every pair, counted from the right of `rest`.
      grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
    }

    return (negative ? '-₹' : '₹') + grouped;
  },

  /* ================================================================== *
   * UI.field
   * ================================================================== */

  /**
   * Build one labelled form control with a hint and an error slot.
   *
   * Every control is at least 48px tall via the .input/.select/.textarea
   * classes (DESIGN.md §12: most registrations happen one-handed on a phone,
   * standing in a queue). The font-size on those classes is >= 1rem, which is
   * also what stops iOS Safari zooming the page on focus and leaving the form
   * half off-screen.
   *
   * @param {Object} spec
   * @param {string} spec.label      visible label text
   * @param {string} spec.name       form field name; also seeds the id
   * @param {string} [spec.type='text']  text | tel | email | date | number |
   *        password | url | textarea | select | file. Anything else is passed
   *        through to <input type> untouched.
   * @param {boolean} [spec.required=false]
   * @param {string} [spec.hint]     one line under the label, e.g. the format
   * @param {Array} [spec.options]   for type 'select'. Either
   *        ['BATSMAN', 'BOWLER'] or [{value:'BATSMAN', label:'Batsman'}, ...].
   * @param {string} [spec.value]    initial value
   * @param {string} [spec.placeholder]
   * @param {string} [spec.accept]        type 'file'
   * @param {string} [spec.capture]       type 'file'; 'user'|'environment'
   *        opens the camera directly (DESIGN.md §12)
   * @param {boolean} [spec.multiple]     type 'file'
   * @param {string} [spec.inputmode]     e.g. 'numeric' for a UPI reference
   * @param {string} [spec.autocomplete]
   * @param {string|number} [spec.min]
   * @param {string|number} [spec.max]
   * @param {string|number} [spec.step]
   * @param {string|number} [spec.maxLength]
   * @param {number} [spec.rows=4]        type 'textarea'
   * @param {string} [spec.placeholderOption]  the "Select one" row prepended
   *        to a select. Defaults to '— Select —'. Pass '' to omit it.
   * @return {{wrap: HTMLElement, input: HTMLElement,
   *           setError: function(string): void, clearError: function(): void}}
   */
  field: function (spec) {
    const s = spec || {};
    const name = String(s.name || 'field');
    const type = String(s.type || 'text');
    const id = UI._id('f-' + name.replace(/[^A-Za-z0-9_-]+/g, '-'));
    const hintId = id + '-hint';
    const errId = id + '-error';

    const wrap = UI._el('div', 'field');
    if (type === 'file') wrap.className = 'field field--file';

    /* ---- label -------------------------------------------------- */
    const label = UI._el('label', 'field__label');
    label.setAttribute('for', id);              // real for/id binding, so the
    label.appendChild(                          // whole label is a tap target
      document.createTextNode(String(s.label === undefined ? name : s.label)));

    if (s.required) {
      // The asterisk is decorative; the word is what a screen reader hears.
      // Colour and a glyph are never the only signal (DESIGN.md §51).
      const star = UI._el('span', 'field__required', '*');
      star.setAttribute('aria-hidden', 'true');
      label.appendChild(document.createTextNode(' '));
      label.appendChild(star);
      label.appendChild(UI._srOnly(' (required)'));
    }
    wrap.appendChild(label);

    /* ---- control ------------------------------------------------ */
    let input;

    if (type === 'textarea') {
      input = UI._el('textarea', 'textarea');
      input.rows = Number(s.rows) > 0 ? Number(s.rows) : 4;

    } else if (type === 'select') {
      input = UI._el('select', 'select');
      const ph = (s.placeholderOption === undefined) ? '— Select —' : s.placeholderOption;
      if (ph !== '') {
        const opt = UI._el('option', null, ph);
        opt.value = '';
        // A required select must not be satisfiable by the placeholder.
        if (s.required) opt.disabled = true;
        input.appendChild(opt);
      }
      (s.options || []).forEach(function (o) {
        const isObj = (o && typeof o === 'object');
        const value = String(isObj ? o.value : o);
        const text = String(isObj ? (o.label === undefined ? o.value : o.label) : o);
        const opt = UI._el('option', null, text);
        opt.value = value;
        input.appendChild(opt);
      });

    } else {
      input = UI._el('input', type === 'file' ? 'input input--file' : 'input');
      input.type = type;
      if (type === 'file') {
        // accept="image/*" is required by CONTRACTS-PHASE1.md §5.7.
        input.setAttribute('accept', s.accept === undefined ? 'image/*' : String(s.accept));
        if (s.capture) input.setAttribute('capture', String(s.capture));
        if (s.multiple) input.multiple = true;
      }
    }

    input.id = id;
    input.name = name;
    if (s.required) {
      input.required = true;
      input.setAttribute('aria-required', 'true');
    }
    if (s.placeholder !== undefined && type !== 'select' && type !== 'file') {
      input.setAttribute('placeholder', String(s.placeholder));
    }
    ['inputmode', 'autocomplete', 'min', 'max', 'step', 'pattern'].forEach(function (attr) {
      if (s[attr] !== undefined && s[attr] !== null) {
        input.setAttribute(attr, String(s[attr]));
      }
    });
    if (s.maxLength !== undefined) input.setAttribute('maxlength', String(s.maxLength));
    if (s.value !== undefined && s.value !== null && type !== 'file') {
      input.value = String(s.value);
    }

    wrap.appendChild(input);

    /* ---- hint --------------------------------------------------- */
    const described = [];
    if (s.hint) {
      const hint = UI._el('span', 'field__hint', String(s.hint));
      hint.id = hintId;
      wrap.appendChild(hint);
      described.push(hintId);
    }

    /* ---- error slot --------------------------------------------- */
    // Always present, always empty to begin with. Creating it up front means
    // the announcement fires when the TEXT changes; a live region that is
    // inserted at the same moment it gets its text is often missed.
    const error = UI._el('span', 'field__error');
    error.id = errId;
    error.setAttribute('aria-live', 'polite');
    error.hidden = true;
    wrap.appendChild(error);
    described.push(errId);

    input.setAttribute('aria-describedby', described.join(' '));

    /**
     * Show a field error. Red comes from .field--invalid and .field__error,
     * the "⚠" glyph from the existing .field__error::before rule in app.css
     * section 6, and the word "Error:" from the visually-hidden span here.
     * Three signals, so the message survives greyscale and colour blindness
     * (DESIGN.md §51).
     * @param {string} message
     * @return {void}
     */
    const setError = function (message) {
      const text = String(message === undefined || message === null ? '' : message);
      if (!text) return clearError();

      error.textContent = '';
      error.appendChild(UI._srOnly('Error: '));
      error.appendChild(document.createTextNode(text));
      error.hidden = false;

      input.setAttribute('aria-invalid', 'true');
      wrap.className = wrap.className.indexOf('field--invalid') === -1
        ? wrap.className + ' field--invalid'
        : wrap.className;
    };

    /**
     * @return {void}
     */
    const clearError = function () {
      error.textContent = '';
      error.hidden = true;
      input.removeAttribute('aria-invalid');
      wrap.className = wrap.className
        .replace(/\s*\bfield--invalid\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };

    return { wrap: wrap, input: input, setError: setError, clearError: clearError };
  },

  /* ================================================================== *
   * UI.banner
   * ================================================================== */

  /**
   * A full-width message strip.
   *
   * Each kind carries a glyph AND a word AND a colour. On a phone in bright
   * sunlight the colour is the first thing to go, and about 1 in 12 men
   * cannot separate the red one from the green one at all (DESIGN.md §51).
   *
   * @param {string} kind  'error' | 'success' | 'info'. Anything else is
   *        treated as 'info'.
   * @param {string} message  shown verbatim; may be server text.
   * @return {HTMLElement}
   */
  banner: function (kind, message) {
    const kinds = {
      error:   { cls: 'banner--error',   mark: '⚠', word: 'Error: ',   role: 'alert' },
      success: { cls: 'banner--success', mark: '✓', word: 'Success: ', role: 'status' },
      info:    { cls: 'banner--info',    mark: 'ℹ', word: '',          role: 'status' }
    };
    const k = kinds[String(kind)] || kinds.info;

    const box = UI._el('div', 'banner ' + k.cls);
    // role="alert" interrupts; role="status" waits for a gap. An error the
    // player has to act on earns the interruption, a success message does not.
    box.setAttribute('role', k.role);
    if (k.role === 'status') box.setAttribute('aria-live', 'polite');

    const mark = UI._el('span', 'banner__mark', k.mark);
    mark.setAttribute('aria-hidden', 'true');   // decorative; the word follows
    box.appendChild(mark);
    box.appendChild(document.createTextNode(' '));

    if (k.word) box.appendChild(UI._srOnly(k.word));
    box.appendChild(document.createTextNode(
      String(message === undefined || message === null ? '' : message)));

    return box;
  },

  /* ================================================================== *
   * UI.button
   * ================================================================== */

  /**
   * A button that cannot be double-submitted.
   *
   * WHY busyLabel MATTERS (DESIGN.md §12, CONTRACTS-PHASE1.md §5.1)
   * Double submission is the single most common cause of duplicate
   * registrations. On 3G a player.register call takes several seconds while
   * two images upload; the page looks frozen, so the player taps again, and
   * the second tap lands before the first response. The server's lock catches
   * the duplicate mobile and returns DUPLICATE_MOBILE — but the player then
   * sees an error for a registration that actually succeeded, and gives up.
   *
   * So the button does three things the moment it is pressed:
   *   1. sets a busy flag BEFORE anything async starts, and ignores any
   *      further clicks while it is set. This is the part that actually
   *      prevents the second submit — `disabled` alone loses the race against
   *      a fast double-tap on some mobile browsers.
   *   2. disables itself and sets aria-busy, so the state is visible and
   *      announced.
   *   3. swaps the label to busyLabel ("Submitting…"), so the wait is
   *      obviously the app working, not the app hung.
   * Everything is restored when the promise settles, success or failure,
   * because a failed submit must be retryable.
   *
   * @param {string} label
   * @param {function(Event): (Promise|*)} onClick  may return a promise. The
   *        button restores itself whether it resolves or rejects, because a
   *        failed submit must stay retryable. A rejection is logged, not
   *        re-thrown — see the comment at the call site.
   * @param {Object} [opts]
   * @param {string} [opts.variant='primary']  'primary'|'secondary'|'danger'
   * @param {string} [opts.busyLabel]  when set, enables the guard above
   * @param {string} [opts.type='button']  'button' keeps a stray Enter key
   *        from submitting a surrounding <form>
   * @param {boolean} [opts.disabled=false]
   * @return {HTMLButtonElement}
   */
  button: function (label, onClick, opts) {
    const o = opts || {};
    const variant = String(o.variant || 'primary');
    const text = String(label === undefined ? '' : label);

    const btn = UI._el('button', 'btn btn--' + variant, text);
    btn.type = String(o.type || 'button');
    if (o.disabled) btn.disabled = true;

    btn.addEventListener('click', function (ev) {
      if (btn.disabled) return;

      if (!o.busyLabel) {
        if (typeof onClick === 'function') onClick(ev);
        return;
      }

      // (1) The flag, set synchronously, before any await point exists.
      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';

      // (2) and (3).
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.className = 'btn btn--' + variant + ' btn--busy';
      btn.textContent = String(o.busyLabel);

      const restore = function () {
        delete btn.dataset.busy;
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        btn.className = 'btn btn--' + variant;
        btn.textContent = text;
      };

      let result;
      try {
        result = (typeof onClick === 'function') ? onClick(ev) : undefined;
      } catch (syncErr) {
        // A handler that throws before it ever returns a promise must not
        // leave the button stuck as "Submitting…" forever.
        restore();
        throw syncErr;
      }

      Promise.resolve(result).then(restore, function (err) {
        restore();
        // Deliberately NOT re-thrown. Re-throwing here would create a fresh
        // rejected promise that nothing can ever attach a .catch to — the
        // page's own error handling lives inside onClick, on the promise it
        // returned, and has already run by this point. So a re-throw buys
        // nothing except a phantom "unhandled promise rejection" in the
        // console on every failed submit. Logging keeps a forgotten .catch
        // visible without inventing an unhandleable rejection.
        if (typeof console !== 'undefined' && console.error) {
          console.error('UI.button: "' + text + '" handler rejected', err);
        }
      });
    });

    return btn;
  },

  /* ================================================================== *
   * UI.spinner
   * ================================================================== */

  /**
   * "Working on it" indicator.
   *
   * The glyph is aria-hidden and the label is the accessible text, so a
   * screen reader hears "Uploading photo…" rather than a bullet character.
   * app.css section 10 already zeroes animations under
   * prefers-reduced-motion, which covers the spin.
   *
   * @param {string} [label='Loading…']
   * @return {HTMLElement}
   */
  spinner: function (label) {
    const text = String(label === undefined || label === null ? 'Loading…' : label);

    const box = UI._el('div', 'spinner');
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');

    const mark = UI._el('span', 'spinner__mark', '●');
    mark.setAttribute('aria-hidden', 'true');
    box.appendChild(mark);

    box.appendChild(UI._el('span', 'spinner__label', text));

    return box;
  },

  /* ================================================================== *
   * UI.progress
   * ================================================================== */

  /**
   * A real <progress> element plus a text percentage.
   *
   * CONTRACTS-PHASE1.md §5.2: on 3G a 150 KB upload takes seconds, and
   * silence makes people press submit again. The number matters as much as
   * the bar — a bar that has not visibly moved looks identical to a bar that
   * is stuck.
   *
   * @param {string} [label='Uploading']  prefix for the text alternative
   * @return {{el: HTMLElement, bar: HTMLElement,
   *           set: function(number): void, done: function(string=): void}}
   */
  progress: function (label) {
    const name = String(label === undefined || label === null ? 'Uploading' : label);

    const wrap = UI._el('div', 'progress');

    const bar = UI._el('progress', 'progress__bar');
    bar.max = 100;
    bar.value = 0;
    bar.setAttribute('aria-label', name);
    wrap.appendChild(bar);

    // <progress> announces inconsistently across screen readers, and some
    // browsers draw it only two pixels tall. The text is not a nicety.
    const text = UI._el('span', 'progress__label', name + ' 0%');
    text.setAttribute('role', 'status');
    text.setAttribute('aria-live', 'polite');
    wrap.appendChild(text);

    /**
     * @param {number} pct  clamped to 0..100
     * @return {void}
     */
    const set = function (pct) {
      let n = Number(pct);
      if (!isFinite(n)) n = 0;
      n = Math.max(0, Math.min(100, Math.round(n)));
      bar.value = n;
      bar.removeAttribute('data-indeterminate');
      text.textContent = name + ' ' + n + '%';
    };

    /**
     * @param {string} [message='Done']
     * @return {void}
     */
    const done = function (message) {
      bar.value = 100;
      text.textContent = String(
        message === undefined || message === null ? 'Done' : message);
    };

    return { el: wrap, bar: bar, set: set, done: done };
  },

  /* ================================================================== *
   * UI.confirmDialog
   * ================================================================== */

  /**
   * Modal yes/no. Resolves true only on the confirm button.
   *
   * NEVER window.confirm. It blocks the whole JS thread (so any poll or
   * upload in flight stalls), it cannot be styled or translated, several
   * mobile browsers show it with a "stop this page creating more dialogs"
   * checkbox that then suppresses every later one, and it is unusable inside
   * an async flow.
   *
   * Native <dialog>.showModal is used where it exists — Chrome 37+, Firefox
   * 98+, Safari 15.4+ — because it gives the top layer, the ::backdrop, real
   * inert-ing of the page behind, and Escape handling for free.
   *
   * FALLBACK for Firefox < 98 and Safari < 15.4: a plain div with
   * role="dialog" aria-modal="true" and class dialog--fallback, which needs
   * position:fixed centring and its own scrim in CSS. Focus trapping and
   * Escape are done in JS on BOTH paths, because the native trap does not
   * exist on the fallback and running the same code on both keeps one
   * behaviour to reason about.
   *
   * Dismissing in any way — Escape, the cancel button, a click on the
   * backdrop — resolves false. It never rejects, so callers can write
   *     if (!await UI.confirmDialog(...)) return;
   *
   * @param {Object} spec
   * @param {string} spec.title
   * @param {string} [spec.body]
   * @param {string} [spec.confirmLabel='Confirm']
   * @param {string} [spec.cancelLabel='Cancel']
   * @param {boolean} [spec.danger=false]  style confirm as destructive
   * @return {Promise<boolean>}
   */
  confirmDialog: function (spec) {
    const s = spec || {};
    const titleId = UI._id('dlg-title');
    const bodyId = UI._id('dlg-body');

    return new Promise(function (resolve) {
      const native = (typeof HTMLDialogElement === 'function') &&
        (typeof document.createElement('dialog').showModal === 'function');

      const root = document.createElement(native ? 'dialog' : 'div');
      root.className = native ? 'dialog' : 'dialog dialog--fallback';
      if (!native) {
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
      }
      root.setAttribute('aria-labelledby', titleId);

      const box = UI._el('div', 'dialog__box');

      const h = UI._el('h2', 'dialog__title', String(s.title || 'Are you sure?'));
      h.id = titleId;
      box.appendChild(h);

      if (s.body) {
        const p = UI._el('p', 'dialog__body', String(s.body));
        p.id = bodyId;
        root.setAttribute('aria-describedby', bodyId);
        box.appendChild(p);
      }

      const actions = UI._el('div', 'dialog__actions');

      // Whatever had focus before, so it can be handed back on close. Losing
      // focus to <body> would dump a keyboard user at the top of the page.
      const previous = document.activeElement;
      let settled = false;

      /**
       * @param {boolean} answer
       * @return {void}
       */
      const close = function (answer) {
        if (settled) return;
        settled = true;

        document.removeEventListener('keydown', onKeydown, true);
        try {
          if (native && root.open) root.close();
        } catch (e) { /* already closed */ }
        if (root.parentNode) root.parentNode.removeChild(root);

        if (previous && typeof previous.focus === 'function') {
          try { previous.focus(); } catch (e) { /* gone from the DOM */ }
        }
        resolve(!!answer);
      };

      const confirmBtn = UI.button(
        String(s.confirmLabel || 'Confirm'),
        function () { close(true); },
        { variant: s.danger ? 'danger' : 'primary' });

      const cancelBtn = UI.button(
        String(s.cancelLabel || 'Cancel'),
        function () { close(false); },
        { variant: 'secondary' });

      // Confirm first in the DOM so it is the default focus, cancel second.
      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
      box.appendChild(actions);
      root.appendChild(box);

      /**
       * Escape closes as "no", and Tab cycles inside the dialog.
       *
       * Capture phase, on the document, so it wins even if the page has its
       * own key handlers (the auction console binds F and R globally).
       * @param {KeyboardEvent} ev
       * @return {void}
       */
      function onKeydown(ev) {
        if (ev.key === 'Escape' || ev.key === 'Esc') {
          ev.preventDefault();
          ev.stopPropagation();
          close(false);
          return;
        }

        if (ev.key !== 'Tab') return;

        // Only two focusables, so the trap is small and exact. Wrapping by
        // hand rather than querying the subtree keeps it predictable.
        const order = [confirmBtn, cancelBtn];
        const at = order.indexOf(document.activeElement);
        ev.preventDefault();
        const next = ev.shiftKey
          ? order[(at <= 0 ? order.length : at) - 1]
          : order[(at + 1) % order.length];
        if (next && typeof next.focus === 'function') next.focus();
      }

      // A click on the dialog element itself, rather than on .dialog__box, is
      // a click on the backdrop area. Treat it as a dismissal.
      root.addEventListener('click', function (ev) {
        if (ev.target === root) close(false);
      });

      // Native Escape fires 'cancel' before 'close'; route it through the
      // same path so the promise always settles exactly once.
      root.addEventListener('cancel', function (ev) {
        ev.preventDefault();
        close(false);
      });

      document.body.appendChild(root);
      document.addEventListener('keydown', onKeydown, true);

      if (native) {
        try {
          root.showModal();
        } catch (e) {
          // showModal throws if the element is already open or not connected.
          root.setAttribute('open', '');
        }
      }

      if (typeof confirmBtn.focus === 'function') confirmBtn.focus();
    });
  }
};
