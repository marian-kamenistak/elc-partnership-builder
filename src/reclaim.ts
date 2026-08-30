/**
 * Reclaim scheduling-link webhook receiver (Marian 2026-08-10): closes the loop between "offer
 * sent" and "call booked". Reclaim fires a signed POST the moment a Scheduling Link meeting is
 * created, rescheduled, or cancelled (Business/Enterprise plans; docs:
 * help.reclaim.ai/en/articles/10008727). We match the booker's email to the Attio person, find
 * their company's elc_partners_queue entry, append a "Call booked" line to queue_notes, and
 * ping the partners Slack channel.
 *
 * Security posture:
 *  - Requests carry x-reclaim-signature-256 (HMAC-SHA256 of the raw body). Until Marian
 *    creates the webhook config in Reclaim (Team Settings → Webhook Settings) and sets
 *    RECLAIM_WEBHOOK_SECRET here, the receiver runs LOG-ONLY: it acknowledges, logs the
 *    payload for calibration, and touches neither Attio nor Slack. An unauthenticated
 *    endpoint must not mutate the CRM.
 *  - Respond fast (<10s per their contract) and idempotently: the queue_notes line carries
 *    the meeting id, and a repeat delivery with the same id is skipped.
 *
 * Payload fields are parsed defensively — Reclaim's exact schema is calibrated from the first
 * logged events, so extraction looks in several plausible places for the attendee email.
 */
import type { SubmitEnv } from "./core/submit";

export type ReclaimEnv = SubmitEnv & { RECLAIM_WEBHOOK_SECRET?: string };

/**
 * Reclaim's `x-reclaim-signature-256`, in BOTH encodings.
 *
 * This used to compute hex only. Reclaim's webhook docs describe the digest as base64, and a
 * mismatch here is invisible in the worst way: every delivery 401s, Reclaim retries, and after 24h
 * of failures it AUTO-SUSPENDS the webhook config — so the integration turns itself off and nothing
 * in this codebase ever logs a booking that did not arrive. As of 2026-08-30 not one real booking
 * had ever reached this handler, which is consistent with exactly that.
 *
 * Rather than bet on which encoding is right, accept either. Both are HMAC-SHA256 over the same raw
 * body with the same secret, so accepting the alternative representation of the same digest adds no
 * attack surface — it is the same proof, spelled differently.
 */
async function hmacDigest(secret: string, body: string): Promise<{ hex: string; b64: string }> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	const bytes = new Uint8Array(sig);
	return {
		hex: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""),
		b64: btoa(String.fromCharCode(...bytes)),
	};
}

/** Marian's own addresses. He is the HOST on every payload, never the booker. */
const OWN_EMAILS = new Set(["marian@engineeringleaders.io", "marian@marian.coach", "marian@kamenistak.com", "leads@marian.coach"]);

/**
 * The BOOKER's email — not the host's.
 *
 * THE BUG THIS REPLACES (found 2026-08-30 by a signed probe). The old version walked the payload
 * depth-first and, at each object, preferred attendee-ish keys before a bare `email`. That looks
 * right and is not: the preference was applied PER OBJECT, while the recursion visited objects in
 * key order. Reclaim's shape is
 *
 *   meeting: { participants: [{ is_host: true, email: <MARIAN> }], attendee: { attendee_email: <BOOKER> } }
 *
 * and `participants` precedes `attendee`, so the walk reached the host's bare `email` first and
 * returned it. Every booking looked up Marian in Attio instead of the prospect — silently, because
 * "person found, no queue entry" is a perfectly ordinary-looking outcome.
 *
 * So: read the known attendee path FIRST, explicitly. Only then fall back to a scan, and make the
 * scan skip host records and Marian's own addresses. Same lesson the mc-web booking hook already
 * carries for `name` (see mentoring-inquiry-builder/src/hooks.ts extractAttendeeName) — the fix
 * there was never ported here.
 */
