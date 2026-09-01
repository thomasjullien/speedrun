# Scoreboard logos

Drop the two official logo files here, named exactly:

- `imoca.svg`        - shown on the left of the scoreboard
- `ocean-race.svg`   - shown on the right

`.png` also works: rename the file to `imoca.png` / `ocean-race.png` and change
the two `src` attributes in `htmlBoard()` in `public/app.js`.

**Use the white / reversed versions.** The scoreboard is on a dark background,
so a logo in black artwork is invisible. Most brand kits ship a "reversed" or
"white" variant for exactly this.

A missing file is not an error: the `onerror` handler removes the image and the
header simply centres itself. So the board works before the logos arrive.

Sizing is handled by CSS (`.board-logo`): 46 px tall on a desktop or TV screen,
32 px on a phone, aspect ratio preserved. Any reasonably sized file will do.

These are third-party trademarks - make sure the event is entitled to display
them.
