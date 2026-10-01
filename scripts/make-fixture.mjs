/**
 * Regenerate src/data/offer-catalog.fixture.json (the redacted catalog CI tests against) from
 * the real, gitignored src/data/offer-catalog.json.
 *
 * Why it exists: the fixture used to be hand-made once (2026-09-05) and then drifted. Every
 * later catalog sync (Signature Meetup, the Community Launch ladder, the discount end date)
 * reached the real file but not the fixture, so CI tested a catalog that no longer existed
 * and stayed red from 2026-09-17. test/fixture.test.ts now fails locally whenever the two
 * disagree, pointing here.
 *
 * Redaction (same as the hand-made fixture): every `notes` field (internal pricing rationale)
 * becomes a placeholder, and the deliberately unpublished vendor tier is priced at 0.
 *
 * Usage, after `npm run offers:sync` in elc-web:
 *   node scripts/make-fixture.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NOTES = "[redacted for the public repo — internal pricing rationale, not published]";

export function redactCatalog(real) {
	const walk = (v) => {
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") {
			const out = {};
			for (const [k, x] of Object.entries(v)) out[k] = k === "notes" && x ? NOTES : walk(x);
			return out;
		}
		return v;
	};
	const c = walk(real);
	c.generatedAt = "[fixture — see src/data/offer-catalog.json for the real, generated file]";
	c.source = "FIXTURE — not the real catalog.yaml source";
	for (const p of c.presets ?? []) if (p.id === "vendor") p.price = 0;
	for (const i of c.items ?? []) if (i.tiers?.vendor) i.tiers.vendor.price = 0;
	return c;
}

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const real = JSON.parse(readFileSync(here("../src/data/offer-catalog.json"), "utf8"));
	writeFileSync(here("../src/data/offer-catalog.fixture.json"), JSON.stringify(redactCatalog(real), null, 2) + "\n");
	console.log("wrote src/data/offer-catalog.fixture.json");
}
