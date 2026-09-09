# Race Timer

Timing boats between a start line and a finish line, when the two lines are
manned by **two different people on two different phones**.

Each boat starts when it wants, gets a limited number of attempts, and is ranked
on its best run.

- **Start post** — tap a boat as it crosses the start line.
- **Finish post** — the boats currently on course are listed with their running
  clock; tap the one that crosses.
- **Results** — best run per boat, gap to the leader, every run, CSV export.
  Boats level on their best run are separated by their second best, then their
  third, and so on; a boat with no further time to offer loses the tie-break,
  which also puts boats with no time at all at the bottom. When a tie-break
  decided the order, the row says so, and the CSV carries the second best.
- **Setup** — boats (name, sail number, colour), attempts per boat.

No app to install: it is a web page. Open it on a phone and, if you like, add it
to the home screen to get it full screen.

## Why it holds up with two separate posts

**One shared state, pushed live.** The server owns the truth and streams every
change to both posts over Server-Sent Events. The moment the start line taps a
boat, it appears on the finish line's screen.

**Both phones are put on the same clock.** Two devices are never exactly in
sync, and a 2-second drift would poison every result. Each phone measures its
own offset against the server the way NTP does — several probes, keep the one
with the lowest round trip — and every timestamp is expressed in server time.
The current offset is shown at the bottom of the Setup screen.

**A tap is never lost or distorted.** The time is taken *on the device at the
instant of the tap*, so network latency changes nothing. If the connection
drops, taps queue up locally (the badge in the header shows how many are
waiting) and sync by themselves when it comes back — each one carries an id, so
a replay can never double-count. Every action is also appended to
`data/events.jsonl`, which is never rewritten.

**MARK START / MARK FINISH.** A boat crosses the line before you have worked out
which one it is. The big button freezes the time immediately; you pick the boat
afterwards, with no penalty on the recorded time.

## The scoreboard

`/board` is a read-only display for a spectator screen: a navy band carrying the
logos, the event name set large in red, the boats currently on course with their
running clocks, and the standings. No app chrome, no navigation, no control of
any kind. The look follows The Ocean Race scoreboard - white ground, navy
blocks, red reserved for the leader, heavy uppercase type.

It is built for a television. Row height comes from a single `--row-h` variable
derived from how many rows there are to show, and every type size is a fraction
of it, so a fleet of six and a fleet of fourteen both fill one screen without
scrolling. Verified from 7 to 14 rows at 1600x900.

Read-only is enforced by the server, not just hidden in the page. With
`PUBLIC_BOARD=1`, exactly these are readable without the password:

    /board   /app.js   /style.css   /logos/*   /api/state   /api/stream   /api/time

Everything else still demands it, and **`POST /api/action` always does** — so a
spectator with the link can watch the race but cannot alter a single time. Leave
`PUBLIC_BOARD` unset to keep the board behind the password like the rest.

Logos live in `public/logos/` — see the README there.

## TV overlays

Two transparent pages, meant to be dropped into vMix or OBS as a browser source
and left running. No integration work for the gallery: they paste a URL.

    /overlay-standings    the ranking
    /overlay-oncourse     the boats running right now, with live clocks

Both are transparent (the root element too, or the source composites an opaque
rectangle), carry no chrome and no controls, and never show a scrollbar. Text
always sits on an opaque bar rather than straight on the video, which is the
difference between legible and not over moving water.

**They render nothing at all when there is nothing to show**, so the source can
stay on air permanently: the on-course overlay is invisible between runs and
reappears by itself the moment the start line taps a boat - no reload, no cue.

Query parameters, so the operator can fit them without touching the code:

| Parameter    | Effect                                        |
| ------------ | --------------------------------------------- |
| `?scale=1.4` | everything larger (0.4 to 4)                  |
| `?rows=5`    | cap the standings at five boats               |
| `?align=right` | hug the right edge instead of the left      |
| `?title=0`   | drop the event-name strip                     |

They sit behind the same `PUBLIC_BOARD` switch as the scoreboard: readable
without the password when it is on, and writes are refused either way.

Note the URLs are one path segment deep on purpose. The page loads `app.js` and
`style.css` by relative URL, so a nested `/overlay/standings` would resolve them
against the wrong folder and the page would silently stay blank.

## Running it locally

```bash
node server.js
```

Then open `http://localhost:8080`. The console also prints the LAN address to
use from a phone on the same Wi-Fi. Data is written to `./data/`.

Useful URLs — bookmark one per post:

| Screen     | URL               |
| ---------- | ----------------- |
| Start      | `/?post=start`    |
| Finish     | `/?post=finish`   |
| Results    | `/?post=results`  |
| Scoreboard | `/board`          |

## Deploying (Dokploy)

Production runs on a Hostinger VPS managed by Dokploy, behind Traefik, at
`https://imoca.tech/speedrun/`. Dokploy builds this repo and Traefik terminates
TLS and routes the sub-path.

Dokploy application settings:

| Setting        | Value                                    |
| -------------- | ---------------------------------------- |
| Source         | this GitHub repo, branch `main`          |
| Domain host    | `imoca.tech`                             |
| Domain path    | `/speedrun`                              |
| Strip Path     | off (the server handles the prefix)      |
| Container Port | `8090`                                   |
| Volume         | mount on `/app/data`                     |

Environment:

```bash
PORT=8090
BASE_PATH=/speedrun
AUTH_USER=timing
AUTH_PASS=...
PUBLIC_BOARD=1        # optional: opens /speedrun/board without the password
```

The prefix is handled defensively: the server strips `BASE_PATH` when it is
present and serves the plain path when the proxy already removed it, so it works
whether or not Strip Path is on.

**The volume is the one setting that cannot be fixed after the fact** — without
it, a redeploy wipes every recorded time. The startup banner in the logs
confirms it:

```
Data dir    : /app/data
Persistence : ok
```

`Persistence : BROKEN` means the directory is mounted but not writable.

Deploying an update is a `git push` followed by Redeploy in Dokploy.

## On the day

1. **Setup** — add the boats, give each a colour, set the number of attempts.
2. Open `/speedrun/?post=start` on the start-line phone,
   `/speedrun/?post=finish` on the finish-line phone.
3. Check the header badge says **SYNCED** on both.
4. Time the runs. Results update live on any third screen.
5. Show `/speedrun/board` on any spare screen for the competitors.
6. **Export CSV** at the end.

Times are recorded and displayed to a tenth of a second, which matches what a
finger on a screen can actually resolve. A run can be corrected afterwards from
**Results** (the `⋮` button on any run): nudge the start or finish by a second,
cancel a run so it no longer counts, or delete it.

## Layout

```
server.js            Node server, no dependencies: state, live stream, API
public/index.html    Page shell
public/app.js        The whole UI: clock sync, offline queue, five screens
public/style.css     Mobile-first dark theme
public/logos/        Scoreboard logos (see the README there)
data/state.json      Current state (written atomically)
data/events.jsonl    Append-only log of every action ever received
deploy/              systemd unit + nginx snippet (only for a host without Dokploy)
```
