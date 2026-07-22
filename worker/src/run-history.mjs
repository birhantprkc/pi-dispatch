import * as nodeFs from "node:fs";
import { basename, join } from "node:path";

/**
 * Durable per-run history.
 *
 * The PURE HELPERS are total functions over their arguments -- no filesystem, no clock, no
 * `process.env`, no randomness -- so the record shape and the filename/telemetry parsing are testable
 * without a container, a queue, or a disk: `sanitizeJobId`, `parseExitTurns`, `buildRecord`.
 *
 * The I/O factories -- `makeLogSink`, `makeRecordWriter`, `makeLogReaper` -- each inject their own `fs`
 * (and, for the reaper, their own clock via `now`), so they too are testable with a fake and no disk.
 * `makeLogSink` streams a job's raw output to a per-job `.log` and recovers the turn count from a
 * bounded tail; `makeRecordWriter` serialises a finished run to a JSON sidecar; `makeLogReaper` sweeps
 * aged `.log`/`.json` files at boot.
 */

/**
 * Turn an arbitrary job id into a single legal filename segment.
 *
 * BullMQ scheduled ids are `repeat:<schedulerId>:<millis>`; a colon is an illegal NTFS filename
 * character, so writing `<id>.json` verbatim throws on Windows. A strict allowlist (letters, digits,
 * dot, underscore, hyphen) is the safe subset across Windows and POSIX; everything else collapses to
 * `_`. A nullish or empty id yields a fixed sentinel so a downstream writer still produces a file
 * rather than silently dropping the record.
 */
export function sanitizeJobId(id) {
	if (id === null || id === undefined) return "unknown-job";
	const s = String(id);
	if (s === "") return "unknown-job";
	return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Recover the agent's turn count from buffered container stdout, or `null` if it is not reported.
 *
 * The stream interleaves docker/agent noise and other JSON events (`pi_auto_retry`) with the runner's
 * own lines. Only the success exit line carries `turns` (`image/runner/run-job.mjs:108`); the
 * catch-path exit line (`:122`) omits it. Scan from the end and return the turns of the last `exit`
 * event that reports an integer count.
 *
 * This is read-only telemetry: it MUST NEVER throw and MUST NOT feed exit-code or retry
 * classification -- that is the container exit code's job (INT-RUNNER-EXIT-CODE-PROTOCOL). Every parse
 * is guarded; a truncated or non-JSON line is skipped.
 */
export function parseExitTurns(text) {
	if (typeof text !== "string") return null;
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line === "") continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // docker/agent noise or a truncated final line
		}
		if (parsed?.event !== "exit") continue;
		return Number.isInteger(parsed?.turns) ? parsed.turns : null;
	}
	return null;
}

/**
 * Recover the agent's token usage from buffered container stdout, or `null` if it is not reported.
 *
 * Mirrors `parseExitTurns`: scan from the end for the last `exit` event and read its `tokens` object
 * (`{ input, output, total, cost }`). Only the success exit line carries it
 * (`image/runner/run-job.mjs`); the catch-path exit line omits it, and a container that died before the
 * runner's exit line yields none -- all three cases are `null`.
 *
 * Read-only telemetry, exactly like `parseExitTurns`: NEVER throws and MUST NOT feed exit-code or retry
 * classification (INT-RUNNER-EXIT-CODE-PROTOCOL). A malformed or non-object `tokens` (or one missing a
 * numeric `total`) is `null`, never a partial that could poison the daily token counter.
 */
export function parseExitTokens(text) {
	if (typeof text !== "string") return null;
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line === "") continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // docker/agent noise or a truncated final line
		}
		if (parsed?.event !== "exit") continue;
		const t = parsed?.tokens;
		if (t && typeof t === "object" && !Array.isArray(t) && typeof t.total === "number") return t;
		return null;
	}
	return null;
}

/**
 * Build the durable run record from the full BullMQ job wrapper and the run's outcome.
 *
 * The record is id-only by construction: an EXPLICIT object literal that reads exactly the stable,
 * non-PII fields and never spreads `job.data`, `result`, or `error`. Per `no-pii-in-logs` and
 * `REQ-LOCAL-JOB-VISIBILITY`, a GitHub job's `title`/`body` and a local job's `task` and full `folder`
 * path stay out of the record -- for local jobs only the folder's `basename` is kept, because the full
 * path embeds the operator's OS account name.
 *
 * `reason` is a fixed enum passthrough (worker-abort | over-budget | unprotected-branch |
 * runner-policy | ...), never free-form or payload text. `exitCode`, `turns`, and `budgetReserved`
 * default to `null` when the outcome does not carry them, so the record shape is stable whether or not
 * the source reports those fields.
 */
