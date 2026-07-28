/**
 * `pi-dispatch doctor` — preflight the host before the first job. Prints a ✓/⚠/✗ line per prerequisite
 * with a one-line fix, and exits non-zero if any hard check fails, so it is usable in a setup script.
 *
 * Reads the handful of values it needs with config.mjs's own defaults rather than loadConfig, so it
 * runs even when GitHub auth is unset — a local-folder deployment needs none of it. Mirrors the kill
 * switch in cli.mjs, which reads only VALKEY_URL for the same reason (it must work when GitHub is
 * misconfigured). The provider key is checked for presence only and never printed (secrets-and-pii).
 *
 * GitHub auth gets two advisory (never failing) checks: the default GITHUB_AUTH_SOURCE=gh mints from the
 * operator's FULL-scope gh login, which then reaches every token-carrying job container — the opposite of
 * the App path's per-repo short-lived tokens (CONST-TOKEN-SCOPED-PER-JOB) — so doctor names the scopes it
 * carries; and gh is preflighted inside the job image, since a token that works host-side but not
 * in-container fails jobs mid-run, not at submit. Token values travel via the spawn env only, never argv.
 *
 * The staged-packages checks (REQ-GLOBAL-PI-OVERLAY, INT-TRIGGERS-FILE-CONTRACT) exist because every way
 * that feature breaks is SILENT: a trigger sets `run.packages: true`, nothing is staged, PI_PACKAGES is
 * never emitted, and the flow runs without the tools it was written for -- then exits 0. Doctor is the only
 * place that sees the staged set and its arming state at once, so it is where those become visible.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { findLiteralSecret, ADMIN_RE } from "./import-pi.mjs";
import { PACKAGES_SUBDIR, readStageManifest } from "./packages.mjs";
import { parseTriggers } from "./triggers.mjs";

const NODE_FLOOR = [22, 19]; // pi's engine floor (22.19.0)

// Which env var holds the credential for each provider. Presence is checked, value never read out.
// anthropic lists the OAuth token too because it silently takes precedence over the API key upstream.
const PROVIDER_KEYS = {
	anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
	openai: ["OPENAI_API_KEY"],
	google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
	gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

// gh login scopes that reach well past what a job should ever hold — called out by name in the fix line.
const BROAD_SCOPES = ["admin:org", "delete_repo", "workflow"];

export async function runDoctor(env = process.env, deps = {}) {
	const {
		cwd = process.cwd(),
		out = (s) => process.stdout.write(s),
		spawn = nodeSpawn,
		probeValkey = defaultProbeValkey,
		fileExists = existsSync,
		nodeVersion = process.versions.node,
	} = deps;

	const jobImage = env.PI_JOB_IMAGE ?? "pi-job:latest";
	const valkeyUrl = env.VALKEY_URL ?? "redis://127.0.0.1:6379";
	const provider = env.PI_PROVIDER ?? "anthropic";

	const checks = [];
	checks.push(nodeCheck(nodeVersion));

	checks.push({
		ok: fileExists(join(cwd, ".env")),
		warn: true, // advisory: env may be supplied by a service manager instead of a file
		label: ".env present",
		fix: "run `pi-dispatch init` to scaffold one (or supply env via your service manager)",
	});

	const dockerCode = await runCmd(spawn, "docker", ["info"]);
	checks.push({
		ok: dockerCode === 0,
		label: "Docker daemon reachable",
		fix: dockerCode === null ? "install Docker — `docker` was not found on PATH" : "start Docker (the daemon is not responding)",
	});

	// Only meaningful if docker itself responds; otherwise the image check is noise on top of a down daemon.
	const imageCode = dockerCode === 0 ? await runCmd(spawn, "docker", ["image", "inspect", jobImage]) : null;
	checks.push({
		ok: imageCode === 0,
		label: `Job image present (${jobImage})`,
		fix: "docker pull ghcr.io/edgehero/pi-job:latest && docker tag ghcr.io/edgehero/pi-job:latest pi-job:latest  (or build image/Dockerfile)",
	});

	// The default source `gh` mints job tokens from the operator's gh login, so the FULL-scope login token
	// reaches every token-carrying job container — the opposite of the App path's per-repo short-lived
	// tokens (CONST-TOKEN-SCOPED-PER-JOB). Both checks below warn, never fail: a local-only deployment with
	// the default source is valid, for the same reason the worker's own auth at start is best-effort.
	const ghSource = env.GITHUB_AUTH_SOURCE ?? "gh"; // config.mjs's own default, read directly — no loadConfig
	if (ghSource === "gh") {
		// gh writes `auth status` to stdout or stderr depending on version — capture both combined.
		const status = await runCmdCapture(spawn, "gh", ["auth", "status"]);
		if (status.code === 0) {
			const scopes = parseGhTokenScopes(status.output);
			const broad = (scopes ?? []).filter((s) => BROAD_SCOPES.includes(s));
			checks.push({
				ok: false,
				warn: true,
				label: `GITHUB_AUTH_SOURCE=gh forwards your full gh login into every token-carrying job container (${
					scopes ? `scopes: ${scopes.join(", ")}` : "scopes not reported (fine-grained token)"
				})`,
				fix:
					(broad.length > 0 ? `this token carries broad scopes (${broad.join(", ")}) -- ` : "") +
					"use a fine-grained PAT (GITHUB_AUTH_SOURCE=pat) or a GitHub App for per-job scoping -- see SECURITY.md",
			});
		} else {
			checks.push({
				ok: false,
				warn: true,
				label: "GITHUB_AUTH_SOURCE is gh but `gh auth status` failed",
				fix: "run `gh auth login` (or switch GITHUB_AUTH_SOURCE) -- github jobs and run.github cron triggers will refuse to run",
			});
		}
	}

	// Preflight gh INSIDE the job image: a token that works host-side but not in-container (no egress from
	// containers, stale image) fails jobs mid-run, not at submit. Only meaningful when docker and the image
	// are green; otherwise it is noise on top of the failures already reported above.
	if (dockerCode === 0 && imageCode === 0) {
		if (ghSource === "app") {
			checks.push({ ok: true, label: "in-image gh auth: skipped (GITHUB_AUTH_SOURCE=app mints per-job)" });
		} else {
			let token = "";
			if (ghSource === "gh") {
				const minted = await runCmdCapture(spawn, "gh", ["auth", "token"]);
				if (minted.code === 0) token = minted.output.trim();
				// mint failed → skip: the status check above already warned that gh auth is broken
			} else if (ghSource === "pat") {
				const patVar = env.GITHUB_PAT_VAR ?? "GITHUB_PAT"; // config.mjs's patVar default, read directly
				token = (env[patVar] ?? "").trim(); // absent → skip; loadConfig fails loud at worker boot anyway
			}
			if (token) {
				// Value-less `-e` flags: docker forwards GH_TOKEN/GITHUB_TOKEN from the spawn env, so the
				// token value never enters argv (visible in `ps`) and never reaches doctor's output.
				const probe = await runCmdCapture(
					spawn,
					"docker",
					["run", "--rm", "-e", "GH_TOKEN", "-e", "GITHUB_TOKEN", "--entrypoint", "gh", jobImage, "auth", "status"],
					{ env: { ...env, GH_TOKEN: token, GITHUB_TOKEN: token } },
				);
				checks.push({
					ok: probe.code === 0,
					warn: true,
					label:
						probe.code === 0
							? `gh authenticates inside the job image (${jobImage})`
							: `gh cannot authenticate inside the job image (${jobImage})`,
					fix: "check network egress from containers or rebuild/pull the job image -- jobs that use gh will fail mid-run",
				});
			}
		}
	}

	checks.push({
		ok: await probeValkey(valkeyUrl),
		label: `Valkey reachable (${valkeyUrl})`,
		fix: "docker compose -f deploy/docker-compose.yml up -d",
	});

	const keys = PROVIDER_KEYS[provider] ?? [`${provider.toUpperCase()}_API_KEY`];
	let keyOk = keys.some((k) => (env[k] ?? "").trim().length > 0);
	let keyNote = "";
	// The key may come from pi's auth.json when the env has none (ON by default; PI_AUTH_FROM_PI=0 forces
	// env-only) — so don't falsely report it missing.
	const authFromPi = env.PI_AUTH_FROM_PI !== "0";
	if (!keyOk && authFromPi) {
		const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
		try {
			const cred = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))?.[provider];
			if (cred?.type === "api_key" && cred.key) {
				keyOk = true;
				keyNote = " — from pi auth.json";
			} else if (cred?.type === "oauth") {
				keyNote = " — pi login is OAuth/subscription: not usable for an unattended service, configure an API key";
			}
		} catch {}
	}
	checks.push({
		ok: keyOk,
		label: `Provider key set (${provider}: ${keys.join(" or ")})${keyNote}`,
		fix: authFromPi ? `run \`pi login\` with an API key for ${provider}, or set ${keys[0]} in .env` : `set ${keys[0]} in .env`,
	});

	// Counted once: it drives the ARMED/dormant pair inside the overlay block AND the two "armed but nothing
	// to load" checks -- one for a staged-package-less overlay, one for no overlay at all.
	const armedTriggers = countPackageTriggers(env, fileExists);

	// Global pi overlay (REQ-GLOBAL-PI-OVERLAY), only when configured. The overlay is mounted :ro into an
	// adversarial-input container, so the load-bearing checks are that it holds NO credential.
	const overlay = env.PI_GLOBAL_PI_DIR;
	if (overlay) {
		const dirOk = fileExists(overlay);
		checks.push({ ok: dirOk, label: `Global overlay dir exists (${overlay})`, fix: "run `pi-dispatch import-pi`, or fix PI_GLOBAL_PI_DIR" });
		if (dirOk) {
			checks.push({
				ok: !fileExists(join(overlay, "auth.json")),
				label: "Overlay is credential-free (no auth.json)",
				fix: "delete auth.json from the overlay — the provider key belongs in env, never a mounted file",
			});
			const modelsPath = join(overlay, "models.json");
			let modelsOk = true;
			let modelsFix = "";
			if (fileExists(modelsPath)) {
				try {
					const leak = findLiteralSecret(JSON.parse(readFileSync(modelsPath, "utf8")));
					if (leak) {
						modelsOk = false;
						modelsFix = `literal secret at ${leak} — move it to env/auth.json or a "$VAR" reference`;
					}
				} catch {
					modelsOk = false;
					modelsFix = "overlay models.json is not valid JSON";
				}
			}
			checks.push({ ok: modelsOk, label: "Overlay models.json is credential-free", fix: modelsFix });
			if (fileExists(join(overlay, "extensions"))) {
				if (env.PI_GLOBAL_ALLOW_EXTENSIONS === "1") {
					checks.push({
						ok: false,
						warn: true,
						label: "Overlay extensions present and ARMED (PI_GLOBAL_ALLOW_EXTENSIONS=1)",
						fix: "they run code against adversarial input with open egress — vet each; never the admin extension",
					});
				} else {
					checks.push({ ok: true, label: "Overlay extensions present but dormant (PI_GLOBAL_ALLOW_EXTENSIONS unset)" });
				}
			}

			// Staged pi packages (REQ-GLOBAL-PI-OVERLAY): pinned third-party code the operator staged with
			// `import-pi --with-packages`, armed per trigger with `run.packages: true`. Keyed on the dir the
			// same way the extensions pair above is, so a deployment that stages none prints nothing here.
			const packagesDir = join(overlay, PACKAGES_SUBDIR);
			if (fileExists(packagesDir)) {
				const manifest = readStageManifest({ globalPiDir: overlay, readFile: (p) => readFileSync(p, "utf8"), fileExists });
				if (!manifest) {
					checks.push({
						ok: false,
						label: `Staged packages manifest readable (${PACKAGES_SUBDIR}/packages.json)`,
						fix: "re-run `pi-dispatch import-pi --with-packages` -- without the manifest nothing knows what is staged, so no package is ever loaded",
					});
				} else {
					// A manifest entry whose dir is gone loads nothing, and pi reports no error for a package
					// it was never told about -- the stage is only as real as the dirs behind the names.
					const missing = manifest.packages.filter((p) => !fileExists(join(packagesDir, p.dir))).map((p) => p.name);
					checks.push({
						ok: missing.length === 0,
						label: `Staged packages present (${manifest.packages.map((p) => `${p.name}@${p.version}`).join(", ")})`,
						fix: `staged dir missing for ${missing.join(", ")} -- re-run \`pi-dispatch import-pi --with-packages\` to restage`,
					});
					// The admin extension's twin, and blocked for the same reason import-pi blocks that one.
					const admin = manifest.packages.filter((p) => ADMIN_RE.test(p.name) || ADMIN_RE.test(p.dir)).map((p) => p.name);
					if (admin.length > 0) {
						checks.push({
							ok: false,
							label: `Staged package looks like the dispatch admin (${admin.join(", ")})`,
							fix: "remove it from the overlay -- a package that can enqueue paid jobs from INSIDE a job container is a recursion vector",
						});
					}
				}
				if (armedTriggers > 0) {
					checks.push({
						ok: false,
						warn: true,
						label: `Staged packages ARMED on ${armedTriggers} trigger(s) (run.packages: true)`,
						fix: "they run third-party code against adversarial input with open egress -- vet each, and keep every version exactly pinned",
					});
				} else {
					checks.push({ ok: true, label: "Staged packages present but dormant (no trigger sets run.packages: true)" });
				}
			} else if (armedTriggers > 0) {
				// The silently-package-less job: the flag is set, nothing is staged, PI_PACKAGES is never
				// emitted, and the flow runs WITHOUT the tools it was written for -- on a clean exit 0.
				checks.push({
					ok: false,
					label: `${armedTriggers} trigger(s) set run.packages: true but nothing is staged in ${packagesDir}`,
					fix: "declare them in pi-packages.json and run `pi-dispatch import-pi --with-packages`, or drop run.packages from the trigger -- otherwise the flow runs without its tools and still exits 0",
				});
			}
		}
	} else if (armedTriggers > 0) {
		// Same silent failure one level up: the staged set lives INSIDE the overlay, so no overlay means the
		// packages are not mounted at all, however carefully they were staged.
		checks.push({
			ok: false,
			label: `${armedTriggers} trigger(s) set run.packages: true but PI_GLOBAL_PI_DIR is unset`,
			fix: "set PI_GLOBAL_PI_DIR -- staged packages live inside the overlay and are mounted with it, so with no overlay there is nothing to load",
		});
	}

	let failed = false;
	for (const c of checks) {
		out(`${c.ok ? "✓" : c.warn ? "⚠" : "✗"} ${c.label}\n`);
		if (!c.ok) {
			out(`    → ${c.fix}\n`);
			if (!c.warn) failed = true;
		}
	}
	out(failed ? "\ndoctor: some checks failed — fix the above, then re-run.\n" : "\ndoctor: ready. Start the worker with `pi-dispatch worker`.\n");
	return failed ? 1 : 0;
}

function nodeCheck(version) {
	const [maj, min] = version.split(".").map((n) => Number.parseInt(n, 10));
	const ok = maj > NODE_FLOOR[0] || (maj === NODE_FLOOR[0] && min >= NODE_FLOOR[1]);
	return {
		ok,
		label: `Node ≥ ${NODE_FLOOR[0]}.${NODE_FLOOR[1]} (have ${version})`,
		fix: `upgrade Node to ${NODE_FLOOR[0]}.${NODE_FLOOR[1]} or newer`,
	};
}

/**
 * How many triggers arm the staged packages (`run.packages: true`, INT-TRIGGERS-FILE-CONTRACT)? Parsed with
 * the SHARED `parseTriggers`, so doctor counts exactly the entries the worker and receiver will act on --
 * a truthy `"true"` string is rejected there and therefore never counted as armed here.
 *
 * Swallows ANY error to 0 -- a missing, unreadable, or malformed triggers file already fails LOUD at worker
 * boot (config.mjs, schedules.mjs), so re-reporting the parse failure here would only bury doctor's own
 * findings under a second copy of a diagnosis the operator already gets.
 */
