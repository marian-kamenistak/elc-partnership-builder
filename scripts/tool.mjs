/**
 * Local tool harness: drive the partnership builder's tools from a shell, without deploying and
 * without any chance of a live email.
 *
 * Why it exists: persona testing needs to exercise the REAL tool surface (same core modules the
 * Worker registers), but the deployed Worker is a shared production endpoint and request_offer
 * sends mail, writes to Attio and pings Slack. This harness calls the same core functions and
 * hard-stubs the one mutating tool, so an agent can walk a full visitor journey safely.
 *
 * Usage:
 *   npx tsx scripts/tool.mjs <tool_name> '<json args>'
 *   npx tsx scripts/tool.mjs list
 *
 * NOT a substitute for a post-deploy smoke test of the live endpoint: transport, rate limiting
 * and the submit pipeline are out of scope here by design.
 */
import { partnershipOptions } from "../src/core/options.ts";
import { matchPackage } from "../src/core/match.ts";
import { buildBusinessCase, approvalMemo } from "../src/core/businesscase.ts";
import { fitToBudget } from "../src/core/fit.ts";
import { isSeatPriced, priceSeats, seatSpecFor } from "../src/core/seats.ts";
import { buildJourney } from "../src/core/journey.ts";
import { detectBoundaryConflicts, guardrailBlock } from "../src/core/guardrails.ts";
import { ATTRIBUTION } from "../src/content.ts";
import {
	aiDiscount,
	availableItems,
	discountFor,
	eur,
	journeyItemsFor,
	PRESET_IDS,
	presetById,
	resolveBasket,
} from "../src/core/catalog.ts";

const ATTR_PATH = "/partner/";

/** Mirrors index.ts toolResult so the agent sees exactly what a client would receive. */
function toolResult(payload, note) {
	const isError = "error" in payload;
	const body = [note, JSON.stringify(payload, null, 2), isError ? null : guardrailBlock()].filter(Boolean).join("\n\n");
	return body + (isError ? "" : ATTRIBUTION(ATTR_PATH));
}

