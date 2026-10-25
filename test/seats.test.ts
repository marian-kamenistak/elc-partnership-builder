/**
 * Per-seat pricing invariants.
 *
 * The finding these guard (2026-08-20, lowest-scoring persona): the circle package is a per-seat
 * product and the configurator could only express a fixed bundle, so an 8-seat buyer received a
 * 3-seat offer and was told they had budget left over. Silent in both directions.
 *
 * Since 2026-10-25 both seat packages are flat: Team Circle (id `starter`) €990 a seat from 3,
 * Team Seats (`team-seats`) €249 a seat from 5. One open-ended band each, no volume break.
 */
import { describe, expect, it } from "vitest";
import { bandFor, isSeatPriced, priceSeats, seatSpecFor } from "../src/core/seats";
import { presetById } from "../src/core/catalog";

const SEAT_PRESETS = ["starter", "team-seats"];

describe("seat pricing", () => {
	it("only the seat packages are seat-priced; fixed bundles ignore seats entirely", () => {
		for (const p of SEAT_PRESETS) expect(isSeatPriced(p), p).toBe(true);
		for (const p of ["hiring", "education", "product", "story", "free"]) {
			expect(isSeatPriced(p), p).toBe(false);
		}
		const r = priceSeats("hiring", 8);
		expect("error" in r && r.error).toBe("not_seat_priced");
	});

	it("the minimum-seat entry equals the published bundle price exactly", () => {
		// The identity that stops seat pricing and bundle pricing drifting apart.
		for (const p of SEAT_PRESETS) {
			const spec = seatSpecFor(p)!;
			const r = priceSeats(p, spec.minimum_seats);
			if ("error" in r) throw new Error(`${p}: ${r.error}`);
			expect(r.total, p).toBe(presetById(p)!.price);
		}
		expect(seatSpecFor("starter")!.minimum_seats).toBe(3);
		expect(seatSpecFor("team-seats")!.minimum_seats).toBe(5);
	});

	it("prices a flat rate per seat at every headcount", () => {
		const cases: [string, number, number, number][] = [
			// preset, seats, per seat, total
			["starter", 3, 990, 2970],
			["starter", 8, 990, 7920],
			["starter", 40, 990, 39600],
			["team-seats", 5, 249, 1245],
			["team-seats", 12, 249, 2988],
			["team-seats", 40, 249, 9960],
		];
		for (const [p, seats, perSeat, total] of cases) {
			const r = priceSeats(p, seats);
			if ("error" in r) throw new Error(`${p} ${seats}: ${r.error}`);
			expect(r.per_seat, `${p} ${seats} seats`).toBe(perSeat);
			expect(r.total, `${p} ${seats} seats`).toBe(total);
		}
	});

	it("refuses to price below the minimum instead of quoting fewer seats", () => {
		for (const n of [1, 2]) {
			const r = priceSeats("starter", n);
			expect("error" in r && r.error, `starter ${n} seats`).toBe("below_minimum");
		}
		for (const n of [1, 4]) {
			const r = priceSeats("team-seats", n);
			expect("error" in r && r.error, `team-seats ${n} seats`).toBe("below_minimum");
		}
	});

	it("rejects nonsense headcounts rather than composing something", () => {
		for (const p of SEAT_PRESETS) {
			for (const n of [0, -3, 2.5]) {
				const r = priceSeats(p, n);
				expect("error" in r, `${p} ${n}`).toBe(true);
			}
		}
	});

	it("always returns the full band table, so headcount can be chosen with the price visible", () => {
		const circle = priceSeats("starter", 4);
		if ("error" in circle) throw new Error(circle.error);
		expect(circle.bands).toEqual([{ seats: "3+", per_seat: 990 }]);
		const seats = priceSeats("team-seats", 6);
		if ("error" in seats) throw new Error(seats.error);
		expect(seats.bands).toEqual([{ seats: "5+", per_seat: 249 }]);
	});

	it("names no volume break on a flat price", () => {
		for (const p of SEAT_PRESETS) {
			const r = priceSeats(p, seatSpecFor(p)!.minimum_seats);
			if ("error" in r) throw new Error(r.error);
			expect(r.next_break, p).toBeUndefined();
		}
	});

	it("bands are contiguous and never more expensive as volume rises", () => {
		for (const p of SEAT_PRESETS) {
			const spec = seatSpecFor(p)!;
			for (let i = 1; i < spec.bands.length; i++) {
				expect(spec.bands[i].from, "no gap between bands").toBe((spec.bands[i - 1].to as number) + 1);
				expect(spec.bands[i].price, "volume must not get more expensive").toBeLessThan(spec.bands[i - 1].price);
			}
			// Every seat count from the minimum up resolves to exactly one band.
			for (let n = spec.minimum_seats; n <= 60; n++) expect(bandFor(p, n), `${p} ${n} seats`).toBeDefined();
		}
	});
});
