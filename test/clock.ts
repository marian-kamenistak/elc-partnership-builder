import { afterAll, vi } from "vitest";
import { aiDiscount } from "../src/core/catalog";

/**
 * Pin Date to noon UTC on the AI-channel discount's last day, read from the catalog.
 *
 * Suites that assert discounted prices (10,080 for 12,000, and so on) otherwise go red the day
 * the catalog's end date passes, as they did on 2026-10-01 when the date was hard-coded here.
 * Expiry itself is tested explicitly against the same catalog date in core.test.ts.
 *
 * Call at module top level: it pins immediately, not in beforeAll, because some suites build
 * their fixtures while describe blocks are collected.
 */
export function pinClockInsideDiscountWindow(): void {
	const expires = aiDiscount()?.expires;
	if (expires) vi.setSystemTime(new Date(`${expires}T12:00:00Z`));
	afterAll(() => {
		vi.useRealTimers();
	});
}
