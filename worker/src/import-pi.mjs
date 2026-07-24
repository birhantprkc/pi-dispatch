/**
 * `pi-dispatch import-pi` — stage a CREDENTIAL-FREE copy of the host's `pi` setup into a global overlay
 * dir, so every job can reuse it (REQ-GLOBAL-PI-OVERLAY). Point `PI_GLOBAL_PI_DIR` at the result and the
 * worker mounts it `:ro` into each container, layered UNDER each repo's own `.pi/`.
 *
 * The overlay must never carry a secret (CONST-TOKEN-SCOPED-PER-JOB): the provider key stays in the host's
 * `auth.json` / env and reaches the container through the env allowlist, never a mounted file. So this
 * command copies only the safe subset and REFUSES a `models.json` that embeds a literal key.
 *
 * Copied:   models.json (definitions only, sanitized), skills/, APPEND_SYSTEM.md, and — only under
 *           --with-extensions — extensions/ (verbatim; the admin extension is hard-blocked).
 * Never:    auth.json, settings.json, sessions/, themes/, prompts/, tools/.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A valid skill/extension entry name: lowercase kebab/underscore, no dots (no "..") and no slashes. */
const ENTRY_NAME_RE = /^[a-z0-9](?:[a-z0-9_.-]{0,62}[a-z0-9])?$/i;
/** The admin extension — never duplicated into a job overlay (it can enqueue paid jobs: a recursion vector). */
const ADMIN_RE = /pi-dispatch|dispatch-admin/i;

