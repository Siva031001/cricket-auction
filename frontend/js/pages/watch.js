/**
 * watch.js — the public live-viewer page. `WatchPage`.
 *
 * Route: /watch/:tournamentId?k=<display_token>&video=<embed url>&teams=<n>
 * Spec: the "Live Streaming & Broadcast Overlay" enhancement, §2C, §12.
 *
 * WHAT THIS IS
 *   An ordinary, scrollable web page anyone can open to follow the auction —
 *   the projector's content, laid out for a phone or laptop screen instead of
 *   a hall. Same data source as the projector and the OBS overlay
 *   (`auction.displayState` via js/broadcast.js), same read-only guarantee,
 *   same display_token gate.
 *
 * BRANDING (§19)
 *   The header shows the tournament's real name and logo. Those come from
 *   `tournament.getPublic` — a SEPARATE, one-time call, not part of the poll
 *   loop, because branding does not change every two seconds and there is no
 *   reason to ask for it on a timer. `auction.displayState` also carries a
 *   `tournament_name`; if the getPublic call fails for any reason, that name
 *   is used as the fallback so the header is never blank just because a
 *   second, non-essential request had a bad moment.
 *
 * VIDEO (§12, §13)
 *   There is no free video ingest/hosting in this stack, and none is added
 *   here. `?video=` accepts an EMBED URL from a small allow-list of platforms
 *   that already offer free live streaming (YouTube, YouTube-nocookie,
 *   Facebook) and renders it in an <iframe>. Any other domain is refused and
 *   the slot is left empty with a quiet explanation — never an arbitrary
 *   iframe pointed at whatever a query string happened to contain. Nothing
 *   is stored: the organiser puts the URL in the /watch link they share, the
 *   same way the display token already travels in that link.
 *
 * DATA MODEL HONESTY
 *   Same limits as stream.js: no base price, no incremental bid state. See
 *   that file's header for the full reasoning — it applies here unchanged.
 *
 * PERFORMANCE (§15)
 *   One extra request at load (tournament.getPublic), never repeated. The
 *   live loop is the same 2s/backoff-to-15s poll every other broadcast screen
 *   uses, paused while the tab is hidden.
 *
 * HARD RULES
 *   textContent only. Vanilla JS. Every network call through API (via
 *   Broadcast for the poll, directly for the one-time branding call).
 *
 * CSS CLASS NAMES THIS FILE EMITS (css/watch.css owns all of them)
 *   watch  watch__header  watch__logo  watch__title  watch__live
 *   watch__video  watch__video-frame  watch__video-empty
 *   watch__now  watch__card  watch__photo  watch__name  watch__meta
 *   watch__result  watch__amount  watch__team  watch__waiting
 *   watch__teams  watch__team-card  watch__team-name  watch__team-purse
 *   watch__team-count  watch__tallies  watch__tally  watch__errors
 */

