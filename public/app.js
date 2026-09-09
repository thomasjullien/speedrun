/*
 * Race Timer - client
 *
 * Three things make two separate posts (start line / finish line) work:
 *   1. the server is the single source of truth, pushed live over SSE;
 *   2. every phone measures its own clock offset against the server, so a tap
 *      on either line lands on the same timeline (see syncClock);
 *   3. a tap is timestamped locally and queued, so neither latency nor a
 *      dropped connection can distort or lose a time (see queue / flush).
 */
(function () {
  'use strict';

  var LS_OUTBOX = 'raceTimer.outbox';
  var LS_VIEW = 'raceTimer.view';
  var TAP_GUARD_MS = 350; // ignore an accidental double tap on the same control

  // Kept in step with PALETTE in server.js.
  var PALETTE = [
    '#ef4444', '#38bdf8', '#fbbf24', '#22c55e', '#d946ef', '#f97316',
    '#14b8a6', '#a78bfa', '#ec4899', '#84cc16', '#3b82f6', '#e2e8f0',
  ];

  // Absolute base for API calls, so the app works under any sub-path.
  // Credentials are stripped: someone will bookmark the page as
  // https://user:pass@host/speedrun/ to skip the password prompt on a phone,
  // and fetch() refuses to build a request from a URL that carries them.
  var PARAMS = new URLSearchParams(location.search);

  // Alternative faces of the same app, each on its own path, one segment deep.
  // The API lives at the application root, so that segment is stripped before
  // resolving it: '/speedrun/overlay-standings' still calls '/speedrun/api/state'.
  var PAGE_PATHS = /\/(board|overlay-[a-z]+)\/?$/;

  var API_BASE = (function () {
    try {
      var u = new URL(location.href);
      u.username = '';
      u.password = '';
      u.search = '';
      u.hash = '';
      var p = u.pathname.replace(PAGE_PATHS, '/');
      if (!/\/$/.test(p)) p = p.replace(/[^/]*$/, '');
      u.pathname = p;
      return u.href;
    } catch (e) {
      return './';
    }
  })();

  function api(path) { return API_BASE + path; }

  // Read-only scoreboard: reached at /board, or with ?post=board.
  // The server refuses every write from an unauthenticated visitor, so this is
  // not merely a hidden UI - the results genuinely cannot be altered from here.
  var BOARD_MODE = /\/board\/?$/.test(location.pathname) ||
    PARAMS.get('post') === 'board';

  // Broadcast overlays: /overlay/standings and /overlay/oncourse. Transparent
  // background, no chrome, meant to be dropped into vMix or OBS as a browser
  // source and left running.
  var OVERLAY = (function () {
    var m = location.pathname.match(/\/overlay-([a-z]+)\/?$/);
    var name = m ? m[1] : PARAMS.get('overlay');
    return name === 'standings' || name === 'oncourse' ? name : null;
  })();

  var READ_ONLY = BOARD_MODE || !!OVERLAY;

  // ============================================================== utilities

  function el(id) { return document.getElementById(id); }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad(n, w) {
    var s = String(Math.floor(Math.abs(n)));
    while (s.length < w) s = '0' + s;
    return s;
  }

  /** Duration as m:ss.t (or h:mm:ss.t past the hour). */
  function fmtDur(ms) {
    if (ms == null || !isFinite(ms)) return '--:--.-';
    var neg = ms < 0;
    ms = Math.abs(ms);
    var tenths = Math.floor(ms / 100) % 10;
    var total = Math.floor(ms / 1000);
    var s = total % 60;
    var m = Math.floor(total / 60) % 60;
    var h = Math.floor(total / 3600);
    var body = h > 0 ? h + ':' + pad(m, 2) + ':' + pad(s, 2) : m + ':' + pad(s, 2);
    return (neg ? '-' : '') + body + '.' + tenths;
  }

  /** Time of day, optionally with tenths. */
  function fmtTod(ts, tenths) {
    if (!ts) return '--:--:--';
    var d = new Date(ts);
    var out = pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2);
    return tenths ? out + '.' + Math.floor(d.getMilliseconds() / 100) : out;
  }

  function buzz(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms || 30); } catch (e) {}
  }

  // ============================================================== server clock
  //
  // Two phones are never on the same clock. Each one measures its offset the
  // way NTP does: several probes, keep the one with the lowest round trip.
  // Every timestamp we emit is then expressed in server time.

  var clockOffset = 0;
  var clockRtt = null;
  var clockSynced = false;

  function serverNow() { return Date.now() + clockOffset; }

  function syncClock(rounds) {
    rounds = rounds || 5;
    var best = null;
    var chain = Promise.resolve();

    for (var i = 0; i < rounds; i++) {
      chain = chain.then(function () {
        var t0 = Date.now();
        return fetch(api('api/time'), { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var t1 = Date.now();
            var rtt = t1 - t0;
            // Assume a symmetric round trip: the server read happened at (t0+t1)/2.
            var offset = j.now - (t0 + t1) / 2;
            if (!best || rtt < best.rtt) best = { rtt: rtt, offset: offset };
          })
          .catch(function () { /* offline: keep the previous offset */ });
      });
    }

    return chain.then(function () {
      if (best) {
        clockOffset = best.offset;
        clockRtt = best.rtt;
        clockSynced = true;
      }
      renderNet();
    });
  }

  // ============================================================== state

  var server = null;      // authoritative state from the server
  var outbox = [];        // taps not yet acknowledged
  var connected = false;
  var flushing = false;
  var retryTimer = null;
  var view = 'start';
  var capture = { start: null, finish: null }; // frozen timestamp awaiting a boat
  var lastTapAt = 0;

  function loadOutbox() {
    try {
      var raw = localStorage.getItem(LS_OUTBOX);
      outbox = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(outbox)) outbox = [];
    } catch (e) { outbox = []; }
  }

  function saveOutbox() {
    try { localStorage.setItem(LS_OUTBOX, JSON.stringify(outbox)); } catch (e) {}
  }

  /** Queue one or more mutations: timestamped now, rendered now, sent ASAP. */
  function queue(action) {
    var list = Array.isArray(action) ? action : [action];
    list.forEach(function (a) {
      a.id = a.id || uid('a_');
      if (a.ts == null) a.ts = serverNow();
      outbox.push(a);
    });
    saveOutbox();
    render();
    flush();
  }

  function flush() {
    if (flushing || !outbox.length) return;
    flushing = true;
    var batch = outbox.slice(0, 50);

    // fetch() can throw synchronously (a malformed URL, for one). Going
    // through a promise keeps that on the failure path: if it escaped, the
    // flag below would stay set and the queue would never drain again.
    Promise.resolve()
      .then(function () {
        return fetch(api('api/action'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ actions: batch }),
        });
      })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        var sent = {};
        batch.forEach(function (a) { sent[a.id] = true; });
        outbox = outbox.filter(function (a) { return !sent[a.id]; });
        saveOutbox();
        if (body.state) server = body.state;
        if (body.error) toast(body.error, { error: true });
        setConnected(true);
        render();
      })
      .catch(function () {
        setConnected(false);
      })
      .then(function () {
        flushing = false;
        if (outbox.length) {
          clearTimeout(retryTimer);
          retryTimer = setTimeout(flush, 1500);
        }
      });
  }

  function setConnected(v) {
    if (connected === v) return;
    connected = v;
    renderNet();
  }

  function openStream() {
    var es = new EventSource(api('api/stream'));
    es.onmessage = function (ev) {
      try { server = JSON.parse(ev.data); } catch (e) { return; }
      setConnected(true);
      render();
    };
    es.onopen = function () { setConnected(true); };
    es.onerror = function () { setConnected(false); }; // EventSource retries on its own
  }

  // ============================================================== local projection
  //
  // The UI must react to a tap instantly, even with no network. We replay the
  // queued actions on top of the server state to get what the screen shows.

  function derive() {
    if (!server) return null;
    var s = JSON.parse(JSON.stringify(server));
    outbox.forEach(function (a) { applyLocal(s, a); });
    return s;
  }

  function applyLocal(s, a) {
    var run;
    switch (a.type) {
      case 'start':
        run = s.runs.filter(function (r) { return r.boatId === a.boatId && r.status === 'running'; })[0];
        if (run) {
          if (!a.force) return;
          run.status = 'cancelled';
        }
        s.runs.push({
          id: a.runId, boatId: a.boatId, startAt: a.ts,
          finishAt: null, status: 'running', pending: true,
        });
        break;

      case 'finish':
        run = a.runId ? findRun(s, a.runId) : null;
        if (!run) {
          run = s.runs
            .filter(function (r) { return r.boatId === a.boatId && r.status === 'running'; })
            .sort(function (x, y) { return x.startAt - y.startAt; })[0];
        }
        if (!run || run.status !== 'running' || a.ts <= run.startAt) return;
        run.finishAt = a.ts;
        run.status = 'done';
        run.pending = true;
        break;

      case 'unfinish':
        run = findRun(s, a.runId);
        if (run) { run.finishAt = null; run.status = 'running'; run.pending = true; }
        break;

      case 'cancelRun':
        run = findRun(s, a.runId);
        if (run) { run.status = 'cancelled'; run.pending = true; }
        break;

      case 'restoreRun':
        run = findRun(s, a.runId);
        if (run) { run.status = run.finishAt ? 'done' : 'running'; run.pending = true; }
        break;

      case 'deleteRun':
        s.runs = s.runs.filter(function (r) { return r.id !== a.runId; });
        break;

      case 'setRunTime':
        run = findRun(s, a.runId);
        if (run) { run[a.field === 'finishAt' ? 'finishAt' : 'startAt'] = a.value; run.pending = true; }
        break;
    }
  }

  function findRun(s, id) {
    return s.runs.filter(function (r) { return r.id === id; })[0] || null;
  }

  // ============================================================== selectors

  function boatOf(s, id) {
    return s.boats.filter(function (b) { return b.id === id; })[0] || null;
  }

  function boatLabel(s, id) {
    var b = boatOf(s, id);
    return b ? b.name : 'Unknown boat';
  }

  function boatColor(s, id) {
    var b = boatOf(s, id);
    return (b && b.color) || 'transparent';
  }

  /** Inline custom property consumed by the colour accents in style.css. */
  function colorStyle(color) {
    return ' style="--boat:' + esc(color) + '"';
  }

  function dot(color) {
    return '<span class="cdot" style="--boat:' + esc(color) + '"></span>';
  }

  function runsOfBoat(s, id) {
    return s.runs.filter(function (r) { return r.boatId === id; });
  }

  /** A cancelled run does not burn an attempt. */
  function attemptsUsed(s, id) {
    return runsOfBoat(s, id).filter(function (r) { return r.status !== 'cancelled'; }).length;
  }

  function attemptsLeft(s, id) {
    return Math.max(0, s.maxAttempts - attemptsUsed(s, id));
  }

  function duration(run) {
    return run && run.finishAt && run.startAt ? run.finishAt - run.startAt : null;
  }

  function doneRuns(s, id) {
    return runsOfBoat(s, id).filter(function (r) { return r.status === 'done' && duration(r) != null; });
  }

  function bestRun(s, id) {
    return doneRuns(s, id).sort(function (a, b) { return duration(a) - duration(b); })[0] || null;
  }

  function runningRuns(s) {
    return s.runs
      .filter(function (r) { return r.status === 'running'; })
      .sort(function (a, b) { return a.startAt - b.startAt; });
  }

  function runningRunOf(s, id) {
    return runningRuns(s).filter(function (r) { return r.boatId === id; })[0] || null;
  }

  /** Every timed run of a boat, quickest first. */
  function sortedTimes(s, id) {
    return doneRuns(s, id)
      .map(duration)
      .sort(function (x, y) { return x - y; });
  }

  /**
   * Two boats level on their best run are separated by their second best, then
   * by the third, and so on. A boat with no further time to offer loses the
   * tie-break, which also places boats with no time at all at the bottom.
   */
  function compareBoats(a, b) {
    var n = Math.max(a.times.length, b.times.length);
    for (var i = 0; i < n; i++) {
      var x = a.times[i];
      var y = b.times[i];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (x !== y) return x - y;
    }
    return 0;
  }

  /** Ranking: best time per boat, ties broken on the runs behind it. */
  function ranking(s) {
    var rows = s.boats.map(function (b) {
      var times = sortedTimes(s, b.id);
      return {
        boat: b,
        best: bestRun(s, b.id),
        times: times,
        ms: times.length ? times[0] : null,
        second: times.length > 1 ? times[1] : null,
        attempts: attemptsUsed(s, b.id),
        finished: times.length,
      };
    });
    rows.sort(compareBoats);
    var leader = rows.length && rows[0].ms != null ? rows[0].ms : null;
    rows.forEach(function (r, i) {
      r.pos = r.ms != null ? i + 1 : null;
      r.gap = r.ms != null && leader != null && i > 0 ? r.ms - leader : null;
      // Level with a neighbour on the best run: the order came from the
      // tie-break, so say so rather than leave it looking arbitrary.
      var prev = rows[i - 1];
      var next = rows[i + 1];
      r.tied = r.ms != null &&
        ((prev && prev.ms === r.ms) || (next && next.ms === r.ms));
    });
    return rows;
  }

  // ============================================================== toast & modal

  var toastNode = el('toast');
  var toastBtn = toastNode.querySelector('button');
  var toastMsg = toastNode.querySelector('.msg');
  var toastTimer = null;
  var toastUndo = null;

  function toast(message, opts) {
    opts = opts || {};
    clearTimeout(toastTimer);
    toastMsg.textContent = message;
    toastNode.classList.toggle('err', !!opts.error);
    toastUndo = opts.undo || null;
    toastBtn.hidden = !toastUndo;
    toastBtn.textContent = opts.undoLabel || 'Undo';
    toastNode.classList.add('show');
    toastTimer = setTimeout(hideToast, opts.ms || (toastUndo ? 7000 : 3200));
  }

  function hideToast() {
    toastNode.classList.remove('show');
    toastUndo = null;
    toastBtn.hidden = true;
  }

  toastBtn.addEventListener('click', function () {
    var fn = toastUndo;
    hideToast();
    if (fn) fn();
  });

  var modalNode = el('modal');

  function modal(opts) {
    modalNode.querySelector('h3').textContent = opts.title || '';
    var p = modalNode.querySelector('.body');
    p.innerHTML = opts.html || esc(opts.text || '');
    p.hidden = !(opts.html || opts.text);
    var acts = modalNode.querySelector('.acts');
    acts.innerHTML = '';
    (opts.actions || []).forEach(function (a) {
      if (a.row) {
        var row = document.createElement('div');
        row.className = 'btn-row';
        a.row.forEach(function (sub) {
          var b = document.createElement('button');
          b.className = 'btn ' + (sub.cls || '');
          b.style.flex = '1';
          b.textContent = sub.label;
          b.addEventListener('click', function () { if (!sub.keepOpen) closeModal(); sub.onClick(); });
          row.appendChild(b);
        });
        acts.appendChild(row);
        return;
      }
      var btn = document.createElement('button');
      btn.className = 'btn ' + (a.cls || '');
      btn.textContent = a.label;
      btn.addEventListener('click', function () {
        if (!a.keepOpen) closeModal();
        if (a.onClick) a.onClick();
      });
      acts.appendChild(btn);
    });
    modalNode.classList.add('show');
  }

  function closeModal() { modalNode.classList.remove('show'); }

  modalNode.addEventListener('click', function (e) {
    if (e.target === modalNode) closeModal();
  });

  // ============================================================== rendering

  var views = {
    start: el('view-start'),
    finish: el('view-finish'),
    results: el('view-results'),
    setup: el('view-setup'),
    board: el('view-board'),
    overlay: el('view-overlay'),
  };

  function renderNet() {
    var pill = el('netPill');
    var txt = el('netTxt');
    var pending = outbox.length;
    pill.className = 'pill ' + (pending ? 'wait' : connected ? 'ok' : 'ko');
    if (pending) txt.textContent = pending + ' pending';
    else if (!connected) txt.textContent = 'Offline';
    else txt.textContent = clockSynced ? 'Synced' : 'Live';
    pill.title = clockSynced
      ? 'Clock offset ' + Math.round(clockOffset) + ' ms, round trip ' + Math.round(clockRtt) + ' ms'
      : 'Clock not synced yet';
  }

  function setView(next) {
    view = next;
    // Never remember a display mode: it would hijack the app on a later visit.
    if (next !== 'board' && next !== 'overlay') {
      try { localStorage.setItem(LS_VIEW, next); } catch (e) {}
    }
    Object.keys(views).forEach(function (k) {
      views[k].classList.toggle('active', k === next);
    });
    document.querySelectorAll('nav button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === next);
    });
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    renderNet();
    var s = derive();
    if (!s) return;

    el('eventName').textContent = s.eventName || 'Race Timer';

    // Re-rendering under the user's fingers would drop focus mid-typing.
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT';

    if (view === 'overlay') {
      views.overlay.innerHTML = OVERLAY === 'oncourse'
        ? htmlOverlayOnCourse(s)
        : htmlOverlayStandings(s);
    }
    else if (view === 'board') views.board.innerHTML = htmlBoard(s);
    else if (view === 'start') views.start.innerHTML = htmlStart(s);
    else if (view === 'finish') views.finish.innerHTML = htmlFinish(s);
    else if (view === 'results') views.results.innerHTML = htmlResults(s);
    else if (view === 'setup' && !typing) views.setup.innerHTML = htmlSetup(s);

    tick();
  }

  // -------------------------------------------------------------- start post

  function htmlStart(s) {
    var out = [];

    if (capture.start) {
      out.push(
        '<div class="capture-banner">' +
          '<div><div class="lbl">Start time held</div>' +
          '<div class="val mono">' + fmtTod(capture.start, true) + '</div></div>' +
          '<button data-act="clear-capture" data-line="start">Discard</button>' +
        '</div>' +
        '<div class="section-title">Which boat crossed?</div>'
      );
    } else {
      out.push(
        '<button class="top-btn start" data-act="mark-start">MARK START' +
          '<small>hold the time now, pick the boat after</small>' +
        '</button>'
      );
    }

    var live = runningRuns(s);
    if (live.length) {
      out.push('<div class="section-title">On course (' + live.length + ')</div>');
      live.forEach(function (r) {
        out.push(
          '<div class="run-card"' + colorStyle(boatColor(s, r.boatId)) + '>' +
            '<div class="who"><div class="name">' + esc(boatLabel(s, r.boatId)) + '</div>' +
            '<div class="sub">started ' + fmtTod(r.startAt, true) + '</div></div>' +
            '<div class="elapsed mono" data-live-start="' + r.startAt + '">0:00.0</div>' +
            '<button class="act" data-act="cancel-start" data-run="' + r.id + '">UNDO</button>' +
          '</div>'
        );
      });
    }

    out.push('<div class="section-title">Tap a boat as it crosses the line</div>');

    if (!s.boats.length) {
      out.push('<div class="empty">No boats yet.<br>Add them in <b>Setup</b>.</div>');
      return out.join('');
    }

    out.push('<div class="boat-grid">');
    s.boats.forEach(function (b) {
      var running = runningRunOf(s, b.id);
      var left = attemptsLeft(s, b.id);
      var best = bestRun(s, b.id);
      var cls = running ? 'running' : left <= 0 ? 'exhausted' : 'go';
      var chip = running
        ? '<span class="chip">ON COURSE</span>'
        : left <= 0 ? '<span class="chip done">DONE</span>' : '';
      var meta = best
        ? 'Best ' + fmtDur(duration(best)) + ' &middot; ' + left + ' left'
        : left + ' of ' + s.maxAttempts + ' runs left';
      out.push(
        '<button class="boat-btn ' + cls + '" data-act="start-boat" data-boat="' + b.id + '"' +
          colorStyle(b.color) + '>' +
          chip +
          '<span class="name">' + esc(b.name) + '</span>' +
          (b.sail ? '<span class="sail">' + esc(b.sail) + '</span>' : '') +
          '<span class="meta">' + meta + '</span>' +
        '</button>'
      );
    });
    out.push('</div>');
    return out.join('');
  }

  // -------------------------------------------------------------- finish post

  function htmlFinish(s) {
    var out = [];
    var live = runningRuns(s);

    if (capture.finish) {
      out.push(
        '<div class="capture-banner">' +
          '<div><div class="lbl">Finish time held</div>' +
          '<div class="val mono">' + fmtTod(capture.finish, true) + '</div></div>' +
          '<button data-act="clear-capture" data-line="finish">Discard</button>' +
        '</div>' +
        '<div class="section-title">Which boat crossed?</div>'
      );
    } else {
      out.push(
        '<button class="top-btn" data-act="mark-finish">MARK FINISH' +
          '<small>hold the time now, pick the boat after</small>' +
        '</button>'
      );
    }

    if (!live.length) {
      out.push('<div class="empty">No boat on course.<br>Times appear here as the start line sends them.</div>');
    } else {
      if (!capture.finish) out.push('<div class="section-title">On course (' + live.length + ')</div>');
      live.forEach(function (r) {
        var used = runsOfBoat(s, r.boatId).filter(function (x) { return x.status !== 'cancelled'; }).length;
        out.push(
          '<button class="run-card finish" data-act="finish-run" data-run="' + r.id + '"' +
            colorStyle(boatColor(s, r.boatId)) + '>' +
            '<div class="who"><div class="name">' + esc(boatLabel(s, r.boatId)) + '</div>' +
            '<div class="sub">started ' + fmtTod(r.startAt, true) + ' &middot; run ' + used + '/' + s.maxAttempts + '</div></div>' +
            '<div class="elapsed mono" data-live-start="' + r.startAt + '">0:00.0</div>' +
            '<span class="cta">Finish</span>' +
          '</button>'
        );
      });
    }

    var recent = s.runs
      .filter(function (r) { return r.status === 'done'; })
      .sort(function (a, b) { return b.finishAt - a.finishAt; })
      .slice(0, 5);

    if (recent.length) {
      out.push('<div class="section-title">Just finished</div><div class="panel">');
      recent.forEach(function (r) {
        out.push(
          '<div class="run-row">' +
            '<div class="info"><div class="l1">' + dot(boatColor(s, r.boatId)) +
              esc(boatLabel(s, r.boatId)) + ' &middot; ' +
              '<span class="mono">' + fmtDur(duration(r)) + '</span></div>' +
              '<div class="l2">' + fmtTod(r.startAt, true) + ' &rarr; ' + fmtTod(r.finishAt, true) + '</div></div>' +
            '<button class="act" data-act="undo-finish" data-run="' + r.id + '">UNDO</button>' +
          '</div>'
        );
      });
      out.push('</div>');
    }

    return out.join('');
  }

  // -------------------------------------------------------------- results

  function htmlResults(s) {
    var rows = ranking(s);
    var out = [];

    out.push('<div class="section-title">Standings &mdash; best run per boat</div>');

    if (!rows.length) {
      out.push('<div class="empty">No boats yet.<br>Add them in <b>Setup</b>.</div>');
      return out.join('');
    }

    rows.forEach(function (r) {
      var cls = r.pos ? 'rank p' + r.pos : 'rank none';
      var sub = r.pos
        ? r.finished + ' timed run' + (r.finished > 1 ? 's' : '') +
          (r.attempts >= s.maxAttempts ? ' &middot; all attempts used' : '') +
          (r.tied
            ? ' &middot; tie on best, 2nd best ' +
              (r.second != null ? fmtDur(r.second) : 'none')
            : '')
        : (runningRunOf(s, r.boat.id) ? 'on course' : 'no time yet');
      out.push(
        '<div class="' + cls + '"' + colorStyle(r.boat.color || 'transparent') + '>' +
          '<div class="pos">' + (r.pos || '&ndash;') + '</div>' +
          '<div class="who"><div class="name">' + esc(r.boat.name) + '</div>' +
            '<div class="sub">' + (r.boat.sail ? esc(r.boat.sail) + ' &middot; ' : '') + sub + '</div></div>' +
          '<div class="time"><div class="big mono">' + (r.ms != null ? fmtDur(r.ms) : '&ndash;') + '</div>' +
            (r.gap != null ? '<div class="gap mono">+' + fmtDur(r.gap) + '</div>' : '') +
          '</div>' +
        '</div>'
      );
    });

    out.push(
      '<div class="btn-row" style="margin-top:14px">' +
        '<button class="btn primary" data-act="export">Export CSV</button>' +
      '</div>'
    );

    out.push('<div class="section-title">All runs</div>');

    var any = false;
    s.boats.forEach(function (b) {
      var runs = runsOfBoat(s, b.id).sort(function (x, y) { return x.startAt - y.startAt; });
      if (!runs.length) return;
      any = true;
      var best = bestRun(s, b.id);
      out.push(
        '<div class="panel"><div class="head"><span class="t">' + dot(b.color) + esc(b.name) + '</span>' +
        '<span class="n">' + attemptsUsed(s, b.id) + '/' + s.maxAttempts + ' attempts</span></div>'
      );
      runs.forEach(function (r, i) {
        var d = duration(r);
        var isBest = best && r.id === best.id;
        var label = r.status === 'cancelled' ? 'cancelled'
          : r.status === 'running' ? 'on course'
          : fmtDur(d);
        out.push(
          '<div class="run-row ' + (isBest ? 'best ' : '') + (r.status === 'cancelled' ? 'cancelled' : '') + '">' +
            '<div class="idx">#' + (i + 1) + '</div>' +
            '<div class="info"><div class="l1 mono">' + label + (isBest ? ' &#9733;' : '') + '</div>' +
              '<div class="l2">' + fmtTod(r.startAt, true) +
              (r.finishAt ? ' &rarr; ' + fmtTod(r.finishAt, true) : '') +
              (r.edited ? ' &middot; edited' : '') + '</div></div>' +
            '<button class="act" data-act="run-menu" data-run="' + r.id + '">&#8942;</button>' +
          '</div>'
        );
      });
      out.push('</div>');
    });

    if (!any) out.push('<div class="empty">No runs recorded yet.</div>');

    return out.join('');
  }

  // -------------------------------------------------------------- setup

  function htmlSetup(s) {
    var out = [];

    out.push(
      '<div class="section-title">Event</div>' +
      '<div class="field"><label>Name</label>' +
      '<input type="text" id="inEvent" value="' + esc(s.eventName) + '" maxlength="80"></div>' +
      '<div class="field"><label>Attempts per boat</label>' +
      '<input type="number" id="inAttempts" min="1" max="50" value="' + s.maxAttempts + '"></div>' +
      '<button class="btn primary wide" data-act="save-settings">Save</button>'
    );

    out.push('<div class="section-title">Boats (' + s.boats.length + ')</div>');
    if (s.boats.length) {
      out.push('<div class="panel">');
      s.boats.forEach(function (b, i) {
        out.push(
          '<div class="boat-edit">' +
            '<div class="n"><div class="nm">' + dot(b.color) + esc(b.name) + '</div>' +
            (b.sail ? '<div class="sl">' + esc(b.sail) + '</div>' : '') + '</div>' +
            '<button class="mini" data-act="move-boat" data-boat="' + b.id + '" data-dir="up"' +
              (i === 0 ? ' disabled style="opacity:.3"' : '') + '>&uarr;</button>' +
            '<button class="mini" data-act="move-boat" data-boat="' + b.id + '" data-dir="down"' +
              (i === s.boats.length - 1 ? ' disabled style="opacity:.3"' : '') + '>&darr;</button>' +
            '<button class="mini" data-act="edit-boat" data-boat="' + b.id + '">&#9998;</button>' +
          '</div>'
        );
      });
      out.push('</div>');
    }

    out.push(
      '<div class="field" style="margin-top:12px"><label>Add boats</label>' +
      '<input type="text" id="inBoat" placeholder="Name, or several: Alba, Kite, Zephyr"></div>' +
      '<div class="field"><label>Sail number (single boat only)</label>' +
      '<input type="text" id="inSail" placeholder="FRA 42"></div>' +
      '<button class="btn wide" data-act="add-boat">Add</button>'
    );

    out.push(
      '<div class="section-title">Danger zone</div>' +
      '<button class="btn danger wide" data-act="reset-runs">Clear all runs</button>' +
      '<p class="hint">Boats are kept, every recorded time is erased. ' +
      'The raw log in <code>data/events.jsonl</code> is never touched.</p>'
    );

    out.push(
      '<div class="section-title">This device</div>' +
      '<p class="hint">Clock offset with the server: <b class="mono">' +
      (clockSynced ? (clockOffset > 0 ? '+' : '') + Math.round(clockOffset) + ' ms' : 'not synced') +
      '</b><br>Round trip: <b class="mono">' + (clockRtt != null ? Math.round(clockRtt) + ' ms' : '&ndash;') + '</b>' +
      '<br>Both posts are corrected onto the same timeline, so times stay comparable.</p>' +
      '<button class="btn wide" data-act="resync">Re-sync clock</button>'
    );

    return out.join('');
  }

  // -------------------------------------------------------------- scoreboard
  //
  // Read-only display for a spectator screen. No control that mutates anything
  // is rendered here, and the server rejects writes from unauthenticated
  // visitors anyway.

  function htmlBoard(s) {
    var rows = ranking(s);
    var live = runningRuns(s);
    var out = [];

    // Tell the stylesheet how many rows it has to fit on one screen.
    out.push('<div class="tor" style="--n:' + Math.max(4, rows.length + live.length) + '">');

    out.push(
      '<div class="tor-head tor-pad">' +
        '<img class="tor-logo mark" src="logos/imoca.png" alt="IMOCA" onerror="this.remove()">' +
        '<div class="tor-spacer"></div>' +
        '<span class="tor-live"><i></i>Live</span>' +
        '<div class="tor-spacer"></div>' +
        '<img class="tor-logo wordmark reversed" src="logos/ocean-race.png"' +
          ' alt="The Ocean Race" onerror="this.remove()">' +
      '</div>'
    );

    out.push('<h1 class="tor-title tor-pad">' + esc(s.eventName || 'Scoreboard') + '</h1>');

    if (live.length) {
      out.push('<div class="tor-section tor-pad">On course</div>');
      out.push('<div class="tor-rows tor-pad">');
      live.forEach(function (r) {
        out.push(
          '<div class="tor-lrow"' + colorStyle(boatColor(s, r.boatId)) + '>' +
            '<span class="tr-colour"></span>' +
            '<span class="tr-name">' + esc(boatLabel(s, r.boatId)) + '</span>' +
            '<span class="tr-time mono" data-live-start="' + r.startAt + '">0:00.0</span>' +
          '</div>'
        );
      });
      out.push('</div>');
    }

    out.push('<div class="tor-section tor-pad">Standings</div>');

    if (!rows.length) {
      out.push('<div class="empty">No boats yet.</div></div>');
      return out.join('');
    }

    out.push('<div class="tor-rows tor-pad">');
    rows.forEach(function (r) {
      var cls = r.pos === 1 ? 'leader' : (r.pos ? '' : 'unranked');
      out.push(
        '<div class="tor-row ' + cls + '"' + colorStyle(r.boat.color || 'transparent') + '>' +
          '<div class="tr-pos">' + (r.pos || '&ndash;') + '</div>' +
          '<div class="tr-bar">' +
            '<span class="tr-colour"></span>' +
            '<span class="tr-name">' + esc(r.boat.name) +
              (r.boat.sail ? '<span class="tr-sail">' + esc(r.boat.sail) + '</span>' : '') +
            '</span>' +
            '<span class="tr-runs">' + r.attempts + '/' + s.maxAttempts + ' runs</span>' +
            '<span class="tr-time mono">' + (r.ms != null ? fmtDur(r.ms) : '&ndash;') + '</span>' +
            '<span class="tr-gap mono">' + (r.gap != null ? '+' + fmtDur(r.gap) : '') + '</span>' +
          '</div>' +
        '</div>'
      );
    });
    out.push('</div>');

    out.push('</div>');
    return out.join('');
  }

  // -------------------------------------------------------------- TV overlays
  //
  // Transparent pages for a vMix / OBS browser source. They carry no chrome and
  // no controls, render nothing at all when there is nothing to show - an
  // overlay left permanently on air must disappear by itself rather than sit
  // there as an empty box - and take their size from query parameters so the
  // operator can fit them without touching the code.
  //
  //   ?scale=1.4     everything larger
  //   ?rows=5        cap the standings at five boats
  //   ?align=right   hug the right edge instead of the left
  //   ?title=0       drop the event-name strip

  function overlayNum(name, fallback, min, max) {
    var raw = parseFloat(PARAMS.get(name));
    if (!isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, raw));
  }

  function overlayShell(inner) {
    var cls = 'ov' +
      (PARAMS.get('align') === 'right' ? ' ov-right' : '') +
      (PARAMS.get('title') === '0' ? ' ov-notitle' : '');
    return '<div class="' + cls + '" style="--ov-scale:' +
      overlayNum('scale', 1, 0.4, 4) + '">' + inner + '</div>';
  }

  function overlayTitle(s) {
    if (PARAMS.get('title') === '0') return '';
    return '<div class="ov-head">' + esc(s.eventName || 'Race') + '</div>';
  }

  function htmlOverlayStandings(s) {
    // Every boat stays on screen, including those yet to post a time: the
    // gallery wants a stable list that does not reshuffle its own height.
    var rows = ranking(s);
    if (!rows.length) return '';

    rows = rows.slice(0, overlayNum('rows', 99, 1, 99));

    var body = rows.map(function (r) {
      var cls = r.pos === 1 ? ' leader' : (r.pos ? '' : ' unranked');
      return '<div class="ov-row' + cls + '"' +
        colorStyle(r.boat.color || 'transparent') + '>' +
          '<div class="ov-pos">' + (r.pos || '&ndash;') + '</div>' +
          '<div class="ov-bar">' +
            '<span class="ov-colour"></span>' +
            '<span class="ov-name">' + esc(r.boat.name) + '</span>' +
            '<span class="ov-runs">' + r.attempts + '/' + s.maxAttempts + ' runs</span>' +
            '<span class="ov-time mono">' + (r.ms != null ? fmtDur(r.ms) : '&ndash;') + '</span>' +
            '<span class="ov-gap mono">' + (r.gap != null ? '+' + fmtDur(r.gap) : '') + '</span>' +
          '</div>' +
        '</div>';
    }).join('');

    return overlayShell(overlayTitle(s) + '<div class="ov-rows">' + body + '</div>');
  }

  function htmlOverlayOnCourse(s) {
    var live = runningRuns(s);
    if (!live.length) return ''; // nothing on course: show nothing at all

    var body = live.map(function (r) {
      return '<div class="ov-row live"' + colorStyle(boatColor(s, r.boatId)) + '>' +
          '<div class="ov-bar">' +
            '<span class="ov-colour"></span>' +
            '<span class="ov-name">' + esc(boatLabel(s, r.boatId)) + '</span>' +
            '<span class="ov-time mono" data-live-start="' + r.startAt + '">0:00.0</span>' +
          '</div>' +
        '</div>';
    }).join('');

    return overlayShell(overlayTitle(s) + '<div class="ov-rows">' + body + '</div>');
  }

  // ============================================================== live ticker

  // Only touch the DOM when the text actually changes: with nothing on course
  // the page stops mutating entirely, which is easier on the battery.
  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  function tick() {
    var now = serverNow();
    setText(el('clock'), fmtTod(now));
    var nodes = document.querySelectorAll('[data-live-start]');
    for (var i = 0; i < nodes.length; i++) {
      setText(nodes[i], fmtDur(now - Number(nodes[i].getAttribute('data-live-start'))));
    }
  }

  setInterval(tick, 100);

  // ============================================================== interactions

  function guard() {
    var now = Date.now();
    if (now - lastTapAt < TAP_GUARD_MS) return false;
    lastTapAt = now;
    return true;
  }

  function startBoat(s, boatId, ts, force) {
    var runId = uid('run_');
    queue({ type: 'start', boatId: boatId, ts: ts, runId: runId, force: !!force });
    buzz(35);
    toast('Start · ' + boatLabel(s, boatId) + ' at ' + fmtTod(ts, true), {
      undo: function () { queue({ type: 'cancelRun', runId: runId, reason: 'mistap' }); },
    });
  }

  function onStartBoat(s, boatId) {
    var ts = capture.start != null ? capture.start : serverNow();
    var boat = boatOf(s, boatId);
    if (!boat) return;
    capture.start = null;

    var running = runningRunOf(s, boatId);
    if (running) {
      modal({
        title: boat.name + ' is already on course',
        text: 'Started at ' + fmtTod(running.startAt, true) + '. Restarting cancels that run.',
        actions: [
          { label: 'Restart from ' + fmtTod(ts, true), cls: 'primary', onClick: function () { startBoat(s, boatId, ts, true); } },
          { label: 'Keep the current run', onClick: function () { render(); } },
        ],
      });
      return;
    }

    if (attemptsLeft(s, boatId) <= 0) {
      modal({
        title: 'No attempts left',
        text: boat.name + ' has used all ' + s.maxAttempts + ' attempts.',
        actions: [
          { label: 'Start anyway', cls: 'primary', onClick: function () { startBoat(s, boatId, ts); } },
          { label: 'Cancel', onClick: function () { render(); } },
        ],
      });
      return;
    }

    startBoat(s, boatId, ts);
  }

  function onFinishRun(s, runId) {
    var run = findRun(s, runId);
    if (!run || run.status !== 'running') return;
    var ts = capture.finish != null ? capture.finish : serverNow();
    capture.finish = null;

    if (ts <= run.startAt) {
      toast('That time is before the start', { error: true });
      render();
      return;
    }

    queue({ type: 'finish', runId: runId, ts: ts });
    buzz([25, 40, 25]);
    toast(boatLabel(s, run.boatId) + ' · ' + fmtDur(ts - run.startAt), {
      undo: function () { queue({ type: 'unfinish', runId: runId }); },
    });
  }

  function openRunMenu(s, runId) {
    var run = findRun(s, runId);
    if (!run) return;
    var d = duration(run);
    var name = boatLabel(s, run.boatId);

    function nudge(field, delta) {
      var base = run[field];
      if (base == null) return;
      queue({ type: 'setRunTime', runId: runId, field: field, value: base + delta });
      setTimeout(function () { openRunMenu(derive(), runId); }, 60);
    }

    var actions = [
      { row: [
        { label: 'Start −1s', keepOpen: true, onClick: function () { nudge('startAt', -1000); } },
        { label: 'Start +1s', keepOpen: true, onClick: function () { nudge('startAt', 1000); } },
      ] },
    ];

    if (run.finishAt) {
      actions.push({ row: [
        { label: 'Finish −1s', keepOpen: true, onClick: function () { nudge('finishAt', -1000); } },
        { label: 'Finish +1s', keepOpen: true, onClick: function () { nudge('finishAt', 1000); } },
      ] });
    }

    if (run.status === 'cancelled') {
      actions.push({ label: 'Restore this run', cls: 'primary', onClick: function () { queue({ type: 'restoreRun', runId: runId }); } });
    } else {
      actions.push({ label: 'Cancel this run', onClick: function () { queue({ type: 'cancelRun', runId: runId }); } });
    }

    actions.push({ label: 'Delete permanently', cls: 'danger', onClick: function () { queue({ type: 'deleteRun', runId: runId }); } });
    actions.push({ label: 'Close', onClick: function () {} });

    modal({
      title: name + (d != null ? ' — ' + fmtDur(d) : ''),
      html: 'Start <b class="mono">' + fmtTod(run.startAt, true) + '</b>' +
        (run.finishAt ? '<br>Finish <b class="mono">' + fmtTod(run.finishAt, true) + '</b>' : '<br>Still on course') +
        '<br><br>Nudge a time if the tap was late or early.',
      actions: actions,
    });
  }

  function swatchesHtml(selected) {
    return '<div class="swatches">' + PALETTE.map(function (c) {
      return '<button class="swatch' + (c === selected ? ' sel' : '') +
        '" data-color="' + c + '" style="--c:' + c + '"></button>';
    }).join('') + '</div>';
  }

  function editBoat(s, boatId) {
    var boat = boatOf(s, boatId);
    if (!boat) return;
    var chosen = boat.color || PALETTE[0];

    modal({
      title: 'Edit ' + boat.name,
      html: '<input type="text" id="mName" value="' + esc(boat.name) + '" placeholder="Name">' +
        '<input type="text" id="mSail" value="' + esc(boat.sail || '') +
        '" placeholder="Sail number" style="margin-top:8px">' +
        '<div style="margin-top:14px;font-size:12px;font-weight:700;letter-spacing:.6px;' +
        'text-transform:uppercase;color:var(--txt-faint)">Colour</div>' +
        swatchesHtml(chosen),
      actions: [
        { label: 'Save', cls: 'primary', onClick: function () {
          var n = el('mName');
          var sl = el('mSail');
          queue({
            type: 'updateBoat',
            boatId: boatId,
            name: n ? n.value : boat.name,
            sail: sl ? sl.value : '',
            color: chosen,
          });
        } },
        { label: 'Remove boat and its runs', cls: 'danger', onClick: function () {
          queue({ type: 'removeBoat', boatId: boatId });
        } },
        { label: 'Cancel', onClick: function () {} },
      ],
    });

    // The palette lives inside the modal body, so wire it once the modal is up.
    modalNode.querySelectorAll('.swatch').forEach(function (sw) {
      sw.addEventListener('click', function () {
        chosen = sw.getAttribute('data-color');
        modalNode.querySelectorAll('.swatch').forEach(function (o) { o.classList.remove('sel'); });
        sw.classList.add('sel');
      });
    });
  }

  function exportCsv(s) {
    var rows = ranking(s);

    // Truncate like fmtDur does, so the numeric column never disagrees with
    // the displayed time (24.95 s reads 0:24.9, not 25,0).
    function secs(ms) {
      return ms == null ? '' : (Math.floor(ms / 100) / 10).toFixed(1).replace('.', ',');
    }

    var lines = [];
    lines.push([s.eventName, new Date().toLocaleString()].join(';'));
    lines.push('');
    lines.push('Rank;Boat;Sail;Colour;Best time;Best (s);2nd best;Timed runs;Attempts used;Gap to leader');
    rows.forEach(function (r) {
      lines.push([
        r.pos || '',
        r.boat.name,
        r.boat.sail || '',
        r.boat.color || '',
        r.ms != null ? fmtDur(r.ms) : '',
        secs(r.ms),
        r.second != null ? fmtDur(r.second) : '',
        r.finished,
        r.attempts + '/' + s.maxAttempts,
        r.gap != null ? '+' + fmtDur(r.gap) : '',
      ].join(';'));
    });

    lines.push('');
    lines.push('Boat;Sail;Attempt;Start;Finish;Duration;Duration (s);Status');
    s.boats.forEach(function (b) {
      runsOfBoat(s, b.id)
        .sort(function (x, y) { return x.startAt - y.startAt; })
        .forEach(function (r, i) {
          var d = duration(r);
          lines.push([
            b.name, b.sail || '', i + 1,
            fmtTod(r.startAt, true),
            r.finishAt ? fmtTod(r.finishAt, true) : '',
            d != null ? fmtDur(d) : '',
            secs(d),
            r.status,
          ].join(';'));
        });
    });

    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (s.eventName || 'results').replace(/[^\w\- ]+/g, '') + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  document.addEventListener('click', function (e) {
    // The scoreboard and the overlays carry no controls at all: belt and
    // braces alongside the server-side rule that only the password can write.
    if (READ_ONLY) return;

    var navBtn = e.target.closest('nav button');
    if (navBtn) return setView(navBtn.getAttribute('data-view'));

    var node = e.target.closest('[data-act]');
    if (!node) return;
    var act = node.getAttribute('data-act');
    var s = derive();
    if (!s) return;

    switch (act) {
      case 'mark-start':
        capture.start = serverNow();
        buzz(35);
        render();
        break;

      case 'mark-finish':
        capture.finish = serverNow();
        buzz(35);
        render();
        break;

      case 'clear-capture':
        capture[node.getAttribute('data-line')] = null;
        render();
        break;

      case 'start-boat':
        if (!guard()) return;
        onStartBoat(s, node.getAttribute('data-boat'));
        break;

      case 'finish-run':
        if (!guard()) return;
        onFinishRun(s, node.getAttribute('data-run'));
        break;

      case 'cancel-start':
        queue({ type: 'cancelRun', runId: node.getAttribute('data-run'), reason: 'mistap' });
        break;

      case 'undo-finish':
        queue({ type: 'unfinish', runId: node.getAttribute('data-run') });
        toast('Back on course');
        break;

      case 'run-menu':
        openRunMenu(s, node.getAttribute('data-run'));
        break;

      case 'export':
        exportCsv(s);
        break;

      case 'save-settings': {
        var name = el('inEvent').value;
        var att = el('inAttempts').value;
        queue({ type: 'settings', eventName: name, maxAttempts: att });
        toast('Settings saved');
        break;
      }

      case 'add-boat': {
        var input = el('inBoat');
        var sailInput = el('inSail');
        var raw = (input.value || '').trim();
        if (!raw) return;
        var sail = sailInput.value || '';
        var names = raw.split(/[,\n;]+/).map(function (x) { return x.trim(); }).filter(Boolean);
        // Clear before queueing: queue() re-renders and replaces these inputs.
        input.value = '';
        sailInput.value = '';
        queue(names.map(function (n) {
          return { type: 'addBoat', name: n, sail: names.length === 1 ? sail : '' };
        }));
        toast(names.length + ' boat' + (names.length > 1 ? 's' : '') + ' added');
        break;
      }

      case 'move-boat':
        queue({ type: 'moveBoat', boatId: node.getAttribute('data-boat'), direction: node.getAttribute('data-dir') });
        break;

      case 'edit-boat':
        editBoat(s, node.getAttribute('data-boat'));
        break;

      case 'reset-runs':
        modal({
          title: 'Clear all runs?',
          text: 'Every recorded time is erased. Boats are kept. This cannot be undone from the app.',
          actions: [
            { label: 'Yes, clear everything', cls: 'danger', onClick: function () { queue({ type: 'resetRuns' }); } },
            { label: 'Cancel', onClick: function () {} },
          ],
        });
        break;

      case 'resync':
        syncClock(7).then(function () { toast('Clock synced'); render(); });
        break;
    }
  });

  // ============================================================== screen wake lock

  var wakeLock = null;

  function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (!wakeLock) keepAwake();
    syncClock(3);  // a phone that slept may have drifted
    flush();
  });

  // ============================================================== boot

  function boot() {
    loadOutbox();

    var params = new URLSearchParams(location.search);
    var wanted = params.get('post') || params.get('view');
    var stored = null;
    try { stored = localStorage.getItem(LS_VIEW); } catch (e) {}
    var initial = OVERLAY ? 'overlay' : BOARD_MODE ? 'board' : (wanted || stored || 'start');
    if (!views[initial]) initial = 'start';

    if (BOARD_MODE) document.body.classList.add('board-mode');
    if (OVERLAY) {
      document.body.classList.add('overlay-mode', 'ov-' + OVERLAY);
      document.documentElement.classList.add('overlay-mode');
    }

    fetch(api('api/state'), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) { server = s; setConnected(true); render(); })
      .catch(function () { setConnected(false); });

    syncClock(6).then(function () { render(); });
    setInterval(function () { syncClock(3); }, 120000);

    openStream();
    setView(initial);

    window.addEventListener('online', function () { flush(); syncClock(3); });
    document.addEventListener('click', keepAwake, { once: true });

    if (outbox.length) flush();
  }

  boot();
})();
