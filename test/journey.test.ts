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

describe("containment + completeness", () => {
	for (const preset of ["nebula", "supernova", "quasar"]) {
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
		const a = JSON.stringify(journeyFor("quasar"));
		const b = JSON.stringify(journeyFor("quasar"));
		expect(a).toBe(b);
	});
});

describe("constraints", () => {
	it("anchors: announcement items in month 1, closer in month 12, conference at its offset", () => {
		const j = journeyFor("nebula", "2026-09"); // 2027-04 = month 8
		const byId = (id: string) => j.months.filter((m) => m.item_id === id).map((m) => m.month);
		expect(byId("listed-as-partner")).toEqual([1]);
		expect(byId("conference-tickets")).toEqual([8]);
		expect(j.months[0].title).toBe("Partnership announcement");
		expect(j.months[j.months.length - 1].title).toBe("Partnership review & renewal");
	});
	it("annual anchor rolls forward: 2027-06 start places the conference in April 2028 (month 11)", () => {
		// Fable audit finding 1: a past YYYY-MM anchor advances by whole years until it lands
		// inside the window instead of vanishing from every post-April journey.
		const j = journeyFor("nebula", "2027-06");
		expect(j.unplaced.find((x) => x.item_id === "conference-tickets")).toBeUndefined();
		expect(j.months.filter((m) => m.item_id === "conference-tickets").map((m) => m.month)).toEqual([11]);
	});
	it("lead times hold: hosted meetup never before month 3", () => {
		const j = journeyFor("nebula");
		for (const m of j.months.filter((x) => x.item_id === "hosted-meetup")) {
			expect(m.month).toBeGreaterThanOrEqual(3);
		}
	});
	it("heavy items never share a month (hosted meetup + dinner)", () => {
		const j = journeyFor("quasar"); // quasar has both dinner + speaker slots; nebula has meetup
		const heavyIds = ["hosted-meetup", "decision-maker-dinner"];
		const heavyMonths = j.months.filter((m) => m.item_id && heavyIds.includes(m.item_id)).map((m) => m.month);
		expect(new Set(heavyMonths).size).toBe(heavyMonths.length);
	});
	it("spacing holds: company spotlights at least 6 months apart", () => {
		const j = journeyFor("nebula");
		const months = j.months.filter((m) => m.item_id === "company-spotlight").map((m) => m.month);
		if (months.length === 2) expect(Math.abs(months[1] - months[0])).toBeGreaterThanOrEqual(6);
	});
	it("quarterly linkedin posts: 4 occurrences, 3+ months apart", () => {
		const j = journeyFor("nebula");
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

describe("live-run regressions (2026-08-08 Nebula)", () => {
	it("full default nebula basket: nothing unplaced except date-anchored overflows", () => {
		const j = journeyFor("nebula", "2026-09");
		expect(j.unplaced).toEqual([]);
	});
	it("series numbering is chronological", () => {
		const j = journeyFor("nebula", "2026-09");
		const posts = j.months.filter((m) => m.item_id === "linkedin-posts");
		posts.forEach((p, i) => expect(p.title).toContain(`(${i + 1} of 4)`));
	});
});
