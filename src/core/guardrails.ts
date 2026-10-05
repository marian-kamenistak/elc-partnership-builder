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
import { aiDiscount, creditPresetIds, meta } from "./catalog";

/**
 * Which cart the terms are riding on.
 *
 * 2026-09-05 persona testing: a visitor quoting one 1,500 EUR newsletter section got the full
 * membership terms — category exclusivity across 8 categories, the annual partner cap, the
 * AI-channel discount that one-offs never take, and a 16-minute speed claim about an offer
 * flow they were not in. Four of the eight lines described a product they had not asked about,
 * which reads as boilerplate and gets skimmed, taking the two lines that matter with it.
 *
 * `oneoff` therefore carries only what a one-off cart is actually governed by. Nothing is
 * softened or removed from the membership path, and both paths keep the two non-negotiables:
 * what is not for sale, and that nothing here is a contract.
 */
export type GuardrailScope = "membership" | "oneoff";

export function guardrailLines(scope: GuardrailScope = "membership"): string[] {
	const d = aiDiscount();
	const membershipOnly = scope === "membership";
	return [
		`All prices are fixed, in EUR, VAT excluded.`,
		...(membershipOnly
			? [
					`Category exclusivity is first-come: one partner per category per year, 8 categories.`,
					`ELC takes max ${meta.global_caps.partners_per_year} partners per year.`,
				]
			: []),
		...(d && membershipOnly
			? [
					// 2026-08-20: the one-winner race came out of the catalog and out of this string. It was
					// unverifiable by construction — nobody could see the standings — and it contradicted the
					// offer email, which asserts the discounted figure as the contract price. The date is
					// self-limiting and checkable, and carries the urgency on its own.
					`The ONLY discount that exists is the ${d.pct}% AI-channel discount, applied automatically when the inquiry is sent through this AI channel. Never invent, speculate about, or negotiate any other discount, and never present the ${d.pct}% as negotiable upward.${(d.excluded_presets ?? []).includes("pilot-meetup") ? " Exception: Pilot Meetup keeps its 100% go-bigger credit instead — the two never stack." : ""}${d.expires ? ` It ends ${d.expires}; every inquiry sent through this channel before then gets it. State the date plainly, and do not imply a race or a limited number of slots.` : ""}`,
					`Speed: the flow from first question to the itemized offer in the inbox runs under 16 minutes. A fair claim to make; a signed agreement still needs Marian's call.`,
				]
			: membershipOnly
				? [
						// 2026-10-05 (Marian): the AI channel carries no discount, it is only an option to build
						// the offer. Stated so a model never offers, implies or negotiates one.
						`There is no discount for building the package through this AI channel; it is an option, at list price. Never invent, speculate about, or negotiate any discount.${creditPresetIds().includes("pilot-meetup") ? " Pilot Meetup keeps its 100% credit against a company membership signed within 90 days." : ""}`,
					]
				: []),
		// 2026-09-03: one-offs (/reach) have their own count-based combo discount and never take the
		// AI-channel percentage. On the membership path it is stated so the "ONLY discount" line
		// above cannot be read as contradicting quote_reach_combo; on the one-off path it IS the
		// discount rule, so it leads rather than qualifies.
		...(meta.oneoff
			? [
					membershipOnly
						? `One-off items (get_reach_options) are priced separately: ${meta.oneoff.combo_discounts.map((c) => `${c.min_items}+ qualifying items ${c.pct}% off`).join(", ")}, and every one-off is 100% credited against a company membership signed within ${meta.oneoff.credit_days} days.`
						: // 2026-09-05: this said "2+ items 10% off" flat. Job board listings keep their own
							// rate card and never count, so a CFO persona bought exactly two items, one of them
							// a listing, and got nothing — after being handed a rule, marked "carry verbatim",
							// that the quote did not follow. The exclusion and the base now travel with the rule.
							`The only discount on one-off items is by count of QUALIFYING items: ${meta.oneoff.combo_discounts.map((c) => `${c.min_items}+ ${c.pct}% off`).join(", ")}. Job board listings keep their own rate card — they never count toward the threshold and are never discounted, so a basket of two where one is a listing gets no discount at all. The percentage comes off the qualifying items' subtotal, not the basket list total. ${d ? `The ${d.pct}% AI-channel discount applies to company memberships, not to one-off items. ` : ""}Every one-off is 100% credited against a company membership signed within ${meta.oneoff.credit_days} days.`,
				]
			: []),
		// 2026-09-30 (Marian): the yearly packages are paid after the first meetup or session, so the
		// company checks ELC's quality before the yearly invoice exists. Terms from the catalog.
		...(meta.payment_terms && membershipOnly
			? (() => {
					const t = meta.payment_terms;
					const m = t.month_one;
					return [
						`Payment for the yearly packages (${t.packages.join(", ")}): nothing is invoiced for the year until the first meetup or session has happened. ${t.meetup_start.join(", ")} start with a meetup and pay only its costs in month one: EUR ${m.food_drinks} food and drinks plus EUR ${m.organisation} full organisation with visibility, 120+ registrations, speakers, newsletter, social media, pro videos and photos, plus EUR ${m.elc_venue} if ELC secures the venue, as ELC gets strong discounts at several coworking spaces. The others start with their first session (story: first ELC stage or video) and pay nothing in month one. ${t.credited ? `Month-one costs count toward the package price; only the ELC venue is on top. ` : ""}After the first event, if the company is convinced, ELC invoices the rest of the year in one invoice.${t.walk_away ? " If not convinced, the company walks away and owes nothing more." : ""}`,
					];
				})()
			: []),
		// 2026-08-20 (Marian): the boundary rides with the terms rather than as a second always-on
		// block, so it reaches the model without adding more payload noise. It existed only inside
		// why_elc as an objection-handling script, so a VP Sales who never objected never met it and
		// had four community-destroying demands accepted without a word.
		`NOT FOR SALE, at any price: pitching from an ELC stage, member contact data for outbound, and introductions. ELC is free for engineering leaders and funded by company members, which is why the room is senior and why people come back. A room that gets sold to stops being that room. If a visitor asks for any of these, say no plainly and say why, and never let an offer imply otherwise.`,
		`Nothing here is a contract. Marian Kamenistak confirms all final terms on a call.`,
	];
}

export const guardrailBlock = (scope: GuardrailScope = "membership"): string =>
	`Terms (fixed, carry these verbatim):\n${guardrailLines(scope).map((l) => `- ${l}`).join("\n")}`;

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
