/**
 * Fit a package to an exact budget.
 *
 * Why (2026-08-20 audit): the wizard only understood four budget BANDS, but real buyers arrive
 * with a number — "we have EUR 8,000 approved". The old flow answered that by matching a band,
 * overshooting, and then handing the connecting model a 22-item price list to solve a knapsack
 * problem freehand. Different models produced different baskets from the same budget, and none
 * of them could explain the choice. This makes the composition deterministic and explainable.
 *
 * The method is deliberately simple and defensible rather than optimal:
 *   1. Foundation items first. They anchor what the package IS; dropping them to squeeze in an
 *      extra add-on produces a cheaper basket that no longer delivers the goal.
 *   2. Then the remaining standard items, cheapest-first, so the count of things they get is
 *      maximised for the money — the shape buyers recognise as good value.
 *   3. Add-ons last, and only if room remains.
 * Cheapest-first is greedy, not optimal, but it is EXPLAINABLE, which matters more here: every
 * inclusion and every exclusion comes back with a reason a person can argue with.
 *
 * Free items (price 0) are always included — leaving them out would be strictly worse.
 */
import { availableItems, defaultBasket, discountFor, eur, presetById, resolveBasket, type ResolvedItem } from "./catalog";

export type FitInput = {
	preset_id: string;
	/** Hard ceiling in EUR. Interpreted against the AI-channel price when the discount applies. */
	budget: number;
	/** Item ids the visitor has said they specifically want; kept even if pricey, unless impossible. */
	must_have?: string[];
	/** Compare against the discounted price (default) or the list price. */
	against?: "discounted" | "list";
};

type Candidate = { id: string; name: string; value: string; price: number; addon: boolean; foundation: boolean };

const listAll = (presetId: string): Candidate[] => {
	// availableItems over an empty basket enumerates the whole tier, standard + addons.
	return availableItems(presetId, []) as Candidate[];
};

/** Cost of a basket at the price the visitor is actually being asked to pay. */
function priceOf(presetId: string, ids: string[], against: "discounted" | "list") {
	const { total } = resolveBasket(presetId, ids);
	const d = against === "discounted" ? discountFor(total, "mcp", presetId) : null;
	return { list: total, payable: d ? d.discounted : total, discount_pct: d?.pct ?? 0 };
}

export function fitToBudget(input: FitInput) {
	const preset = presetById(input.preset_id);
	if (!preset) return { error: `unknown preset "${input.preset_id}"` };
	if (!Number.isFinite(input.budget) || input.budget < 0) {
		return { error: `budget must be a positive number of EUR, got ${input.budget}` };
	}
	const against = input.against ?? "discounted";
	const all = listAll(input.preset_id);
	if (!all.length) return { error: `preset "${input.preset_id}" sells no items` };

	const mustHave = new Set((input.must_have ?? []).filter((id) => all.some((c) => c.id === id)));
	const unknownMustHave = (input.must_have ?? []).filter((id) => !all.some((c) => c.id === id));

	// Priority order: must-haves, then foundations, then cheap standards, then add-ons.
	const rank = (c: Candidate): number => {
		if (mustHave.has(c.id)) return 0;
		if (c.price === 0) return 1;
		if (c.foundation && !c.addon) return 2;
		if (!c.addon) return 3;
		return 4;
	};
	const ordered = [...all].sort((a, b) => rank(a) - rank(b) || a.price - b.price || a.id.localeCompare(b.id));

	const chosen: string[] = [];
	const excluded: { id: string; name: string; price: number; reason: string }[] = [];
	for (const c of ordered) {
		const trial = [...chosen, c.id];
		const { payable } = priceOf(input.preset_id, trial, against);
		if (payable <= input.budget) {
			chosen.push(c.id);
		} else {
			excluded.push({
				id: c.id,
				name: c.name,
				price: c.price,
				reason: mustHave.has(c.id)
					? `You asked for this one, but it does not fit under ${eur(input.budget)} alongside the rest — raising the budget to about ${eur(priceOf(input.preset_id, trial, against).payable)} would include it.`
					: `Would take the total past ${eur(input.budget)}.`,
			});
		}
	}

	const priced = priceOf(input.preset_id, chosen, against);
	const { standard, addons } = resolveBasket(input.preset_id, chosen);
	const full = defaultBasket(input.preset_id);
	const fullPriced = priceOf(input.preset_id, full, against);

	// What one more step up would cost — the honest upsell, stated as a fact rather than a push.
	const nextUp = excluded.filter((e) => e.price > 0).sort((a, b) => a.price - b.price)[0];

	const droppedMustHaves = [...mustHave].filter((id) => !chosen.includes(id));

	return {
		package: { id: preset.id, name: preset.name, bundle_price: preset.price },
		budget: input.budget,
		priced_against: against === "discounted" ? "the AI-channel price" : "the list price",
		fits: {
			item_ids: chosen,
			standard,
			addons,
			list_total: priced.list,
			payable_total: priced.payable,
			discount_pct: priced.discount_pct,
			total_display: priced.payable === 0 ? "Free" : `${eur(priced.payable)} / year, excl. VAT`,
			headroom: Math.max(0, input.budget - priced.payable),
			headroom_display:
				input.budget - priced.payable > 0
					? `${eur(input.budget - priced.payable)} of the budget is still unspent`
					: "The budget is fully used",
		},
		left_out: excluded,
		...(nextUp
			? {
					nearest_upgrade: {
						id: nextUp.id,
						name: nextUp.name,
						price: nextUp.price,
						note: `The cheapest thing not included is ${nextUp.name} at ${eur(nextUp.price)}. Mention it once, as information, not as a push.`,
					},
				}
			: {}),
		full_package_for_comparison: {
			item_count: standard.length + addons.length,
			full_item_count: full.length,
			payable_total: fullPriced.payable,
			note:
				fullPriced.payable <= input.budget
					? `The complete ${preset.name} package already fits inside ${eur(input.budget)} — recommend it whole rather than a trimmed version.`
					: `The complete ${preset.name} package is ${eur(fullPriced.payable)}, which is ${eur(fullPriced.payable - input.budget)} above this budget.`,
		},
		...(droppedMustHaves.length ? { must_haves_that_did_not_fit: droppedMustHaves } : {}),
		...(unknownMustHave.length ? { unknown_must_have_ids: unknownMustHave } : {}),
		method:
			"Foundation items first (they anchor the package), then the remaining standard items cheapest-first to maximise what the budget buys, add-ons last. Greedy and explainable rather than mathematically optimal: every exclusion above carries its reason.",
		caveat:
			"A trimmed package is a real package, not a lesser one, but foundation items were kept for a reason. If the visitor wants one dropped, call customize_package with their choice — this tool advises, it does not lock anything.",
		next_tool: "customize_package to adjust further, build_business_case to price the argument, or request_offer to send it.",
	};
}
