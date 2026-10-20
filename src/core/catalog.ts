/**
 * Catalog access + pricing core. The ONLY module that touches offer-catalog.json.
 *
 * src/data/offer-catalog.json is GENERATED — never hand-edit. It is written by
 * web/elc-web/scripts/offers/sync.mjs from partnerships/offers/catalog.yaml, the single
 * source of truth, in the same run that writes elc-web's copy. That is the whole price-parity
 * guarantee: this Worker cannot quote a number the website disagrees with.
 *
 * Redaction rules ported from elc-web src/pages/partner/offer-catalog.json.ts:
 *   - the `vendor` tier/preset is DELIBERATELY UNPUBLISHED (sold directly) — excluded by tier
 *     key so a future vendor-only item inherits the exclusion;
 *   - item/preset `notes` carry internal pricing rationale and never leave this module.
 *
 * Basket resolution mirrors elc-web src/pages/partner/api/offer.ts `resolveBasket` — keep the
 * two in step (cross-referencing comment lives there too).
 */
import raw from "../data/offer-catalog.json";

export type TierSpec = { role: "standard" | "addon" | "exclusive"; price: number; foundation?: boolean };
export type Item = {
	id: string;
	name: string;
	value: string;
	category: string;
	interests: string[];
	tiers: Record<string, TierSpec>;
	name_by_tier?: Record<string, string>;
	price_display?: string;
	scope?: string;
	candidate?: boolean;
	cap?: Record<string, number>;
};
export type Preset = {
	id: string;
	name: string;
	price: number;
	/** Which of the four goal groups this package answers. Defaults the business-case branch. */
	interest?: string;
	row?: string;
	question_band?: string;
	cta_label?: string;
	cta_url?: string;
};
export type RoutingEntry = { preset: string; addons?: string[] };
export type Discount = { pct: number; channels: string[]; applies_to: string; excluded_presets?: string[]; cap_deals?: number; expires?: string };

/** A single item a company buys once, no package (2026-09-03, /reach). Outcomes arrive resolved. */
export type OneOff = {
	id: string;
	item?: string;
	name: string;
	value: string;
	examples: string[];
	outcomes: string[];
	price: number;
	premium_price?: number;
	price_max?: number;
	/** Itemised ladder (speaker programme, 2026-10-20): rungs[0] is the entry price, price 0 = included. */
	rungs?: { id: string; name: string; value: string; price: number }[];
	/** The whole ladder at once, below the rung sum. */
	bundle_price?: number;
	/** Dedicated subpage on the site (/reach/<slug>/). */
	page?: string;
	lead_time: string;
	cap?: { total_per_year: number };
	cta_url?: string;
	included_in: string[];
};
export type OneOffMeta = {
	combo_discounts: { min_items: number; pct: number }[];
	credit_days: number;
	no_stack_with?: string[];
	excluded_from_combo?: string[];
	example_combos?: { id: string; name: string; items: string[] }[];
	/** Standalone meetup basis (2026-10-20): organisation when the company hosts and caters, ELC venue surcharge, catering at cost. */
	meetup?: { organisation: number; elc_venue: number; food_drinks: "at_cost" | "included" | number };
};

type Catalog = {
	generatedAt: string;
	meta: {
		currency: string;
		vat: string;
		global_caps: Record<string, number>;
		interest_groups: Record<string, string>;
		discounts?: Record<string, Discount>;
		oneoff?: OneOffMeta;
		/** One fee per hire on top of every package (Marian 2026-10-20). */
		hire_fee?: { amount: number; currency: string; applies_to: string; due: string };
		payment_terms?: {
			packages: string[];
			meetup_start: string[];
			month_one: {
				food_drinks: number;
				organisation: number;
				elc_venue: number;
				/** What the company pays for the first meetup (Marian 2026-10-18): fee 0, catering at cost, venue only if rented. */
				charged: { organisation: number; food_drinks: "at_cost" | "included" | number; elc_venue: "if_rented" | "included" | number };
			};
			credited: boolean;
			invoice_after_yes: boolean;
			walk_away: boolean;
		};
	};
	routing: { goals: string[]; budgets: string[]; match: Record<string, Record<string, RoutingEntry[]>> };
	presets: Preset[];
	items: Item[];
	oneoffs?: OneOff[];
};

