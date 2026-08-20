/**
 * Per-seat pricing for the packages that are sold by headcount rather than as a fixed bundle.
 *
 * Why this exists (2026-08-20 persona testing): Team is a per-seat product living inside a
 * fixed-price configurator, and the mismatch was silent in both directions. The front door
 * advertised "Team from €900 a seat" exactly once, then no tool could express a seat count. An
 * Engineering Director asking for 8 seats got a €2,268 offer covering 3, and was told "€4,176 of
 * the budget is still unspent" — so the buyer would have believed their whole leadership team was
 * covered, and ELC would have under-delivered by five seats, with neither side finding out until
 * kickoff. It scored the lowest of all eleven personas.
 *
 * The band table was never the missing piece — `meta.per_seat.team` has carried it all along
 * (minimum 3 seats; 3-5 €900, 6-10 €820, 11-25 €740, 26+ €650). Nothing read it. This module is
 * the reader.
 *
 * Relationship to the bundle price: the preset's €2,700 IS the 3-seat entry (3 × €900), so seat
 * pricing and bundle pricing agree at the minimum and diverge above it, which is the intent.
 * A test pins that identity so the two can never drift.
 */
import { eur, meta } from "./catalog";

type Band = { from: number; to: number | null; price: number };
type SeatSpec = { unit: string; minimum_seats: number; bands: Band[] };

const seatSpecs = (meta as unknown as { per_seat?: Record<string, SeatSpec> }).per_seat ?? {};

/** Packages sold per seat. Anything absent here is a fixed bundle and ignores `seats` entirely. */
export const isSeatPriced = (presetId: string): boolean => Boolean(seatSpecs[presetId]);

export const seatSpecFor = (presetId: string): SeatSpec | undefined => seatSpecs[presetId];

/** The band a given seat count falls into. `to: null` means open-ended at the top. */
export function bandFor(presetId: string, seats: number): Band | undefined {
	const spec = seatSpecs[presetId];
	if (!spec) return undefined;
	return spec.bands.find((b) => seats >= b.from && (b.to === null || seats <= b.to));
}

export type SeatPrice = {
	seats: number;
	per_seat: number;
	total: number;
	total_display: string;
	minimum_seats: number;
	band: string;
	/** Every band, always returned. A buyer deciding headcount needs to see where the price drops. */
	bands: { seats: string; per_seat: number }[];
	next_break?: { at_seats: number; per_seat: number; note: string };
};

export function priceSeats(presetId: string, seats: number): SeatPrice | { error: string; message: string } {
	const spec = seatSpecs[presetId];
	if (!spec) {
		return {
			error: "not_seat_priced",
			message: `${presetId} is a fixed-price package, not sold per seat. Do not pass seats for it; use customize_package normally.`,
		};
	}
	if (!Number.isInteger(seats) || seats < 1) {
		return { error: "invalid_seats", message: `seats must be a whole number of people, got ${seats}.` };
	}
	if (seats < spec.minimum_seats) {
		return {
			error: "below_minimum",
			message: `${presetId} starts at ${spec.minimum_seats} seats. Quote ${spec.minimum_seats} and say so plainly rather than pricing fewer.`,
		};
	}
	const band = bandFor(presetId, seats);
	if (!band) return { error: "no_band", message: `No price band covers ${seats} seats. Book a call rather than guessing.` };

	const bandsOut = spec.bands.map((b) => ({
		seats: b.to === null ? `${b.from}+` : `${b.from} to ${b.to}`,
		per_seat: b.price,
	}));
	// The next volume break, so a buyer at 5 seats learns that 6 is cheaper per head. Stated as
	// information; whether it is worth adding a person is their call, not a nudge to make.
	const next = spec.bands.find((b) => b.from > seats);
	return {
		seats,
		per_seat: band.price,
		total: seats * band.price,
		total_display: `${eur(seats * band.price)} / year, excl. VAT (${seats} seats at ${eur(band.price)} each)`,
		minimum_seats: spec.minimum_seats,
		band: band.to === null ? `${band.from}+ seats` : `${band.from} to ${band.to} seats`,
		bands: bandsOut,
		...(next
			? {
					next_break: {
						at_seats: next.from,
						per_seat: next.price,
						note: `At ${next.from} seats the price drops to ${eur(next.price)} each. Mention it once as information, not as a push to add people they do not have.`,
					},
				}
			: {}),
	};
}
