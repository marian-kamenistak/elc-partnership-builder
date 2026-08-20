/**
 * Per-seat pricing invariants.
 *
 * The finding these guard (2026-08-20, lowest-scoring persona): Team is a per-seat product and
 * the configurator could only express a fixed €2,700, so an 8-seat buyer received a 3-seat offer
 * and was told they had budget left over. Silent in both directions.
 */
import { describe, expect, it } from "vitest";
import { bandFor, isSeatPriced, priceSeats, seatSpecFor } from "../src/core/seats";
import { presetById } from "../src/core/catalog";

describe("seat pricing", () => {
	it("only Team is seat-priced; fixed bundles ignore seats entirely", () => {
		expect(isSeatPriced("team")).toBe(true);
		for (const p of ["hiring", "education", "product", "story", "free"]) {
			expect(isSeatPriced(p), p).toBe(false);
		}
		const r = priceSeats("hiring", 8);
		expect("error" in r && r.error).toBe("not_seat_priced");
	});

	it("the 3-seat entry equals the published bundle price exactly", () => {
		// The identity that stops seat pricing and bundle pricing drifting apart.
		const spec = seatSpecFor("team")!;
		const r = priceSeats("team", spec.minimum_seats);
		expect("error" in r).toBe(false);
		if ("error" in r) return;
		expect(r.total).toBe(presetById("team")!.price);
	});

	it("walks the published volume bands", () => {
		const cases: [number, number, number][] = [
			// seats, per seat, total
			[3, 900, 2700],
			[5, 900, 4500],
			[6, 820, 4920],
			[8, 820, 6560],
			[11, 740, 8140],
			[25, 740, 18500],
			[26, 650, 16900],
			[40, 650, 26000],
		];
		for (const [seats, perSeat, total] of cases) {
			const r = priceSeats("team", seats);
			if ("error" in r) throw new Error(`${seats}: ${r.error}`);
			expect(r.per_seat, `${seats} seats`).toBe(perSeat);
			expect(r.total, `${seats} seats`).toBe(total);
		}
	});

	it("refuses to price below the minimum instead of quoting fewer seats", () => {
		for (const n of [1, 2]) {
			const r = priceSeats("team", n);
			expect("error" in r && r.error, `${n} seats`).toBe("below_minimum");
		}
	});

	it("rejects nonsense headcounts rather than composing something", () => {
		for (const n of [0, -3, 2.5]) {
			const r = priceSeats("team", n);
			expect("error" in r, `${n}`).toBe(true);
		}
	});

	it("always returns the full band table, so headcount can be chosen with the price visible", () => {
		const r = priceSeats("team", 4);
		if ("error" in r) throw new Error(r.error);
		expect(r.bands).toEqual([
			{ seats: "3 to 5", per_seat: 900 },
			{ seats: "6 to 10", per_seat: 820 },
			{ seats: "11 to 25", per_seat: 740 },
			{ seats: "26+", per_seat: 650 },
		]);
	});

	it("names the next volume break, and stops naming one at the top band", () => {
		const mid = priceSeats("team", 5);
		if ("error" in mid) throw new Error(mid.error);
		expect(mid.next_break?.at_seats).toBe(6);
		expect(mid.next_break?.per_seat).toBe(820);
		const top = priceSeats("team", 40);
		if ("error" in top) throw new Error(top.error);
		expect(top.next_break).toBeUndefined();
	});

	it("bands are contiguous and strictly cheaper as volume rises", () => {
		const spec = seatSpecFor("team")!;
		for (let i = 1; i < spec.bands.length; i++) {
			expect(spec.bands[i].from, "no gap between bands").toBe((spec.bands[i - 1].to as number) + 1);
			expect(spec.bands[i].price, "volume must not get more expensive").toBeLessThan(spec.bands[i - 1].price);
		}
		// Every seat count from the minimum up resolves to exactly one band.
		for (let n = spec.minimum_seats; n <= 60; n++) expect(bandFor("team", n), `${n} seats`).toBeDefined();
	});
});
