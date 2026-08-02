# Cost analytics

Every run records what it spent (`docs`: run history; `specs`: `REQ-TOKEN-ACCOUNTING-AND-CAPS`). The
costs surface makes that history analyzable: what a flow costs, what a month costs per model, what a
subscription is actually saving, and what a flow *would* cost on a different model. It informs; it
changes nothing — no auto-switching, no vendor API calls, no database (`REQ-COST-ANALYTICS`,
`DES-COST-FOLD-BY-SCAN`).

## The COSTS view

Press `c` on the dashboard (`/dispatch`). The view is verdict-first:

```
┌ pi-dispatch ── COSTS · Aug 2026 (mtd) ─────────────────────────────┐
│ VERDICT  kimi-allegro is SAVING ~$41.30 est. this month            │
│   plan price (prorated) $99.00 → $3.19 · plan runs @ API ~$44.49   │
│ daily  ▁▁▂▃▂▅▇▃▂▁·▁▂▂▃█▄▂▁▁▂▃▂▁▁▂▄▃▂▁  Σ ≥$12.41 · max $3.10/d    │
│ flow             runs   tokens    cost        api-equiv            │
│ › triage           41   12.4M     ≥$8.02      $8.02                │
│   nightly-sync     28    6.1M     plan:kimi   ~$3.90 est.          │
│ plans   kimi-allegro $99/mo · 28 runs · ~$3.54/run amortized       │
│         peak 5h window: 9 runs — limit undisclosed by vendor       │
│ ~ estimates at pi-ai 0.80.7 · 3 runs not repriceable               │
│ [↑↓] row [f] flow/model [t] 7d/30d/mtd [w] what-if [esc] back      │
└────────────────────────────────────────────────────────────────────┘
```

Keys: `t` cycles the window (7d / 30d / month-to-date), `f` toggles the by-flow / by-model table,
`w` opens the what-if on the selected flow (press again to cycle candidate models; `/` type-to-filters
the full priced catalog), `Esc` backs out one layer at a time.

## How to read the numbers

Every dollar carries its class, rendered by one shared formatter — these markers are contractual
(`REQ-COST-ANALYTICS`), not decoration:

| rendering        | meaning |
|---|---|
| `$4.12`          | metered — the stream-time price pi-ai computed when the run happened |
| `≥$4.12`         | a floor — some spend was unpriced/unresolved, or the run pre-dates the meter |
| `plan:kimi`      | covered by a declared subscription — prepaid, **never shown as $0.00** |
| `$0 (unrated)`   | a zero-rate provider with **no** declared subscription — unrated, never "free" |
| `~$4.12 est.`    | an estimate (what-if, API-equivalent, or a sum containing any estimate) |
| `~~$4 seeded`    | seeded from no history — a band, never a point |
| `—`              | unknown (the container died before reporting) |

Metered numbers are pi-ai's computed prices, not invoices. The series is bounded by run-history
retention (`PI_LOG_RETENTION_DAYS`, default 30 days; the scan hard-caps at 92 days even when retention
is the keep-forever `0`), and the screen says which window it shows.

## Declaring subscriptions

Subscription-backed providers (`kimi-coding`, `zai-coding-cn`, …) ship all-zero rate tables, so their
runs record `cost: 0` — prepaid, not free. The real price can only come from you: declare each plan in
`subscriptions.json` (scaffolded by `pi-dispatch init`; see `subscriptions.example.json`;
`PI_SUBSCRIPTIONS_FILE` overrides the path). The file feeds arithmetic only — it never touches
execution, routing, or auth (`DES-SUBSCRIPTIONS-ARE-COUNTERFACTUAL-ONLY`).

- `counterfactualModel` names a *priced* pi-ai model used for the "this month at API rates" comparison —
  the verdict line. Without it the verdict honestly degrades to "no API-rate baseline declared".
- Quota `windows` take `unit`/`limit` **as far as the vendor states them** — `null` is first-class
  "undisclosed", and the screen then shows peak-usage facts instead of inventing a burn-down.
- `hypothetical: true` marks a plan you are *considering*: its verdict reads WOULD SAVE / WOULD LOSE,
  computed against what those runs actually cost you today.
- Editing the file re-classifies history retroactively — classification happens when the screen folds,
  not when the run was recorded.

## The what-if

"This flow, same token profile, on a different model." Estimates re-price the flow's *recorded*
per-model token ledgers (cache split included) through pi-ai's own `calculateCost` — tiers and the
Anthropic 1h cache-write rule come along for free — and are always marked `est.`, name the rates
version, and report coverage (runs without a ledger are excluded, never back-derived). Cross-provider
comparisons carry a caveat: same token profile, different tokenizers — directional only. A flow with no
ledgered history gets one offer: the `$0.5–$5/job` band recorded at `OQ-002`, labeled
`unmeasured (OQ-002)`.

## Without the TUI

- `/dispatch costs [7d|30d|mtd]` — the same fold, plain text, same labels.
- `/dispatch costs whatif <provider>/<model> [--flow <flow>]` — scripting-friendly what-if; unknown
  models get closest-match suggestions (this is the full-catalog path).
- The `dispatch_costs` tool returns the fold as JSON in which **every monetary value carries its
  `class`** — a model reading it can no more launder an estimate into a fact than the screen can.

## Environment

| variable | default | effect |
|---|---|---|
| `PI_SUBSCRIPTIONS_FILE` | `./deploy/subscriptions.json` | where the admin reads plan declarations |
| `PI_DISPATCH_ASCII` | unset | `1` = ASCII glyphs (frames, meters, sparkline ramp) for glyph-hostile terminals |
| `PI_LOG_RETENTION_DAYS` | `30` | bounds the analyzable history (`0` = keep forever; scan still caps at 92 days) |

## Honest limits

- Totals are **floors**: a `pi` subprocess spawned by a staged package is unmetered (`OQ-011`), and a
  retried job's sidecar keeps only the last attempt's spend.
- Runs recorded before the per-model ledger landed cannot be re-priced; they are counted and named in
  the provenance line, never guessed at.
- Rates provenance is pinned: each ledgered run remembers the pi-ai version that priced it, and a later
  pin bump shows up as "priced under older rates" — history is never silently repriced.
