/**
 * register.js — the public player registration page.  Route /register/:tournamentId
 *
 * Spec: CONTRACTS-PHASE1.md §1 (image transport), §2 (tournament.getPublic,
 * player.checkMobile, player.register), §4 (structure), §5 (behaviour).
 * Design rationale: DESIGN.md §6.2, §8, §11, §12.
 *
 * This is the only screen an ordinary player ever sees, and they see it once,
 * on a phone, on mobile data, usually in a hurry. Every decision below is
 * biased towards "never lose a registration that the player already paid for".
 *
 * RULES CARRIED OVER FROM PHASE 0 AND STILL BINDING
 *   1. textContent only. NEVER innerHTML. The tournament name comes from a
 *      Sheet and the tournament id comes from the URL — both are untrusted.
 *   2. Vanilla JS. No framework, no build step, no CDN, no web font.
 *   3. <body data-route="register"> so register.css can scope itself.
 *   4. Every network call goes through API. Never fetch() directly.
 *
 * OWNED BY OTHER AGENTS — CALL, DO NOT REIMPLEMENT
 *   ImageTool  (js/image.js)  resize + base64, EXIF-aware
 *   UI         (js/ui.js)     field / banner / button / spinner / progress
 *   App, Router, API, CONFIG  the Phase 0 shell
 *
 * PAGE FLOW
 *   loading  ->  load failed (retry)          <- bad mobile data lands here
 *            ->  registration closed (stop)   <- never render a doomed form
 *            ->  form  ->  submitting  ->  confirmation
 *                      ^                 |
 *                      +---- server rejected, EVERY field kept ----+
 */

