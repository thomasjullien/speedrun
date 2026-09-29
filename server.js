'use strict';
/**
 * Race Timer - single dependency-free Node server.
 *
 *  - serves the web UI (public/)
 *  - owns the authoritative state (boats, runs)
 *  - pushes every change live to all connected posts via SSE
 *  - exposes /api/time so each phone can correct its own clock drift
 *
 * The start line and the finish line are manned by two different people on two
 * different phones, so timestamps are taken on the device at the moment of the
 * tap and expressed in server time. Network latency never affects a result.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;

/**
 * Reads a non-secret setting. Deployment UIs often hand the value over still
 * wrapped in the quotes the user typed, so strip those and surrounding space.
 * Not used for passwords, where a quote could be a real character.
 */
function setting(name) {
  return String(process.env[name] || '').trim().replace(/^["']|["']$/g, '').trim();
}

// Sub-path the app is published under, e.g. BASE_PATH=/speedrun.
// Normalised to '' or '/xxx' (no trailing slash).
const BASE_PATH = (function () {
  const raw = setting('BASE_PATH').replace(/^\/+|\/+$/g, '');
  return raw ? '/' + raw : '';
})();

// Optional shared password. Unset (the default) leaves the app open.
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';

// Optional token for the TV data feed (/api/live, /api/live/stream). When set,
// the feed demands it - as ?token=... or 'Authorization: Bearer ...' - and
// PUBLIC_BOARD no longer opens it. The operators' password still works too.
const LIVE_TOKEN = process.env.LIVE_TOKEN || '';

// When on, the scoreboard at /board is readable without the password.
// Only reads are ever exempt - recording a time always needs the password.
const PUBLIC_BOARD = /^(1|true|yes|on|open|public)$/i.test(setting('PUBLIC_BOARD'));

// The exact GET routes the scoreboard and the broadcast overlays need, and
// nothing more.
const BOARD_ROUTES = {
  '/board': 1, '/board/': 1,
  '/overlay-standings': 1, '/overlay-standings/': 1,
  '/overlay-oncourse': 1, '/overlay-oncourse/': 1,
  '/style.css': 1, '/app.js': 1,
  '/api/state': 1, '/api/stream': 1, '/api/time': 1,
};

const LIVE_ROUTES = { '/api/live': 1, '/api/live/stream': 1 };

// Pages that are the app itself in another guise, all served from index.html.
// Deliberately one path segment deep: the page loads app.js and style.css by
// relative URL, so a nested path would resolve them against the wrong folder.
const PAGE_ROUTES = ['/board', '/overlay-standings', '/overlay-oncourse'];

function isPublicBoardRequest(req, p) {
  if (!PUBLIC_BOARD || req.method !== 'GET') return false;
  // The data feed is open with the board unless it has a token of its own.
  if (LIVE_ROUTES[p] === 1) return !LIVE_TOKEN;
  // The logos the scoreboard displays have to load too.
  return BOARD_ROUTES[p] === 1 || p.indexOf('/logos/') === 0;
}
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_FILE = path.join(DATA_DIR, 'events.jsonl');

// Beyond this gap between a client timestamp and server time, the client clock
// is considered nonsense and the server substitutes its own time.
const MAX_CLOCK_DRIFT_MS = 12 * 3600 * 1000;

// ---------------------------------------------------------------- state

function defaultState() {
  return {
    eventName: 'Race day',
    maxAttempts: 3,
    boats: [],
    runs: [],
    rev: 0,
    updatedAt: Date.now(),
  };
}

let state = defaultState();
const processedActions = new Map(); // actionId -> receivedAt, for idempotency

/**
 * Confirms the data directory is actually writable. Without a mounted volume a
 * container starts fine and only loses everything on the next deploy, so say so
 * loudly at boot rather than let it be discovered mid-race.
 */
function checkDataDir() {
  const probe = path.join(DATA_DIR, '.write-test');
  try {
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    return true;
  } catch (err) {
    console.error('');
    console.error('  !! CANNOT WRITE TO ' + DATA_DIR + ' (' + err.code + ')');
    console.error('  !! Times will not be saved. Mount a writable volume there.');
    console.error('');
    return false;
  }
}

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = Object.assign(defaultState(), parsed);
    console.log('State restored: ' + state.boats.length + ' boat(s), ' + state.runs.length + ' run(s).');
  } catch (err) {
    const backup = STATE_FILE + '.corrupt-' + Date.now();
    fs.copyFileSync(STATE_FILE, backup);
    console.error('state.json unreadable, copied to ' + backup + ' - starting empty.');
  }
}

