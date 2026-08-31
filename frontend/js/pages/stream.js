/**
 * stream.js — the OBS Browser Source overlay. `StreamPage`.
 *
 * Route: /stream/:tournamentId?k=<display_token>&layout=<player|bottom|full|sold>
 * Spec: the "Live Streaming & Broadcast Overlay" enhancement, §2B, §3, §10, §11.
 *
 * WHAT THIS IS
 *   A transparent-background page meant to be added to OBS Studio as a Browser
 *   Source and placed over live camera footage. It shows nothing an audience
 *   should not see, has no clickable control, and paints itself from
 *   `auction.displayState` — the exact same public, token-gated action the
 *   projector (display.js) already polls. It reuses js/broadcast.js for the
 *   poll/backoff/version logic rather than a second copy of it.
 *
 * WHAT THIS IS NOT
 *   It is not a second organiser console. There is no button here, and there
 *   never will be — CONTRACTS §21: "the streaming page should be read-only.
 *   The only source of truth remains the existing auction workflow." Every
 *   auction action still happens on /organiser/auction, exactly as today.
 *
 * DATA MODEL HONESTY (analysis §1)
 *   No base price exists anywhere in the schema (DESIGN.md §6.5a: prices are
 *   deliberately unpredictable, no floor is stored). This page does not show
 *   one. No incremental-bid state exists either — auction_status is only
 *   PENDING / SOLD / UNSOLD — so "Player Introduced" and "Live Bidding" from
 *   the original brief are the SAME backend state here: a player is on the
 *   table with no result yet. Inventing a bid ticker would create a second
 *   source of truth beside the organiser's own voice in the room, which
 *   CONTRACTS explicitly says not to do.
 *
 * LAYOUTS (§11 — an extension point, not a closed set)
 *   player  (default) a corner-anchored player card, nothing else
 *   bottom             a broadcast lower-third bar spanning the width
 *   full                the player card plus a compact team ticker and tallies
 *   sold                shows ONLY the SOLD/UNSOLD sting, otherwise nothing —
 *                       meant to be added as a SEPARATE OBS layer from `player`
 *                       or `bottom`, so a producer can time its own visibility
 *   Adding a fifth layout is one new render function and one line in
 *   StreamPage.LAYOUTS — see that map before touching anything else.
 *
 * TRANSPARENCY (§9, §10)
 *   body/html backgrounds are transparent for every layout. Cards carry their
 *   own translucent panel so text stays legible over arbitrary footage; the
 *   rest of the 1920x1080 canvas stays see-through. No scrollbars: overflow is
 *   hidden on the route, sized to fit rather than to scroll.
 *
 * ANIMATION (§18)
 *   One CSS class, `.is-revealed`, toggled by removing/reforcing a reflow the
 *   same way display.js does it — see _replay. Respects
 *   prefers-reduced-motion via app.css's existing global rule; nothing here
 *   duplicates that media query.
 *
 * HARD RULES (CONTRACTS-PHASE1.md §4, CONTRACTS.md §15)
 *   textContent only — player and team names are public form input. Vanilla
 *   JS, no framework, no build step, no CDN, no web font. Every network call
 *   goes through Broadcast (which itself goes through API).
 *
 * CSS CLASS NAMES THIS FILE EMITS (css/stream.css owns all of them)
 *   stream  stream__card  stream__photo  stream__serial  stream__name
 *   stream__meta  stream__status  stream__amount  stream__team
 *   stream__bar  stream__ticker  stream__ticker-item  stream__tallies
 *   stream__sold  stream__sold-title  stream__sold-name  stream__sold-amount
 *   stream__sold-team  stream__link  is-revealed  is-idle  is-hidden
 *   Reused from app.css unchanged: status  status--pending  status--sold
 *   status--unsold
 */