export function extractEmail(o: unknown): string | null {
	const valid = (v: unknown): string | null =>
		typeof v === "string" && /^\S+@\S+\.\S+$/.test(v) && !OWN_EMAILS.has(v.toLowerCase()) ? v.toLowerCase() : null;

	// 1. The documented Reclaim path, checked before anything walks anywhere.
	const m = (o as any)?.meeting;
	const direct = valid(m?.attendee?.attendee_email) ?? valid((o as any)?.attendee?.attendee_email);
	if (direct) return direct;

	// 2. Fallback scan for non-Reclaim senders (Zapier mappings, manual curl). Host participant
	//    records are skipped outright so the scan cannot reintroduce the original bug.
	const seen = new Set<unknown>();
	const walk = (v: unknown, depth: number): string | null => {
		if (depth > 6 || v === null || typeof v !== "object" || seen.has(v)) return null;
		seen.add(v);
		const rec = v as Record<string, unknown>;
		if (rec.is_host === true) return null;
		for (const k of ["attendeeEmail", "attendee_email", "inviteeEmail", "email"]) {
			const hit = valid(rec[k]);
			if (hit) return hit;
		}
		for (const val of Object.values(rec)) {
			const found = walk(val, depth + 1);
			if (found) return found;
		}
		return null;
	};
	return walk(o, 0);
}

/**
 * The meeting id — which Reclaim nests at `meeting.meeting_id`, a path the old version never looked
 * at. It checked three TOP-LEVEL keys only, so it returned "unknown" on every real payload.
 *
 * That is not cosmetic. The idempotency marker downstream is the string
 * `Call booked (Reclaim meeting <id>)`, so with every id "unknown" the marker was identical for
 * everyone: the second booking by anyone would match the first one's note and be silently dropped
 * as a duplicate delivery.
 */
export function extractMeetingId(o: unknown): string {
	const rec = o as Record<string, any>;
	for (const v of [rec?.meeting?.meeting_id, rec?.meeting?.id, rec?.meeting_id, rec?.id, rec?.eventId, rec?.meetingId]) {
		if (typeof v === "string" || typeof v === "number") return String(v);
	}
	return "unknown";
}