let saveTimer = null;
function saveState() {
  state.rev += 1;
  state.updatedAt = Date.now();
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE); // atomic: a crash mid-write cannot corrupt the state
  }, 120);
}

// Append-only audit trail: even if state.json were lost, every tap is on disk.
function logEvent(entry) {
  fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', function () {});
}

// ---------------------------------------------------------------- live push (SSE)

const clients = new Set();

function broadcast() {
  const payload = 'data: ' + JSON.stringify(state) + '\n\n';
  for (const res of clients) {
    try { res.write(payload); } catch (e) { clients.delete(res); }
  }
}

setInterval(function () {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); }
  }
  for (const res of liveClients) {
    try { res.write(': ping\n\n'); } catch (e) { liveClients.delete(res); }
  }
}, 20000).unref();

// ---------------------------------------------------------------- helpers

let idCounter = 0;
function uid(prefix) {
  idCounter += 1;
  return prefix + '_' + Date.now().toString(36) + '_' + idCounter.toString(36);
}

function sanitizeTs(ts) {
  const now = Date.now();
  const n = Number(ts);
  if (!Number.isFinite(n)) return now;
  if (Math.abs(n - now) > MAX_CLOCK_DRIFT_MS) return now;
  return Math.round(n);
}

function boatById(id) {
  return state.boats.find(function (b) { return b.id === id; }) || null;
}

// Boat colours: picked to stay distinguishable on a phone screen in daylight.
const PALETTE = [
  '#ef4444', '#38bdf8', '#fbbf24', '#22c55e', '#d946ef', '#f97316',
  '#14b8a6', '#a78bfa', '#ec4899', '#84cc16', '#3b82f6', '#e2e8f0',
];

function sanitizeColor(value, fallbackIndex) {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  return PALETTE[fallbackIndex % PALETTE.length];
}

function runningRunOfBoat(boatId) {
  return state.runs.find(function (r) { return r.boatId === boatId && r.status === 'running'; }) || null;
}

// ---------------------------------------------------------------- actions

/**
 * Every mutation goes through here. Each action carries a client-generated id,
 * so replaying a queued action after a network drop can never double-count it.
 *
 * That makes `action.id` reserved: it is the de-duplication key and nothing
 * else. Payload identifiers get their own field (`boatId`, `runId`), or two
 * edits to the same boat would share a key and the second would be dropped.
 */
