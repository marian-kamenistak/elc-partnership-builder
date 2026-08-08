/**
 * Core invariants (plan §Verification):
 *  - price parity: every preset's default basket totals its published bundle price
 *  - discount math: AI channels get round(total * 0.84), web never does, free never does
 *  - redaction: vendor tier and internal notes never leave the catalog module
 *  - routing: every matrix entry resolves to a real, priced match
 */
import { describe, expect, it } from "vitest";
import {
	aiDiscount,
	availableItems,
	defaultBasket,
	discountFor,
	liveItems,
	PRESET_IDS,
	presets,
	resolveBasket,
	routing,
} from "../src/core/catalog";
import { guardrailLines } from "../src/core/guardrails";
import { matchPackage } from "../src/core/match";
import { partnershipOptions } from "../src/core/options";

describe("price parity", () => {
	// The load-bearing invariant: the server can never quote a number the website disagrees with.
	for (const preset of presets) {
		it(`${preset.id}: default basket sums to the published ${preset.price}`, () => {
			const { total, addons } = resolveBasket(preset.id, defaultBasket(preset.id));
			expect(addons).toHaveLength(0); // defaults are standard-only
			expect(total).toBe(preset.price);
		});
	}
});

describe("discount", () => {
	it("is configured at 16% for chat and mcp, pilot-meetup excluded", () => {
		expect(aiDiscount()).toEqual({
			pct: 16,
			channels: ["chat", "mcp"],
			applies_to: "basket_total",
			excluded_presets: ["pilot-meetup"],
		});
	});
	it("computes round(total*0.84) on AI channels", () => {
		expect(discountFor(12000, "mcp")).toEqual({ pct: 16, discounted: 10080 });
		expect(discountFor(15000, "chat")).toEqual({ pct: 16, discounted: 12600 });
		expect(discountFor(20000, "mcp")).toEqual({ pct: 16, discounted: 16800 });
	});
	it("never applies to web or to a free basket", () => {
		expect(discountFor(12000, "web")).toBeNull();
		expect(discountFor(0, "mcp")).toBeNull();
	});
});

describe("redaction", () => {
	it("vendor tier never leaves the catalog module", () => {
		for (const item of liveItems) expect(Object.keys(item.tiers)).not.toContain("vendor");
		expect(PRESET_IDS).not.toContain("vendor");
		for (const preset of PRESET_IDS) {
			for (const a of availableItems(preset, [])) expect(a.id).not.toBe("vendor-seat");
		}
	});
	it("internal notes are stripped from live items", () => {
		for (const item of liveItems) expect(item).not.toHaveProperty("notes");
	});
});

describe("routing", () => {
	it("every goal x budget cell resolves to at least one priced match", () => {
		for (const budget of routing.budgets) {
			for (const goal of routing.goals) {
				const result = matchPackage(goal, budget);
				expect(result.ok, `${budget}/${goal}`).toBe(true);
				if (result.ok) {
					expect(result.matches.length).toBeGreaterThan(0);
					for (const m of result.matches) expect(m.price).toBeGreaterThanOrEqual(0);
				}
			}
		}
	});
	it("exclusivity budget lands on quasar + category-exclusivity at 32000", () => {
		const result = matchPackage("product", "exclusivity");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.matches[0].preset_id).toBe("quasar");
			expect(result.matches[0].included_addons).toContain("category-exclusivity");
			expect(result.matches[0].price).toBe(32000);
		}
	});
	it("bad input returns guidance, not a guess", () => {
		const result = matchPackage("world-domination", "solid");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("talent");
	});
});

describe("guardrails + options", () => {
	it("guardrails carry the fixed-terms lines and the discount amendment", () => {
		const text = guardrailLines().join(" ");
		expect(text).toContain("VAT excluded");
		expect(text).toContain("max 10 partners");
		expect(text).toContain("16% AI-channel discount");
		expect(text).toContain("Marian Kamenistak confirms");
	});
	it("options carry both questions, the mentor link-out, and no invented numbers", () => {
		const o = partnershipOptions();
		expect(o.question_1.options.map((x) => x.id).sort()).toEqual(["hiring", "newsite", "product", "talent"]);
		expect(o.question_2.options.map((x) => x.id)).toEqual(["free", "start", "solid", "exclusivity"]);
		expect(o.not_for).toContain("/mentor/");
		expect(o.community.members).toBe("3,100+");
	});
});

describe("match surfaces the AI-channel price", () => {
	it("every priced match carries ai_channel_price with both figures", () => {
		const result = matchPackage("hiring", "solid");
		expect(result.ok).toBe(true);
		if (result.ok) {
			const m = result.matches[0];
			expect(m.ai_channel_price).toEqual({
				pct: 16,
				price: Math.round(m.price * 0.84),
				display: expect.stringContaining("16% AI-channel discount"),
			});
			expect(m.summary).toContain("through this AI channel");
		}
	});
	it("the free match carries no discount field", () => {
		const result = matchPackage("talent", "free");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.matches[0].ai_channel_price).toBeUndefined();
	});
});

describe("no stacking: pilot-meetup keeps credit, not the pct", () => {
	it("discountFor skips excluded presets", () => {
		expect(discountFor(3500, "mcp", "pilot-meetup")).toBeNull();
		expect(discountFor(3500, "chat", "pilot-meetup")).toBeNull();
		expect(discountFor(3500, "mcp", "orbit")).toEqual({ pct: 16, discounted: 2940 });
	});
	it("pilot-meetup matches carry the credit framing, no ai_channel_price", () => {
		const result = matchPackage("hiring", "start");
		expect(result.ok).toBe(true);
		if (result.ok) {
			const pilot = result.matches.find((m) => m.preset_id === "pilot-meetup");
			expect(pilot).toBeDefined();
			expect(pilot!.ai_channel_price).toBeUndefined();
			expect(pilot!.summary).toContain("credit");
		}
	});
	it("guardrails state the exception", () => {
		expect(guardrailLines().join(" ")).toContain("never stack");
	});
});

describe("magnet at the entry point (eval e9 regression)", () => {
	it("options carry the discount as data with the exception named", () => {
		const o = partnershipOptions() as ReturnType<typeof partnershipOptions> & {
			ai_channel_discount?: { pct: number; what: string; exception: string };
		};
		expect(o.ai_channel_discount?.pct).toBe(16);
		expect(o.ai_channel_discount?.what).toContain("only discount");
		expect(o.ai_channel_discount?.exception).toContain("never stack");
	});
});