function countPackageTriggers(env, fileExists) {
	try {
		const path = env.PI_TRIGGERS_FILE; // config.mjs's own default is null -- unset means no triggers at all
		if (!path || !fileExists(path)) return 0;
		return parseTriggers(readFileSync(path, "utf8"), path).filter((t) => t.run.packages === true).length;
	} catch {
		return 0;
	}
}

/** Resolve a spawned command's exit code; null means it could not be launched (e.g. not on PATH). */
function runCmd(spawn, cmd, args) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { stdio: "ignore" });
		} catch {
			resolve(null);
			return;
		}
		child.on("error", () => resolve(null)); // ENOENT etc. — the binary is not available
		child.on("close", (code) => resolve(code));
	});
}

/**
 * Like runCmd but collects stdout+stderr into one combined string — gh moves its human output between
 * the two across versions, so callers get both. Resolves `{code, output}`; `code: null` when the command
 * could not be launched or overran the timeout (default 30s, so a hung docker daemon cannot stall doctor).
 * `opts.env` is passed through to the spawn so secrets can travel via env instead of argv.
 */
function runCmdCapture(spawn, cmd, args, opts = {}) {
	const { timeoutMs = 30000 } = opts;
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...(opts.env ? { env: opts.env } : {}) });
		} catch {
			resolve({ code: null, output: "" });
			return;
		}
		let output = "";
		let done = false;
		const finish = (code) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ code, output });
		};
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {}
			finish(null);
		}, timeoutMs);
		child.stdout?.on("data", (d) => (output += d));
		child.stderr?.on("data", (d) => (output += d));
		child.on("error", () => finish(null)); // ENOENT etc. — the binary is not available
		child.on("close", (code) => finish(code));
	});
}

