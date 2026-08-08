// VENDORED by web/elc-web/scripts/offers/sync.mjs from web/elc-web/src/lib/journey.ts —
// DO NOT EDIT HERE. Edit the source and run `npm run offers:sync`.
/**
 * The 12-month partnership journey engine. PURE and dependency-free on purpose: this exact
 * file runs in the browser (Phase: membership page), in the Astro Worker (chat backend), and
 * is VENDORED byte-for-byte into mcp/elc-partnership-builder/src/core/journey.ts by
 * scripts/offers/sync.mjs — one implementation, no drift. Do not import anything here.
 *
 * Contract (approved spec §6 + Marian's Pass 1 review 2026-08-08,
 * partnerships/offers/journey-metadata-pass1.md):
 *  - `monthly` items go to the recurring strip, never a month slot.
 *  - one-off → 1 occurrence, half-yearly → 2, quarterly → 4.
 *  - anchors place first: start → month 1, end → month 12, 'YYYY-MM' → its offset from
 *    start_month (dropped WITH A STATED REASON if outside the 12 months — never silently).
 *  - remaining occurrences land in the emptiest legal month; legal = at or after
 *    lead_time_months, at least spacing_months from a sibling occurrence, and (for
 *    heavy items) in a month with no other heavy item. Ties break to the earlier month,
 *    which keeps the whole thing deterministic.
 *  - every journey opens with the partnership announcement and closes with the review —
 *    fixed entries, not purchasable items (Marian confirmed both 2026-08-08).
 *
 * WHY deterministic rather than model-composed: a journey is a set of delivery commitments.
 * An invented "month 3: private dinner" for a buyer who bought no dinner is a promise ELC
 * cannot keep. The narrating AI writes prose AROUND this skeleton; it never edits it.
 */

export type JourneyCadence = "monthly" | "one-off" | "quarterly" | "half-yearly";

export interface JourneyMeta {
	cadence: JourneyCadence;
	lead_time_months?: number;
	anchor?: string; // 'start' | 'end' | 'YYYY-MM'
	spacing_months?: number;
	heavy?: boolean;
}

export interface JourneyItem {
	id: string;
	name: string;
	value: string;
	journey?: JourneyMeta;
}

export interface JourneyEntry {
	month: number; // 1-12
	item_id: string | null; // null for the fixed opener/closer
	title: string;
	detail: string;
}

export interface JourneyResult {
	start_month: string; // YYYY-MM
	months: JourneyEntry[]; // sorted by month, then insertion order
	recurring: { item_id: string; title: string; detail: string }[];
	unplaced: { item_id: string; reason: string }[];
}

const OCCURRENCES: Record<Exclude<JourneyCadence, "monthly">, number> = {
	"one-off": 1,
	"half-yearly": 2,
	quarterly: 4,
};

/** Months between two YYYY-MM strings (b - a). Pure arithmetic, no Date object. */
function monthDiff(a: string, b: string): number {
	const [ay, am] = a.split("-").map(Number);
	const [by, bm] = b.split("-").map(Number);
	return (by - ay) * 12 + (bm - am);
}