/* eslint-disable no-unused-vars */
const RegisterPage = {

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */

  /** Wire values are CONTRACTS.md §4 ENUM.PLAYER_ROLE. Labels are plain English. */
  ROLE_OPTIONS: [
    { value: 'BATSMAN', label: 'Batsman' },
    { value: 'BOWLER', label: 'Bowler' },
    { value: 'ALL_ROUNDER', label: 'All rounder' }
  ],

  /** ENUM.PLAYER_STYLE. "Left handed" / "Right handed" — not "batting style". */
  STYLE_OPTIONS: [
    { value: 'LEFT', label: 'Left handed' },
    { value: 'RIGHT', label: 'Right handed' }
  ],

  /**
   * Client-side messages. Deliberately the same words the server sends
   * (DESIGN.md §11) so a player never sees the same problem described two
   * different ways depending on which side caught it.
   */
  MSG: {
    name: 'Please enter your full name.',
    dob: 'Please check the date of birth.',
    role: 'Please choose your playing role.',
    style: 'Please choose left handed or right handed.',
    mobile: 'Enter a 10-digit mobile number.',
    mobileTaken: 'A registration already exists for this mobile number. Please contact the tournament organiser.',
    photo: 'Please upload a clear photo.',
    screenshot: 'Please upload your payment screenshot.',
    upiRef: 'Enter the reference number from your payment app. It is 6 to 35 letters and numbers.',
    stillPreparing: 'Your photos are still being prepared. Please wait a moment and press Submit again.',
    imageFailed: 'That image could not be read. Please choose another one.',
    fixBelow: 'Please check the highlighted answers below.'
  },

  /** Longest side / quality for the payment screenshot (CONTRACTS-PHASE1 §1). */
  SHOT_OPTS: { maxEdge: 1024, quality: 0.8 },

  /**
   * Rough upload speed used only to pace the progress bar, in bytes/second.
   * ~40 KB/s is a pessimistic 3G figure; being pessimistic is correct, because
   * a bar that crawls and then jumps to done reads as "working", while a bar
   * that hits 100% and sits there reads as "frozen".
   */
  ASSUMED_UPLOAD_BPS: 40000,

  /** The live page state. One per render; torn down by _cleanup. */
  _state: null,

  /* ------------------------------------------------------------------ *
   * Entry point
   * ------------------------------------------------------------------ */

  /**
   * Render the registration page.
   * @param {Object} ctx router context {path, params, query, pattern}
   * @return {void}
   */
  render: function (ctx) {
    RegisterPage._cleanup();

    document.body.dataset.route = 'register';
    document.title = 'Player registration · Cricket Auction';

    const tournamentId = String((ctx && ctx.params && ctx.params.tournamentId) || '').trim();

    const state = {
      ctx: ctx,
      tournamentId: tournamentId,
      tournament: null,
      fields: {},          // name -> UI.field result
      images: {},          // 'photo' | 'screenshot' -> encoded payload pieces
      pending: {},         // 'photo' | 'screenshot' -> true while encoding
      tokens: {},          // 'photo' | 'screenshot' -> race guard counter
      objectUrls: [],      // to revoke on teardown
      submitting: false,
      submitBtn: null,
      errorHost: null,
      progressHost: null,
      progress: null,
      progressTimer: null,
      mobileChecked: '',   // last mobile passed to player.checkMobile
      mobileTaken: false   // advisory only — never blocks submission
    };
    RegisterPage._state = state;

    if (!tournamentId) {
      // Only reachable if the router pattern changes; still better than a
      // request the server is bound to reject.
      RegisterPage._renderLoadError(state, {
        code: 'VALIDATION_FAILED',
        message: 'This registration link is incomplete. Please ask the organiser for the full link.'
      });
      return;
    }

    RegisterPage._load(state);
  },

  /**
   * Release anything the previous render is still holding. Called on every
   * render, so navigating away and back cannot leak object URLs or leave a
   * progress timer ticking against a detached bar.
   * @return {void}
   */
  _cleanup: function () {
    const s = RegisterPage._state;
    if (!s) return;

    if (s.progressTimer) {
      window.clearInterval(s.progressTimer);
      s.progressTimer = null;
    }
    RegisterPage._revokeAll(s);
    RegisterPage._state = null;
  },

  /* ------------------------------------------------------------------ *
   * Load
   * ------------------------------------------------------------------ */

  /**
   * Fetch the public tournament record and render whichever state it implies.
   * @param {Object} state
   * @return {void}
   */
  _load: function (state) {
    RegisterPage._renderLoading(state);

    API.call('tournament.getPublic', { tournamentId: state.tournamentId })
      .then(function (data) {
        if (RegisterPage._state !== state) return;   // navigated away mid-flight
        if (!data || typeof data !== 'object') {
          throw { code: 'INTERNAL_ERROR', message: 'The tournament details could not be read.' };
        }
        state.tournament = data;

        // §5.4 — if the server says registration is not open, render the reason
        // and STOP. Rendering a form the server is guaranteed to reject wastes
        // the player's data allowance and their patience.
        if (data.registration_open === true) {
          RegisterPage._renderForm(state);
        } else {
          RegisterPage._renderClosed(state, data.registration_message);
        }
      })
      .catch(function (err) {
        if (RegisterPage._state !== state) return;
        RegisterPage._renderLoadError(state, err);
      });
  },

  /* ------------------------------------------------------------------ *
   * Screen: loading
   * ------------------------------------------------------------------ */

  /**
   * @param {Object} state
   * @return {void}
   */
  _renderLoading: function (state) {
    const panel = RegisterPage._panel();
    panel.appendChild(RegisterPage._h1('Loading tournament…'));

    const spin = document.createElement('div');
    spin.className = 'reg-loading';
    spin.setAttribute('role', 'status');
    spin.setAttribute('aria-live', 'polite');
    spin.appendChild(RegisterPage._el(UI.spinner('Loading tournament…')));
    panel.appendChild(spin);

    RegisterPage._mount(panel);
  },

  /* ------------------------------------------------------------------ *
   * Screen: load failed
   * ------------------------------------------------------------------ */

  /**
   * A player on a train with two bars of signal will see this. It must say
   * what went wrong in plain words and offer one obvious button.
   *
   * @param {Object} state
   * @param {{code:string, message:string}} err
   * @return {void}
   */
  _renderLoadError: function (state, err) {
    const code = (err && err.code) || 'INTERNAL_ERROR';
    const panel = RegisterPage._panel();

    panel.appendChild(RegisterPage._h1('Could not load this page'));

    const banner = RegisterPage._el(UI.banner('error',
      (err && err.message) || 'Something went wrong. Please try again.'));
    if (banner) {
      banner.setAttribute('role', 'alert');
      panel.appendChild(banner);
    }

    panel.appendChild(RegisterPage._note(
      code === 'NETWORK'
        ? 'Check that you are online, then press Try again. Your registration has not been sent.'
        : 'Press Try again. If it keeps failing, ask the organiser to check the registration link.'
    ));

    if (state.tournamentId) {
      panel.appendChild(RegisterPage._kv([['Tournament link id', state.tournamentId]]));
    }

    const retry = RegisterPage._el(UI.button('Try again', function () {
      RegisterPage._load(state);
    }, { variant: 'primary' }));
    if (retry) panel.appendChild(retry);

    RegisterPage._mount(panel);
  },

  /* ------------------------------------------------------------------ *
   * Screen: registration closed
   * ------------------------------------------------------------------ */

  /**
   * CONTRACTS-PHASE1 §5.4. `registration_message` is written by the server and
   * already says which of the three reasons applies, so we show it verbatim
   * rather than guessing from the dates.
   *
   * @param {Object} state
   * @param {string} message
   * @return {void}
   */
  _renderClosed: function (state, message) {
    const t = state.tournament || {};
    const panel = RegisterPage._panel();

    RegisterPage._appendHeader(panel, t);

    const box = document.createElement('section');
    box.className = 'reg-closed';
    box.setAttribute('role', 'status');

    const h = document.createElement('h2');
    h.className = 'reg-closed__title';
    h.textContent = 'Registration is closed';
    box.appendChild(h);

    const p = document.createElement('p');
    p.className = 'reg-closed__reason';
    p.textContent = message || 'Registration is not open for this tournament.';
    box.appendChild(p);

    panel.appendChild(box);

    if (t.reg_start_display || t.reg_end_display) {
      panel.appendChild(RegisterPage._kv([
        ['Registration opens', t.reg_start_display || t.reg_start || '—'],
        ['Registration closes', t.reg_end_display || t.reg_end || '—']
      ]));
    }

    RegisterPage._appendContact(panel, t);
    RegisterPage._mount(panel);
  },

  /* ------------------------------------------------------------------ *
   * Screen: the form
   * ------------------------------------------------------------------ */

  /**
   * @param {Object} state
   * @return {void}
   */
  _renderForm: function (state) {
    const t = state.tournament;
    const panel = RegisterPage._panel();

    RegisterPage._appendHeader(panel, t);
    RegisterPage._appendRules(panel, t);
    RegisterPage._appendPayment(state, panel, t);

    /* ---- Step 2: the form ------------------------------------------- */

    const form = document.createElement('form');
    form.className = 'reg-form';
    form.setAttribute('novalidate', 'novalidate');   // our messages, not the browser's
    form.setAttribute('aria-labelledby', 'reg-form-title');

    const h2 = document.createElement('h2');
    h2.className = 'reg-step__title';
    h2.id = 'reg-form-title';
    h2.textContent = 'Step 2 — Fill in your details';
    form.appendChild(h2);

    const stepNote = RegisterPage._note('All answers are required. Fill this in only after you have paid.');
    stepNote.className = 'reg-step__note';
    form.appendChild(stepNote);

    /* Text and picker fields, in the order DESIGN.md §6 lists them. */

    state.fields.name = RegisterPage._field(form, {
      label: 'Your full name',
      name: 'name',
      type: 'text',
      required: true,
      hint: 'This is the name shown on the big screen during the auction.'
    }, function (input) {
      input.setAttribute('autocomplete', 'name');
      input.setAttribute('autocapitalize', 'words');
      input.setAttribute('maxlength', '60');
    });

    state.fields.dob = RegisterPage._field(form, {
      label: 'Date of birth',
      name: 'dob',
      type: 'date',
      required: true,
      hint: 'Day, month and year you were born.'
    }, function (input) {
      input.setAttribute('autocomplete', 'bday');
      input.setAttribute('max', RegisterPage._todayIso());
      input.setAttribute('min', '1900-01-01');
    });

    state.fields.role = RegisterPage._field(form, {
      label: 'What do you play as?',
      name: 'role',
      type: 'select',
      required: true,
      options: RegisterPage.ROLE_OPTIONS,
      hint: 'Pick the one that fits you best.'
    });

    state.fields.style = RegisterPage._field(form, {
      label: 'Do you play left handed or right handed?',
      name: 'style',
      type: 'select',
      required: true,
      options: RegisterPage.STYLE_OPTIONS
    });

    state.fields.mobile = RegisterPage._field(form, {
      label: 'Mobile number',
      name: 'mobile',
      type: 'tel',
      required: true,
      hint: '10 digits. The organiser will use this number to reach you.'
    }, function (input) {
      input.setAttribute('inputmode', 'numeric');
      input.setAttribute('autocomplete', 'tel-national');
      input.setAttribute('maxlength', '10');
      input.setAttribute('pattern', '[6-9][0-9]{9}');
    });

    RegisterPage._wireMobileCheck(state);

    /* Image fields. accept="image/*" per CONTRACTS-PHASE1 §5.7.
       Deliberately NO `capture` attribute, despite the "capture hints" line in
       DESIGN.md §12. On Android Chrome `capture` forces the camera and removes
       the gallery option entirely. That is plainly wrong for a payment
       screenshot the player has already taken, and unhelpful for a profile
       photo they already have. CONTRACTS-PHASE1 §5.7 is the later document and
       asks only for accept="image/*", so that is what we do. */

    state.fields.photo = RegisterPage._field(form, {
      label: 'Your photo',
      name: 'photo',
      type: 'file',
      required: true,
      hint: 'A clear picture of your face. This is shown during the auction.'
    }, function (input) {
      input.setAttribute('accept', 'image/*');
    });
    RegisterPage._wireImage(state, 'photo', state.fields.photo);

    state.fields.screenshot = RegisterPage._field(form, {
      label: 'Payment screenshot',
      name: 'screenshot',
      type: 'file',
      required: true,
      hint: 'The success screen from your UPI app, showing the amount paid.'
    }, function (input) {
      input.setAttribute('accept', 'image/*');
    });
    RegisterPage._wireImage(state, 'screenshot', state.fields.screenshot);

    state.fields.upiRef = RegisterPage._field(form, {
      label: 'UPI payment reference number',
      name: 'upiRef',
      type: 'text',
      required: true,
      hint: 'Your app may call it transaction id, UTR or reference number. 6 to 35 letters and numbers.'
    }, function (input) {
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('autocapitalize', 'characters');
      input.setAttribute('spellcheck', 'false');
      input.setAttribute('maxlength', '35');
    });

    /* ---- Error region. aria-live so a screen reader announces a rejection
            the player cannot see, e.g. one that scrolled off. --------------- */

    const errorHost = document.createElement('div');
    errorHost.className = 'reg-form__error';
    errorHost.setAttribute('role', 'alert');
    errorHost.setAttribute('aria-live', 'assertive');
    errorHost.setAttribute('aria-atomic', 'true');
    state.errorHost = errorHost;
    form.appendChild(errorHost);

    /* ---- Progress region -------------------------------------------- */

    const progressHost = document.createElement('div');
    progressHost.className = 'reg-form__progress';
    progressHost.setAttribute('aria-live', 'polite');
    progressHost.setAttribute('aria-atomic', 'true');
    state.progressHost = progressHost;
    form.appendChild(progressHost);

    /* ---- Submit ------------------------------------------------------ */

    const submit = RegisterPage._el(UI.button('Submit registration', function (ev) {
      RegisterPage._onSubmit(state, ev);
    }, { variant: 'primary', busyLabel: 'Submitting…' }));

    if (submit) {
      submit.setAttribute('type', 'submit');
      state.submitBtn = submit;
      state.submitLabel = submit.textContent;
      form.appendChild(submit);
    }

    // Enter in a text field also submits, so the guard has to live on the
    // form, not only on the button.
    form.addEventListener('submit', function (ev) {
      RegisterPage._onSubmit(state, ev);
    });

    const smallprint = RegisterPage._note(
      'Your details go only to the tournament organiser. The fee is not paid through this page.'
    );
    smallprint.className = 'reg-smallprint';
    form.appendChild(smallprint);

    panel.appendChild(form);
    RegisterPage._appendContact(panel, t);
    RegisterPage._mount(panel);
  },

  /* ------------------------------------------------------------------ *
   * Form sections
   * ------------------------------------------------------------------ */

  /**
   * Logo, name, description and the fee.
   * @param {HTMLElement} panel
   * @param {Object} t public tournament record
   * @return {void}
   */
  _appendHeader: function (panel, t) {
    const header = document.createElement('header');
    header.className = 'reg-header';

    if (t.logo_url) {
      const logo = document.createElement('img');
      logo.className = 'reg-header__logo';
      logo.src = t.logo_url;
      logo.alt = '';                       // decorative; the name is right below
      logo.setAttribute('loading', 'lazy');
      header.appendChild(logo);
    }

    const h1 = document.createElement('h1');
    h1.className = 'panel__title reg-header__name';
    h1.textContent = t.name || 'Tournament';
    header.appendChild(h1);

    if (t.description) {
      const p = document.createElement('p');
      p.className = 'reg-header__desc';
      p.textContent = t.description;
      header.appendChild(p);
    }

    const fee = document.createElement('p');
    fee.className = 'reg-header__fee';
    const feeLabel = document.createElement('span');
    feeLabel.className = 'reg-header__fee-label';
    feeLabel.textContent = 'Registration fee ';
    const feeValue = document.createElement('strong');
    feeValue.className = 'reg-header__fee-value';
    feeValue.textContent = RegisterPage._feeText(t);
    fee.appendChild(feeLabel);
    fee.appendChild(feeValue);
    header.appendChild(fee);

    if (t.reg_end_display) {
      const until = document.createElement('p');
      until.className = 'reg-header__window';
      until.textContent = 'Registration is open until ' + t.reg_end_display + '.';
      header.appendChild(until);
    }

    panel.appendChild(header);
  },

  /**
   * Rules, if the organiser wrote any. Split on newlines so a pasted list
   * stays readable — still textContent per line, never innerHTML.
   * @param {HTMLElement} panel
   * @param {Object} t
   * @return {void}
   */
  _appendRules: function (panel, t) {
    if (!t.rules) return;

    const details = document.createElement('details');
    details.className = 'reg-rules';

    const summary = document.createElement('summary');
    summary.className = 'reg-rules__summary';
    summary.textContent = 'Tournament rules';
    details.appendChild(summary);

    String(t.rules).split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return;
      const p = document.createElement('p');
      p.className = 'reg-rules__line';
      p.textContent = line;
      details.appendChild(p);
    });

    panel.appendChild(details);
  },

  /**
   * Step 1 — the payment block. DESIGN.md §8 and §12.
   *
   * Three things have to be here, and all three have failed in the field
   * without them:
   *   - the QR big enough to scan from another phone held above it;
   *   - a Download QR Code button, so the player can open it in their gallery
   *     and let their UPI app scan it from there;
   *   - the UPI id as copyable text, because some UPI apps refuse to scan a
   *     saved screenshot at all. That copy button is the whole fallback path.
   *
   * @param {Object} state
   * @param {HTMLElement} panel
   * @param {Object} t
   * @return {void}
   */
  _appendPayment: function (state, panel, t) {
    const sec = document.createElement('section');
    sec.className = 'reg-pay';
    sec.setAttribute('aria-labelledby', 'reg-pay-title');

    const h2 = document.createElement('h2');
    h2.className = 'reg-step__title';
    h2.id = 'reg-pay-title';
    h2.textContent = 'Step 1 — Pay the fee';
    sec.appendChild(h2);

    const amount = document.createElement('p');
    amount.className = 'reg-pay__amount';
    amount.textContent = RegisterPage._feeText(t);
    sec.appendChild(amount);

    /* Plain instructions. The app never touches the money and we say so. */
    const ol = document.createElement('ol');
    ol.className = 'reg-pay__steps';
    [
      'Open your own UPI app — GPay, PhonePe, Paytm or your bank app.',
      'Scan the code below, or pay to the UPI id shown under it.',
      'Pay ' + RegisterPage._feeText(t) + ' and take a screenshot of the success screen.',
      'Come back to this page and fill in Step 2 below.'
    ].forEach(function (text) {
      const li = document.createElement('li');
      li.textContent = text;
      ol.appendChild(li);
    });
    sec.appendChild(ol);

    /* QR, large. */
    if (t.qr_url) {
      const figure = document.createElement('figure');
      figure.className = 'reg-qr';

      const img = document.createElement('img');
      img.className = 'reg-qr__img';
      img.src = t.qr_url;
      img.alt = 'UPI payment QR code for ' + (t.name || 'this tournament');
      figure.appendChild(img);

      const cap = document.createElement('figcaption');
      cap.className = 'reg-qr__caption';
      cap.textContent = 'Scan this code in your UPI app.';
      figure.appendChild(cap);

      sec.appendChild(figure);

      /* Download QR Code. A real <a download>, not a button, so a long-press
         on Android still offers "save image". rel=external + download both
         keep Router's click interceptor out of the way. */
      const dl = document.createElement('a');
      dl.className = 'btn btn--secondary reg-pay__download';
      dl.href = t.qr_download_url || t.qr_url;
      dl.setAttribute('download', 'upi-qr.png');
      dl.setAttribute('rel', 'external noopener');
      dl.setAttribute('target', '_blank');
      dl.textContent = 'Download QR Code';
      sec.appendChild(dl);
    }

    /* UPI id + Copy. */
    if (t.upi_id) {
      const row = document.createElement('div');
      row.className = 'reg-upi';

      const label = document.createElement('span');
      label.className = 'reg-upi__label';
      label.id = 'reg-upi-label';
      label.textContent = 'Or pay to this UPI id';
      row.appendChild(label);

      const value = document.createElement('code');
      value.className = 'reg-upi__value';
      value.textContent = t.upi_id;
      row.appendChild(value);

      const status = document.createElement('span');
      status.className = 'reg-upi__status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');

      const copy = RegisterPage._el(UI.button('Copy UPI id', function () {
        RegisterPage._copyText(String(t.upi_id)).then(function (ok) {
          status.textContent = ok
            ? 'Copied. Paste it in your UPI app.'
            : 'Could not copy automatically. Press and hold the id above to copy it.';
        });
      }, { variant: 'secondary' }));

      if (copy) {
        copy.className = (copy.className ? copy.className + ' ' : '') + 'reg-upi__copy';
        copy.setAttribute('type', 'button');
        copy.setAttribute('aria-describedby', 'reg-upi-label');
        row.appendChild(copy);
      }

      row.appendChild(status);
      sec.appendChild(row);
    }

    const warn = document.createElement('p');
    warn.className = 'reg-pay__warn';
    warn.textContent =
      'This page does not take the payment. Pay in your own UPI app first, then fill in the form below.';
    sec.appendChild(warn);

    panel.appendChild(sec);
  },

  /**
   * Organiser contact. Shown on both the closed state and the form, because
   * "who do I ask?" is the next question after either one.
   * @param {HTMLElement} panel
   * @param {Object} t
   * @return {void}
   */
  _appendContact: function (panel, t) {
    if (!t || (!t.contact_name && !t.contact_mobile)) return;

    const sec = document.createElement('section');
    sec.className = 'reg-contact';

    const h = document.createElement('h2');
    h.className = 'panel__subtitle';
    h.textContent = 'Need help?';
    sec.appendChild(h);

    const p = document.createElement('p');
    p.className = 'reg-contact__line';
    p.textContent = t.contact_name
      ? ('Contact ' + t.contact_name + ' for anything about this tournament.')
      : 'Contact the organiser for anything about this tournament.';
    sec.appendChild(p);

    if (t.contact_mobile) {
      const a = document.createElement('a');
      a.className = 'reg-contact__phone';
      a.href = 'tel:' + String(t.contact_mobile).replace(/[^0-9+]/g, '');
      a.textContent = String(t.contact_mobile);
      sec.appendChild(a);
    }

    panel.appendChild(sec);
  },

  /* ------------------------------------------------------------------ *
   * Fields
   * ------------------------------------------------------------------ */

  /**
   * Build one field with UI.field, run an optional tweak over its input, and
   * append it to the form.
   *
   * @param {HTMLElement} form
   * @param {Object} spec  passed straight to UI.field
   * @param {function(HTMLElement):void} [tweak]  applied to the input element
   * @return {Object} the UI.field result {wrap, input, setError, clearError}
   */
  _field: function (form, spec, tweak) {
    const f = UI.field(spec);
    if (tweak && f && f.input) tweak(f.input);

    const wrap = RegisterPage._el(f);
    if (wrap) form.appendChild(wrap);

    // Typing is the player telling us they are dealing with it. Clear the
    // stale red as soon as they do, not on the next submit.
    if (f && f.input && f.input.addEventListener) {
      f.input.addEventListener('input', function () {
        if (f.clearError) f.clearError();
      });
    }
    return f;
  },

  /**
   * Optional early duplicate warning (CONTRACTS-PHASE1 §2, player.checkMobile).
   *
   * Runs on blur, BEFORE the player has spent two minutes and 300 KB uploading
   * photos. It is a courtesy only:
   *   - a failure means "unknown", never "blocked";
   *   - a `taken: true` warns but still lets them submit, because the
   *     authoritative check runs inside the server's lock and only it decides.
   *
   * @param {Object} state
   * @return {void}
   */
  _wireMobileCheck: function (state) {
    const f = state.fields.mobile;
    if (!f || !f.input || !f.input.addEventListener) return;

    f.input.addEventListener('input', function () {
      state.mobileTaken = false;
    });

    f.input.addEventListener('blur', function () {
      const mobile = String(f.input.value || '').trim();
      if (!RegisterPage._isValidMobile(mobile)) return;
      if (mobile === state.mobileChecked) return;
      state.mobileChecked = mobile;

      API.call('player.checkMobile',
        { tournamentId: state.tournamentId, mobile: mobile },
        { retryBusy: false })
        .then(function (res) {
          if (RegisterPage._state !== state) return;
          if (String(f.input.value || '').trim() !== mobile) return;  // moved on
          if (res && res.taken === true) {
            state.mobileTaken = true;
            if (f.setError) f.setError(RegisterPage.MSG.mobileTaken);
          }
        })
        .catch(function () {
          // Unknown. Rate limited, offline, whatever — carry on silently.
          // Blocking a paying player on a courtesy call would be absurd.
          state.mobileChecked = '';
        });
    });
  },

  /**
   * Resize-on-pick for one image input.
   *
   * Encoding happens the moment the file is chosen, not at submit, for two
   * reasons: the player sees a preview and a size and knows it worked, and
   * submit then has nothing left to do but the network call.
   *
   * @param {Object} state
   * @param {string} key 'photo' | 'screenshot'
   * @param {Object} field UI.field result
   * @return {void}
   */
  _wireImage: function (state, key, field) {
    if (!field || !field.input || !field.input.addEventListener) return;

    const box = document.createElement('div');
    box.className = 'reg-preview';
    box.setAttribute('aria-live', 'polite');

    const img = document.createElement('img');
    img.className = 'reg-preview__img';
    img.alt = '';
    img.hidden = true;

    const caption = document.createElement('span');
    caption.className = 'reg-preview__caption';

    box.appendChild(img);
    box.appendChild(caption);

    const wrap = RegisterPage._el(field);
    if (wrap) wrap.appendChild(box);

    state.tokens[key] = 0;

    field.input.addEventListener('change', function () {
      const token = ++state.tokens[key];
      const files = field.input.files;
      const file = files && files.length ? files[0] : null;

      state.images[key] = null;
      state.pending[key] = false;
      img.hidden = true;
      caption.className = 'reg-preview__caption';

      if (!file) {
        caption.textContent = '';
        return;
      }
      if (field.clearError) field.clearError();

      // Instant preview from the original file, swapped for the actual
      // resized bytes once encoding finishes.
      try {
        const url = ImageTool.previewUrl(file);
        if (url) {
          state.objectUrls.push(url);
          img.src = url;
          img.hidden = false;
        }
      } catch (e) { /* preview is a nicety, never a blocker */ }

      state.pending[key] = true;
      caption.textContent = 'Preparing your image…';

      const job = (key === 'photo')
        ? ImageTool.pair(file)
        : ImageTool.fromFile(file, RegisterPage.SHOT_OPTS);

      Promise.resolve(job).then(function (out) {
        if (RegisterPage._state !== state) return;
        if (token !== state.tokens[key]) return;   // a newer file won

        state.pending[key] = false;

        let bytes = 0;
        if (key === 'photo') {
          state.images.photo = {
            photo: RegisterPage._imagePayload(out && out.photo),
            photoThumb: RegisterPage._imagePayload(out && out.photoThumb)
          };
          bytes = ((out && out.photo && out.photo.bytes) || 0) +
                  ((out && out.photoThumb && out.photoThumb.bytes) || 0);
          if (out && out.photoThumb && out.photoThumb.data) {
            img.src = 'data:' + (out.photoThumb.mime || 'image/jpeg') +
                      ';base64,' + out.photoThumb.data;
            img.hidden = false;
          }
        } else {
          state.images.screenshot = { screenshot: RegisterPage._imagePayload(out) };
          bytes = (out && out.bytes) || 0;
          if (out && out.data) {
            img.src = 'data:' + (out.mime || 'image/jpeg') + ';base64,' + out.data;
            img.hidden = false;
          }
        }

        img.alt = (key === 'photo') ? 'Your chosen photo' : 'Your chosen payment screenshot';
        caption.className = 'reg-preview__caption reg-preview__caption--ok';
        caption.textContent = bytes
          ? ('Ready to send — ' + RegisterPage._formatBytes(bytes))
          : 'Ready to send.';
      }).catch(function () {
        if (RegisterPage._state !== state) return;
        if (token !== state.tokens[key]) return;

        state.pending[key] = false;
        state.images[key] = null;
        img.hidden = true;
        caption.className = 'reg-preview__caption reg-preview__caption--bad';
        caption.textContent = RegisterPage.MSG.imageFailed;
        if (field.setError) field.setError(RegisterPage.MSG.imageFailed);
      });
    });
  },

  /**
   * Reduce an ImageTool result to exactly the three keys CONTRACTS-PHASE1 §1
   * allows on the wire. An allow-list, not a delete-list: width/height/bytes
   * are useful locally and would only bloat the request.
   *
   * @param {Object} r ImageTool result
   * @return {?{data:string, mime:string, filename:string}}
   */
  _imagePayload: function (r) {
    if (!r || !r.data) return null;
    return {
      data: r.data,
      mime: r.mime || 'image/jpeg',
      filename: r.filename || 'image.jpg'
    };
  },

  /* ------------------------------------------------------------------ *
   * Validation — mirrors CONTRACTS-PHASE1 §3 for instant feedback.
   * The server runs the same rules and IS the authority; this only saves a
   * round trip on the obvious mistakes.
   * ------------------------------------------------------------------ */

  /**
   * @param {Object} state
   * @return {Array<{field:string, message:string}>} empty when everything passes
   */
  _validate: function (state) {
    const errors = [];
    const v = RegisterPage._values(state);
    const M = RegisterPage.MSG;

    const nameOk = v.name.length >= 2 && v.name.length <= 60 &&
      /^[\p{L} .'\-]+$/u.test(v.name);
    if (!nameOk) errors.push({ field: 'name', message: M.name });

    if (!RegisterPage._isValidDob(v.dob, state)) errors.push({ field: 'dob', message: M.dob });

    if (!RegisterPage._inOptions(v.role, RegisterPage.ROLE_OPTIONS)) {
      errors.push({ field: 'role', message: M.role });
    }
    if (!RegisterPage._inOptions(v.style, RegisterPage.STYLE_OPTIONS)) {
      errors.push({ field: 'style', message: M.style });
    }
    if (!RegisterPage._isValidMobile(v.mobile)) errors.push({ field: 'mobile', message: M.mobile });

    if (!state.images.photo || !state.images.photo.photo || !state.images.photo.photoThumb) {
      errors.push({ field: 'photo', message: state.pending.photo ? M.stillPreparing : M.photo });
    }
    if (!state.images.screenshot || !state.images.screenshot.screenshot) {
      errors.push({
        field: 'screenshot',
        message: state.pending.screenshot ? M.stillPreparing : M.screenshot
      });
    }
    if (!/^[A-Za-z0-9]{6,35}$/.test(v.upiRef)) errors.push({ field: 'upiRef', message: M.upiRef });

    return errors;
  },

  /**
   * Read every field, trimmed.
   * @param {Object} state
   * @return {Object<string,string>}
   */
  _values: function (state) {
    const out = {};
    Object.keys(state.fields).forEach(function (k) {
      const f = state.fields[k];
      out[k] = (f && f.input && typeof f.input.value === 'string')
        ? f.input.value.trim()
        : '';
    });
    out.upiRef = out.upiRef ? out.upiRef.toUpperCase() : '';
    return out;
  },

  /**
   * @param {string} s
   * @return {boolean} exactly 10 digits starting 6-9 (Util.isValidMobileIN)
   */
  _isValidMobile: function (s) {
    return /^[6-9][0-9]{9}$/.test(String(s || '').trim());
  },

  /**
   * Age must be 8–70 **at the tournament start date** (CONTRACTS-PHASE1 §3).
   *
   * tournament.getPublic does not expose `startDate` — it is not in the §2
   * allow-list — so the browser cannot apply the real rule. We use `reg_end`
   * as the reference instead: registration always closes on or before the
   * tournament starts, so an age computed at reg_end is never higher than the
   * real one, and this check can therefore never reject someone the server
   * would accept. The server recomputes with the real start date.
   *
   * @param {string} iso 'YYYY-MM-DD' from <input type="date">
   * @param {Object} state
   * @return {boolean}
   */
  _isValidDob: function (iso, state) {
    const dob = RegisterPage._parseIsoDate(iso);
    if (!dob) return false;

    const today = RegisterPage._parseIsoDate(RegisterPage._todayIso());
    if (RegisterPage._compareDates(dob, today) > 0) return false;    // born tomorrow

    const t = state.tournament || {};
    const at = RegisterPage._parseIsoDate(t.reg_end) || today;

    let years = at.y - dob.y;
    if (at.m < dob.m || (at.m === dob.m && at.d < dob.d)) years--;

    return years >= 8 && years <= 70;
  },

  /**
   * @param {string} value
   * @param {Array<{value:string}>} options
   * @return {boolean}
   */
  _inOptions: function (value, options) {
    for (let i = 0; i < options.length; i++) {
      if (options[i].value === value) return true;
    }
    return false;
  },

  /* ------------------------------------------------------------------ *
   * Submit
   * ------------------------------------------------------------------ */

  /**
   * @param {Object} state
   * @param {Event} [ev]
   * @return {void}
   */
  _onSubmit: function (state, ev) {
    if (ev && ev.preventDefault) ev.preventDefault();

    // DESIGN.md §12 / CONTRACTS-PHASE1 §5.1. The flag, not the disabled
    // attribute, is the real guard: a double tap can land two events before
    // the browser repaints the disabled button.
    if (state.submitting) return;

    RegisterPage._clearFormError(state);
    Object.keys(state.fields).forEach(function (k) {
      const f = state.fields[k];
      if (f && f.clearError) f.clearError();
    });

    const errors = RegisterPage._validate(state);
    if (errors.length) {
      errors.forEach(function (e) {
        const f = state.fields[e.field];
        if (f && f.setError) f.setError(e.message);
      });
      RegisterPage._showFormError(state, errors.length === 1
        ? errors[0].message
        : RegisterPage.MSG.fixBelow);
      RegisterPage._focusField(state, errors[0].field);
      return;
    }

    const v = RegisterPage._values(state);
    const payload = {
      tournamentId: state.tournamentId,
      name: v.name,
      dob: v.dob,
      role: v.role,
      style: v.style,
      mobile: v.mobile,
      upiRef: v.upiRef,
      photo: state.images.photo.photo,
      photoThumb: state.images.photo.photoThumb,
      screenshot: state.images.screenshot.screenshot
    };

    state.submitting = true;
    RegisterPage._setSubmitBusy(state, true);
    RegisterPage._startProgress(state, RegisterPage._payloadBytes(payload));

    API.call('player.register', payload)
      .then(function (data) {
        if (RegisterPage._state !== state) return;
        RegisterPage._stopProgress(state, true);
        RegisterPage._renderConfirmation(state, data, v);
      })
      .catch(function (err) {
        if (RegisterPage._state !== state) return;
        RegisterPage._stopProgress(state, false);
        state.submitting = false;
        RegisterPage._setSubmitBusy(state, false);
        RegisterPage._handleSubmitError(state, err);
      });
  },

  /**
   * Server said no. CONTRACTS-PHASE1 §5.6: keep every field exactly as it is.
   *
   * Nothing here clears an input or resets the form, and the encoded images
   * stay in state.images, so a duplicate-mobile rejection costs the player one
   * correction and one more tap — not two photo pickers and a retyped form.
   *
   * @param {Object} state
   * @param {{code:string, message:string}} err
   * @return {void}
   */
  _handleSubmitError: function (state, err) {
    const code = (err && err.code) || 'INTERNAL_ERROR';
    const message = (err && err.message) || 'Something went wrong. Please try again.';

    // The window shut while they were filling the form. A form the server will
    // now always reject must not stay on screen (§5.4).
    if (code === 'REGISTRATION_CLOSED') {
      RegisterPage._renderClosed(state, message);
      return;
    }

    // Always the server's own words — it is the authority, and its message
    // names the real problem (§5, DESIGN.md §11).
    RegisterPage._showFormError(state, message);

    let focusOn = null;
    if (code === 'DUPLICATE_MOBILE') focusOn = 'mobile';
    else if (code === 'DUPLICATE_UPI_REF') focusOn = 'upiRef';

    if (focusOn) {
      const f = state.fields[focusOn];
      if (f && f.setError) f.setError(message);
      RegisterPage._focusField(state, focusOn);
    } else if (state.errorHost && state.errorHost.scrollIntoView) {
      state.errorHost.scrollIntoView({ block: 'center' });
    }
  },

  /**
   * @param {Object} state
   * @param {boolean} busy
   * @return {void}
   */
  _setSubmitBusy: function (state, busy) {
    const btn = state.submitBtn;
    if (!btn) return;

    btn.disabled = !!busy;
    btn.setAttribute('aria-busy', busy ? 'true' : 'false');
    btn.textContent = busy ? 'Submitting…' : (state.submitLabel || 'Submit registration');
  },

  /**
   * @param {Object} state
   * @param {string} field
   * @return {void}
   */
  _focusField: function (state, field) {
    const f = state.fields[field];
    if (!f || !f.input) return;
    const wrap = RegisterPage._el(f);
    if (wrap && wrap.scrollIntoView) wrap.scrollIntoView({ block: 'center' });
    if (f.input.focus) f.input.focus();
  },

  /**
   * @param {Object} state
   * @param {string} message
   * @return {void}
   */
  _showFormError: function (state, message) {
    if (!state.errorHost) return;
    state.errorHost.textContent = '';
    const banner = RegisterPage._el(UI.banner('error', message));
    if (banner) state.errorHost.appendChild(banner);
    else state.errorHost.textContent = message;
  },

  /**
   * @param {Object} state
   * @return {void}
   */
  _clearFormError: function (state) {
    if (state.errorHost) state.errorHost.textContent = '';
  },

  /* ------------------------------------------------------------------ *
   * Progress
   *
   * HONEST NOTE. Real byte-level upload progress needs XMLHttpRequest's
   * upload.onprogress event; fetch() has no equivalent, and every call must go
   * through API (rule 4), which uses fetch. So the bar below is paced from the
   * actual payload size at a pessimistic 3G rate and deliberately stalls at
   * 92% until the server answers. It never claims to be finished before it is.
   * The point of DESIGN.md §12 is that the player sees movement instead of
   * silence, and this delivers exactly that.
   * ------------------------------------------------------------------ */

  /**
   * @param {Object} state
   * @param {number} bytes approximate size of the JSON body
   * @return {void}
   */
  _startProgress: function (state, bytes) {
    if (!state.progressHost) return;

    state.progressHost.textContent = '';

    const label = document.createElement('p');
    label.className = 'reg-progress__label';
    label.textContent = 'Sending your registration — ' + RegisterPage._formatBytes(bytes) +
      '. Please keep this page open.';
    state.progressHost.appendChild(label);
    state.progressLabel = label;

    const prog = UI.progress();
    state.progress = prog;
    const el = RegisterPage._el(prog);
    if (el) state.progressHost.appendChild(el);

    const expectedMs = Math.max(1500, (bytes / RegisterPage.ASSUMED_UPLOAD_BPS) * 1000);
    const startedAt = Date.now();

    if (prog && prog.set) prog.set(2);

    state.progressTimer = window.setInterval(function () {
      const share = Math.min(1, (Date.now() - startedAt) / expectedMs);
      const pct = Math.min(92, Math.round(2 + share * 90));
      if (prog && prog.set) prog.set(pct);
      if (pct >= 92 && state.progressLabel) {
        state.progressLabel.textContent =
          'Almost done. Waiting for the tournament server to confirm…';
      }
    }, 250);
  },

  /**
   * @param {Object} state
   * @param {boolean} ok
   * @return {void}
   */
  _stopProgress: function (state, ok) {
    if (state.progressTimer) {
      window.clearInterval(state.progressTimer);
      state.progressTimer = null;
    }
    if (state.progress && state.progress.set) state.progress.set(ok ? 100 : 0);
    if (state.progress && state.progress.done) state.progress.done();
    state.progress = null;

    if (state.progressHost) state.progressHost.textContent = '';
    state.progressLabel = null;
  },

  /**
   * Approximate wire size. Base64 is ~4/3 of the binary, and the rest of the
   * JSON is noise by comparison, so summing the base64 lengths is close enough
   * to pace a progress bar.
   * @param {Object} payload
   * @return {number} bytes
   */
  _payloadBytes: function (payload) {
    let n = 512;
    ['photo', 'photoThumb', 'screenshot'].forEach(function (k) {
      const img = payload[k];
      if (img && img.data) n += img.data.length;
    });
    return n;
  },

  /* ------------------------------------------------------------------ *
   * Screen: confirmation (DESIGN.md §12, CONTRACTS-PHASE1 §5.5)
   * ------------------------------------------------------------------ */

  /**
   * The serial number is the only thing on this screen that matters. It is
   * called out at the auction and the player has to be able to read it back
   * from a photo of their own screen.
   *
   * There is deliberately NO "register again" link — a second registration by
   * the same person is a duplicate, not a feature.
   *
   * @param {Object} state
   * @param {Object} data player.register response
   * @param {Object} v the submitted values, as a fallback for name
   * @return {void}
   */
  _renderConfirmation: function (state, data, v) {
    const d = data || {};
    const t = state.tournament || {};
    const serial = (d.serial_no === 0 || d.serial_no) ? String(d.serial_no) : '—';
    const playerName = d.name || (v && v.name) || '';
    const tournamentName = d.tournament_name || t.name || '';

    document.title = 'Registered · Cricket Auction';

    // Nothing left to keep alive: the form is gone and so are its previews.
    RegisterPage._revokeAll(state);

    const panel = RegisterPage._panel();
    panel.className = 'panel reg-done';

    const tick = document.createElement('p');
    tick.className = 'reg-done__tick';
    tick.setAttribute('aria-hidden', 'true');
    tick.textContent = '✓';
    panel.appendChild(tick);

    const h1 = document.createElement('h1');
    h1.className = 'panel__title reg-done__title';
    h1.textContent = 'You are registered';
    panel.appendChild(h1);

    const serialBox = document.createElement('div');
    serialBox.className = 'reg-done__serial-box';
    serialBox.setAttribute('role', 'status');

    const serialLabel = document.createElement('p');
    serialLabel.className = 'reg-done__serial-label';
    serialLabel.textContent = 'Your serial number';
    serialBox.appendChild(serialLabel);

    const serialValue = document.createElement('p');
    serialValue.className = 'reg-done__serial';
    serialValue.textContent = serial;
    serialBox.appendChild(serialValue);

    panel.appendChild(serialBox);

    const save = document.createElement('p');
    save.className = 'reg-done__keep';
    save.textContent = 'Please save this number. It will be used during the auction.';
    panel.appendChild(save);

    const rows = [];
    if (playerName) rows.push(['Name', playerName]);
    if (tournamentName) rows.push(['Tournament', tournamentName]);
    if (d.registered_at_display) rows.push(['Registered on', d.registered_at_display]);
    if (d.player_id) rows.push(['Reference', d.player_id]);
    if (rows.length) panel.appendChild(RegisterPage._kv(rows));

    const status = document.createElement('p');
    status.className = 'reg-done__status';
    status.textContent =
      'The organiser will check your payment screenshot. Nothing more is needed from you now.';
    panel.appendChild(status);

    const saveBtn = RegisterPage._el(UI.button('Save as image', function () {
      RegisterPage._saveAsImage({
        serial: serial,
        name: playerName,
        tournament: tournamentName,
        registeredAt: d.registered_at_display || ''
      });
    }, { variant: 'primary' }));
    if (saveBtn) {
      saveBtn.setAttribute('type', 'button');
      panel.appendChild(saveBtn);
    }

    RegisterPage._appendContact(panel, t);
    RegisterPage._mount(panel);

    if (panel.scrollIntoView) panel.scrollIntoView({ block: 'start' });
  },

  /**
   * Draw the confirmation onto a canvas and download it as a PNG.
   *
   * A phone screenshot is easy to lose in a busy gallery; a named file in
   * Downloads is not. Portrait 1080×1350 so it fills a phone screen when
   * opened later, and prints readably if the organiser wants it on paper.
   *
   * @param {{serial:string, name:string, tournament:string, registeredAt:string}} info
   * @return {void}
   */
  _saveAsImage: function (info) {
    const W = 1080;
    const H = 1350;

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;

    const ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return;

    const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#0F5FA6';
    ctx.fillRect(0, 0, W, 24);

    ctx.textAlign = 'center';
    let y = 170;

    ctx.fillStyle = '#48555F';
    ctx.font = '600 40px ' + SANS;
    y = RegisterPage._wrapText(ctx, (info.tournament || 'Tournament').toUpperCase(), W / 2, y, W - 140, 54);

    y += 60;
    ctx.fillStyle = '#10181F';
    ctx.font = '700 52px ' + SANS;
    ctx.fillText('You are registered', W / 2, y);

    y += 90;
    ctx.fillStyle = '#48555F';
    ctx.font = '600 40px ' + SANS;
    ctx.fillText('YOUR SERIAL NUMBER', W / 2, y);

    y += 230;
    ctx.fillStyle = '#0F5FA6';
    ctx.font = '800 300px ' + SANS;
    ctx.fillText(info.serial || '—', W / 2, y);

    y += 110;
    ctx.fillStyle = '#10181F';
    ctx.font = '700 60px ' + SANS;
    y = RegisterPage._wrapText(ctx, info.name || '', W / 2, y, W - 140, 74);

    if (info.registeredAt) {
      y += 60;
      ctx.fillStyle = '#48555F';
      ctx.font = '400 36px ' + SANS;
      ctx.fillText('Registered on ' + info.registeredAt, W / 2, y);
    }

    ctx.fillStyle = '#48555F';
    ctx.font = '600 38px ' + SANS;
    RegisterPage._wrapText(ctx,
      'Please save this number. It will be used during the auction.',
      W / 2, H - 150, W - 160, 50);

    const filename = 'registration-' + String(info.serial || 'number').replace(/[^\w-]/g, '') + '.png';

    const trigger = function (href, revoke) {
      const a = document.createElement('a');
      a.href = href;
      a.download = filename;
      a.setAttribute('rel', 'external');   // keep Router's click handler out
      if (document.body.appendChild) document.body.appendChild(a);
      if (a.click) a.click();
      if (a.remove) a.remove();
      if (revoke) window.setTimeout(function () { URL.revokeObjectURL(href); }, 10000);
    };

    if (canvas.toBlob) {
      canvas.toBlob(function (blob) {
        if (!blob) return;
        trigger(URL.createObjectURL(blob), true);
      }, 'image/png');
    } else if (canvas.toDataURL) {
      trigger(canvas.toDataURL('image/png'), false);
    }
  },

  /**
   * Centre-wrap text inside maxWidth.
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} text
   * @param {number} x
   * @param {number} y baseline of the first line
   * @param {number} maxWidth
   * @param {number} lineHeight
   * @return {number} baseline of the last line drawn
   */
  _wrapText: function (ctx, text, x, y, maxWidth, lineHeight) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    if (!words.length) return y;

    let line = '';
    let cursor = y;

    for (let i = 0; i < words.length; i++) {
      const test = line ? (line + ' ' + words[i]) : words[i];
      const w = ctx.measureText ? ctx.measureText(test).width : 0;
      if (w > maxWidth && line) {
        ctx.fillText(line, x, cursor);
        cursor += lineHeight;
        line = words[i];
      } else {
        line = test;
      }
    }
    ctx.fillText(line, x, cursor);
    return cursor;
  },

  /* ------------------------------------------------------------------ *
   * Small helpers. textContent everywhere.
   * ------------------------------------------------------------------ */

  /**
   * Put one element into the app root, replacing whatever was there.
   * @param {HTMLElement} el
   * @return {void}
   */
  _mount: function (el) {
    const root = (typeof App !== 'undefined' && App.root)
      ? App.root
      : document.getElementById('app');
    if (!root) return;
    root.textContent = '';
    root.appendChild(el);
  },

  /**
   * @return {HTMLElement} an empty <main class="panel">
   */
  _panel: function () {
    const main = document.createElement('main');
    main.className = 'panel';
    return main;
  },

  /**
   * @param {string} text
   * @return {HTMLElement}
   */
  _h1: function (text) {
    const h = document.createElement('h1');
    h.className = 'panel__title';
    h.textContent = text;
    return h;
  },

  /**
   * @param {string} text
   * @return {HTMLElement}
   */
  _note: function (text) {
    const p = document.createElement('p');
    p.className = 'panel__note';
    p.textContent = text;
    return p;
  },

  /**
   * @param {Array<Array<string>>} rows [label, value] pairs
   * @return {HTMLElement}
   */
  _kv: function (rows) {
    const dl = document.createElement('dl');
    dl.className = 'kv';
    rows.forEach(function (row) {
      const dt = document.createElement('dt');
      dt.textContent = row[0];
      const dd = document.createElement('dd');
      dd.textContent = String(row[1]);
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    return dl;
  },

  /**
   * UI returns plain elements for some helpers and small objects for others
   * ({wrap,...} from field, {el,...} from progress). This normalises both so
   * a change on either side cannot silently append `undefined`.
   *
   * @param {*} x
   * @return {?HTMLElement}
   */
  _el: function (x) {
    if (!x) return null;
    if (x.nodeType === 1) return x;
    return x.wrap || x.el || x.node || null;
  },

  /**
   * The fee as text. `reg_fee_display` is built by the server with the same
   * Indian grouping the rest of the system uses, so prefer it; UI.money is
   * documented as taking paise while `reg_fee` is whole rupees, so it is not
   * a safe substitute here.
   *
   * @param {Object} t
   * @return {string}
   */
  _feeText: function (t) {
    if (t && t.reg_fee_display) return String(t.reg_fee_display);
    if (t && (t.reg_fee === 0 || t.reg_fee)) return '₹' + String(t.reg_fee);
    return 'the registration fee';
  },

  /**
   * @param {number} bytes
   * @return {string} e.g. "148 KB"
   */
  _formatBytes: function (bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' bytes';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (Math.round(n / (1024 * 102.4)) / 10) + ' MB';
  },

  /**
   * @return {string} today as 'YYYY-MM-DD' in the device's own timezone
   */
  _todayIso: function () {
    const d = new Date();
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  },

  /**
   * Parse a calendar date without letting the timezone shift it.
   * @param {string} v 'YYYY-MM-DD' or an ISO timestamp
   * @return {?{y:number, m:number, d:number}}
   */
  _parseIsoDate: function (v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '').trim());
    if (!m) return null;

    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;

    // Reject 2026-02-30 and friends, which Date silently rolls into March.
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 ||
        probe.getUTCDate() !== d) return null;

    return { y: y, m: mo, d: d };
  },

  /**
   * @param {{y:number,m:number,d:number}} a
   * @param {{y:number,m:number,d:number}} b
   * @return {number} <0, 0 or >0
   */
  _compareDates: function (a, b) {
    if (a.y !== b.y) return a.y - b.y;
    if (a.m !== b.m) return a.m - b.m;
    return a.d - b.d;
  },

  /**
   * Copy to the clipboard, with a fallback for the browsers that do not have
   * the async Clipboard API or refuse it outside a secure context.
   *
   * @param {string} text
   * @return {Promise<boolean>} resolves true when the copy is believed to have
   *         worked. Never rejects — the caller shows a manual instruction.
   */
  _copyText: function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)
        .then(function () { return true; })
        .catch(function () { return RegisterPage._copyFallback(text); });
    }
    return Promise.resolve(RegisterPage._copyFallback(text));
  },

  /**
   * @param {string} text
   * @return {boolean}
   */
  _copyFallback: function (text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.className = 'visually-hidden';
      document.body.appendChild(ta);
      if (ta.select) ta.select();
      if (ta.setSelectionRange) ta.setSelectionRange(0, text.length);
      const ok = document.execCommand ? document.execCommand('copy') : false;
      ta.remove();
      return !!ok;
    } catch (e) {
      return false;
    }
  },

  /**
   * @param {Object} state
   * @return {void}
   */
  _revokeAll: function (state) {
    if (!state || !state.objectUrls) return;
    state.objectUrls.forEach(function (url) {
      try { URL.revokeObjectURL(url); } catch (e) { /* already gone */ }
    });
    state.objectUrls = [];
  }
};