function applyAction(action) {
  const type = action && action.type;
  const ts = sanitizeTs(action && action.ts);

  switch (type) {
    case 'start': {
      const boat = boatById(action.boatId);
      if (!boat) return { error: 'Unknown boat' };
      const current = runningRunOfBoat(boat.id);
      if (current) {
        if (!action.force) {
          return { error: 'That boat is already on course', code: 'ALREADY_RUNNING', runId: current.id };
        }
        current.status = 'cancelled';
        current.cancelReason = 'restarted';
      }
      const run = {
        // The client may supply the id, so it can undo its own start even
        // before the server response has come back.
        id: typeof action.runId === 'string' && action.runId ? action.runId : uid('run'),
        boatId: boat.id,
        startAt: ts,
        finishAt: null,
        status: 'running',
        createdAt: Date.now(),
      };
      state.runs.push(run);
      return { ok: true, run: run };
    }

    case 'finish': {
      let run = action.runId ? state.runs.find(function (r) { return r.id === action.runId; }) : null;
      if (!run && action.boatId) {
        // No explicit run: finish the oldest one still on course for that boat.
        run = state.runs
          .filter(function (r) { return r.boatId === action.boatId && r.status === 'running'; })
          .sort(function (a, b) { return a.startAt - b.startAt; })[0] || null;
      }
      if (!run) return { error: 'No run on course for that boat' };
      if (run.status !== 'running') return { error: 'Run already closed' };
      if (ts <= run.startAt) return { error: 'Finish time is before the start time' };
      run.finishAt = ts;
      run.status = 'done';
      return { ok: true, run: run };
    }

    case 'unfinish': {
      const run = state.runs.find(function (r) { return r.id === action.runId; });
      if (!run) return { error: 'Unknown run' };
      run.finishAt = null;
      run.status = 'running';
      return { ok: true, run: run };
    }

    case 'cancelRun': {
      const run = state.runs.find(function (r) { return r.id === action.runId; });
      if (!run) return { error: 'Unknown run' };
      run.status = 'cancelled';
      run.cancelReason = action.reason || 'cancelled';
      return { ok: true, run: run };
    }

    case 'restoreRun': {
      const run = state.runs.find(function (r) { return r.id === action.runId; });
      if (!run) return { error: 'Unknown run' };
      run.status = run.finishAt ? 'done' : 'running';
      delete run.cancelReason;
      return { ok: true, run: run };
    }

    case 'deleteRun': {
      const i = state.runs.findIndex(function (r) { return r.id === action.runId; });
      if (i < 0) return { error: 'Unknown run' };
      state.runs.splice(i, 1);
      return { ok: true };
    }

    case 'setRunTime': {
      const run = state.runs.find(function (r) { return r.id === action.runId; });
      if (!run) return { error: 'Unknown run' };
      const field = action.field === 'finishAt' ? 'finishAt' : 'startAt';
      const value = sanitizeTs(action.value);
      if (field === 'finishAt' && run.startAt && value <= run.startAt) {
        return { error: 'Finish must come after the start' };
      }
      if (field === 'startAt' && run.finishAt && value >= run.finishAt) {
        return { error: 'Start must come before the finish' };
      }
      run[field] = value;
      run.edited = true;
      return { ok: true, run: run };
    }

    case 'addBoat': {
      const name = String(action.name || '').trim();
      if (!name) return { error: 'Empty name' };
      const boat = {
        id: uid('boat'),
        name: name,
        sail: String(action.sail || '').trim(),
        color: sanitizeColor(action.color, state.boats.length),
      };
      state.boats.push(boat);
      return { ok: true, boat: boat };
    }

    case 'updateBoat': {
      const boat = boatById(action.boatId);
      if (!boat) return { error: 'Unknown boat' };
      if (typeof action.name === 'string' && action.name.trim()) boat.name = action.name.trim();
      if (typeof action.sail === 'string') boat.sail = action.sail.trim();
      if (typeof action.color === 'string') boat.color = sanitizeColor(action.color, 0);
      return { ok: true, boat: boat };
    }

    case 'removeBoat': {
      const i = state.boats.findIndex(function (b) { return b.id === action.boatId; });
      if (i < 0) return { error: 'Unknown boat' };
      state.boats.splice(i, 1);
      state.runs = state.runs.filter(function (r) { return r.boatId !== action.boatId; });
      return { ok: true };
    }

    case 'moveBoat': {
      const i = state.boats.findIndex(function (b) { return b.id === action.boatId; });
      if (i < 0) return { error: 'Unknown boat' };
      const j = i + (action.direction === 'up' ? -1 : 1);
      if (j < 0 || j >= state.boats.length) return { ok: true };
      const moved = state.boats.splice(i, 1)[0];
      state.boats.splice(j, 0, moved);
      return { ok: true };
    }

    case 'settings': {
      if (typeof action.eventName === 'string' && action.eventName.trim()) {
        state.eventName = action.eventName.trim().slice(0, 80);
      }
      if (action.maxAttempts != null) {
        state.maxAttempts = Math.max(1, Math.min(50, Math.round(Number(action.maxAttempts) || 1)));
      }
      return { ok: true };
    }

    case 'resetRuns': {
      state.runs = [];
      return { ok: true };
    }

    default:
      return { error: 'Unknown action: ' + type };
  }
}