export function buildJourney(items: JourneyItem[], startMonth: string): JourneyResult {
	if (!/^\d{4}-\d{2}$/.test(startMonth)) {
		throw new Error(`start_month must be YYYY-MM, got "${startMonth}"`);
	}

	const recurring: JourneyResult["recurring"] = [];
	const unplaced: JourneyResult["unplaced"] = [];
	type Occ = { item: JourneyItem; meta: JourneyMeta; index: number; total: number };
	const anchored: Occ[] = [];
	const floating: Occ[] = [];

	for (const item of items) {
		const meta = item.journey ?? { cadence: "one-off" as const };
		if (meta.cadence === "monthly") {
			recurring.push({ item_id: item.id, title: item.name, detail: item.value });
			continue;
		}
		const total = OCCURRENCES[meta.cadence];
		for (let index = 0; index < total; index++) {
			(meta.anchor !== undefined && index === 0 ? anchored : floating).push({ item, meta, index, total });
		}
	}

	// month -> placed occurrences. Month 1 and 12 start pre-loaded with the fixed entries so
	// load-balancing sees them as busy months from the start.
	const placed = new Map<number, { occ: Occ }[]>();
	for (let m = 1; m <= 12; m++) placed.set(m, []);
	const byItem = new Map<string, number[]>(); // item id -> months used

	const monthLoad = (m: number) => placed.get(m)!.length + (m === 1 || m === 12 ? 1 : 0);
	const hasHeavy = (m: number) => placed.get(m)!.some((p) => p.occ.meta.heavy === true);

	function legal(occ: Occ, m: number): boolean {
		if (m < 1 + (occ.meta.lead_time_months ?? 0)) return false;
		const spacing = occ.meta.spacing_months ?? 0;
		const siblings = byItem.get(occ.item.id) ?? [];
		if (siblings.some((s) => Math.abs(s - m) < Math.max(1, spacing))) return false;
		if (occ.meta.heavy === true && hasHeavy(m)) return false;
		return true;
	}

	function put(occ: Occ, m: number) {
		placed.get(m)!.push({ occ });
		byItem.set(occ.item.id, [...(byItem.get(occ.item.id) ?? []), m]);
	}

	// 1. Anchors first — they are commitments to a point in time, everything else flexes.
	for (const occ of anchored) {
		const a = occ.meta.anchor!;
		let m: number;
		if (a === "start") m = 1;
		else if (a === "end") m = 12;
		else {
			m = monthDiff(startMonth, a) + 1;
			// ANNUAL EVENTS ROLL FORWARD (2026-08-08 Fable audit finding 1): the conference
			// happens every April, and a literal YYYY-MM anchor made it vanish from every
			// journey starting after that date. A past anchor advances by whole years until it
			// lands inside the window — April 2027 becomes April 2028 for a 2027-06 start.
			while (m < 1) m += 12;
			if (m > 12) {
				unplaced.push({
					item_id: occ.item.id,
					reason: `anchored to ${a}, which falls outside the 12 months from ${startMonth} — lands in the following partnership year`,
				});
				continue;
			}
		}
		put(occ, m);
	}

	// 2. Floating occurrences. Two regimes, both deterministic:
	//    - SERIES (quarterly/half-yearly): earliest-legal placement, so a quarterly item lands
	//      as a rhythm (1, 4, 7, 10) instead of being scattered by load-balancing until the
	//      last occurrence has no legal month left — the exact failure the first live Nebula
	//      run produced (linkedin-posts 4th occurrence unplaceable).
	//    - SINGLE one-offs: emptiest legal month, earlier wins ties — spreads the year.
	//    Ordered by constraint tightness (series first, then heavy, then longest lead) so the
	//    hardest-to-place get first pick.
	const rank = (o: Occ) => (o.total > 1 ? 1000 : 0) + (o.meta.heavy ? 100 : 0) + (o.meta.lead_time_months ?? 0);
	const stableFloating = floating
		.map((o, i) => ({ o, i }))
		.sort((x, y) => rank(y.o) - rank(x.o) || x.i - y.i)
		.map((x) => x.o);

	for (const occ of stableFloating) {
		let best: number | null = null;
		for (let m = 1; m <= 12; m++) {
			if (!legal(occ, m)) continue;
			if (occ.total > 1) {
				best = m; // series: earliest legal keeps the rhythm and guarantees fit when feasible
				break;
			}
			// Singles: emptiest month wins, but with a mild early bias (audit finding 3: pure
			// load-balancing drifted the least-constrained items to months 10-11, against the
			// approved "early, it feeds later items" rationale). Load dominates 4:1 so the year
			// still spreads; the month term breaks near-ties toward the front.
			const score = monthLoad(m) * 4 + m;
			if (best === null || score < monthLoad(best) * 4 + best) best = m;
		}
		if (best === null) {
			unplaced.push({ item_id: occ.item.id, reason: "no legal month left under its lead-time/spacing/heavy constraints" });
			continue;
		}
		put(occ, best);
	}

	// 3. Assemble, with the fixed opener and closer bracketing the year.
	const months: JourneyEntry[] = [
		{
			month: 1,
			item_id: null,
			title: "Partnership announcement",
			detail: "The partnership goes public: announcement from Marian on LinkedIn and in the newsletter, your logo live across ELC channels.",
		},
	];
	// Number series occurrences CHRONOLOGICALLY — the expansion index reflects placement order,
	// which read as "(3 of 4)" landing before "(1 of 4)" in the first live run.
	const chronoRank = new Map<string, number>();
	for (let m = 1; m <= 12; m++) {
		for (const { occ } of placed.get(m)!) {
			const n = occ.total > 1 ? ` (${(chronoRank.get(occ.item.id) ?? 0) + 1} of ${occ.total})` : "";
			chronoRank.set(occ.item.id, (chronoRank.get(occ.item.id) ?? 0) + 1);
			months.push({ month: m, item_id: occ.item.id, title: occ.item.name + n, detail: occ.item.value });
		}
	}
	months.push({
		month: 12,
		item_id: null,
		title: "Partnership review & renewal",
		detail: "The year in numbers: warm intros, hires, reach, rooms you were in. Renewal terms agreed while the results are on the table.",
	});
	months.sort((a, b) => a.month - b.month);

	return { start_month: startMonth, months, recurring, unplaced };
}
