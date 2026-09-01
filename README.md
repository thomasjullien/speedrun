# Race Timer

Timing boats between a start line and a finish line, when the two lines are
manned by **two different people on two different phones**.

Each boat starts when it wants, gets a limited number of attempts, and is ranked
on its best run.

- **Start post** — tap a boat as it crosses the start line.
- **Finish post** — the boats currently on course are listed with their running
  clock; tap the one that crosses.
- **Results** — best run per boat, gap to the leader, every run, CSV export.
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

## Running it locally

```bash
node server.js
```

Then open `http://localhost:8080`. The console also prints the LAN address to
use from a phone on the same Wi-Fi. Data is written to `./data/`.

Useful URLs — bookmark one per post:

| Post   | URL                  |
| ------ | -------------------- |
| Start  | `/?post=start`       |
| Finish | `/?post=finish`      |
| Results| `/?post=results`     |

## Deploying to the VPS (www.imoca.tech/speedrun)

The app is path-agnostic: it uses relative URLs, so it runs under any sub-path
as long as it is reached with a trailing slash (the nginx snippet handles that).

```bash
# from this folder
scp -r server.js package.json public deploy root@VPS:/opt/race-timer/
ssh root@VPS 'bash /opt/race-timer/deploy/install.sh'
```

Then add the two blocks from `deploy/nginx-speedrun.conf` to the existing
`www.imoca.tech` server block and reload nginx:

```bash
nginx -t && systemctl reload nginx
```

The service listens on `127.0.0.1:8090` only — nginx is the only way in, and the
page is set to `noindex, nofollow` so it stays out of search engines.

The snippet enables HTTP basic auth, so create the password file **before**
reloading nginx or it will refuse to start:

```bash
apt-get install -y apache2-utils
htpasswd -c /etc/nginx/.htpasswd-speedrun timing
```

Both posts then sign in once with the same `timing` account. Once entered, the
browser keeps sending the credentials, including on the live stream — nothing
re-prompts mid-race. On iOS, adding the page to the home screen may ask for it
once more the first time it opens.

Updating later:

```bash
scp -r server.js public root@VPS:/opt/race-timer/
ssh root@VPS 'systemctl restart race-timer'
```

State survives the restart (`/opt/race-timer/data/state.json`).

## On the day

1. **Setup** — add the boats, give each a colour, set the number of attempts.
2. Open `/speedrun/?post=start` on the start-line phone,
   `/speedrun/?post=finish` on the finish-line phone.
3. Check the header badge says **SYNCED** on both.
4. Time the runs. Results update live on any third screen.
5. **Export CSV** at the end.

Times are recorded and displayed to a tenth of a second, which matches what a
finger on a screen can actually resolve. A run can be corrected afterwards from
**Results** (the `⋮` button on any run): nudge the start or finish by a second,
cancel a run so it no longer counts, or delete it.

## Layout

```
server.js            Node server, no dependencies: state, live stream, API
public/index.html    Page shell
public/app.js        The whole UI: clock sync, offline queue, four screens
public/style.css     Mobile-first dark theme
data/state.json      Current state (written atomically)
data/events.jsonl    Append-only log of every action ever received
deploy/              systemd unit, nginx snippet, install script
```