export function buildRecord({ job, result, error, startedAt, endedAt }) {
	const data = job.data ?? {};
	const kind = data.kind ?? job.name;
	const source = result ?? error ?? {};
	return {
		jobId: job.id,
		kind: kind ?? null,
		target: targetFor(kind, data),
		flow: data.flow ?? null,
		startedAt: startedAt ?? null,
		endedAt: endedAt ?? null,
		outcome: result ? (result.outcome ?? null) : "failed",
		reason: source.reason ?? null,
		exitCode: source.exitCode ?? null,
		turns: source.turns ?? null,
		// Token accounting (INT-RUN-HISTORY-FILE-CONTRACT): additive and nullable, an explicit literal, no
		// spread. The runner's per-job usage totals `{ input, output, total, cost }`, or null when the
		// container died before the exit line. PII-free -- integer token counts and numeric cost only.
		tokens: source.tokens ?? null,
		budgetReserved: source.budgetReserved ?? null,
		attempt: job.attemptsMade ?? 0,
		// Chain telemetry (INT-RUN-HISTORY-FILE-CONTRACT): additive and nullable, explicit literals, no spread.
		// parentJobId/chainDepth come from a chained child's own job.data; chainRefused counts a PARENT's
		// /outbox requests that were refused. A chain refusal is pre-enqueue of the child, so the `reason` enum
		// stays untouched -- chainRefused is a separate int count, never a terminal reason.
		parentJobId: data.parentJobId ?? null,
		chainDepth: data.chainDepth ?? null,
		chainRefused: source.chainRefused ?? null,
	};
}

/**
 * A stable, non-PII target label. GitHub jobs read `repo#issue`; local jobs read `local:<basename>` --
 * basename only, so the full folder path (which on Windows carries the OS account name) never lands in
 * the record.
 */
function targetFor(kind, data) {
	if (kind === "github") return `${data.repo}#${data.issueNumber}`;
	if (kind === "local") return `local:${basename(data.folder ?? "")}`;
	return null;
}

/** Retain only the last ~8KB of container output for turn recovery, so per-job memory stays flat. */
const TAIL_CAP_BYTES = 8 * 1024;

/**
 * The durable log sink: the I/O layer that streams a job's raw container output to a per-job `.log`
 * file and recovers the turn count from a bounded tail of that same output.
 *
 * Fault isolation is the contract, not a nicety. This sits on the money path -- `write` is a stdout
 * `data` listener (run-container.mjs:52) and `close` runs at teardown -- so a throw or an unbounded
 * await here corrupts the run outcome or turns a finished job into a 30-minute timeout
 * (CONST-RETRY-INFRA-ONLY). Therefore `write` and `close` NEVER throw and `close` NEVER hangs: every
 * body is try/catch-swallowed and the flush is a bounded race. This mirrors the "NEVER throws" posture
 * of `makeReaper` and the comment adapter in `start.mjs`.
 *
 * The raw `.log` is written ONLY when `enabled`: raw container output is user-authored data, so it is
 * opt-in per `no-pii-in-logs`. When disabled, no file is opened, but the bounded tail still accumulates
 * so `close` can still report the turn count. The path stays host-side and never reaches the container.
 *
 * Memory is flat regardless of job length: the tail keeps only the last `TAIL_CAP_BYTES`, so a 200-turn
 * job does not accumulate megabytes (REQ-QUEUE-BURST-NO-DROP). The filename runs through `sanitizeJobId`
 * because scheduled ids carry a colon, illegal on NTFS. `fs` is injectable so the sink is testable with
 * a fake writable and no disk.
 */
export function makeLogSink({ logsDir, enabled, fs = nodeFs, log = () => {} }) {
	try {
		fs.mkdirSync(logsDir, { recursive: true });
	} catch (err) {
		log("logs_dir_error", { reason: err?.message });
	}

	return function openJobLog(jobId) {
		let tail = "";
		let stream = null;

		function write(chunk) {
			try {
				tail += typeof chunk === "string" ? chunk : chunk.toString("utf8");
				if (tail.length > TAIL_CAP_BYTES) tail = tail.slice(tail.length - TAIL_CAP_BYTES);
				if (!enabled) return;
				if (stream === null) {
					stream = fs.createWriteStream(join(logsDir, `${sanitizeJobId(jobId)}.log`), { flags: "a" });
					// Attach before the first write so an EPIPE/ENOSPC/EACCES surfaces as a log line rather
					// than an unhandled 'error' that kills the worker.
					stream.on("error", (e) => log("log_sink_error", { jobId, reason: e?.message }));
				}
				stream.write(chunk);
			} catch (err) {
				log("log_sink_error", { jobId, reason: err?.message });
			}
		}

		async function close({ timeoutMs = 2000 } = {}) {
			// Capture turns and tokens from the tail first, so they survive even if the flush errors or times out.
			const turns = parseExitTurns(tail);
			const tokens = parseExitTokens(tail);
			try {
				if (stream !== null) {
					const s = stream;
					s.end();
					let timer;
					const timeout = new Promise((resolve) => {
						timer = setTimeout(resolve, timeoutMs);
					});
					try {
						// Bounded race: resolve on flush completion, on stream error, or on the deadline --
						// whichever is first. An unbounded finish-await would turn a completed job into a timeout.
						await Promise.race([
							new Promise((resolve) => s.once("finish", resolve)),
							new Promise((resolve) => s.once("error", resolve)),
							timeout,
						]);
					} finally {
						clearTimeout(timer);
					}
				}
			} catch (err) {
				log("log_sink_error", { jobId, reason: err?.message });
			}
			return { turns, tokens };
		}

		return { write, close };
	};
}