const catalog = raw as unknown as Catalog;

/** Same allowlist as elc-web membership.astro PRESET_IDS. Vendor Seat absent on purpose. */
export const PRESET_IDS = ["free", "starter", "leadership-pilot", "pilot-meetup", "hiring-meetup", "intro-sprint", "launch-audit", "community-launch", "launch-run", "hiring", "education", "vital", "visibility", "story", "product"];

/**
 * Presets that keep the 100% credit instead of the AI-channel percentage (catalog
 * meta.discounts.ai_channel.excluded_presets), read from the catalog so a new credit-mechanic rung
 * cannot ship with the discount framing. Pilot Meetup and the Community Launch ladder as of
 * 2026-10-20 (Signature Meetup retired that day).
 */
export const creditPresetIds = (): string[] => catalog.meta.discounts?.ai_channel?.excluded_presets ?? [];
export const isCreditPreset = (id: string): boolean => creditPresetIds().includes(id);
const EXCLUDED_TIER_KEYS = ["vendor"];

const stripExcludedTiers = (item: Item): Item => ({
	...item,
	tiers: Object.fromEntries(Object.entries(item.tiers ?? {}).filter(([k]) => !EXCLUDED_TIER_KEYS.includes(k))),
});

/** Items the builder may talk about: live, community-scoped, priced in a published tier. */
export const liveItems: Item[] = catalog.items
	.filter((i) => !i.candidate && (i.scope ?? "community") === "community")
	.map(stripExcludedTiers)
	.filter((i) => Object.keys(i.tiers).length > 0)
	// notes never left the raw type; strip anything extra defensively.
	.map(({ ...i }) => {
		delete (i as Record<string, unknown>).notes;
		return i;
	});

export const presets: Preset[] = catalog.presets.filter((p) => PRESET_IDS.includes(p.id));
export const routing = catalog.routing;
export const meta = catalog.meta;
/** EUR fee per hire made through ELC, 0 when the catalog carries none. */
export const hireFee = (): number => catalog.meta.hire_fee?.amount ?? 0;
export const generatedAt = catalog.generatedAt;

export const presetById = (id: string): Preset | undefined => presets.find((p) => p.id === id);

/** Product Exclusive composes on product's tier key (membership.astro tierKeyOf precedent). */
export const tierKeyOf = (presetId: string): string => (presetId === "product-exclusive" ? "product" : presetId);

/** What this item is called when this tier is buying (name_by_tier fallback chain). */
export const nameFor = (item: Item, tier: string): string => item.name_by_tier?.[tier] ?? item.name;

export type ResolvedItem = { id: string; name: string; value: string; price: number; addon: boolean; foundation: boolean };

/** Port of offer.ts resolveBasket: unknown ids drop silently, server total is authoritative. */
export function resolveBasket(presetId: string, itemIds: string[]) {
	const tier = tierKeyOf(presetId);
	const wanted = new Set(itemIds);
	const items: ResolvedItem[] = [];
	for (const item of liveItems) {
		const spec = item.tiers[tier];
		if (!spec || !wanted.has(item.id)) continue;
		items.push({
			id: item.id,
			name: nameFor(item, tier),
			value: item.value,
			price: spec.price,
			addon: spec.role !== "standard",
			foundation: spec.foundation === true,
		});
	}
	const standard = items.filter((i) => !i.addon);
	const addons = items.filter((i) => i.addon);
	const total = items.reduce((acc, i) => acc + i.price, 0);
	return { standard, addons, total };
}

/** The default basket for a preset: every standard item on, add-ons off (toggle-board default). */
export function defaultBasket(presetId: string): string[] {
	const tier = tierKeyOf(presetId);
	return liveItems.filter((i) => i.tiers[tier]?.role === "standard").map((i) => i.id);
}

