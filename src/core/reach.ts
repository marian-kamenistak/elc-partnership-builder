/**
 * One-offs: what get_reach_options returns (2026-09-03, the /reach page as data).
 *
 * A company that wants ONE thing once — a newsletter section for its conference, a meetup in
 * its office, a dinner — is not a company-membership conversation, and forcing it through the
 * goal+budget wizard loses it. This is the menu for that buyer, read from the same generated
 * catalog as everything else, so a one-off price here is the price on /reach by construction.
 */
import { ELC_FACTS, SITE } from "../content";
import { eur, oneoffMeta, oneoffs, presetById } from "./catalog";

const packageName = (id: string): string => presetById(id)?.name ?? id;

export function reachOptions() {
	const m = oneoffMeta;
	const combos = (m?.combo_discounts ?? []).map((d) => `${d.min_items} or more items: ${d.pct}% off`).join("; ");
	return {
		what: `Single items a company buys once. No package, no annual commitment. Pick the item, ELC sets the date. Full page: ${SITE}/reach/`,
		who_this_is_for:
			"A company with one concrete thing to put in front of engineering leaders in Central Europe: a conference to announce, a senior role to fill, a product to demo, a topic to put on a dinner table. If they want two or more things across a year, a company membership is cheaper — say so and hand over to get_partnership_options.",
		audience: {
			members: ELC_FACTS.membersLabel,
			newsletter: `${ELC_FACTS.newsletterSubscribersLabel} subscribers, ${ELC_FACTS.newsletterOpenRate}% open rate`,
			meetups: `${ELC_FACTS.meetupsPerYear} a year, ${ELC_FACTS.meetupAttendance}+ leaders each`,
			seniority: `${ELC_FACTS.segmentManagerPlusPct}% Manager+`,
		},
		items: oneoffs.map((o) => ({
			id: o.id,
			name: o.name,
			what_you_get: o.value,
			examples: o.examples,
			outcomes: o.outcomes,
			price: o.price,
			price_display: o.premium_price ? `${eur(o.price)}, Premium ${eur(o.premium_price)}` : eur(o.price),
			lead_time: o.lead_time,
			...(o.cap ? { cap: `${o.cap.total_per_year} a year across all companies` } : {}),
			...(o.included_in.length ? { included_in_packages: o.included_in.map(packageName) } : {}),
			...(o.cta_url ? { buy_at: o.cta_url } : {}),
			counts_toward_combo: !(m?.excluded_from_combo ?? []).includes(o.id),
		})),
		combo_discount: {
			rule: combos,
			never_stacks_with: "the AI-channel discount. A one-off basket is not a package; quote the combo price only.",
			excluded: (m?.excluded_from_combo ?? []).join(", ") || "none",
			examples: (m?.example_combos ?? []).map((c) => ({ id: c.id, name: c.name, items: c.items })),
			how_to_quote: "Call quote_reach_combo with the chosen ids. Never add the numbers yourself.",
		},
		credit: `Every one-off is 100% credited against a company membership signed within ${m?.credit_days ?? 90} days. A one-off is a deposit on a package, not a competitor to one.`,
		package_math:
			"Every item here sits inside a company membership at a fraction of the one-off price. One-offs are for companies that want one thing, once. Two or more things a year: route to get_partnership_options.",
		not_for_sale: [
			"Pitching from an ELC stage. The speaker at a hosted meetup tells a real story and passes the same filter as every ELC speaker.",
			"Member contact data. A dedicated newsletter is sent by ELC to ELC's list; the list is never handed over.",
			// 2026-09-04, Marian's call: introductions move from "never" to "only with the
			// member's explicit consent". The promise that actually matters — the list is
			// never handed over — is unchanged, and the line above still carries it. A
			// brokered intro contacts the member, not the buyer, and happens only on a yes.
			"Introductions without the member's consent. ELC will carry a request to a member and introduce you only if they say yes; you never receive contact data, and a no costs you nothing.",
		],
		next_tool:
			"When the visitor picks items, call quote_reach_combo. To lock a date, book_intro_call. Prices are EUR ex VAT; Marian confirms every one-off on a call.",
	};
}
