/**
 * Business case + budget fit invariants.
 *
 * The rule these guard: the server computes, the model narrates. Anything a CFO could check has
 * to be arithmetic here, and anything ELC has not published must never appear as a figure.
 */
import { describe, expect, it } from "vitest";
import { approvalMemo, buildBusinessCase, recruiterFeeBand, RECRUITER_FEE_HIGH, RECRUITER_FEE_LOW } from "../src/core/businesscase";
import { defaultBasket, discountFor, PRESET_IDS, resolveBasket } from "../src/core/catalog";
import { fitToBudget } from "../src/core/fit";

const basket = (p: string) => defaultBasket(p);

describe("business case: arithmetic is the server's job", () => {
	it("investment mirrors resolveBasket + discountFor exactly, never re-derived", () => {
		for (const p of PRESET_IDS) {
			const ids = basket(p);
			if (!ids.length) continue;
			const c = buildBusinessCase({ preset_id: p, item_ids: ids });
			if ("error" in c) throw new Error(`${p}: ${c.error}`);
			// Free short-circuits: a €0 package has nothing to justify (see the no_case_needed branch).
			if ("no_case_needed" in c) continue;
			const { total } = resolveBasket(p, ids);
			const d = discountFor(total, "mcp", p);
			expect(c.investment.list_total, p).toBe(total);
			expect(c.investment.final_total, p).toBe(d ? d.discounted : total);
		}
	});

	it("the Free package gets a route, not a €0 approval request", () => {
		const c = buildBusinessCase({ preset_id: "free", item_ids: basket("free") });
		expect("no_case_needed" in c && c.no_case_needed).toBe(true);
		expect(approvalMemo(c), "nobody asks a CFO to approve zero euros").toBe("");
	});

	it("branches on goal instead of arguing recruiter fees at everyone", () => {
		// The defect 8 of 11 personas reported: identical output regardless of what was bought.
		const edu = buildBusinessCase({ preset_id: "education", item_ids: basket("education") });
		const hire = buildBusinessCase({ preset_id: "hiring", item_ids: basket("hiring") });
		if ("error" in edu || "no_case_needed" in edu) throw new Error("education case missing");
		if ("error" in hire || "no_case_needed" in hire) throw new Error("hiring case missing");
		expect(edu.what_it_replaces).not.toEqual(hire.what_it_replaces);
		expect(edu.what_it_replaces.join(" ")).toContain("leadership-training");
		expect(hire.what_it_replaces.join(" ")).toContain("Agency fees");
		// And the training buyer gets a retention argument, not a recruiting one.
		expect(edu.retention, "talent goal must argue replacement cost").not.toBeNull();
		expect(edu.hiring).toBeNull();
		// No orphan recruiter assumption on a case that never uses the band.
		const product = buildBusinessCase({ preset_id: "product", item_ids: basket("product") });
		if ("error" in product || "no_case_needed" in product) throw new Error("product case missing");
		expect(product.assumptions.join(" ")).not.toContain("Recruiter fee band");
		expect(product.product_case).not.toBeNull();
	});

	it("suggests KPIs to track rather than leaving the column empty", () => {
		for (const p of ["hiring", "education", "product"]) {
			const c = buildBusinessCase({ preset_id: p, item_ids: basket(p) });
			if ("error" in c || "no_case_needed" in c) throw new Error(p);
			expect(c.kpis_to_track.length, p).toBeGreaterThan(0);
		}
	});

	it("never calls a non-annual package a year", () => {
		for (const p of ["leadership-pilot", "pilot-meetup"]) {
			const c = buildBusinessCase({ preset_id: p, item_ids: basket(p) });
			if ("error" in c || "no_case_needed" in c) throw new Error(p);
			expect(c.term.annual, p).toBe(false);
			const m = approvalMemo(c, "Tester");
			expect(m, `${p} memo must not claim 12 months`).not.toContain("for 12 months");
			expect(m, `${p} memo must not price per year`).not.toContain("/year");
		}
	});

	it("break-even is ceil(net / fee) and never rounds down to zero", () => {
		const c = buildBusinessCase({ preset_id: "hiring", item_ids: basket("hiring") });
		if ("error" in c) throw new Error(c.error);
		expect(c.hiring).not.toBeNull();
		// €10,080 net against the €15k-25k published band → 1 hire either way.
		expect(c.hiring?.break_even_hires).toBe("1 senior hire");
	});

	it("a supplied salary replaces the generic band with their own numbers", () => {
		const generic = recruiterFeeBand();
		expect(generic.low).toBe(RECRUITER_FEE_LOW);
		expect(generic.high).toBe(RECRUITER_FEE_HIGH);
		const theirs = recruiterFeeBand(85000);
		expect(theirs.low).toBe(12750);
		expect(theirs.high).toBe(21250);
		expect(theirs.basis).toContain("85,000");
	});

	it("the hiring comparison only appears when the basket actually buys hiring", () => {
		const edu = buildBusinessCase({ preset_id: "education", item_ids: basket("education") });
		if ("error" in edu) throw new Error(edu.error);
		expect(edu.hiring, "Education has no hiring items — do not argue recruiter ROI").toBeNull();
	});

	it("reach claims only cover what is in the basket", () => {
		const c = buildBusinessCase({ preset_id: "hiring", item_ids: ["marians-list"] });
		if ("error" in c) throw new Error(c.error);
		const labels = c.reach.map((r) => r.label);
		expect(labels).not.toContain("Newsletter opens per year");
		expect(labels).not.toContain("Conference");
	});

	it("every figure names its basis, so nothing reads as an unsourced number", () => {
		const c = buildBusinessCase({ preset_id: "hiring", item_ids: basket("hiring") });
		if ("error" in c) throw new Error(c.error);
		for (const f of [...c.figures, ...c.reach]) expect(f.basis.length, f.label).toBeGreaterThan(10);
	});

	it("never forecasts outcomes", () => {
		const c = buildBusinessCase({ preset_id: "hiring", item_ids: basket("hiring"), open_senior_roles: 4 });
		if ("error" in c) throw new Error(c.error);
		const blob = JSON.stringify(c).toLowerCase();
		for (const banned of ["you will hire", "guaranteed", "expect to hire", "projected hires"]) {
			expect(blob, `case must not promise outcomes: "${banned}"`).not.toContain(banned);
		}
		expect(c.hiring?.caveat).toContain("not a forecast");
	});

	it("rejects an empty basket rather than pricing nothing", () => {
		const c = buildBusinessCase({ preset_id: "hiring", item_ids: [] });
		expect("error" in c && c.error).toContain("empty_basket");
	});
});

