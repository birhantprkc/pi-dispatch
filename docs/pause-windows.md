# Quiet hours — scoped pause windows

Pause a **specific folder or repo's** runs *between certain times* — recurring daily, restricted to certain
weekdays or a date range, in a timezone of your choice — and resume automatically after. A paused job is
**deferred, never dropped**: it waits in the queue and runs once the window ends.

This is distinct from the global pause (`pi-dispatch pause` / `/dispatch` `p`), which stops the **whole**
queue with no schedule. Scoped pause windows are per-scope and timed, and the two compose — a scope can be
inside a pause window while the rest of the queue keeps draining.

## Enable it

Point `PI_PAUSE_WINDOWS_FILE` at a JSON file. Unset = the feature is off.

```bash
# .env
PI_PAUSE_WINDOWS_FILE=/absolute/path/to/pause-windows.json
```

```json
{
  "windows": [
    { "scope": "acme/web", "from": "22:00", "to": "06:00", "tz": "Europe/Amsterdam" }
  ]
}
```

The worker validates the file at boot (a malformed file **refuses startup**, fail-loud) and **live-reloads**
it on change — an edit takes effect on the next job without a restart, and a bad edit keeps the last-good
windows. The `deploy/pause-windows.json` in this repo is an empty template (`{ "windows": [] }`).

## The window schema

| Field | Required | Meaning |
|---|---|---|
| `scope` | **yes** | What the window applies to: a **repo** `"owner/name"` (github jobs), a **folder** host path (local/cron jobs), or `"*"` for **all** scopes. Matched exactly. |
| `from` | **yes** | Pause **start**, `"HH:MM"` 24-hour. |
| `to` | **yes** | Resume time, `"HH:MM"` 24-hour. If `from > to` the window is **overnight** (spans midnight). `from == to` is rejected — a 24h pause isn't expressible; remove the trigger instead. |
| `tz` | no (default `UTC`) | IANA timezone, e.g. `"Europe/Amsterdam"`, `"America/New_York"`. `from`/`to` are that zone's wall clock, DST-correct. |
| `days` | no (default: every day) | Weekday allow-list, e.g. `["mon","tue","wed","thu","fri"]`. Gates the day the window **starts** — an overnight window that starts on an allowed day still runs into the next morning. |
| `dateFrom` | no | Inclusive `"YYYY-MM-DD"`: the window applies only on/after this **start** date. |
| `dateTo` | no | Inclusive `"YYYY-MM-DD"`: only on/before this start date. |

## Examples

**Daytime freeze (same-day window)** — pause a repo 09:00–17:00 UTC:
```json
{ "scope": "acme/web", "from": "09:00", "to": "17:00" }
```

**Overnight quiet hours** — pause a folder every night 22:00 → 06:00 in Amsterdam time (`from > to` = overnight):
```json
{ "scope": "/srv/site", "from": "22:00", "to": "06:00", "tz": "Europe/Amsterdam" }
```

**Weeknights only** — the overnight window, but only when it *starts* on a weekday:
```json
{ "scope": "acme/web", "from": "22:00", "to": "06:00", "tz": "Europe/Amsterdam",
  "days": ["mon","tue","wed","thu","fri"] }
```

**A change-freeze between dates** — no runs for `acme/api`, all day, across a release window:
```json
{ "scope": "acme/api", "from": "00:00", "to": "23:59", "dateFrom": "2026-08-10", "dateTo": "2026-08-14" }
```

**Everything, on weekends** — pause all scopes on Saturday/Sunday nights:
```json
{ "scope": "*", "from": "20:00", "to": "08:00", "days": ["sat","sun"] }
```

**Multiple windows** — they're independent; a job is paused if it falls inside *any* matching window, and held until the latest one ends:
```json
{ "windows": [
  { "scope": "acme/web", "from": "22:00", "to": "06:00", "tz": "Europe/Amsterdam" },
  { "scope": "/srv/site", "from": "09:00", "to": "17:00" }
] }
```

## How it works

- **Deferred, not dropped.** When a job is picked up and its scope is inside an active window, the worker moves
  it to the queue's **delayed** set until the window ends (via BullMQ's `moveToDelayed`), then it runs
  automatically. It keeps its identity (so GitHub delivery-GUID dedup still holds) and survives a worker restart.
- **Zero cost while paused.** The check runs **before** the budget reservation, so a deferred job reserves no
  spend slot and counts nothing against your daily/weekly/monthly caps — a deferral is not a job start.
- **Timezone-correct.** Wall-clock times are resolved in the window's `tz` using the runtime's built-in
  timezone data (DST-correct), with no extra dependency.

## Managing windows

Three equivalent ways — all write the same validated file and take effect live:

1. **Edit the file.** Change `pause-windows.json`; the worker hot-reloads it (keeps the last-good set on a bad edit).
2. **In the panel.** Open `/dispatch`, press `w` → add or delete a window through operator dialogs. The
   **PAUSES** section shows each window as `●` paused (with a resume countdown) or `○` open.
3. **From an agent, human-gated.** The model tools `dispatch_pause_add` / `dispatch_pause_delete` (and the
   read-only `dispatch_pauses`) let an agent manage windows — but each write **pops an operator confirmation
   the model can't answer**, and is refused when no operator is present.

## Caveats

- A window edited or removed **while a job is already delayed** doesn't re-time that job — it wakes at its
  original window-end and the gate re-checks then. (You can also promote delayed jobs manually via the queue.)
- `from == to` is rejected on purpose. To pause a scope indefinitely, remove its trigger rather than express a
  24-hour window.

## Reference

The internal specs: `REQ-SCOPED-PAUSE-WINDOWS` ([requirements](../specs/requirements.md)),
`DES-SCOPED-PAUSE-VIA-MOVE-TO-DELAYED` ([design](../specs/design.md)),
`INT-PAUSE-WINDOWS-FILE-CONTRACT` ([interfaces](../specs/interfaces.md)).