export async function handleReclaimHook(request: Request, env: ReclaimEnv): Promise<Response> {
	const ok = (msg: string) => new Response(JSON.stringify({ ok: true, note: msg }), { status: 200, headers: { "content-type": "application/json" } });
	const raw = await request.text();

	// Signature gate. No secret configured → log-only mode, never CRM writes.
	const secret = env.RECLAIM_WEBHOOK_SECRET;
	if (!secret) {
		console.log("[RECLAIM_HOOK_LOG_ONLY]", raw.slice(0, 2000));
		return ok("log-only: RECLAIM_WEBHOOK_SECRET not set");
	}
	const sigHeader = (request.headers.get("x-reclaim-signature-256") ?? "").replace(/^sha256=/, "").trim();
	const expected = await hmacDigest(secret, raw);
	if (sigHeader !== expected.hex && sigHeader !== expected.b64) {
		// Log the LENGTH, never the value: 64 means Reclaim sent hex, 44 means base64, anything else
		// means the header shape changed and neither branch will ever match again.
		console.error("[RECLAIM_HOOK_BAD_SIG] header_len=" + sigHeader.length);
		return new Response(JSON.stringify({ ok: false, error: "bad_signature" }), { status: 401, headers: { "content-type": "application/json" } });
	}

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(raw);
	} catch {
		return ok("unparseable body, acknowledged");
	}

	const eventType = String(payload.type ?? payload.event ?? payload.action ?? "created");
	const email = extractEmail(payload);
	const meetingId = extractMeetingId(payload);
	if (!email) {
		console.log("[RECLAIM_HOOK_NO_EMAIL]", raw.slice(0, 2000));
		return ok("no attendee email found, logged for calibration");
	}
	if (/cancel/i.test(eventType)) {
		// Cancellations only ping Slack — never silently un-book a CRM note.
		await postSlack(env, `:calendar: Reclaim: *${email}* cancelled their call (meeting ${meetingId}).`);
		return ok("cancellation pinged");
	}

	// ── Attio: person by email → company → partners-queue entry → append the booked line ──────
	let attioNote = "attio_skipped";
	if (env.ATTIO_TOKEN) {
		try {
			const headers = { Authorization: `Bearer ${env.ATTIO_TOKEN}`, "content-type": "application/json" };
			const personRes = await fetch("https://api.attio.com/v2/objects/people/records/query", {
				method: "POST",
				headers,
				body: JSON.stringify({ filter: { email_addresses: email }, limit: 1 }),
			});
			const person: any = personRes.ok ? await personRes.json().catch(() => ({ data: [] })) : { data: [] };
			const personId: string | undefined = person?.data?.[0]?.id?.record_id;
			const companyRef = person?.data?.[0]?.values?.company?.[0]?.target_record_id;
			if (companyRef) {
				const entriesRes = await fetch(`https://api.attio.com/v2/objects/companies/records/${companyRef}/entries?limit=100`, {
					headers: { Authorization: `Bearer ${env.ATTIO_TOKEN}` },
				});
				const entries: any = entriesRes.ok ? await entriesRes.json().catch(() => ({ data: [] })) : { data: [] };
				const queueEntry = (entries.data ?? []).find((e: any) => e.list_api_slug === "elc_partners_queue");
				if (queueEntry) {
					const entryRes = await fetch(`https://api.attio.com/v2/lists/elc_partners_queue/entries/${queueEntry.entry_id}`, {
						headers: { Authorization: `Bearer ${env.ATTIO_TOKEN}` },
					});
					const entry: any = entryRes.ok ? await entryRes.json().catch(() => null) : null;
					const existingNotes: string = entry?.data?.entry_values?.queue_notes?.[0]?.value ?? "";
					const marker = `Call booked (Reclaim meeting ${meetingId})`;
					if (existingNotes.includes(marker)) {
						attioNote = "already_marked"; // idempotency: repeat delivery, same meeting
					} else {
						const patch = await fetch(`https://api.attio.com/v2/lists/elc_partners_queue/entries/${queueEntry.entry_id}`, {
							method: "PATCH",
							headers,
							body: JSON.stringify({ data: { entry_values: { queue_notes: `${existingNotes}\n${marker} — ${email}`.trim() } } }),
						});
						attioNote = patch.ok ? "queue_marked" : `queue_patch_failed_${patch.status}`;
					}
				} else {
					attioNote = "no_queue_entry";
				}
			} else {
				attioNote = personId ? "person_without_company" : "person_not_found";
			}
		} catch (e) {
			console.error("[RECLAIM_HOOK_ATTIO]", String(e));
			attioNote = "attio_exception";
		}
	}

	await postSlack(
		env,
		`:dart: *Call booked* via Reclaim: ${email} (meeting ${meetingId}). Attio: ${attioNote}. If this is an AI-channel inquiry, the loop is closed — offer sent, call booked.`,
	);
	return ok(`processed: ${attioNote}`);
}

async function postSlack(env: ReclaimEnv, text: string): Promise<void> {
	if (!env.SLACK_BOT_TOKEN_ELC || !env.SLACK_PARTNERS_CHANNEL) return;
	try {
		const res = await fetch("https://slack.com/api/chat.postMessage", {
			method: "POST",
			headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN_ELC}`, "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify({ channel: env.SLACK_PARTNERS_CHANNEL, text, unfurl_links: false }),
		});
		const data: any = await res.json().catch(() => ({ ok: false }));
		if (!data.ok) console.error("reclaim slack post failed", data.error);
	} catch (e) {
		console.error("reclaim slack exception", String(e));
	}
}