describe("approval memo: the forwardable artifact", () => {
	const c = buildBusinessCase({
		preset_id: "hiring",
		item_ids: basket("hiring"),
		company: "Acme Fintech",
		open_senior_roles: 4,
		avg_first_year_salary: 85000,
		kpis: "Fill 4 senior backend roles.",
	});

	it("carries the ask, the price, the monthly split and the terms", () => {
		const m = approvalMemo(c, "Jana Novakova");
		expect(m).toContain("Subject: Approval request");
		expect(m).toContain("€10,080");
		expect(m).toContain("€840 a month");
		expect(m).toContain("Marian Kamenistak");
		expect(m).toContain("Jana Novakova");
		expect(m).toContain("Acme Fintech");
	});

	it("states its own assumptions, so the recipient can audit it", () => {
		const m = approvalMemo(c, "Jana Novakova");
		expect(m).toContain("Assumptions behind these numbers");
		expect(m).toContain("No hire count, retention rate, pipeline or conversion rate is forecast");
	});

	it("reads cleanly: no duplicated clause, no placeholder left in", () => {
		const m = approvalMemo(c, "Jana Novakova");
		expect(m).not.toContain("of a single placement of a single placement");
		expect(m).not.toMatch(/\bof a single agency placement of a single\b/);
		expect(m).not.toContain("undefined");
		expect(m).not.toContain("[company]");
		expect(m).not.toContain("NaN");
	});

	it("uses the community's own city list, correctly joined", () => {
		expect(approvalMemo(c)).toContain("Prague, Brno, Bratislava and Kraków");
	});
});

describe("fit_to_budget: deterministic, explainable composition", () => {
	it("never exceeds the stated ceiling", () => {
		for (const budget of [500, 2000, 5000, 8000, 12000, 40000]) {
			for (const p of PRESET_IDS) {
				if (!basket(p).length) continue;
				const f = fitToBudget({ preset_id: p, budget });
				if ("error" in f) continue;
				expect(f.fits.payable_total, `${p} @ ${budget}`).toBeLessThanOrEqual(budget);
			}
		}
	});

	it("is deterministic: same input twice, identical basket", () => {
		const a = JSON.stringify(fitToBudget({ preset_id: "hiring", budget: 8000 }));
		const b = JSON.stringify(fitToBudget({ preset_id: "hiring", budget: 8000 }));
		expect(a).toBe(b);
	});

	it("keeps free items — leaving them out is strictly worse", () => {
		const f = fitToBudget({ preset_id: "hiring", budget: 8000 });
		if ("error" in f) throw new Error(f.error);
		expect(f.fits.item_ids).toContain("learning-digest"); // €0
		expect(f.fits.item_ids).toContain("media-partner-network"); // €0
	});

	it("every exclusion carries a reason a person can argue with", () => {
		const f = fitToBudget({ preset_id: "hiring", budget: 8000 });
		if ("error" in f) throw new Error(f.error);
		expect(f.left_out.length).toBeGreaterThan(0);
		for (const e of f.left_out) expect(e.reason.length, e.id).toBeGreaterThan(15);
	});

	it("recommends the whole package when it already fits", () => {
		const f = fitToBudget({ preset_id: "hiring", budget: 20000 });
		if ("error" in f) throw new Error(f.error);
		expect(f.full_package_for_comparison.note).toContain("already fits");
	});

	it("prices against the AI-channel figure by default, list price on request", () => {
		const disc = fitToBudget({ preset_id: "hiring", budget: 10080 });
		const list = fitToBudget({ preset_id: "hiring", budget: 10080, against: "list" });
		if ("error" in disc || "error" in list) throw new Error("unexpected error");
		expect(disc.fits.discount_pct).toBe(16);
		expect(list.fits.discount_pct).toBe(0);
		// The discounted view buys strictly more for the same ceiling.
		expect(disc.fits.list_total).toBeGreaterThan(list.fits.list_total);
	});

	it("rejects a nonsense budget instead of composing something", () => {
		expect("error" in fitToBudget({ preset_id: "hiring", budget: -5 })).toBe(true);
		expect("error" in fitToBudget({ preset_id: "nope", budget: 5000 })).toBe(true);
	});

	it("reports must-have ids it could not honour rather than silently dropping them", () => {
		const f = fitToBudget({ preset_id: "hiring", budget: 600, must_have: ["hosted-meetup"] });
		if ("error" in f) throw new Error(f.error);
		expect(f.must_haves_that_did_not_fit).toContain("hosted-meetup");
	});
});
