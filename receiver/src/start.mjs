/**
 * The receiver entry point: an always-on, public webhook producer that resolves the harness's own
 * identity, then serves `makeReceiver` over `node:http` and enqueues onto the shared queue.
 *
 * DES-TRIGGER-OUTSIDE-PI: the trigger is a separate always-on process, outside the container and the
 * agent. It only produces jobs; it never runs pi.
 *
 * CONST-TRIGGER-AUTHOR-GATE: `selfId` is the bot-loop guard's sole input -- the filter drops any event
 * whose `sender.id` is our own. Resolving it is therefore a HARD-FAIL boot invariant: if identity does
 * not resolve, the rejection propagates and the server is NEVER created. A receiver that listened
 * without `selfId` would run the guard disarmed, and its own completion comments would re-trigger jobs
 * -- an unbounded paid recursion. The worker's auth is best-effort because it can fail a github job
 * per-job; the receiver has no such per-job fallback, so identity resolution is a boot gate.
 *
 * The receiver resolves identity ONLY. It holds no per-repo tokens: minting a scoped token is the
 * worker's job, per container, per job (CONST-TOKEN-SCOPED-PER-JOB).
 *
 * DES-ADMIN-VIA-PI-EXTENSION: this process exposes exactly one surface, the webhook handler. There is no
 * admin, dashboard, or admin-extension route here -- the admin surface is a pi extension in the
 * operator's session and binds no port.
 */

import http from "node:http";
import { watch } from "node:fs";
import { dirname, basename } from "node:path";
import { loadReceiverConfig, triggersFilePath, reloadTriggers } from "./config.mjs";
import { makeReceiver } from "./receiver.mjs";
import { makeGitHubAuth } from "@pi-dispatch/worker/get-token";
import { resolveGitLabSelfId } from "@pi-dispatch/worker/gitlab-identity";
import { resolveForgejoSelfId } from "@pi-dispatch/worker/forgejo-identity";
import { makeResolveAuthority } from "./gitlab-members.mjs";
import { makeResolveForgejoAuthority } from "./forgejo-members.mjs";
import { makeQueue } from "@pi-dispatch/worker/queue";
import { parseConnection } from "@pi-dispatch/worker/connection";

/**
 * Boot the receiver. Collaborators are injected (defaulting to the real ones) so the whole wiring is
 * testable offline with no GitHub, no Valkey, and no socket. Returns the listening server.
 */
