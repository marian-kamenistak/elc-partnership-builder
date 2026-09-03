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
	};
	routing: { goals: string[]; budgets: string[]; match: Record<string, Record<string, RoutingEntry[]>> };
	presets: Preset[];
	items: Item[];
	oneoffs?: OneOff[];
};

const catalog = raw as unknown as Catalog;

/** Same allowlist as elc-web membership.astro PRESET_IDS. Vendor Seat absent on purpose. */
export const PRESET_IDS = ["free", "starter", "leadership-pilot", "pilot-meetup", "hiring", "education", "vital", "visibility", "story", "product"];
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

/** The AI-channel discount from catalog meta. Null when unconfigured (fail closed: no discount). */
export function aiDiscount(): Discount | null {
	return meta.discounts?.ai_channel ?? null;
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
	// existing server-side — no stale 16% can reach an email or the CRM. The first-4 cap is a
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
	items: { id: string; name: string; price: number; lead_time: string; counts_toward_combo: boolean }[];
	unknown_ids: string[];
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
export function quoteOneoffs(ids: string[]): OneOffQuote {
	const m = oneoffMeta;
	const excluded = new Set(m?.excluded_from_combo ?? []);
	const wanted = [...new Set(ids)];
	const items: OneOffQuote["items"] = [];
	const unknown: string[] = [];
	for (const id of wanted) {
		const o = oneoffById(id);
		if (!o) {
			unknown.push(id);
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
			journey: (i as Item & { journey?: import("./journey").JourneyMeta }).journey,
		}));
}