function handleAction(action) {
  if (action && action.id) {
    if (processedActions.has(action.id)) return { ok: true, duplicate: true };
    processedActions.set(action.id, Date.now());
    if (processedActions.size > 2000) {
      const cutoff = Date.now() - 6 * 3600 * 1000;
      for (const entry of processedActions) {
        if (entry[1] < cutoff) processedActions.delete(entry[0]);
      }
    }
  }
  const result = applyAction(action);
  if (result && result.ok) {
    logEvent({ at: Date.now(), action: action });
    saveState();
    broadcast();
    broadcastLive();
  }
  return result;
}

// ---------------------------------------------------------------- live feed (TV graphics)

/**
 * The raw data a broadcast graphics system needs, already worked out: the
 * standings, the boats on course and the last finish. Graphics tools (vMix
 * data sources, Singular, CasparCG templates...) cannot run the ranking
 * themselves, so the server does it and hands over plain fields, each time
 * both in milliseconds and as display text.
 *
 * The ranking mirrors ranking() in public/app.js - keep the two in step.
 */

function pad2(n) {
  const s = String(Math.floor(Math.abs(n)));
  return s.length < 2 ? '0' + s : s;
}

/** Duration as m:ss.t (or h:mm:ss.t past the hour), as the app shows it. */
function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const t = Math.abs(ms);
  const tenths = Math.floor(t / 100) % 10;
  const total = Math.floor(t / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const body = h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  return (ms < 0 ? '-' : '') + body + '.' + tenths;
}

/** Gap to the leader: +4.3 under a minute, +1:04.3 beyond. */
function fmtGap(ms) {
  if (ms == null) return '';
  if (ms < 60000) return '+' + Math.floor(ms / 1000) + '.' + (Math.floor(ms / 100) % 10);
  return '+' + fmtDur(ms);
}

function runDuration(r) {
  return r.status === 'done' && r.finishAt && r.startAt ? r.finishAt - r.startAt : null;
}

function boatFields(b) {
  return { boatId: b.id, name: b.name };
}

function liveFeed() {
  const now = Date.now();
  const max = state.maxAttempts;

  const rows = state.boats.map(function (b) {
    const runs = state.runs.filter(function (r) { return r.boatId === b.id; });
    const times = runs.map(runDuration)
      .filter(function (d) { return d != null; })
      .sort(function (x, y) { return x - y; });
    return {
      boat: b,
      times: times,
      used: runs.filter(function (r) { return r.status === 'done'; }).length,
      running: runs.some(function (r) { return r.status === 'running'; }),
    };
  });

  // Level on the best run: the second best decides, then the third... A boat
  // with no further time loses, which also sends boats with none to the bottom.
  rows.sort(function (a, b) {
    const n = Math.max(a.times.length, b.times.length);
    for (let i = 0; i < n; i++) {
      const x = a.times[i];
      const y = b.times[i];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (x !== y) return x - y;
    }
    return 0;
  });

  const leader = rows.length && rows[0].times.length ? rows[0].times[0] : null;
  const standings = rows.map(function (r, i) {
    const best = r.times.length ? r.times[0] : null;
    const prev = rows[i - 1];
    const next = rows[i + 1];
    const gap = best != null && leader != null && i > 0 ? best - leader : null;
    return Object.assign(boatFields(r.boat), {
      pos: best != null ? i + 1 : null,
      bestMs: best,
      best: fmtDur(best),
      gapMs: gap,
      gap: fmtGap(gap),
      tied: best != null &&
        (!!prev && prev.times[0] === best || !!next && next.times[0] === best),
      attemptsUsed: r.used,
      attemptsLeft: Math.max(0, max - r.used),
      attempts: r.used + '/' + max,
      onCourse: r.running,
      timesMs: r.times,
      times: r.times.map(fmtDur),
    });
  });

  const posOf = {};
  standings.forEach(function (s) { posOf[s.boatId] = s.pos; });

  const onCourse = state.runs
    .filter(function (r) { return r.status === 'running' && boatById(r.boatId); })
    .sort(function (a, b) { return a.startAt - b.startAt; })
    .map(function (r) {
      const b = boatById(r.boatId);
      const used = state.runs.filter(function (x) { return x.boatId === b.id && x.status === 'done'; }).length;
      // The run underway is the next attempt, not yet a used one.
      const attempt = Math.min(max, used + 1);
      const elapsed = Math.max(0, now - r.startAt);
      return Object.assign(boatFields(b), {
        runId: r.id,
        startAt: r.startAt,
        elapsedMs: elapsed,
        elapsed: fmtDur(elapsed),
        attempt: attempt,
        attemptLabel: attempt + '/' + max,
        currentPos: posOf[b.id],
      });
    });

  const last = state.runs
    .filter(function (r) { return runDuration(r) != null && boatById(r.boatId); })
    .sort(function (a, b) { return b.finishAt - a.finishAt; })[0];
  let lastFinish = null;
  if (last) {
    const b = boatById(last.boatId);
    const ms = runDuration(last);
    const row = standings.find(function (s) { return s.boatId === b.id; });
    lastFinish = Object.assign(boatFields(b), {
      runId: last.id,
      finishAt: last.finishAt,
      timeMs: ms,
      time: fmtDur(ms),
      // Whether this run is the boat's best, and where that leaves it.
      personalBest: row.bestMs === ms,
      pos: row.pos,
      // Against the current leader: 0 when this run is the new fastest.
      gapMs: ms - leader,
      gap: ms > leader ? fmtGap(ms - leader) : '',
    });
  }

  return {
    event: state.eventName,
    maxAttempts: max,
    serverTime: now,
    rev: state.rev,
    updatedAt: state.updatedAt,
    leader: standings.length && standings[0].pos ? standings[0] : null,
    standings: standings,
    onCourse: onCourse,
    lastFinish: lastFinish,
  };
}