/**
 * Pull the scope list out of `gh auth status` output. The line reads like
 * `  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'` (older gh omits the quotes). Returns null
 * when the line is absent — fine-grained tokens report no classic scopes at all.
 */
function parseGhTokenScopes(output) {
	const m = output.match(/Token scopes:\s*(.+)/);
	if (!m) return null;
	return m[1]
		.split(",")
		.map((s) => s.trim().replace(/^'(.*)'$/, "$1"))
		.filter((s) => s.length > 0);
}

/**
 * Reachability probe with a raw, fail-fast ioredis client. `lazyConnect` holds the connect until the
 * error handler is attached, so a down Valkey is reported as one ✗ line — not the ioredis stack traces
 * a BullMQ Queue's internal client would dump. Reuses `parseConnection`'s fail-fast options (cli.mjs:88).
 */
async function defaultProbeValkey(url) {
	const { Redis } = await import("ioredis");
	const { parseConnection } = await import("./connection.mjs");
	const client = new Redis({ ...parseConnection(url, { failFast: true }), lazyConnect: true });
	client.on("error", () => {}); // swallow connect errors + retries; reachability is the ✓/✗, not a trace
	try {
		await client.connect();
		await client.ping();
		return true;
	} catch {
		return false;
	} finally {
		client.disconnect();
	}
}