// Resolve the host's pi agent dir the way pi's getAgentDir() does (env override, else ~/.pi/agent).
// Custom: the worker CLI depends on @earendil-works/pi-ai/compat, not the whole pi-coding-agent SDK;
// importing the SDK just to read one well-known path is not worth the weight.
function defaultFrom(env) {
	return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** A config value that defers to the environment/a command rather than embedding a literal secret. */
function isIndirection(v) {
	return typeof v === "string" && (v.startsWith("$") || v.startsWith("!"));
}

/**
 * Find a literal secret in a parsed models.json. Returns a human-readable location, or null if clean.
 * A provider `apiKey`, or an auth-ish header, that is a plain string (not `$ENV` / `!cmd`) is a literal.
 */
export function findLiteralSecret(models) {
	const providers = models?.providers;
	if (!providers || typeof providers !== "object") return null;
	for (const [name, cfg] of Object.entries(providers)) {
		if (typeof cfg?.apiKey === "string" && !isIndirection(cfg.apiKey)) return `providers.${name}.apiKey`;
		const headers = cfg?.headers;
		if (headers && typeof headers === "object") {
			for (const [h, val] of Object.entries(headers)) {
				if (/auth|api[-_]?key|token|secret|bearer/i.test(h) && typeof val === "string" && !isIndirection(val)) {
					return `providers.${name}.headers.${h}`;
				}
			}
		}
	}
	return null;
}

export function runImportPi(argv = [], deps = {}) {
	const {
		env = process.env,
		cwd = process.cwd(),
		out = (s) => process.stdout.write(s),
		fs = { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync },
	} = deps;

	const withExtensions = argv.includes("--with-extensions");
	const from = flagValue(argv, "--from") ?? defaultFrom(env);
	const to = flagValue(argv, "--to") ?? join(cwd, "pi-global");

	if (!fs.existsSync(from)) {
		out(`error: no pi setup found at ${from}\n  Is pi installed and configured? Set PI_CODING_AGENT_DIR or pass --from <dir>.\n`);
		return 1;
	}

	// Pre-flight the one hard security gate BEFORE writing anything: a literal key in models.json aborts the
	// whole import so no half-overlay is produced and no secret is ever written to the overlay.
	const modelsSrc = join(from, "models.json");
	let modelsText;
	if (fs.existsSync(modelsSrc)) {
		modelsText = fs.readFileSync(modelsSrc, "utf8");
		let parsed;
		try {
			parsed = JSON.parse(modelsText);
		} catch {
			modelsText = null; // malformed: skip it with a warning rather than abort the whole import
		}
		if (parsed) {
			const leak = findLiteralSecret(parsed);
			if (leak) {
				out(
					`error: ${modelsSrc} embeds a literal secret at ${leak}.\n` +
						`  The overlay is mounted into an adversarial-input container, so it must be credential-free.\n` +
						`  Move the key to auth.json (\`pi\` login) or reference the environment (e.g. "$MY_KEY"), then re-run.\n`,
				);
				return 1;
			}
		}
	}

	const results = [];
	fs.mkdirSync(to, { recursive: true });

	// models.json — definitions only, already proven literal-secret-free above.
	if (modelsText) {
		fs.writeFileSync(join(to, "models.json"), modelsText);
		results.push(["models.json", "custom model/provider definitions (credential-free)"]);
	} else if (fs.existsSync(modelsSrc)) {
		results.push(["models.json", "SKIPPED — not valid JSON"]);
	}

	// skills/ — copy each named skill dir (SKILL.md + its files), skipping symlinks and odd names.
	const skillsCount = copyNamedDirs(fs, join(from, "skills"), join(to, "skills"), out);
	if (skillsCount > 0) results.push(["skills/", `${skillsCount} skill${skillsCount === 1 ? "" : "s"}`]);

	// APPEND_SYSTEM.md — the operator's global persona.
	if (fs.existsSync(join(from, "APPEND_SYSTEM.md"))) {
		fs.copyFileSync(join(from, "APPEND_SYSTEM.md"), join(to, "APPEND_SYSTEM.md"));
		results.push(["APPEND_SYSTEM.md", "global persona (layers under each repo's persona)"]);
	}

	// extensions/ — the sharp edge. Off unless --with-extensions; the admin extension is always blocked.
	const extSrc = join(from, "extensions");
	if (withExtensions && fs.existsSync(extSrc)) {
		const { copied, blocked } = copyExtensions(fs, extSrc, join(to, "extensions"), out);
		if (copied > 0) results.push(["extensions/", `${copied} extension${copied === 1 ? "" : "s"} — VET THESE`]);
		for (const name of blocked) out(`  blocked extension "${name}" — the admin extension must never run inside a job.\n`);
		out(
			"\n⚠ Extensions run code against adversarial input with open network egress and are NOT scanned for\n" +
				"  secrets. Review every one, then arm them with PI_GLOBAL_ALLOW_EXTENSIONS=1 (they stay dormant otherwise).\n",
		);
	} else if (fs.existsSync(extSrc)) {
		results.push(["extensions/", "skipped — re-run with --with-extensions to include (the risky part)"]);
	}

	out(`Imported the credential-free subset of ${from} → ${to}\n\n`);
	for (const [name, note] of results) out(`  ${name.padEnd(18)} ${note}\n`);
	out(`\n  (auth.json, settings.json, sessions/ are never copied — your credential stays in env/auth.json.)\n`);
	out(nextSteps(to, withExtensions));
	return 0;
}

/** Copy `<src>/<name>/**` for each valid, non-symlink child dir. Returns the count copied. */
function copyNamedDirs(fs, src, dst, out) {
	if (!fs.existsSync(src)) return 0;
	let n = 0;
	for (const name of fs.readdirSync(src)) {
		if (!ENTRY_NAME_RE.test(name)) {
			out(`  skipped "${name}" — unexpected name\n`);
			continue;
		}
		const childSrc = join(src, name);
		if (fs.statSync(childSrc).isSymbolicLink?.() || !fs.statSync(childSrc).isDirectory()) continue;
		copyTree(fs, childSrc, join(dst, name));
		n++;
	}
	return n;
}

/** Like copyNamedDirs but reports the admin extension it refuses to copy. */
function copyExtensions(fs, src, dst, out) {
	let copied = 0;
	const blocked = [];
	for (const name of fs.readdirSync(src)) {
		if (ADMIN_RE.test(name)) {
			blocked.push(name);
			continue;
		}
		if (!ENTRY_NAME_RE.test(name)) {
			out(`  skipped "${name}" — unexpected name\n`);
			continue;
		}
		const childSrc = join(src, name);
		const st = fs.statSync(childSrc);
		if (st.isSymbolicLink?.()) continue;
		if (st.isDirectory()) copyTree(fs, childSrc, join(dst, name));
		else fs.copyFileSync(childSrc, join(dst, name));
		copied++;
	}
	return { copied, blocked };
}

/** Recursively copy a directory tree, skipping symlinks (a symlink could point outside the source). */
function copyTree(fs, src, dst) {
	fs.mkdirSync(dst, { recursive: true });
	for (const entry of fs.readdirSync(src)) {
		const s = join(src, entry);
		const st = fs.statSync(s);
		if (st.isSymbolicLink?.()) continue;
		if (st.isDirectory()) copyTree(fs, s, join(dst, entry));
		else fs.copyFileSync(s, join(dst, entry));
	}
}

function flagValue(argv, flag) {
	const i = argv.indexOf(flag);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function nextSteps(to, withExtensions) {
	const ext = withExtensions
		? "  3. After vetting, set PI_GLOBAL_ALLOW_EXTENSIONS=1 in .env to load the overlay's extensions\n"
		: "";
	return `
Next:
  1. Set PI_GLOBAL_PI_DIR=${to} in .env
  2. pi-dispatch doctor        # verifies the overlay is credential-free
${ext}`;
}
