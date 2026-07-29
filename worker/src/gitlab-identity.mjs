/**
 * Resolve the harness's OWN GitLab user id -- the counterpart of identity.mjs's `resolveSelfId`, and the
 * thing the receiver's bot-loop guard compares every delivery's `user.id` against.
 *
 * It lives in the worker package for the same reason `identity.mjs` does: both services need it, and one
 * implementation is what keeps them from disagreeing about who "we" are. A receiver that resolved a
 * different id than the worker posts under would let the worker's own comments trigger jobs.
 *
 * Fails CLOSED. Every failure throws rather than returning null, because the caller's only use for the
 * answer is to refuse events that came from us: an unresolved id would disarm the guard, and a disarmed
 * guard turns one status comment into an unbounded paid recursion. `startReceiver` deliberately does not
 * catch it, so a receiver that cannot establish its own identity never listens.
 *
 * A project or group access token authenticates as its own BOT USER, and `GET /user` returns that bot's
 * id -- which is exactly the identity comments will be posted under.
 */

import { configError } from "./config.mjs";

/** Resolve the acting identity's integer user id from `GET /user`. `fetchFn` is injected for tests. */
export async function resolveGitLabSelfId({ apiUrl, token, fetchFn = fetch }) {
	if (typeof token !== "string" || token.trim() === "") {
		throw configError("gitlab identity: a non-empty GITLAB_TOKEN is required to resolve the harness's own user id");
	}
	const url = `${String(apiUrl ?? "https://gitlab.com").replace(/\/+$/, "")}/api/v4/user`;
	let res;
	try {
		res = await fetchFn(url, { headers: { "PRIVATE-TOKEN": token }, redirect: "error" });
	} catch (err) {
		throw configError(`gitlab identity: GET /user failed (${fetchFailureReason(err)})`);
	}
	if (!res.ok) {
		// The status alone, never the body: an error body can echo the token back.
		throw configError(`gitlab identity: GET /user returned ${res.status}`);
	}
	let body;
	try {
		body = await res.json();
	} catch (err) {
		throw configError(`gitlab identity: GET /user returned unparseable JSON (${err?.message ?? "unknown"})`);
	}
	if (!Number.isInteger(body?.id)) {
		throw configError("gitlab identity: GET /user returned no integer id");
	}
	return body.id;
}

/**
 * A fetch rejection's real reason. Node's `fetch` rejects with the bare string "fetch failed" and puts the
 * actual cause underneath -- so the single commonest self-hosted GitLab misconfiguration, a private CA the
 * host does not trust, reports nothing an operator can act on. Unwrapping turns that into
 * "self-signed certificate in certificate chain", which names the fix (NODE_EXTRA_CA_CERTS).
 */
export function fetchFailureReason(err) {
	const parts = [];
	for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth++) {
		const m = typeof e?.message === "string" ? e.message : null;
		if (m && !parts.includes(m)) parts.push(m);
	}
	return parts.join(": ") || "network error";
}
