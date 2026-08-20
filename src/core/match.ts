/**
 * Goal + budget → matched preset(s), resolved through the catalog's shared routing matrix —
 * the SAME matrix elc-web's PartnerPicker and the membership deep-link boot use, so the AI
 * wizard and the website can never route the same answers differently.
 *
 * Errors guide the agent to correct usage (mcp-launch agent-centric rule): bad input returns
 * the valid ids, never a guess.
 */
import { aiDiscount, defaultBasket, discountFor, eur, presetById, resolveBasket, routing, type RoutingEntry } from "./catalog";

export type Match = {
	preset_id: string;
	name: string;
	price: number;
	price_display: string;
	/** The magnet, surfaced AT the match moment. Marian's live test (2026-08-08) showed a
	 *  summarizing model skipping the discount when it only rode in the terms block — an
	 *  explicit per-match field is what makes it un-skippable. */
	ai_channel_price?: { pct: number; price: number; display: string };
	included_addons: string[];
	default_item_ids: string[];
	/**
	 * The same basket as default_item_ids, but showable. Returning ids alone (2026-08-20 audit)
	 * meant a model had 19 opaque strings at the one moment it needs to describe the package, so
	 * it either called customize_package purely to resolve names or, worse, guessed from the ids.
	 * Name + price only: the long `value` prose stays in customize_package, which is where
	 * itemised detail belongs.
	 */
	default_items: { id: string; name: string; price: number; foundation: boolean }[];
	summary: string;
};

export function matchPackage(goal: string, budget: string): { ok: true; matches: Match[] } | { ok: false; error: string } {
	if (!routing.goals.includes(goal)) {
		return { ok: false, error: `Unknown goal "${goal}". Valid goals: ${routing.goals.join(", ")}.` };
	}
	if (!routing.budgets.includes(budget)) {
		return { ok: false, error: `Unknown budget "${budget}". Valid budgets: ${routing.budgets.join(", ")}.` };
	}
	const entries: RoutingEntry[] = routing.match[budget]?.[goal] ?? [];
	if (!entries.length) {
		return { ok: false, error: `No route for ${budget}/${goal} — this combination has no package. Re-ask the two questions.` };
	}
	// A routing cell pointing at a preset that is no longer published (renamed, legacied) used to
	// throw here, which surfaced to the visitor as a hard tool failure rather than a fallback —
	// start/talent did exactly that for two weeks after the 7-package cutover (2026-08-20). Stale
	// entries now drop and the remaining ones still answer; only an entirely stale cell errors,
	// and it errors in the same guiding style as the two input checks above.
	const live = entries.filter((e) => presetById(e.preset));
	if (!live.length) {
		return {
			ok: false,
			error: `No live package is routed for ${budget}/${goal} right now. Offer the free layer (https://www.engineeringleaders.io/partner/membership/free/) or book_intro_call, and do not invent a package.`,
		};
	}
	const matches = live.map((e) => {
		const p = presetById(e.preset)!;
		const defaults = defaultBasket(p.id);
		const withAddons = [...defaults, ...(e.addons ?? [])];
		const { standard, addons, total } = resolveBasket(p.id, withAddons);
		// "mcp" stands in for "any AI channel" here — chat and mcp always carry the discount
		// together (sync.mjs validates channels ⊆ [chat, mcp]). Exclusions (pilot-meetup keeps
		// its credit instead) resolve inside discountFor.
		const d = discountFor(total, "mcp", p.id);
		return {
			preset_id: p.id,
			name: p.name,
			price: total,
			price_display: total === 0 ? "Free" : `${eur(total)} / year, excl. VAT`,
			...(d
				? {
						ai_channel_price: {
							pct: d.pct,
							price: d.discounted,
							display: `${eur(d.discounted)} / year after the ${d.pct}% AI-channel discount — applied automatically when the inquiry is sent from this conversation. Always present both figures.`,
						},
					}
				: {}),
			included_addons: e.addons ?? [],
			default_item_ids: withAddons,
			default_items: [...standard, ...addons].map((i) => ({
				id: i.id,
				name: i.name,
				price: i.price,
				foundation: i.foundation,
			})),
			summary:
				p.id === "free"
					? "The free layer, running today: no invoice, no contract."
					: p.id === "pilot-meetup"
						? `${p.name} at ${eur(total)}, 100% credited if you go bigger within 90 days. The credit is its discount — the ${aiDiscount()?.pct ?? 16}% AI-channel discount applies to every other paid preset but does not stack here.`
						: `${p.name} at ${eur(total)} with every standard item on${d ? `, ${eur(d.discounted)} through this AI channel` : ""}. Toggle off what you do not need — the total moves with you.`,
		};
	});
	return { ok: true, matches };
}