/**
 * The durable record writer: serialises a finished run's `buildRecord` output to a per-job JSON sidecar.
 *
 * Fault isolation is the contract. The processor wrapper calls `writeRecord` on the money path, so a
 * throw here corrupts a run outcome or turns a finished job into a retry (CONST-RETRY-INFRA-ONLY).
 * Therefore construction and `writeRecord` NEVER throw: the whole write body is try/catch-swallowed,
 * mirroring `makeLogSink`.
 *
 * The write is SYNCHRONOUS by design: it must complete before `process.exit(0)` on shutdown
 * (`index.mjs:83`), and an async write loses that race. `fs.writeFileSync` truncates by default, so a
 * re-run of the same job id overwrites -- last write wins.
 *
 * The failure log carries only `jobId` and `reason`; never the record object or its serialized JSON,
 * which embed target/flow fields (`no-pii-in-logs`). `sanitizeJobId` is applied only at the filename
 * boundary; the record body keeps the raw id. `fs` is injectable so the writer is testable with a fake
 * and no disk.
 */
export function makeRecordWriter({ logsDir, fs = nodeFs, log = () => {} }) {
	try {
		fs.mkdirSync(logsDir, { recursive: true });
	} catch (err) {
		log("logs_dir_error", { reason: err?.message });
	}

	return function writeRecord(record) {
		try {
			// Custom: flat JSON sidecar per job over a DB/logging lib -- records are immutable, filename-keyed
			// by jobId, no cross-record queries; DES-RUN-HISTORY-FLAT-FILES-NO-DB; specs/interfaces.md:11
			// (there is deliberately no database).
			const path = join(logsDir, `${sanitizeJobId(record.jobId)}.json`);
			const data = `${JSON.stringify(record)}\n`;
			fs.writeFileSync(path, data);
		} catch (err) {
			log("run_record_failed", { jobId: record?.jobId, reason: err?.message });
		}
	};
}

/**
 * The durable log reaper: a boot-time sweep that deletes `.log` and `.json` history files older than
 * the retention window, keeping the logs directory bounded across restarts.
 *
 * Fault isolation is the contract, mirroring `makeReaper` in `start.mjs`: `reapLogs` NEVER throws under
 * any input. A missing logs directory on first boot (`readdirSync` ENOENT), an unreadable entry, or an
 * unlink failure is caught -- logged as `log_reaper_skipped` -- and boot continues. The per-file
 * try/catch is what keeps one bad entry from aborting the whole sweep.
 *
 * `retentionDays === 0` is the documented keep-forever sentinel: the sweep returns early and touches no
 * file. Age comes from the file's `mtimeMs`, never from any date parsed out of the filename -- the
 * on-disk mtime is the authority. The `isFile()` guard skips a stray `foo.log/` directory so a
 * mis-shaped entry raises no EISDIR/EPERM. `fs` and `now` are injectable so the reaper is testable with
 * a fake and no disk.
 */
export function makeLogReaper({ logsDir, retentionDays, fs = nodeFs, log = () => {}, now = () => Date.now() }) {
	return function reapLogs() {
		if (retentionDays === 0) return; // keep-forever sentinel: no sweep
		try {
			const names = fs.readdirSync(logsDir);
			const cutoff = now() - retentionDays * 86400000;
			for (const name of names) {
				if (!name.endsWith(".log") && !name.endsWith(".json")) continue;
				try {
					const st = fs.statSync(join(logsDir, name));
					if (st.isFile() && st.mtimeMs < cutoff) {
						fs.unlinkSync(join(logsDir, name));
						log("reaped_log", { file: name });
					}
				} catch (err) {
					log("log_reaper_skipped", { file: name, reason: err?.message });
				}
			}
		} catch (err) {
			log("log_reaper_skipped", { reason: err?.message });
		}
	};
}