/** Everything this preset could still add: items in the tier not currently in the basket. */
export function availableItems(presetId: string, currentIds: string[]) {
	const tier = tierKeyOf(presetId);
	const current = new Set(currentIds);
	return liveItems
		.filter((i) => i.tiers[tier] && !current.has(i.id))
		.map((i) => ({
			id: i.id,
			name: nameFor(i, tier),
			value: i.value,
			price: i.tiers[tier].price,
			addon: i.tiers[tier].role !== "standard",
			foundation: i.tiers[tier].foundation === true,
		}));
}

/**
 * The AI-channel discount from catalog meta. Null when unconfigured or at 0% (fail closed: no
 * discount). 0% since 2026-10-05 (Marian): the AI channel is an option, not a discount, so every
 * caller falls back to list price and no copy may mention a percentage.
 */
export function aiDiscount(): Discount | null {
	const d = meta.discounts?.ai_channel;
	return d && d.pct > 0 ? d : null;
}

/**
 * Apply the AI-channel discount for a submission channel. Server-side only — model and client
 * totals are never trusted. Returns null when the channel does not qualify, the total is 0
 * (Free has nothing to discount), or the preset is excluded (Marian 2026-08-08:
 * credit-or-discount — pilot-meetup keeps its 100% credit and never gets the pct).
 */
export function discountFor(
	total: number,
	channel: string,
	presetId?: string,
	now: Date = new Date(),
): { pct: number; discounted: number } | null {
	const d = aiDiscount();
	if (!d || total <= 0 || !d.channels.includes(channel)) return null;
	if (presetId && (d.excluded_presets ?? []).includes(presetId)) return null;
	// Scarcity expiry (Marian 2026-08-09): after the stated end date the discount simply stops
	// existing server-side — no stale percentage can reach an email or the CRM. The first-4 cap is a
	// stated term enforced at Marian's confirmation call, not a server counter.
	if (d.expires && now.toISOString().slice(0, 10) > d.expires) return null;
	return { pct: d.pct, discounted: Math.round(total * (1 - d.pct / 100)) };
}

export const eur = (n: number): string => `€${n.toLocaleString("en-US")}`;

// ── One-offs (/reach) ───────────────────────────────────────────────────────────────────────
export const oneoffs: OneOff[] = catalog.oneoffs ?? [];
export const oneoffMeta: OneOffMeta | null = meta.oneoff ?? null;
export const ONEOFF_IDS = oneoffs.map((o) => o.id);
export const oneoffById = (id: string): OneOff | undefined => oneoffs.find((o) => o.id === id);

export type OneOffQuote = {
	items: { id: string; name: string; price: number; lead_time: string; counts_toward_combo: boolean; rungs?: string[] }[];
	unknown_ids: string[];
	/** Rung ids that are not on the ladder (speaker programme); reported, never priced. */
	unknown_rungs: string[];
	/** Ids sent more than once. Each one-off is one placement sold once, so repeats are collapsed
	 *  — reported rather than dropped in silence, so a buyer never signs a quote for fewer
	 *  placements than they ordered. */
	duplicate_ids: string[];
	list_total: number;
	combo: { qualifying_items: number; pct: number; saved: number } | null;
	total: number;
	credit_days: number;
};

/**
 * Price a one-off basket. The combo discount is by COUNT of qualifying items (job board listings
 * keep their own rate card and never count), applied to the qualifying items' total only. Server
 * side is authoritative: the model never does this arithmetic. Never stacks with the AI-channel
 * percentage — a one-off basket is not a package, so discountFor is simply never called on it.
 */
export type OneOffQuoteOptions = {
	/** Speaker programme rungs to price (2026-10-20). Absent = the full programme at bundle_price.
	 *  Stage (rungs[0]) is the entry rung and is always included; picking every paid rung is the
	 *  bundle again, never the sum. */
	speaker_rungs?: string[];
};