export async function startReceiver(
	env = process.env,
	{
		makeAuth = makeGitHubAuth,
		makeQueueFn = makeQueue,
		createServer = http.createServer,
		resolveGitLabSelfId: resolveSelfIdFn = resolveGitLabSelfId,
		makeResolveAuthority: makeResolveAuthorityFn = makeResolveAuthority,
		resolveForgejoSelfId: resolveForgejoSelfIdFn = resolveForgejoSelfId,
		makeResolveForgejoAuthority: makeResolveForgejoAuthorityFn = makeResolveForgejoAuthority,
	} = {},
) {
	// Single-object log line: `makeReceiver` calls `log?.({ event, ... })`, so the sink takes ONE object.
	const log = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

	const cfg = loadReceiverConfig(env);

	// HARD-FAIL identity resolution -- NO try/catch. A throw here (absent/bad github auth, unresolvable
	// id) propagates and the server below is never created: without selfId the bot-loop guard cannot
	// run, so refusing to boot is the only safe outcome.
	const { selfId } = await makeAuth(cfg.github);
	log({ event: "self_identity", id: selfId, source: cfg.github.source });

	// Ride-out connection (no failFast): the receiver is long-running and should survive a Valkey
	// restart, not give up on a transient disconnect.
	const queue = makeQueueFn(parseConnection(cfg.valkeyUrl));

	// The GitLab arm, when configured. Its identity resolution is HARD-FAIL for the same reason github's
	// is: without a selfId the bot-loop guard cannot run, and a receiver that listens without it turns the
	// harness's own status comment into another paid job.
	let gitlab = null;
	if (cfg.gitlab) {
		const gitlabSelfId = await resolveSelfIdFn({ apiUrl: cfg.gitlab.apiUrl, token: cfg.gitlab.token });
		log({ event: "self_identity", forge: "gitlab", id: gitlabSelfId, mode: cfg.gitlab.mode });
		gitlab = {
			mode: cfg.gitlab.mode,
			secret: cfg.gitlab.secret,
			selfId: gitlabSelfId,
			resolveAuthority: makeResolveAuthorityFn({ apiUrl: cfg.gitlab.apiUrl, token: cfg.gitlab.token }),
		};
	}

	// The Forgejo arm, when configured. Identity resolution is HARD-FAIL here too, and it is the arm where
	// that matters most: a repo-scoped Forgejo token cannot call GET /user, so an operator who follows the
	// scoping advice without setting FORGEJO_BOT_ID lands exactly here -- and a receiver that shrugged and
	// continued would run with selfId undefined, which never equals a sender id and silently turns the
	// harness's own comments into more paid jobs.
	let forgejo = null;
	if (cfg.forgejo) {
		const forgejoSelfId = await resolveForgejoSelfIdFn({ apiUrl: cfg.forgejo.apiUrl, token: cfg.forgejo.token, botId: cfg.forgejo.botId });
		log({ event: "self_identity", forge: "forgejo", id: forgejoSelfId, source: cfg.forgejo.botId ? "FORGEJO_BOT_ID" : "api" });
		forgejo = {
			secret: cfg.forgejo.secret,
			selfId: forgejoSelfId,
			resolveAuthority: makeResolveForgejoAuthorityFn({ apiUrl: cfg.forgejo.apiUrl, token: cfg.forgejo.token }),
		};
	}

	const handler = makeReceiver({ queue, selfId, cfg, log, gitlab, forgejo });
	const server = createServer(handler);
	server.listen(cfg.port, cfg.bind, () =>
		log({ event: "receiver_started", port: cfg.port, bind: cfg.bind, valkey: cfg.valkeyUrl }),
	);

	// Graceful shutdown AND the live-trigger watcher only on the real entry (default createServer). Under
	// test injection the fakes are per-test, so a process-wide signal handler or an fs watcher would leak
	// across tests; the reload LOGIC (`reloadTriggers`) is unit-tested directly instead.
	if (createServer === http.createServer) {
		watchTriggers(env, cfg, log);
		const shutdown = async (signal) => {
			log({ event: "receiver_stopping", signal });
			await new Promise((resolve) => server.close(resolve));
			await queue.close();
			process.exit(0);
		};
		process.once("SIGTERM", () => void shutdown("SIGTERM"));
		process.once("SIGINT", () => void shutdown("SIGINT"));
	}

	return server;
}

/**
 * Live-reload watcher: watch the DIRECTORY holding the triggers file (robust to the atomic tmp+rename the
 * admin writes with, which swaps the inode a file-watch would lose), debounce, and re-read on change. A bad
 * edit keeps the running triggers (reloadTriggers never throws) and logs a kept-old notice. Best-effort: a
 * platform without `fs.watch` logs and the receiver simply keeps its boot-time triggers.
 */
function watchTriggers(env, cfg, log) {
	const path = triggersFilePath(env);
	const dir = dirname(path) || ".";
	const file = basename(path);
	let timer = null;
	try {
		watch(dir, (_event, changed) => {
			if (changed && changed !== file) return; // only our file (null changed name -> reload to be safe)
			clearTimeout(timer);
			timer = setTimeout(() => {
				const res = reloadTriggers(env, cfg);
				if (res.ok) log({ event: "triggers_reloaded" });
				else log({ event: "triggers_reload_invalid", reason: res.invalid, kept: true });
			}, 150);
		}).unref?.();
		log({ event: "triggers_watching", path });
	} catch (err) {
		log({ event: "triggers_watch_unavailable", reason: err?.message });
	}
}

// Entry point when run directly (main: src/start.mjs, no bin). Kept out of startReceiver so tests call
// it directly. The error line carries only `err.message` -- never a secret or PII.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("start.mjs")) {
	startReceiver(process.env).catch((err) => {
		process.stderr.write(`${JSON.stringify({ event: "receiver_start_failed", reason: err?.message })}\n`);
		process.exitCode = 1;
	});
}
