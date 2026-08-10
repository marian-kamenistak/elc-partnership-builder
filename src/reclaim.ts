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

async function hmacHex(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pull an attendee email out of whatever shape the payload has. */
function extractEmail(o: unknown): string | null {
	const seen = new Set<unknown>();
	const walk = (v: unknown, depth: number): string | null => {
		if (depth > 6 || v === null || typeof v !== "object" || seen.has(v)) return null;
		seen.add(v);
		const rec = v as Record<string, unknown>;
		// Prefer explicitly attendee-ish keys before falling back to any email-shaped string.
		for (const k of ["attendeeEmail", "attendee_email", "inviteeEmail", "email"]) {
			const val = rec[k];
			if (typeof val === "string" && /^\S+@\S+\.\S+$/.test(val)) return val.toLowerCase();
		}
		for (const val of Object.values(rec)) {
			const found = walk(val, depth + 1);
			if (found) return found;
		}
		return null;
	};
	return walk(o, 0);
}

function extractMeetingId(o: unknown): string {
	const rec = o as Record<string, unknown>;
	for (const k of ["id", "eventId", "meetingId"]) {
		const v = rec?.[k];
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
	const sigHeader = (request.headers.get("x-reclaim-signature-256") ?? "").replace(/^sha256=/, "");
	const expected = await hmacHex(secret, raw);
	if (sigHeader !== expected) {
		console.error("[RECLAIM_HOOK_BAD_SIG]");
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
