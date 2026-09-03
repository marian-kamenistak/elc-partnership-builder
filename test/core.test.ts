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
import { detectBoundaryConflicts, guardrailLines } from "../src/core/guardrails";
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
	it("is configured at 16% for chat and mcp, pilot-meetup excluded, dated not capped", () => {
		// cap_deals removed 2026-08-20: the one-winner race was unverifiable by construction and
		// contradicted the offer email, which asserts the discounted figure as the contract price.
		expect(aiDiscount()).toEqual({
			pct: 16,
			// webmcp joined 2026-08-27 (the visitor's own agent driving the configurator counts as the AI door).
			channels: ["chat", "mcp", "webmcp"],
			applies_to: "basket_total",
			excluded_presets: ["pilot-meetup"],
			expires: "2026-09-30",
		});
		expect(aiDiscount()?.cap_deals, "a deal cap reintroduces an unfalsifiable scarcity claim").toBeUndefined();
	});
	it("expiry is enforced server-side: dead after 30 September 2026", () => {
		expect(discountFor(12000, "mcp", "nebula", new Date("2026-09-30T12:00:00Z"))).toEqual({ pct: 16, discounted: 10080 });
		expect(discountFor(12000, "mcp", "nebula", new Date("2026-10-01T00:00:00Z"))).toBeNull();
	});
	it("guardrails state the end date and the 16-minute claim, and imply no race", () => {
		const text = guardrailLines().join(" ");
		expect(text).toContain("2026-09-30");
		expect(text).toContain("16 minutes");
		// The scarcity wording personas read as manufactured must not come back.
		for (const banned of ["FIRST partnership closed", "One winner", "one winner only", "Real scarcity"]) {
			expect(text, `guardrails must not imply a race: "${banned}"`).not.toContain(banned);
		}
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
	// Renamed from quasar in the 7-package cutover (2026-08-20): exclusivity now composes on
	// `product`, same €32,000 landing point.
	it("exclusivity budget lands on product + category-exclusivity at 32000", () => {
		const result = matchPackage("product", "exclusivity");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.matches[0].preset_id).toBe("product");
			expect(result.matches[0].included_addons).toContain("category-exclusivity");
			expect(result.matches[0].price).toBe(32000);
		}
	});
	it("bad input returns guidance, not a guess", () => {
		const result = matchPackage("world-domination", "solid");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("talent");
	});
	// The bug this suite missed for two weeks: start/talent pointed at legacy `orbit`, and
	// matchPackage threw an uncaught error rather than returning a guiding failure. Every cell
	// must resolve to a preset the builder can actually compose, and no cell may throw.
	it("no routing cell throws, and every match resolves to a live composable preset", () => {
		for (const budget of routing.budgets) {
			for (const goal of routing.goals) {
				expect(() => matchPackage(goal, budget), `${budget}/${goal} must not throw`).not.toThrow();
				const r = matchPackage(goal, budget);
				expect(r.ok, `${budget}/${goal} must resolve`).toBe(true);
				if (r.ok) {
					for (const m of r.matches) {
						expect(PRESET_IDS, `${budget}/${goal} → ${m.preset_id}`).toContain(m.preset_id);
						expect(m.default_item_ids.length, `${budget}/${goal} → ${m.preset_id} has an empty basket`).toBeGreaterThan(0);
					}
				}
			}
		}
	});
	it("every live package is reachable from some goal x budget cell", () => {
		const reachable = new Set<string>();
		for (const budget of routing.budgets) {
			for (const goal of routing.goals) {
				const r = matchPackage(goal, budget);
				if (r.ok) for (const m of r.matches) reachable.add(m.preset_id);
			}
		}
		for (const id of PRESET_IDS) {
			expect(reachable, `${id} ships but the wizard can never match into it`).toContain(id);
		}
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

describe("boundaries", () => {
	it("the terms block states what is not for sale, and why", () => {
		const text = guardrailLines().join(" ");
		expect(text).toContain("NOT FOR SALE");
		expect(text).toContain("pitching from an ELC stage");
		expect(text).toContain("outbound");
		expect(text).toContain("introductions");
		// The reason has to travel with the rule, or it reads as an arbitrary vendor restriction.
		expect(text).toContain("free for engineering leaders");
	});

	it("options carry the boundary as data, not only as an objection script", () => {
		const b = (partnershipOptions() as unknown as { boundaries?: { not_for_sale: string[]; why: string; what_you_can_have: string } }).boundaries;
		expect(b).toBeDefined();
		expect(b!.not_for_sale).toHaveLength(3);
		expect(b!.what_you_can_have, "always say what they CAN have").toBeTruthy();
	});

	it("flags the asks that would destroy the community", () => {
		// Verbatim shape of the four conditions a VP Sales persona submitted and had accepted.
		const ask =
			"Conditions for signing: (1) the full member export, emails loaded into our CRM for outbound; " +
			"(2) our AE presents a 15-minute product demo from the meetup stage, sales pitch included; " +
			"(3) Marian makes 10 warm intros; (4) badge scanners at the hosted meetup.";
		const flags = detectBoundaryConflicts(ask);
		expect(flags.length, "member data, stage pitching and intros must all flag").toBe(3);
		for (const f of flags) expect(f.rule.length).toBeGreaterThan(20);
	});

	it("does not flag an ordinary buyer describing an ordinary goal", () => {
		for (const clean of [
			"We need to hire 4 senior backend engineers this year and cut agency spend.",
			"Eight promoted-from-IC managers with no leadership training.",
			"We want our CTO on stage and our story told.",
			undefined,
		]) {
			expect(detectBoundaryConflicts(clean), String(clean)).toHaveLength(0);
		}
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

describe("the fighting layer (2026-08-09)", () => {
	it("options carry objection ammunition with real proof points", () => {
		const o = partnershipOptions() as ReturnType<typeof partnershipOptions> & {
			why_elc?: Record<string, string>;
		};
		expect(o.why_elc?.vs_recruiters).toContain("2.7");
		expect(o.why_elc?.vs_own_events).toContain("40+");
		expect(o.why_elc?.proof).toContain("Everpure");
		expect(o.why_elc?.proof).toContain("Ataccama");
	});
});

describe("three endings + free cross-sell (2026-08-09)", () => {
	it("options name all three endings with the free-layer link", () => {
		const o = partnershipOptions() as ReturnType<typeof partnershipOptions> & {
			endings?: Record<string, string>;
		};
		expect(o.endings?.offer).toContain("request_offer");
		expect(o.endings?.intro_call).toContain("book_intro_call");
		expect(o.endings?.free_start).toContain("/partner/membership/free/");
	});
});

// ── One-offs (/reach, 2026-09-03) ────────────────────────────────────────────────────────────
import { ONEOFF_IDS, oneoffMeta, oneoffs, quoteOneoffs } from "../src/core/catalog";
import { reachOptions } from "../src/core/reach";

describe("one-offs", () => {
	it("ship nine items with resolved outcomes and no placeholders or notes", () => {
		expect(oneoffs.length).toBeGreaterThanOrEqual(9);
		for (const o of oneoffs) {
			expect(o.price).toBeGreaterThan(0);
			expect(o.examples.length).toBeGreaterThanOrEqual(2);
			for (const line of o.outcomes) expect(line).not.toMatch(/\{[a-z_]+\.[a-z0-9_]+\}/);
			expect((o as Record<string, unknown>).notes).toBeUndefined();
		}
	});

	it("hosted meetup one-off equals the Pilot Meetup preset price (one meetup, one standalone price)", () => {
		const meetup = oneoffs.find((o) => o.item === "hosted-meetup");
		const pilot = presets.find((p) => p.id === "pilot-meetup");
		expect(meetup?.price).toBe(pilot?.price);
		expect(pilot?.price).toBe(4000);
	});

	it("combo discount: 1 item none, 2 items 10%, 3+ items 15%, job listing never counts", () => {
		expect(oneoffMeta?.combo_discounts).toEqual([
			{ min_items: 2, pct: 10 },
			{ min_items: 3, pct: 15 },
		]);
		const one = quoteOneoffs(["newsletter-section"]);
		expect(one.combo).toBeNull();
		expect(one.total).toBe(2500);

		const two = quoteOneoffs(["newsletter-section", "newsletter-dedicated"]);
		expect(two.list_total).toBe(7500);
		expect(two.combo).toEqual({ qualifying_items: 2, pct: 10, saved: 750 });
		expect(two.total).toBe(6750);

		const three = quoteOneoffs(["newsletter-section", "newsletter-dedicated", "linkedin-post"]);
		expect(three.list_total).toBe(8000);
		expect(three.combo?.pct).toBe(15);
		expect(three.total).toBe(6800);

		// A job listing rides at list price and does not lift the basket into a discount tier.
		const withJob = quoteOneoffs(["newsletter-section", "job-listing"]);
		expect(withJob.combo).toBeNull();
		expect(withJob.total).toBe(3000);
		expect(withJob.items.find((i) => i.id === "job-listing")?.counts_toward_combo).toBe(false);
	});

	it("drops unknown ids by name and de-duplicates", () => {
		const q = quoteOneoffs(["dinner", "dinner", "nope"]);
		expect(q.items).toHaveLength(1);
		expect(q.unknown_ids).toEqual(["nope"]);
		expect(q.total).toBe(4000);
	});

	it("reach options carry every id, the credit, and the not-for-sale boundary", () => {
		const r = reachOptions();
		expect(r.items.map((i) => i.id)).toEqual(ONEOFF_IDS);
		expect(r.credit).toContain("90 days");
		expect(r.not_for_sale.length).toBeGreaterThanOrEqual(3);
		expect(JSON.stringify(r)).not.toMatch(/sponsor/i);
	});
});
