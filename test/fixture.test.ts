/**
 * The CI fixture must be the redacted real catalog, not a stale snapshot of it.
 *
 * Locally src/data/offer-catalog.json is the real catalog, so this fails the moment a sync
 * changes it without `node scripts/make-fixture.mjs`. In CI that file IS the fixture, and
 * redacting it again is a no-op, so the test passes there by construction.
 */
import { describe, expect, it } from "vitest";
import real from "../src/data/offer-catalog.json";
import fixture from "../src/data/offer-catalog.fixture.json";
import { redactCatalog } from "../scripts/make-fixture.mjs";

describe("CI fixture", () => {
	it("equals the redacted real catalog (run `node scripts/make-fixture.mjs` after a sync)", () => {
		expect(fixture).toEqual(redactCatalog(real));
	});
});