/* eslint-disable no-unused-vars */
const StreamPage = {

  ROUTE_KEY: 'stream',

  /** How many teams the ticker shows in 'full' layout before it gets crowded. */
  DEFAULT_TEAM_LIMIT: 8,

  /** How long the 'sold' layout's sting stays on screen before it clears. */
  SOLD_STING_MS: 6000,

  /**
   * One render function per layout. Each receives the built skeleton's node
   * map and returns nothing — it just decides which parts are visible.
   * Adding a layout: write a new key here plus its CSS block.
   * @const {!Object<string, function(!Object): void>}
   */
  LAYOUTS: {
    player: function (el) { el.root.dataset.layout = 'player'; },
    bottom: function (el) { el.root.dataset.layout = 'bottom'; },
    full:   function (el) { el.root.dataset.layout = 'full'; },
    sold:   function (el) { el.root.dataset.layout = 'sold'; }
  },

  /* ================================================================== *
   * Entry point
   * ================================================================== */

  /**
   * @param {Object} ctx router context {path, params, query, pattern}
   * @return {void}
   */
  render: function (ctx) {
    StreamPage._teardown();

    document.body.dataset.route = StreamPage.ROUTE_KEY;
    document.title = 'Auction overlay · Cricket Auction';

    // <html>'s background cannot be reached by any CSS selector keyed off
    // body[data-route] — there is no "ancestor of a descendant with this
    // attribute" combinator in CSS. Setting it here, and clearing it in
    // _teardown, is what actually makes the page transparent end to end for
    // OBS; it also means navigating to another route in an ordinary browser
    // tab does not leave that route transparent too.
    //
    // setProperty/removeProperty, not a direct .style.background assignment:
    // a real CSSStyleDeclaration aliases the two, but that aliasing is
    // exactly the kind of implicit browser behaviour this codebase avoids
    // relying on elsewhere — being explicit here keeps it testable and keeps
    // the set/clear pair obviously symmetric to the next reader.
    document.documentElement.style.setProperty('background', 'transparent');

    const params = (ctx && ctx.params) || {};
    const query = (ctx && ctx.query) || {};
    const tournamentId = String(params.tournamentId || '').trim();
    const token = String(query.k || '').trim();
    const layoutKey = Object.prototype.hasOwnProperty.call(StreamPage.LAYOUTS, String(query.layout || ''))
      ? String(query.layout)
      : 'player';
    const teamLimit = (function () {
      const n = Number(query.teams);
      return (isFinite(n) && n > 0) ? Math.round(n) : StreamPage.DEFAULT_TEAM_LIMIT;
    }());

    const state = {
      teamLimit: teamLimit,
      soldTimer: null,
      el: StreamPage._buildSkeleton()
    };
    StreamPage._state = state;
    StreamPage.LAYOUTS[layoutKey](state.el);
    StreamPage._mount(state.el.root);

    if (!tournamentId || !token) {
      // No banner, no error text — this is a broadcast surface, not a
      // diagnostics page. Simply nothing renders, so a mis-typed OBS source
      // shows an empty (transparent) layer rather than an alarming message
      // burned into a recording.
      return;
    }

    state.conn = Broadcast.connect({
      tournamentId: tournamentId,
      token: token,
      onSnapshot: function (snap) { StreamPage._paint(state, snap); },
      onLink: function (kind) { StreamPage._setLink(state, kind); },
      onFatal: function () { StreamPage._setLink(state, 'stopped'); }
    });
  },

  /** @return {void} */
  _teardown: function () {
    const state = StreamPage._state;
    StreamPage._state = null;
    try {
      document.documentElement.style.removeProperty('background');
    } catch (e) { /* nothing else this route can do about a hostile document */ }
    if (!state) return;
    if (state.conn) state.conn.stop();
    if (state.soldTimer !== null) {
      window.clearTimeout(state.soldTimer);
      state.soldTimer = null;
    }
  },

  /* ================================================================== *
   * Painting
   * ================================================================== */

  /**
   * @param {!Object} state
   * @param {!Object} snap a Broadcast snapshot, carrying `_transition`
   * @return {void}
   */
  _paint: function (state, snap) {
    const el = state.el;
    const current = (snap && snap.current) ? snap.current : null;
    const closed = String(snap && snap.status || '') === 'AUCTION_CLOSED';

    if (!current || closed) {
      el.card.classList.add('is-idle');
      el.sold.hidden = true;
    } else {
      el.card.classList.remove('is-idle');
      StreamPage._paintCard(el, current);

      const status = String(current.auction_status || '').toUpperCase();
      if (snap._transition === 'SOLD' || snap._transition === 'UNSOLD') {
        StreamPage._paintSting(state, current, status);
      } else if (status !== 'SOLD' && status !== 'UNSOLD') {
        // Player changed without a fresh sale (e.g. returned to the pool) —
        // clear a sting left over from a previous player.
        el.sold.hidden = true;
      }
    }

    StreamPage._paintTicker(state, snap.teams);
    StreamPage._paintTallies(el, snap.summary);
  },

  /**
   * The persistent player card — shown in every layout except 'sold'.
   * @param {!Object} el
   * @param {!Object} p
   * @return {void}
   */
  _paintCard: function (el, p) {
    const serial = (p.serial_no === null || p.serial_no === undefined || p.serial_no === '')
      ? '' : String(p.serial_no);

    Broadcast.setText(el.serial, serial ? '#' + serial : '');
    Broadcast.setText(el.name, String(p.name || 'Unnamed player'));

    const meta = [Broadcast.roleText(p.role), Broadcast.styleText(p.style)]
      .filter(Boolean).join(' · ');
    Broadcast.setText(el.meta, meta);

    const status = String(p.auction_status || '').toUpperCase();
    const spec = Broadcast.STATUS[status] || null;
    if (spec) {
      el.status.hidden = false;
      el.status.className = 'status ' + spec.cls;
      Broadcast.setText(el.statusMark, spec.mark);
      Broadcast.setText(el.statusWord, spec.word);
    } else {
      el.status.hidden = true;
    }

    const amount = p.sold_amount_display ? String(p.sold_amount_display) : '';
    const team = p.team_name ? String(p.team_name) : '';
    Broadcast.setText(el.amount, amount);
    Broadcast.setText(el.team, team);
    el.amount.hidden = !amount;
    el.team.hidden = !team;

    const src = p.photo_url || p.photo_thumb_url || '';
    if (src) {
      el.photoEmpty.hidden = true;
      el.photo.hidden = false;
      if (el.photo.getAttribute('src') !== src) el.photo.setAttribute('src', src);
    } else {
      el.photo.hidden = true;
      el.photo.removeAttribute('src');
      el.photoEmpty.hidden = false;
    }

    const key = String(p.player_id || '') + '|' + serial;
    if (key !== el._shownKey) {
      el._shownKey = key;
      StreamPage._replay(el.card);
    }
  },

  /**
   * The SOLD/UNSOLD sting. Fires once per transition (Broadcast guarantees
   * this), stays on screen briefly, then clears itself — a producer does not
   * have to manually hide it before the next player is called.
   * @param {!Object} state
   * @param {!Object} p
   * @param {string} status 'SOLD' | 'UNSOLD'
   * @return {void}
   */
  _paintSting: function (state, p, status) {
    const el = state.el;
    const won = status === 'SOLD';

    Broadcast.setText(el.soldTitle, won ? 'SOLD' : 'UN-SOLD');
    el.sold.classList.toggle('stream__sold--unsold', !won);
    Broadcast.setText(el.soldName, String(p.name || ''));
    Broadcast.setText(el.soldAmount, won ? String(p.sold_amount_display || '') : '');
    Broadcast.setText(el.soldTeam, won ? String(p.team_name || '') : '');
    el.soldAmount.hidden = !won;
    el.soldTeam.hidden = !won;

    el.sold.hidden = false;
    StreamPage._replay(el.sold);

    if (state.soldTimer !== null) window.clearTimeout(state.soldTimer);
    // Only the 'sold' layout auto-clears: in the other layouts the sting sits
    // beside the ordinary card and can be left until the next player replaces
    // it. In 'sold' it is the ONLY thing on screen, so leaving it up would
    // permanently occupy that OBS layer.
    if (el.root.dataset.layout === 'sold') {
      state.soldTimer = window.setTimeout(function () {
        state.soldTimer = null;
        if (StreamPage._state === state) el.sold.hidden = true;
      }, StreamPage.SOLD_STING_MS);
    }
  },

  /**
   * The team ticker — 'full' layout only, capped so it never crowds the card.
   * @param {!Object} state
   * @param {*} teams snapshot.teams
   * @return {void}
   */
  _paintTicker: function (state, teams) {
    const el = state.el;
    const list = el.ticker;
    if (!list) return;

    list.textContent = '';
    const rows = (Array.isArray(teams) ? teams : []).slice(0, state.teamLimit);
    rows.forEach(function (team) {
      const item = Broadcast.el('li', 'stream__ticker-item');
      item.appendChild(Broadcast.el('span', 'stream__ticker-name',
        String(team.team_name || '')));
      item.appendChild(Broadcast.el('span', 'stream__ticker-purse',
        Broadcast.moneyText(team.purse_remaining_display, team.purse_remaining)));
      list.appendChild(item);
    });
  },

  /**
   * The small persistent tallies — 'full' layout only.
   * @param {!Object} el
   * @param {*} summary snapshot.summary
   * @return {void}
   */
  _paintTallies: function (el, summary) {
    const box = el.tallies;
    if (!box) return;
    const s = (summary && typeof summary === 'object') ? summary : null;
    box.textContent = '';
    if (!s) { box.hidden = true; return; }
    box.hidden = false;

    [['sold', 'Sold'], ['unsold', 'Un-sold'], ['not_called', 'Not called']]
      .forEach(function (pair) {
        if (s[pair[0]] === null || s[pair[0]] === undefined) return;
        const item = Broadcast.el('span', 'stream__tally-item');
        item.appendChild(Broadcast.el('b', '', Broadcast.num(s[pair[0]])));
        item.appendChild(document.createTextNode(' ' + pair[1]));
        box.appendChild(item);
      });
  },

  /**
   * @param {!Object} state
   * @param {string} kind 'live' | 'reconnecting' | 'stopped'
   * @return {void}
   */
  _setLink: function (state, kind) {
    const link = state.el.link;
    if (!link) return;
    link.dataset.state = kind;
  },

  /**
   * Restart a CSS reveal animation. Same trick as display.js._replay:
   * removing the class, forcing a reflow, and re-adding it is the only
   * reliable way to restart a CSS animation without a JS animation library.
   * @param {HTMLElement} node
   * @return {void}
   */
  _replay: function (node) {
    if (!node || !node.classList) return;
    node.classList.remove('is-revealed');
    /* eslint-disable-next-line no-unused-expressions */
    node.offsetWidth;
    node.classList.add('is-revealed');
  },

  /* ================================================================== *
   * The skeleton
   * ================================================================== */

  /** @return {!Object} node map */
  _buildSkeleton: function () {
    const root = Broadcast.el('div', 'stream');
    root.dataset.layout = 'player';

    const link = Broadcast.el('span', 'stream__link');
    link.dataset.state = 'connecting';
    root.appendChild(link);

    /* ---- the player card ---- */
    const card = Broadcast.el('section', 'stream__card is-idle');

    const photoBox = Broadcast.el('div', 'stream__photo-box');
    const photo = Broadcast.el('img', 'stream__photo');
    photo.setAttribute('alt', '');
    photo.hidden = true;
    photoBox.appendChild(photo);
    const photoEmpty = Broadcast.el('div', 'stream__photo-empty');
    photoEmpty.hidden = true;
    photoBox.appendChild(photoEmpty);
    card.appendChild(photoBox);

    const info = Broadcast.el('div', 'stream__info');
    const serial = Broadcast.el('p', 'stream__serial', '');
    info.appendChild(serial);
    const name = Broadcast.el('h1', 'stream__name', '');
    info.appendChild(name);
    const meta = Broadcast.el('p', 'stream__meta', '');
    info.appendChild(meta);

    const result = Broadcast.el('div', 'stream__result');
    const status = Broadcast.el('span', 'status');
    status.hidden = true;
    const statusMark = Broadcast.el('span', 'status__mark', '');
    statusMark.setAttribute('aria-hidden', 'true');
    status.appendChild(statusMark);
    const statusWord = Broadcast.el('span', 'status__word', '');
    status.appendChild(statusWord);
    result.appendChild(status);
    const amount = Broadcast.el('span', 'stream__amount', '');
    amount.hidden = true;
    result.appendChild(amount);
    const team = Broadcast.el('span', 'stream__team', '');
    team.hidden = true;
    result.appendChild(team);
    info.appendChild(result);

    card.appendChild(info);
    root.appendChild(card);

    /* ---- the SOLD/UNSOLD sting ---- */
    const sold = Broadcast.el('section', 'stream__sold');
    sold.hidden = true;
    const soldTitle = Broadcast.el('p', 'stream__sold-title', 'SOLD');
    sold.appendChild(soldTitle);
    const soldName = Broadcast.el('p', 'stream__sold-name', '');
    sold.appendChild(soldName);
    const soldAmount = Broadcast.el('p', 'stream__sold-amount', '');
    sold.appendChild(soldAmount);
    const soldTeam = Broadcast.el('p', 'stream__sold-team', '');
    sold.appendChild(soldTeam);
    root.appendChild(sold);

    /* ---- the team ticker + tallies (full layout) ---- */
    const ticker = Broadcast.el('ul', 'stream__ticker');
    root.appendChild(ticker);
    const tallies = Broadcast.el('div', 'stream__tallies');
    tallies.hidden = true;
    root.appendChild(tallies);

    return {
      root: root, link: link, card: card,
      photo: photo, photoEmpty: photoEmpty,
      serial: serial, name: name, meta: meta,
      status: status, statusMark: statusMark, statusWord: statusWord,
      amount: amount, team: team,
      sold: sold, soldTitle: soldTitle, soldName: soldName,
      soldAmount: soldAmount, soldTeam: soldTeam,
      ticker: ticker, tallies: tallies,
      _shownKey: ''
    };
  },

  /**
   * @param {HTMLElement} el
   * @return {void}
   */
  _mount: function (el) {
    if (typeof App !== 'undefined' && App && typeof App.mount === 'function') {
      App.mount(el);
      return;
    }
    const root = document.getElementById('app');
    if (!root) return;
    root.textContent = '';
    root.appendChild(el);
  }
};