/* eslint-disable no-unused-vars */
const WatchPage = {

  ROUTE_KEY: 'watch',

  DEFAULT_TEAM_LIMIT: 12,

  /**
   * Embed hosts allowed in an <iframe src>. Anything else is refused.
   *
   * This is the whole of the XSS/abuse surface for the `video` query param:
   * without an allow-list, a shared /watch link could be crafted to frame an
   * arbitrary page inside this site's own UI. Restricting to platforms that
   * (a) are free and (b) only serve their own player at these paths closes
   * that off without needing a general URL-safety library.
   * @const {!Array<string>}
   */
  VIDEO_HOSTS: [
    'www.youtube.com', 'youtube.com', 'www.youtube-nocookie.com',
    'www.facebook.com', 'facebook.com'
  ],

  /**
   * @param {Object} ctx router context {path, params, query, pattern}
   * @return {void}
   */
  render: function (ctx) {
    WatchPage._teardown();

    document.body.dataset.route = WatchPage.ROUTE_KEY;
    document.title = 'Live auction · Cricket Auction';

    const params = (ctx && ctx.params) || {};
    const query = (ctx && ctx.query) || {};
    const tournamentId = String(params.tournamentId || '').trim();
    const token = String(query.k || '').trim();
    const teamLimit = (function () {
      const n = Number(query.teams);
      return (isFinite(n) && n > 0) ? Math.round(n) : WatchPage.DEFAULT_TEAM_LIMIT;
    }());

    const state = {
      tournamentId: tournamentId,
      teamLimit: teamLimit,
      brandName: '',
      el: WatchPage._buildSkeleton()
    };
    WatchPage._state = state;
    WatchPage._mount(state.el.root);
    WatchPage._paintVideo(state.el, query.video);

    if (!tournamentId || !token) {
      WatchPage._fatal(state,
        'This link is missing information and cannot show an auction. ' +
        'Ask the organiser for the viewer link again.');
      return;
    }

    // One-time branding call. Not part of the poll — a tournament's name and
    // logo do not change every two seconds.
    if (tournamentId) {
      API.get('tournament.getPublic', { tournamentId: tournamentId })
        .then(function (pub) {
          if (WatchPage._state !== state) return;
          state.brandName = (pub && pub.name) ? String(pub.name) : '';
          Broadcast.setText(state.el.title, state.brandName || 'Live auction');
          if (pub && pub.logo_url) {
            state.el.logo.hidden = false;
            state.el.logo.setAttribute('src', String(pub.logo_url));
          }
        })
        .catch(function () {
          // Non-essential: the live poll's own tournament_name is the fallback,
          // painted the first time a snapshot arrives (see _paint).
        });
    }

    state.conn = Broadcast.connect({
      tournamentId: tournamentId,
      token: token,
      onSnapshot: function (snap) { WatchPage._paint(state, snap); },
      onLink: function (kind) { WatchPage._setLive(state, kind); },
      onFatal: function (message) { WatchPage._fatal(state, message); }
    });
  },

  /** @return {void} */
  _teardown: function () {
    const state = WatchPage._state;
    WatchPage._state = null;
    if (!state) return;
    if (state.conn) state.conn.stop();
  },

  /* ================================================================== *
   * Painting
   * ================================================================== */

  /**
   * @param {!Object} state
   * @param {!Object} snap a Broadcast snapshot
   * @return {void}
   */
  _paint: function (state, snap) {
    const el = state.el;
    const current = (snap && snap.current) ? snap.current : null;
    const closed = String(snap && snap.status || '') === 'AUCTION_CLOSED';

    // The one-time branding call may still be in flight or may have failed;
    // either way, once the live feed knows the tournament's name, use it as
    // soon as nothing better has arrived.
    if (!state.brandName) {
      Broadcast.setText(el.title, Broadcast.tournamentName(snap));
    }

    if (closed) {
      el.card.hidden = true;
      el.waiting.hidden = false;
      Broadcast.setText(el.waitingTitle, 'Auction closed');
      Broadcast.setText(el.waitingBody, 'Thanks for watching. Final results are below.');
    } else if (current) {
      el.waiting.hidden = true;
      el.card.hidden = false;
      WatchPage._paintPlayer(el, current);
    } else {
      el.card.hidden = true;
      el.waiting.hidden = false;
      Broadcast.setText(el.waitingTitle, 'Waiting for the first player');
      Broadcast.setText(el.waitingBody, 'The auction has not started yet. This page updates on its own.');
    }

    WatchPage._paintTeams(state, snap.teams);
    WatchPage._paintTallies(el, snap.summary);
  },

  /**
   * @param {!Object} el
   * @param {!Object} p
   * @return {void}
   */
  _paintPlayer: function (el, p) {
    const serial = (p.serial_no === null || p.serial_no === undefined || p.serial_no === '')
      ? '' : String(p.serial_no);

    Broadcast.setText(el.serial, serial ? '#' + serial : '');
    Broadcast.setText(el.name, String(p.name || 'Unnamed player'));

    const meta = [Broadcast.roleText(p.role), Broadcast.styleText(p.style), Broadcast.ageText(p.age_years)]
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
  },

  /**
   * @param {!Object} state
   * @param {*} teams snapshot.teams
   * @return {void}
   */
  _paintTeams: function (state, teams) {
    const el = state.el;
    const grid = el.teams;
    grid.textContent = '';

    const rows = (Array.isArray(teams) ? teams : []).slice(0, state.teamLimit);
    if (!rows.length) { el.teamsBox.hidden = true; return; }
    el.teamsBox.hidden = false;

    rows.forEach(function (team) {
      const card = Broadcast.el('li', 'watch__team-card');
      card.appendChild(Broadcast.el('span', 'watch__team-name', String(team.team_name || '')));
      card.appendChild(Broadcast.el('span', 'watch__team-purse',
        Broadcast.moneyText(team.purse_remaining_display, team.purse_remaining)));
      const count = Broadcast.num(team.players_count);
      const max = Broadcast.num(team.max_players);
      card.appendChild(Broadcast.el('span', 'watch__team-count', count + ' / ' + max));
      grid.appendChild(card);
    });
  },

  /**
   * @param {!Object} el
   * @param {*} summary snapshot.summary
   * @return {void}
   */
  _paintTallies: function (el, summary) {
    const box = el.tallies;
    const s = (summary && typeof summary === 'object') ? summary : null;
    box.textContent = '';
    if (!s) { box.hidden = true; return; }
    box.hidden = false;

    [['sold', 'Sold'], ['unsold', 'Un-sold'], ['pending_called', 'Awaiting re-auction'],
      ['not_called', 'Not called'], ['eligible', 'Eligible']].forEach(function (pair) {
      if (s[pair[0]] === null || s[pair[0]] === undefined) return;
      const item = Broadcast.el('div', 'watch__tally');
      item.appendChild(Broadcast.el('span', 'watch__tally-value', Broadcast.num(s[pair[0]])));
      item.appendChild(Broadcast.el('span', 'watch__tally-label', pair[1]));
      box.appendChild(item);
    });
  },

  /**
   * Validate and render the optional video embed. Refuses anything off the
   * allow-list rather than rendering an arbitrary iframe from a query string
   * a link could be crafted with.
   * @param {!Object} el
   * @param {*} raw the ?video= value
   * @return {void}
   */
  _paintVideo: function (el, raw) {
    const value = String(raw || '').trim();
    if (!value) {
      // No ?video= at all is exactly as "not configured" as an invalid one —
      // the empty-slot message must say so either way, not just when a bad
      // value was actively refused.
      el.videoEmpty.hidden = false;
      return;
    }

    let url = null;
    try { url = new URL(value); } catch (e) { /* not a URL at all */ }

    const host = url ? String(url.hostname || '').toLowerCase() : '';
    const safe = !!url && url.protocol === 'https:' &&
      WatchPage.VIDEO_HOSTS.indexOf(host) !== -1;

    if (!safe) {
      el.videoEmpty.hidden = false;
      return;
    }

    el.videoEmpty.hidden = true;
    const frame = document.createElement('iframe');
    frame.className = 'watch__video-frame';
    frame.setAttribute('src', url.href);
    frame.setAttribute('title', 'Live stream');
    frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
    frame.setAttribute('allowfullscreen', 'true');
    frame.setAttribute('frameborder', '0');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    el.video.appendChild(frame);
  },

  /**
   * @param {!Object} state
   * @param {string} kind 'live' | 'reconnecting' | 'stopped'
   * @return {void}
   */
  _setLive: function (state, kind) {
    const badge = state.el.live;
    badge.dataset.state = kind;
    Broadcast.setText(state.el.liveWord,
      kind === 'live' ? 'LIVE' : (kind === 'reconnecting' ? 'RECONNECTING' : 'OFFLINE'));
  },

  /**
   * A viewer-facing error. Unlike stream.js (a broadcast surface, silent by
   * design), this is a page a person is actually looking at, so it gets a
   * real message — reusing the same UI.banner every other page in this app
   * uses, so it looks like the rest of the site rather than a second design.
   * @param {!Object} state
   * @param {string} message
   * @return {void}
   */
  _fatal: function (state, message) {
    const el = state.el;
    el.card.hidden = true;
    el.waiting.hidden = true;
    el.teamsBox.hidden = true;
    el.tallies.hidden = true;
    WatchPage._setLive(state, 'stopped');

    el.errors.textContent = '';
    if (typeof UI !== 'undefined' && UI && typeof UI.banner === 'function') {
      el.errors.appendChild(UI.banner('error', String(message || '')));
    } else {
      el.errors.appendChild(Broadcast.el('p', '', String(message || '')));
    }
  },

  /* ================================================================== *
   * Skeleton
   * ================================================================== */

  /** @return {!Object} node map */
  _buildSkeleton: function () {
    const root = Broadcast.el('main', 'panel watch');

    const header = Broadcast.el('header', 'watch__header');
    const logo = document.createElement('img');
    logo.className = 'watch__logo';
    logo.setAttribute('alt', '');
    logo.hidden = true;
    header.appendChild(logo);
    const title = Broadcast.el('h1', 'watch__title', 'Live auction');
    header.appendChild(title);
    const live = Broadcast.el('span', 'watch__live');
    live.dataset.state = 'connecting';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    const liveDot = Broadcast.el('span', 'watch__live-dot', '');
    liveDot.setAttribute('aria-hidden', 'true');
    live.appendChild(liveDot);
    const liveWord = Broadcast.el('span', 'watch__live-word', 'CONNECTING');
    live.appendChild(liveWord);
    header.appendChild(live);
    root.appendChild(header);

    const errors = Broadcast.el('div', 'watch__errors');
    root.appendChild(errors);

    const video = Broadcast.el('div', 'watch__video');
    const videoEmpty = Broadcast.el('p', 'watch__video-empty',
      'No video source has been added to this link yet.');
    videoEmpty.hidden = true;
    video.appendChild(videoEmpty);
    root.appendChild(video);

    /* ---- current player ---- */
    const waiting = Broadcast.el('section', 'watch__waiting');
    const waitingTitle = Broadcast.el('h2', '', 'Connecting…');
    waiting.appendChild(waitingTitle);
    const waitingBody = Broadcast.el('p', '', '');
    waiting.appendChild(waitingBody);
    root.appendChild(waiting);

    const card = Broadcast.el('section', 'watch__card');
    card.hidden = true;
    const photoBox = Broadcast.el('div', 'watch__photo-box');
    const photo = document.createElement('img');
    photo.className = 'watch__photo';
    photo.setAttribute('alt', '');
    photo.hidden = true;
    photoBox.appendChild(photo);
    const photoEmpty = Broadcast.el('div', 'watch__photo-empty', '');
    photoEmpty.hidden = true;
    photoBox.appendChild(photoEmpty);
    card.appendChild(photoBox);

    const info = Broadcast.el('div', 'watch__info');
    const serial = Broadcast.el('p', 'watch__serial', '');
    info.appendChild(serial);
    const name = Broadcast.el('h2', 'watch__name', '');
    info.appendChild(name);
    const meta = Broadcast.el('p', 'watch__meta', '');
    info.appendChild(meta);

    const result = Broadcast.el('div', 'watch__result');
    const status = Broadcast.el('span', 'status');
    status.hidden = true;
    const statusMark = Broadcast.el('span', 'status__mark', '');
    statusMark.setAttribute('aria-hidden', 'true');
    status.appendChild(statusMark);
    const statusWord = Broadcast.el('span', 'status__word', '');
    status.appendChild(statusWord);
    result.appendChild(status);
    const amount = Broadcast.el('span', 'watch__amount', '');
    amount.hidden = true;
    result.appendChild(amount);
    const team = Broadcast.el('span', 'watch__team', '');
    team.hidden = true;
    result.appendChild(team);
    info.appendChild(result);

    card.appendChild(info);
    root.appendChild(card);

    /* ---- teams ---- */
    const teamsBox = Broadcast.el('section', 'watch__teams-box');
    teamsBox.hidden = true;
    teamsBox.appendChild(Broadcast.el('h2', '', 'Teams'));
    const teams = Broadcast.el('ul', 'watch__teams');
    teamsBox.appendChild(teams);
    root.appendChild(teamsBox);

    const tallies = Broadcast.el('div', 'watch__tallies');
    tallies.hidden = true;
    root.appendChild(tallies);

    return {
      root: root, logo: logo, title: title,
      live: live, liveDot: liveDot, liveWord: liveWord,
      errors: errors, video: video, videoEmpty: videoEmpty,
      waiting: waiting, waitingTitle: waitingTitle, waitingBody: waitingBody,
      card: card, photo: photo, photoEmpty: photoEmpty,
      serial: serial, name: name, meta: meta,
      status: status, statusMark: statusMark, statusWord: statusWord,
      amount: amount, team: team,
      teamsBox: teamsBox, teams: teams, tallies: tallies
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
