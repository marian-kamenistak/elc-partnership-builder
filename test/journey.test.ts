/**
 * Journey engine invariants (spec §12 + Marian's Pass 1 rules):
 *  - containment: no month contains an item absent from the basket
 *  - determinism: same input → identical output
 *  - constraints: lead times, spacing, heavy-collision, anchors all hold
 *  - nothing silently dropped: everything is placed, recurring, or unplaced-with-reason
 */
import { describe, expect, it } from "vitest";
import { defaultBasket, journeyItemsFor, PRESET_IDS } from "../src/core/catalog";
import { buildJourney } from "../src/core/journey";

const journeyFor = (preset: string, start = "2026-09") =>
	buildJourney(journeyItemsFor(preset, defaultBasket(preset)), start);

/**
 * 2026-08-20: this suite was written against the cosmic ladder (nebula/supernova/quasar). The
 * 7-package cutover made those presets legacy and stripped them from the generated catalog, so
 * `defaultBasket("nebula")` started returning [] — three tests went red and, worse, the three
 * containment tests went VACUOUSLY GREEN over an empty basket. Retargeted at the live
 * equivalents at the same price points (nebula→hiring €12K, supernova→education €15K,
 * quasar→product €20K), plus a guard below so an empty basket can never pass silently again.
 */
const LIVE = { hiring: "hiring", education: "education", product: "product" } as const;

describe("fixtures are real", () => {
	it("every preset this suite exercises has a non-empty basket", () => {
		for (const preset of Object.values(LIVE)) {
			expect(defaultBasket(preset).length, `${preset} basket is empty — is it legacy?`).toBeGreaterThan(0);
		}
	});
});

describe("containment + completeness", () => {
	for (const preset of Object.values(LIVE)) {
		it(`${preset}: every placed/recurring/unplaced id is in the basket, nothing vanishes`, () => {
			const basket = new Set(defaultBasket(preset));
			const j = journeyFor(preset);
			const seen = new Set<string>();
			for (const m of j.months) {
				if (m.item_id === null) continue; // fixed opener/closer
				expect(basket.has(m.item_id), m.item_id).toBe(true);
				seen.add(m.item_id);
			}
			for (const r of j.recurring) {
				expect(basket.has(r.item_id)).toBe(true);
				seen.add(r.item_id);
			}
			for (const u of j.unplaced) {
				expect(basket.has(u.item_id)).toBe(true);
				expect(u.reason.length).toBeGreaterThan(10);
				seen.add(u.item_id);
			}
			// completeness: every basket item with journey semantics shows up somewhere
			for (const id of basket) expect(seen.has(id), `${id} vanished`).toBe(true);
		});
	}
});

describe("determinism", () => {
	it("same input twice → byte-identical result", () => {
		const a = JSON.stringify(journeyFor(LIVE.product));
		const b = JSON.stringify(journeyFor(LIVE.product));
		expect(a).toBe(b);
	});
});

describe("constraints", () => {
	it("anchors: announcement items in month 1, closer in month 12, conference at its offset", () => {
		const j = journeyFor(LIVE.hiring, "2026-09"); // 2027-04 = month 8
		const byId = (id: string) => j.months.filter((m) => m.item_id === id).map((m) => m.month);
		expect(byId("listed-as-partner")).toEqual([1]);
		expect(byId("conference-tickets")).toEqual([8]);
		expect(j.months[0].title).toBe("Membership announcement");
		expect(j.months[j.months.length - 1].title).toBe("Membership review & renewal");
	});
	it("annual anchor rolls forward: 2027-06 start places the conference in April 2028 (month 11)", () => {
		// Fable audit finding 1: a past YYYY-MM anchor advances by whole years until it lands
		// inside the window instead of vanishing from every post-April journey.
		const j = journeyFor(LIVE.hiring, "2027-06");
		expect(j.unplaced.find((x) => x.item_id === "conference-tickets")).toBeUndefined();
		expect(j.months.filter((m) => m.item_id === "conference-tickets").map((m) => m.month)).toEqual([11]);
	});
	it("lead times hold: hosted meetup never before month 3", () => {
		const j = journeyFor(LIVE.hiring);
		for (const m of j.months.filter((x) => x.item_id === "hosted-meetup")) {
			expect(m.month).toBeGreaterThanOrEqual(3);
		}
	});
	it("heavy items never share a month (hosted meetup + dinner)", () => {
		const j = journeyFor(LIVE.product); // product carries both the dinner and the hosted meetup; hiring only the meetup
		const heavyIds = ["hosted-meetup", "decision-maker-dinner"];
		const heavyMonths = j.months.filter((m) => m.item_id && heavyIds.includes(m.item_id)).map((m) => m.month);
		expect(new Set(heavyMonths).size).toBe(heavyMonths.length);
	});
	it("spacing holds: company spotlights at least 6 months apart", () => {
		const j = journeyFor(LIVE.hiring);
		const months = j.months.filter((m) => m.item_id === "company-spotlight").map((m) => m.month);
		if (months.length === 2) expect(Math.abs(months[1] - months[0])).toBeGreaterThanOrEqual(6);
	});
	it("quarterly linkedin posts: 4 occurrences, 3+ months apart", () => {
		const j = journeyFor(LIVE.hiring);
		const months = j.months
			.filter((m) => m.item_id === "linkedin-posts")
			.map((m) => m.month)
			.sort((a, b) => a - b);
		expect(months.length).toBe(4);
		for (let i = 1; i < months.length; i++) expect(months[i] - months[i - 1]).toBeGreaterThanOrEqual(3);
	});
});

describe("input validation", () => {
	it("rejects malformed start_month", () => {
		expect(() => buildJourney([], "September 2026")).toThrow("YYYY-MM");
	});
	it("free tier: everything recurring or placed, no crash", () => {
		for (const preset of PRESET_IDS) expect(() => journeyFor(preset)).not.toThrow();
	});
});

describe("live-run regressions (2026-08-08, retargeted to Hiring 2026-08-20)", () => {
	it("full default hiring basket: nothing unplaced except date-anchored overflows", () => {
		const j = journeyFor(LIVE.hiring, "2026-09");
		expect(j.unplaced).toEqual([]);
	});
	it("series numbering is chronological", () => {
		const j = journeyFor(LIVE.hiring, "2026-09");
		const posts = j.months.filter((m) => m.item_id === "linkedin-posts");
		posts.forEach((p, i) => expect(p.title).toContain(`(${i + 1} of 4)`));
	});
});
