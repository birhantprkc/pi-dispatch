# Recording the demo (GIF / video)

The `/dispatch` panel is the hook — a short recording of it is worth more than any paragraph. This is the
recipe; it needs a real terminal, so it's yours to run (the panel can't be driven headless). Two options:
[`vhs`](https://github.com/charmbracelet/vhs) (scripted, reproducible, best for a clean GIF) or
[`asciinema`](https://asciinema.org) + [`agg`](https://github.com/asciinema/agg) (records a real session).

## What to show (≈ 20–30s)

1. `pi -e admin/src/index.ts` then `/dispatch` — the live panel: status header, spend meters, triggers,
   pause windows, runs.
2. `↵` on a trigger → the MATCHES / RUNS / TRUST MODEL drill-in.
3. `↵` on a run → the colored post-mortem.
4. (optional) `w` → add a pause window; watch the PAUSES row flip to `● paused · resumes in …`.
5. `q` to close.

Run against a deployment with a little state (a couple of triggers, a finished run or two) so the panel isn't
empty — start the stack (`docker compose -f deploy/docker-compose.yml up -d`), queue one local job, let it
finish, then record.

## Option A — vhs (recommended for a crisp GIF)

`brew install vhs` (or see its README). Save as `docs/demo.tape`:

```tape
# docs/demo.tape
Output docs/images/dispatch-demo.gif
Set FontSize 15
Set Width 1200
Set Height 760
Set Theme "Dracula"
Set Padding 16

Hide
Type "pi -e admin/src/index.ts"  Enter
Sleep 3s
Show

Type "/dispatch"  Enter
Sleep 3s
Down Sleep 500ms   Enter  Sleep 3s   Escape Sleep 1s   # a trigger drill-in
Down Down Down Down Down Down  Enter  Sleep 3s  Escape Sleep 1s   # a run post-mortem
Type "q"
Sleep 1s
```

Then: `vhs docs/demo.tape` → produces `docs/images/dispatch-demo.gif`.

## Option B — asciinema + agg (records a real session)

```bash
asciinema rec docs/dispatch-demo.cast --cols 120 --rows 40
#   ... do the walkthrough above, then exit the shell (Ctrl-D) ...
agg --font-size 15 --theme dracula docs/dispatch-demo.cast docs/images/dispatch-demo.gif
```

An `.cast` file can also be uploaded to asciinema.org and embedded (autoplaying) in the README.

## Where the output goes

- **README**: add the GIF near the top, under the existing SVG panel images.
- **Social preview** (GitHub → Settings → General → Social preview): export a single crisp PNG frame of the
  panel — reuse `docs/images/dispatch-dashboard.svg` rendered to PNG until the GIF exists.
- **pi.dev gallery card**: set `pi.video` (a hosted `.mp4`/`.gif` URL) or `pi.image` in the extension package's
  `package.json` (see the packaging steps) so the listing shows the panel.

Keep the file small (< ~3 MB): trim to ~25s, cap width at ~1200px, and prefer the GIF for GitHub autoplay.
