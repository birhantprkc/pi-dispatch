/**
 * Single-key, never-clobber edits to a dotenv-style file.
 *
 * Exists for `pi-dispatch up`, which fills WEBHOOK_SECRET into a scaffolded .env without asking the
 * operator to hand-run `openssl rand -hex 32`; the github setup flow (PR 6) will reuse it for the same
 * reason. It is init's contract applied to a single key instead of a whole file: init never overwrites
 * an existing file, and this never overwrites an existing VALUE — a key the operator already set is
 * sacrosanct, because a tool that "helpfully" rotates a live webhook secret breaks every configured
 * forge hook at once, silently. When the key is already set the input text is returned UNCHANGED
 * (byte-identical), so callers can compare identity to know nothing happened.
 *
 * Deliberately dependency-free (node:fs only, and only in the thin wrapper): it must stay importable
 * from any future setup command without dragging worker config or queue deps along.
 */
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

/**
 * Pure transform over .env TEXT: set `key` to `value` only where nothing is set yet.
 *
 *   - `KEY=` (empty value, whitespace-only counts)      → that line becomes `KEY=value`, in place
 *   - no set line, but a commented `# KEY=…` line       → the comment becomes `KEY=value`, in place
 *   - no KEY line at all                                → `KEY=value` appended at the end
 *   - `KEY=something` (any non-empty value, anywhere)   → text returned UNCHANGED
 *
 * Every other byte is preserved: lines are only ever replaced whole, CRLF endings survive on the
 * replaced line, and the untouched remainder is never re-serialized. Ambiguity resolves to "do not
 * touch" — a value like `KEY= # tbd` trims to a non-empty string and therefore counts as set, because
 * the cost of wrongly leaving a key alone (operator sets it by hand) is a fraction of the cost of
 * wrongly overwriting one.
 */
export function setEnvKeyIfEmpty(text, key, value) {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const setRe = new RegExp(`^\\s*${escaped}\\s*=(.*)$`);
	const commentRe = new RegExp(`^\\s*#\\s*${escaped}\\s*=`);

	const lines = text.split("\n");
	// Replace a line wholesale, keeping a CRLF file's trailing \r so the file stays one convention.
	const replaceLine = (i) => {
		lines[i] = `${key}=${value}${lines[i].endsWith("\r") ? "\r" : ""}`;
		return lines.join("\n");
	};

	// Pass 1: set lines. ANY non-empty value anywhere means the key is set — return the input text
	// itself (not a copy) so callers can detect "unchanged" by identity. Otherwise remember the FIRST
	// empty set line; a later commented duplicate must not win over it.
	let firstEmpty = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
		const m = line.match(setRe);
		if (!m) continue;
		if (m[1].trim() !== "") return text;
		if (firstEmpty === -1) firstEmpty = i;
	}
	if (firstEmpty !== -1) return replaceLine(firstEmpty);

	// Pass 2: a commented-out `# KEY=` line (only reachable when no set line exists at all).
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
		if (commentRe.test(line)) return replaceLine(i);
	}

	// Pass 3: no trace of the key — append at the end, on its own line.
	const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
	return `${base}${key}=${value}\n`;
}

/**
 * Read → setEnvKeyIfEmpty → write back ATOMICALLY (tmp + rename, the same shape as the admin's
 * writeTriggers), so a watcher or a concurrent reader never sees a half-written .env. When the
 * transform is a no-op the file is not touched at all — no tmp, no rename, no mtime churn — and
 * `{ changed: false }` is returned so callers can say so.
 *
 * Mode: a .env at 0o600 (an operator who locked their secrets down) stays 0o600 — chmod on the tmp
 * BEFORE the rename, so no window exists where the secret-bearing file is wider than it was. Any
 * other mode is left to the platform default; this helper preserves a hardening choice, it does not
 * impose one.
 */
export function updateEnvFile(path, key, value, deps = {}) {
	const { fs = { readFileSync, writeFileSync, renameSync, statSync, chmodSync } } = deps;
	const text = fs.readFileSync(path, "utf8");
	const next = setEnvKeyIfEmpty(text, key, value);
	if (next === text) return { changed: false };
	const tmp = `${path}.tmp`;
	fs.writeFileSync(tmp, next);
	try {
		if ((fs.statSync(path).mode & 0o777) === 0o600) fs.chmodSync(tmp, 0o600);
	} catch {
		// The file vanished between read and write, or the fs cannot stat: leave the tmp's default
		// mode rather than failing an edit that is otherwise sound.
	}
	fs.renameSync(tmp, path);
	return { changed: true };
}