/** Price one laddered one-off from a rung selection. Exported for the chat and HTTP paths. */
export function priceRungs(o: OneOff, selection: string[] | undefined): { price: number; rungs: string[]; unknown: string[] } {
	const ladder = o.rungs ?? [];
	// An absent OR empty selection is the full programme: an agent that passes an empty default must
	// never get Stage alone quoted back (review 2026-10-20).
	if (!ladder.length || !selection?.length) return { price: o.bundle_price ?? o.price, rungs: ladder.map((r) => r.id), unknown: [] };
	const known = new Set(ladder.map((r) => r.id));
	const unknown = [...new Set(selection.filter((id) => !known.has(id)))];
	const picked = new Set(selection.filter((id) => known.has(id)));
	picked.add(ladder[0].id); // the entry rung is never optional
	for (const r of ladder) if (r.price === 0) picked.add(r.id); // included lines always come along
	const paid = ladder.filter((r) => r.price > 0);
	const allPaid = paid.every((r) => picked.has(r.id));
	const price = allPaid && o.bundle_price !== undefined ? o.bundle_price : ladder.filter((r) => picked.has(r.id)).reduce((s, r) => s + r.price, 0);
	return { price, rungs: ladder.filter((r) => picked.has(r.id)).map((r) => r.id), unknown };
}

export function quoteOneoffs(ids: string[], opts: OneOffQuoteOptions = {}): OneOffQuote {
	const m = oneoffMeta;
	const excluded = new Set(m?.excluded_from_combo ?? []);
	const wanted = [...new Set(ids)];
	// 2026-09-05: ordering the same id three times returned ONE line and a total for one, with
	// no warning — a CFO persona found a signable quote for a third of what he asked for. Each
	// one-off is a single placement sold once, so deduping is right; doing it in silence is not.
	const duplicated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
	const items: OneOffQuote["items"] = [];
	const unknown: string[] = [];
	let unknownRungs: string[] = [];
	for (const id of wanted) {
		const o = oneoffById(id);
		if (!o) {
			unknown.push(id);
			continue;
		}
		if (o.rungs) {
			const r = priceRungs(o, opts.speaker_rungs);
			unknownRungs = [...unknownRungs, ...r.unknown];
			items.push({ id: o.id, name: o.name, price: r.price, lead_time: o.lead_time, counts_toward_combo: !excluded.has(o.id), rungs: r.rungs });
			continue;
		}
		items.push({ id: o.id, name: o.name, price: o.price, lead_time: o.lead_time, counts_toward_combo: !excluded.has(o.id) });
	}
	const listTotal = items.reduce((acc, i) => acc + i.price, 0);
	const qualifying = items.filter((i) => i.counts_toward_combo);
	const qualifyingTotal = qualifying.reduce((acc, i) => acc + i.price, 0);
	const tier = [...(m?.combo_discounts ?? [])]
		.sort((a, b) => b.min_items - a.min_items)
		.find((d) => qualifying.length >= d.min_items);
	const saved = tier ? Math.round(qualifyingTotal * (tier.pct / 100)) : 0;
	return {
		items,
		unknown_ids: unknown,
		unknown_rungs: unknownRungs,
		duplicate_ids: duplicated,
		list_total: listTotal,
		combo: tier ? { qualifying_items: qualifying.length, pct: tier.pct, saved } : null,
		total: listTotal - saved,
		credit_days: m?.credit_days ?? 0,
	};
}

/**
 * The basket resolved into journey-engine inputs: per-tier display names, plus each item's
 * scheduling metadata from the catalog. Items the tier does not sell drop, same as
 * resolveBasket — the journey can only ever contain what was bought.
 */
export function journeyItemsFor(presetId: string, itemIds: string[]) {
	const tier = tierKeyOf(presetId);
	const wanted = new Set(itemIds);
	return liveItems
		.filter((i) => i.tiers[tier] && wanted.has(i.id))
		.map((i) => ({
			id: i.id,
			name: nameFor(i, tier),
			value: i.value,
			// Per-package override first (Visibility runs two meetups, 2026-10-05).
			journey:
				(i as Item & { journey_by_tier?: Record<string, import("./journey").JourneyMeta> }).journey_by_tier?.[tier] ??
				(i as Item & { journey?: import("./journey").JourneyMeta }).journey,
		}));
}
