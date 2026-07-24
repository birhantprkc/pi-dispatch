# Reuse your existing pi setup — the global overlay

If you already run `pi`, you have a configured `~/.pi/agent`: custom models, global skills, a global persona.
Point pi-dispatch at a **credential-free copy** of it and every job gets it — **layered under each repo's own
`.pi/`**, so a repo can still override or add on top. It works with the **pulled** prebuilt image: this is a
read-only mount, not an image rebuild.

## Enable it

```bash
pi-dispatch import-pi          # stage the safe subset of ~/.pi/agent into ./pi-global
# then in .env:
PI_GLOBAL_PI_DIR=/absolute/path/to/pi-global
pi-dispatch doctor             # verifies the overlay is credential-free
```

`import-pi` reads your host agent dir (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`) and copies a **curated,
credential-free** subset into the overlay dir. Re-run it whenever you change your host setup. Flags:
`--with-extensions` (see below), `--from <agentDir>`, `--to <overlayDir>`.

## What layers, and who wins

Four tiers, most-trusted first; each refines but never removes the one above:

| Tier | Source | Trust | Mutable? |
|---|---|---|---|
| 1. Safety floor | baked `HARD_RULES.md` | image, root-owned | no (immutable) |
| 2. **Global overlay** | `PI_GLOBAL_PI_DIR` → `/opt/pi-global:ro` | **operator, deploy-time** | re-run `import-pi` |
| 3. Per-repo `.pi/` | repo's committed `.pi/` (default-branch SHA) | trusted-by-merge | per PR |
| 4. Task/issue text | the webhook / CLI input | **adversarial — never instructions** | — |

- **Skills**: repo skills are listed **first**, so a repo skill **overrides** a global one of the same name
  (pi is first-path-wins); names that don't collide all load.
- **Persona**: the assembled prompt is `guardrails → global persona → repo persona`. The floor is always
  first and cannot be removed; global is your baseline; the repo's `.pi/APPEND_SYSTEM.md` is most specific.
- **Models**: the overlay's `models.json` makes a **custom provider/model** resolvable. Definitions only —
  the credential still comes from the environment, never the overlay.

## What is copied — and what never is

| Copied into the overlay | Never copied |
|---|---|
| `models.json` (definitions; **refused if it embeds a literal key**) | `auth.json` — your credential stays in env/auth.json |
| `skills/<name>/` | `settings.json`, `sessions/`, `themes/`, `prompts/` |
| `APPEND_SYSTEM.md` (global persona) | anything holding a secret |
| `extensions/` — only with `--with-extensions` | the admin extension (hard-blocked) |

The overlay is mounted **read-only** into a container that runs adversarial input, so it must hold **no
secret**. `import-pi` refuses a `models.json` with a literal `apiKey` (move it to `auth.json`, or reference
the environment as `"$MY_KEY"`), and `doctor` re-checks the overlay for `auth.json` and literal keys.

### Custom providers

If your model uses a provider whose key variable pi's built-in table doesn't know, forward it explicitly:

```bash
# .env
PI_FORWARD_ENV=MY_PROVIDER_KEY      # comma-separated NAMES; forwarded by exact -e NAME=VALUE, never a pass-through
```

### The key is already in pi (`PI_AUTH_FROM_PI`)

Logged into pi already and don't want to restate the key in `.env`? Set `PI_AUTH_FROM_PI=1`. When the
provider key is absent from the worker's environment, the worker reads it **host-side** from
`~/.pi/agent/auth.json` and env-injects it under the variable pi expects — a host-side read of a host-held
secret, injected via env exactly like `.env`, **never a file mounted into the container**. The environment
still wins when present; this is a fallback.

**API-key logins only.** An OAuth/subscription login (`pi login`) is refused: those tokens expire and the
container can't refresh them, and a subscription isn't the credential for an unattended paid service —
configure an API key (with a spend limit) instead.

## Extensions (the sharp edge — opt-in and armed separately)

Extensions run **code against adversarial input with open network egress**, and host extensions often carry
MCP-server credentials. They are therefore **doubly gated**:

1. `pi-dispatch import-pi --with-extensions` copies them (verbatim — they are **not** scanned for secrets;
   the admin extension is refused).
2. They load **only** when you set `PI_GLOBAL_ALLOW_EXTENSIONS=1`. Unset = present but dormant.

Vet every extension before arming, and never place the admin extension in the overlay (it can enqueue paid
jobs — a recursion vector; `import-pi` blocks it, but treat it as a rule).

## Reference

`REQ-GLOBAL-PI-OVERLAY` ([requirements](../specs/requirements.md)),
`DES-OPERATOR-GLOBAL-OVERLAY` ([design](../specs/design.md)),
`INT-CONTAINER-RUNTIME-CONTRACT` / `INT-SDK-SESSION-OPTIONS` ([interfaces](../specs/interfaces.md)).