const liveClients = new Set();

function broadcastLive() {
  if (!liveClients.size) return;
  const payload = 'data: ' + JSON.stringify(liveFeed()) + '\n\n';
  for (const res of liveClients) {
    try { res.write(payload); } catch (e) { liveClients.delete(res); }
  }
}

// While a boat is on course its running clock changes every second, so keep
// the feed ticking; between runs it only moves when something happens.
setInterval(function () {
  if (liveClients.size && state.runs.some(function (r) { return r.status === 'running'; })) {
    broadcastLive();
  }
}, 1000).unref();

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, function (err, buf) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let raw = '';
    req.on('data', function (chunk) {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', function () {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/** Constant-time compare that does not leak the length either. */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** True when the request carries the operators' Basic credentials. */
function hasBasicAuth(req) {
  const header = req.headers.authorization || '';
  if (!AUTH_USER || header.indexOf('Basic ') !== 0) return false;
  let decoded = '';
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch (e) {}
  const i = decoded.indexOf(':');
  return i > -1 && safeEqual(decoded.slice(0, i), AUTH_USER) && safeEqual(decoded.slice(i + 1), AUTH_PASS);
}

/** True when the request carries LIVE_TOKEN, in the query string or as a Bearer. */
function hasLiveToken(req, url) {
  if (!LIVE_TOKEN) return false;
  const header = req.headers.authorization || '';
  const given = header.indexOf('Bearer ') === 0 ? header.slice(7).trim() : url.searchParams.get('token');
  return given != null && safeEqual(given, LIVE_TOKEN);
}

/** Returns true when the request may proceed; answers 401 itself otherwise. */
function authorised(req, res) {
  if (!AUTH_USER || hasBasicAuth(req)) return true;
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Race Timer", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('Authentication required');
  return false;
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  let p = url.pathname;

  // The app is happy either way: some proxies strip the sub-path before
  // forwarding, others pass it through. Handle the prefix only if it is there.
  if (BASE_PATH) {
    if (p === BASE_PATH) {
      // Relative URLs in the page need the trailing slash to resolve.
      res.writeHead(301, { Location: BASE_PATH + '/' });
      return res.end();
    }
    if (p.indexOf(BASE_PATH + '/') === 0) p = p.slice(BASE_PATH.length);
  }

  // Container health probe: deliberately before the password check.
  if (p === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ok');
  }

  if (LIVE_ROUTES[p] === 1 && LIVE_TOKEN) {
    // CORS preflight: a template sending the token as a Bearer header asks first.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET',
        'Access-Control-Allow-Headers': 'Authorization',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }
    // No password dialog here: the feed is read by machines, not browsers.
    if (!hasLiveToken(req, url) && !hasBasicAuth(req)) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return sendJson(res, 401, { error: 'Missing or invalid token' });
    }
  } else if (!isPublicBoardRequest(req, p) && !authorised(req, res)) {
    // Writes always need the password, so an open scoreboard can still only read.
    return;
  }

  if (p === '/api/time') return sendJson(res, 200, { now: Date.now() });

  if (p === '/api/state') return sendJson(res, 200, state);

  if (p === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // stops nginx from buffering the stream
    });
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify(state) + '\n\n');
    clients.add(res);
    req.on('close', function () { clients.delete(res); });
    return;
  }

  // Raw feed for TV graphics. Read-only data, so any origin may fetch it
  // (a graphics page served from elsewhere, a vMix data source...).
  if (p === '/api/live') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return sendJson(res, 200, liveFeed());
  }

  if (p === '/api/live/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify(liveFeed()) + '\n\n');
    liveClients.add(res);
    req.on('close', function () { liveClients.delete(res); });
    return;
  }

  if (p === '/api/action' && req.method === 'POST') {
    return readBody(req).then(function (body) {
      const actions = Array.isArray(body.actions) ? body.actions : [body];
      const results = actions.map(handleAction);
      const firstError = results.find(function (r) { return r && r.error; });
      sendJson(res, 200, {
        results: results,
        state: state,
        error: firstError ? firstError.error : undefined,
      });
    }).catch(function (e) {
      sendJson(res, 400, { error: e.message });
    });
  }

  if (p.indexOf('/api/') === 0) return sendJson(res, 404, { error: 'Unknown endpoint' });

  // The scoreboard and the overlays are the same page in another mode. Keep a
  // single canonical URL without a trailing slash: the page resolves its API
  // calls relative to its own path, and a trailing slash would push them one
  // level too deep.
  for (let i = 0; i < PAGE_ROUTES.length; i++) {
    const route = PAGE_ROUTES[i];
    if (p === route + '/') {
      res.writeHead(301, { Location: BASE_PATH + route });
      return res.end();
    }
    if (p === route) return serveStatic(req, res, '/');
  }

  return serveStatic(req, res, p);
});

function localAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (net) {
      if (net.family === 'IPv4' && !net.internal) out.push({ name: name, address: net.address });
    });
  });
  return out;
}

loadState();
const writable = checkDataDir();
server.listen(PORT, function () {
  console.log('');
  console.log('  Race Timer - server running');
  console.log('  ------------------------------------------------');
  console.log('  On this machine : http://localhost:' + PORT);
  localAddresses().forEach(function (a) {
    console.log('  From a phone    : http://' + a.address + ':' + PORT + '   (' + a.name + ')');
  });
  console.log('  ------------------------------------------------');
  console.log('  Start post  : add ?post=start');
  console.log('  Finish post : add ?post=finish');
  if (BASE_PATH) console.log('  Sub-path    : ' + BASE_PATH + '/');
  console.log('  Password    : ' + (AUTH_USER ? 'on (user ' + AUTH_USER + ')' : 'off'));
  console.log('  Scoreboard  : ' + BASE_PATH + '/board  ' +
    (PUBLIC_BOARD ? '(open to all, read-only)' : '(password required)'));
  console.log('  TV overlays : ' + BASE_PATH + '/overlay-standings');
  console.log('                ' + BASE_PATH + '/overlay-oncourse');
  console.log('  Live feed   : ' + BASE_PATH + '/api/live  (JSON, poll)  ' +
    (LIVE_TOKEN ? '(token required)' : PUBLIC_BOARD ? '(open to all, read-only)' : '(password required)'));
  console.log('                ' + BASE_PATH + '/api/live/stream  (SSE, push)');
  // Printed as an absolute path: this is the exact path to mount a volume on.
  console.log('  Data dir    : ' + DATA_DIR + (writable ? '' : '  <-- NOT WRITABLE'));
  console.log('  Persistence : ' + (writable ? 'ok' : 'BROKEN - times will be lost'));
  console.log('  Ctrl+C to stop.');
  console.log('');
});
