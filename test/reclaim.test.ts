/**
 * The Reclaim booking hook — three defects found 2026-08-30 by a signed probe, after noticing that
 * in the entire Slack history this handler had never once reported a real booking.
 *
 * The payload shape below is the REAL one, captured from Reclaim (api_version v2026-04-13) and
 * archived in #mc-mentoring-bot on 2026-08-21. Its ordering is the whole point of the first test:
 * `participants` (the host) comes before `attendee` (the booker).
 */
import { describe, expect, it } from "vitest";
import { extractEmail, extractMeetingId, isPartnershipBooking } from "../src/reclaim";

const RECLAIM_CREATED = {
	type: "SchedulingLink.Meeting.Created",
	api_version: "v2026-04-13",
	meeting: {
		participants: [{ is_host: true, user_id: "f081ad80", email: "marian@engineeringleaders.io", name: "Marian Kamenistak" }],
		attendee: { attendee_email: "Booker@Corp.COM", attendee_name: "Real Booker", attendee_zone_id: { id: "Europe/Prague" } },
		start_time: "2026-08-31T21:30:00+02:00",
		scheduling_link_title: "Marian intro all",
		meeting_id: "eEOFVtqQYh6t",
		meeting_title: "Marian and Real Booker - Marian intro all",
		message: "",
	},
};

describe("extractEmail — the booker, never the host", () => {
	it("takes the attendee even though participants[0] appears first in the payload", () => {
		// The original bug in one assertion: this returned marian@engineeringleaders.io, so every
		// booking looked up Marian in Attio instead of the prospect.
		expect(extractEmail(RECLAIM_CREATED)).toBe("booker@corp.com");
	});

	it("lowercases, because Attio's email filter is exact-match", () => {
		expect(extractEmail(RECLAIM_CREATED)).toBe(extractEmail(RECLAIM_CREATED)?.toLowerCase());
	});

	it("never returns one of Marian's own addresses, even when it is the only email present", () => {
		expect(extractEmail({ meeting: { participants: [{ is_host: true, email: "marian@engineeringleaders.io" }] } })).toBeNull();
		expect(extractEmail({ email: "marian@marian.coach" })).toBeNull();
	});

	it("skips any host record in the fallback scan", () => {
		expect(extractEmail({ people: [{ is_host: true, email: "someone@else.com" }, { email: "guest@corp.com" }] })).toBe("guest@corp.com");
	});

	it("still handles the flat shapes a Zapier mapping or manual curl would send", () => {
		expect(extractEmail({ email: "flat@corp.com" })).toBe("flat@corp.com");
		expect(extractEmail({ invitee: { inviteeEmail: "nested@corp.com" } })).toBe("nested@corp.com");
	});

	it("returns null rather than a non-address when nothing qualifies", () => {
		expect(extractEmail({ meeting: { meeting_title: "Marian and someone - not an address" } })).toBeNull();
		expect(extractEmail(null)).toBeNull();
	});
});

describe("extractMeetingId — the idempotency key", () => {
	it("reads the nested path Reclaim actually uses", () => {
		// Was "unknown" on every real payload, which made the downstream duplicate marker
		// `Call booked (Reclaim meeting unknown)` identical for everyone: the second person to book
		// would be silently dropped as a repeat delivery of the first.
		expect(extractMeetingId(RECLAIM_CREATED)).toBe("eEOFVtqQYh6t");
	});

	it("two different bookings produce two different markers", () => {
		const other = { ...RECLAIM_CREATED, meeting: { ...RECLAIM_CREATED.meeting, meeting_id: "differentId" } };
		expect(extractMeetingId(other)).not.toBe(extractMeetingId(RECLAIM_CREATED));
	});

	it("falls back through the older top-level keys, then to unknown", () => {
		expect(extractMeetingId({ id: "top" })).toBe("top");
		expect(extractMeetingId({ nothing: true })).toBe("unknown");
	});
});

describe("partnership vs plain intro — one link, two audiences", () => {
	it("treats a booking tagged from the partner pages as partnership", () => {
		expect(isPartnershipBooking({ meeting: { custom_data: { data: { src: "partner" } } } })).toBe(true);
	});

	it("is forgiving about case and stray whitespace in the tag", () => {
		expect(isPartnershipBooking({ meeting: { custom_data: { data: { src: " Partner " } } } })).toBe(true);
	});

	it("treats an UNTAGGED booking as a plain intro — the safe default", () => {
		// The two mistakes are not symmetrical. Filing a partnership lead as an intro costs a Slack
		// label; filing a stranger's intro as partnership writes "Call booked" onto a real company's
		// queue note in Attio. So absence of the tag must never mean partnership.
		expect(isPartnershipBooking(RECLAIM_CREATED)).toBe(false);
		expect(isPartnershipBooking({ meeting: {} })).toBe(false);
		expect(isPartnershipBooking({})).toBe(false);
		expect(isPartnershipBooking(null)).toBe(false);
	});

	it("does not accept some other data- param as the partnership signal", () => {
		expect(isPartnershipBooking({ meeting: { custom_data: { data: { src: "newsletter" } } } })).toBe(false);
		expect(isPartnershipBooking({ meeting: { custom_data: { data: { claim: "partner" } } } })).toBe(false);
	});
});