const TOOLS = {
	get_partnership_options: () => toolResult(partnershipOptions()),

	match_package: ({ goal, budget }) => {
		const r = matchPackage(goal, budget);
		if (!r.ok) return toolResult({ error: r.error });
		return toolResult({ matches: r.matches }, r.matches.length > 1 ? "Two ways to start. Both real — present both." : undefined);
	},

	customize_package: ({ preset_id, item_ids, seats }) => {
		const preset = presetById(preset_id);
		if (!preset) return toolResult({ error: `unknown preset "${preset_id}" — valid: ${PRESET_IDS.join(", ")}` });
		if (!item_ids?.length) {
			return toolResult({
				error: "empty_basket",
				message: `Nothing is selected, so there is nothing to price — this is NOT a free package. ${preset.name} lists at ${eur(preset.price)}. Pass default_item_ids from match_package to price the standard bundle, then toggle from there.`,
			});
		}
		const { standard, addons, total } = resolveBasket(preset_id, item_ids);
		const resolvedIds = new Set([...standard, ...addons].map((i) => i.id));
		const dropped = item_ids.filter((id) => !resolvedIds.has(id));
		const seatPricing = isSeatPriced(preset_id) && seats !== undefined ? priceSeats(preset_id, seats) : null;
		if (seatPricing && "error" in seatPricing) return toolResult(seatPricing);
		const effectiveTotal = seatPricing ? seatPricing.total : total;
		const d = discountFor(effectiveTotal, "mcp", preset_id);
		return toolResult({
			...(seatPricing
				? { seat_pricing: seatPricing }
				: isSeatPriced(preset_id)
					? {
							seats_not_yet_known: {
								minimum_seats: seatSpecFor(preset_id)?.minimum_seats,
								note: `${preset.name} is priced per seat. The total below is the ${seatSpecFor(preset_id)?.minimum_seats}-seat entry only. Ask how many people they are enrolling, then call again with seats.`,
							},
						}
					: {}),
			...(dropped.length
				? {
						not_available_in_this_package: {
							item_ids: dropped,
							note: `Not sold in ${preset.name}, so NOT included in the total below.`,
						},
					}
				: {}),
			preset: { id: preset_id, name: preset.name, bundle_price: preset.price },
			selected: { standard, addons },
			total: effectiveTotal,
			total_display: seatPricing ? seatPricing.total_display : effectiveTotal === 0 ? "Free" : `${eur(effectiveTotal)} / year, excl. VAT`,
			...(d
				? { ai_channel_discount: { pct: d.pct, price_after_discount: d.discounted, note: "Applied automatically when the inquiry is sent through this AI channel (request_offer). Present both figures." } }
				: preset_id === "pilot-meetup" && total > 0
					? { credit_note: `Pilot Meetup is 100% credited if you go bigger within 90 days. The credit is its discount — the ${aiDiscount()?.pct ?? 16}% AI-channel discount does not stack on top.` }
					: {}),
			available_to_add: availableItems(preset_id, item_ids),
		});
	},

	fit_to_budget: (a) => toolResult(fitToBudget(a)),

	build_business_case: ({ requester_name, ...a }) => {
		const c = buildBusinessCase(a);
		if ("error" in c) return toolResult(c);
		return toolResult({
			...c,
			approval_memo: approvalMemo(c, requester_name),
			approval_memo_usage:
				"Offer this as something they can forward as-is. Do not rewrite the numbers into prose of your own; hand it over whole, then ask whether they want it sent with the offer.",
		});
	},

	design_journey: ({ preset_id, item_ids, start_month }) => {
		const items = journeyItemsFor(preset_id, item_ids);
		if (!items.length) return toolResult({ error: "empty_basket — pass the item_ids from customize_package" });
		try {
			const journey = buildJourney(items, start_month);
			return toolResult({
				...journey,
				note: "Deterministic skeleton. Present it as the year this basket buys; items without scheduling metadata yet were placed as flexible one-offs.",
				scheduling_caveat:
					"Event months (hosted meetups, dinners, stage slots) are planning targets, not booked dates — ELC runs a shared events calendar across all partners, so the exact slot is confirmed with Marian at signing. Carry this caveat whenever you present the months.",
			});
		} catch (e) {
			return toolResult({ error: String(e instanceof Error ? e.message : e) });
		}
	},

	book_intro_call: ({ preset_id, item_ids } = {}) => {
		const base = {
			booking_url: "https://app.reclaim.ai/m/meet-marian/now",
			what: "Direct calendar booking, 30 minutes with Marian. No form before it, no qualification call script — the conversation starts from whatever was built here.",
			also: "Not ready for either? The free layer runs today, no invoice: https://www.engineeringleaders.io/partner/membership/free/",
		};
		if (!preset_id || !item_ids?.length) {
			return toolResult({ ...base, tip: "No package composed yet — that is fine, the call can start from the two questions." });
		}
		const preset = presetById(preset_id);
		const { standard, addons, total } = resolveBasket(preset_id, item_ids);
		const d = discountFor(total, "mcp", preset_id);
		const count = standard.length + addons.length;
		return toolResult({
			...base,
			composed_package: { package: preset?.name ?? preset_id, items: count, list_total: total, ...(d ? { ai_channel_total: d.discounted, discount_pct: d.pct } : {}) },
			booking_note: `${preset?.name ?? preset_id} package, ${count} items, ${eur(d ? d.discounted : total)}/year${d ? ` (incl. ${d.pct}% AI-channel discount)` : ""}. Built with the ELC partnership builder.`,
			tip: "Give the visitor the booking_note verbatim to paste into the booking form's note field.",
			...(d ? { discount_caveat: "Booking a call does not itself lock the AI-channel discount; request_offer is what registers it." } : {}),
		});
	},

	/** STUBBED. Never sends. Validates the same preconditions and reports what WOULD have gone out. */
	request_offer: ({ name, email, company, final_price_confirmed, preset_id, item_ids, kpis, visibility_interest }) => {
		if (final_price_confirmed !== true) {
			return toolResult({
				error: "price_not_confirmed",
				message: "Show the visitor the exact final total first (list and discounted figures) and get an explicit yes. Then call again with final_price_confirmed: true.",
			});
		}
		for (const [k, v] of Object.entries({ name, email, company, preset_id })) {
			if (!v) return toolResult({ error: `missing_required_field: ${k}` });
		}
		const { total } = resolveBasket(preset_id, item_ids ?? []);
		const d = discountFor(total, "mcp", preset_id);
		const conflicts = detectBoundaryConflicts(kpis);
		return toolResult({
			HARNESS_STUB: "No email, CRM write or Slack post happened. This is a local dry run.",
			submitted: true,
			...(conflicts.length
				? {
						boundary_conflict: {
							rules: conflicts.map((c) => c.rule),
							note: "The offer was sent, but they asked for something ELC does not sell. Tell them now, plainly, before they assume it was agreed.",
						},
					}
				: {}),
			preset: presetById(preset_id)?.name ?? preset_id,
			list_total: total,
			...(d ? { ai_channel_discount_pct: d.pct, final_total: d.discounted } : { final_total: total }),
			offer_email_sent_to: email,
			would_have_recorded: { name, company, kpis: kpis ?? null, visibility_interest: visibility_interest ?? null },
			next_step:
				"The offer is in their inbox and Marian has the same list. The discounted figure becomes the contract price on the confirmation call: https://app.reclaim.ai/m/meet-marian/now",
		});
	},
};

const [, , tool, rawArgs] = process.argv;
if (!tool || tool === "list") {
	console.log(Object.keys(TOOLS).join("\n"));
	process.exit(0);
}
if (!TOOLS[tool]) {
	console.error(`unknown tool "${tool}". Available:\n${Object.keys(TOOLS).join("\n")}`);
	process.exit(1);
}
let args = {};
if (rawArgs) {
	try {
		args = JSON.parse(rawArgs);
	} catch (e) {
		console.error(`args must be valid JSON. Got: ${rawArgs}\n${e.message}`);
		process.exit(1);
	}
}
console.log(TOOLS[tool](args));
