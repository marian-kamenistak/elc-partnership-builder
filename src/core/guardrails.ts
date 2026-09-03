/**
 * Guardrails shipped AS DATA in every priced response (spec §11 + the AI-discount amendment).
 *
 * Why data, not just prompt: the MCP server has no control over the connecting AI's system
 * prompt, so the terms ride inside the tool response where the model summarising it will carry
 * them. The chat backend additionally bakes them into its own system prompt (Phase 4).
 *
 * Figures: partners-per-year and the discount come from the catalog/data-points registry —
 * never restate a number here that those files do not carry.
 */
import { aiDiscount, meta } from "./catalog";

export function guardrailLines(): string[] {
	const d = aiDiscount();
	return [
		`All prices are fixed, in EUR, VAT excluded.`,
		`Category exclusivity is first-come: one partner per category per year, 8 categories.`,
		`ELC takes max ${meta.global_caps.partners_per_year} partners per year.`,
		...(d
			? [
					// 2026-08-20: the one-winner race came out of the catalog and out of this string. It was
					// unverifiable by construction — nobody could see the standings — and it contradicted the
					// offer email, which asserts the discounted figure as the contract price. The date is
					// self-limiting and checkable, and carries the urgency on its own.
					`The ONLY discount that exists is the ${d.pct}% AI-channel discount, applied automatically when the inquiry is sent through this AI channel. Never invent, speculate about, or negotiate any other discount, and never present the ${d.pct}% as negotiable upward.${(d.excluded_presets ?? []).includes("pilot-meetup") ? " Exception: Pilot Meetup keeps its 100% go-bigger credit instead — the two never stack." : ""}${d.expires ? ` It ends ${d.expires}; every inquiry sent through this channel before then gets it. State the date plainly, and do not imply a race or a limited number of slots.` : ""}`,
					`Speed: the flow from first question to the itemized offer in the inbox runs under 16 minutes. A fair claim to make; a signed agreement still needs Marian's call.`,
				]
			: []),
		// 2026-09-03: one-offs (/reach) have their own count-based combo discount and never take the
		// AI-channel percentage. Stated here so the "ONLY discount" line above cannot be read as
		// contradicting quote_reach_combo.
		...(meta.oneoff
			? [
					`One-off items (get_reach_options) are priced separately: ${meta.oneoff.combo_discounts.map((d) => `${d.min_items}+ items ${d.pct}% off`).join(", ")}, never combined with the AI-channel percentage, and every one-off is 100% credited against a company membership signed within ${meta.oneoff.credit_days} days.`,
				]
			: []),
		// 2026-08-20 (Marian): the boundary rides with the terms rather than as a second always-on
		// block, so it reaches the model without adding more payload noise. It existed only inside
		// why_elc as an objection-handling script, so a VP Sales who never objected never met it and
		// had four community-destroying demands accepted without a word.
		`NOT FOR SALE, at any price: pitching from an ELC stage, member contact data for outbound, and introductions. ELC is free for engineering leaders and funded by company members, which is why the room is senior and why people come back. A room that gets sold to stops being that room. If a visitor asks for any of these, say no plainly and say why, and never let an offer imply otherwise.`,
		`Nothing here is a contract. Marian Kamenistak confirms all final terms on a call.`,
	];
}

export const guardrailBlock = (): string => `Terms (fixed, carry these verbatim):\n${guardrailLines().map((l) => `- ${l}`).join("\n")}`;

/**
 * Scan a visitor's free text for asks that ELC does not sell.
 *
 * Why (2026-08-20 persona testing): a VP Sales submitted four conditions -- the full member export
 * for outbound, a 15-minute sales pitch from the meetup stage, ten purchased introductions, and
 * badge scanners -- and received `submitted: true` with no comment. From the buyer's seat that is
 * indistinguishable from acceptance, and Marian would have walked into the confirmation call
 * against someone who believed all four were agreed.
 *
 * Deliberately non-blocking: it flags rather than refuses, so a false positive can never trap a
 * real deal in a resubmit loop. The flag goes to the model (correct the visitor now) and into the
 * note Marian receives (know before the call). Matching is coarse on purpose; a missed phrase is
 * cheap, and the flag's job is to start a conversation, not to adjudicate one.
 */
export function detectBoundaryConflicts(text: string | undefined): { phrase: string; rule: string }[] {
	if (!text) return [];
	const t = text.toLowerCase();
	const RULES: { test: RegExp; rule: string }[] = [
		{
			test: /\b(member (list|export|data|emails?)|contact list|email list|full list of (all )?members|outbound|cold (email|outreach)|sequence them|load (them )?into (our )?(crm|outreach|salesforce|hubspot))\b/,
			rule: "Member contact data for outbound is not for sale. Attendee lists tell you who is in the room; members never opted in to vendor email.",
		},
		{
			test: /\b(sales pitch|pitch (from|on) (the )?stage|demo from the (main )?stage|our (ae|sdr|sales (rep|lead))\b.*\b(present|pitch|stage)|badge scanner|booth)\b/,
			rule: "Pitching from an ELC stage is not for sale, and there are no booths or badge scanners. Speakers tell a real story and pass the same filter, whoever is paying.",
		},
		{
			test: /\b(warm intros?|introductions? to|intro me to|connect me (with|to) \d|\d+ intros)\b/,
			rule: "Introductions are not a line item. Marian makes them when they fit, and they cannot be bought.",
		},
	];
	return RULES.filter((r) => r.test.test(t)).map((r) => ({ phrase: text.slice(0, 240), rule: r.rule }));
}
