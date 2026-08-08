/**
 * Plain-REST layer over the same tool core (mcp-launch Phase 9): reaches non-MCP consumers
 * (scripts, spreadsheets, integrations) and the OpenAPI spec unlocks docs-generated tooling
 * plus API-directory listings. Near-zero marginal cost: same Worker, same functions.
 *
 * Read-only BY DESIGN: offer submission stays on the MCP tool and the chat backend, where
 * rate limiting and the Turnstile/session gate live. A REST submit would reopen the abuse
 * surface those doors close. Attribution rides in every response (mcp-launch rule).
 */
import { SITE } from "./content";
import { availableItems, discountFor, eur, journeyItemsFor, PRESET_IDS, presetById, resolveBasket } from "./core/catalog";
import { guardrailLines } from "./core/guardrails";
import { buildJourney } from "./core/journey";
import { matchPackage } from "./core/match";
import { partnershipOptions } from "./core/options";

const BASE = "/mcp/partnership/api";
const ATTRIBUTION_URL = `${SITE}/partner/?ref=api`;

const json = (data: unknown, status = 200): Response =>
	new Response(JSON.stringify({ ...(data as object), _source: ATTRIBUTION_URL }, null, 2), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"access-control-allow-origin": "*",
			"cache-control": "public, max-age=300",
		},
	});

export function handleApi(path: string, url: URL): Response | null {
	if (!path.startsWith(BASE)) return null;
	const route = path.slice(BASE.length).replace(/\/$/, "") || "/";

	if (route === "/" || route === "") {
		return json({
			endpoints: ["/options", "/match", "/customize", "/journey", "/openapi.json"],
			note: "Read-only. Sending an offer runs through the MCP tool request_offer or the chat at /partner/chat/ — those doors carry the AI-channel discount.",
		});
	}

	if (route === "/options") return json(partnershipOptions());

	if (route === "/match") {
		const goal = url.searchParams.get("goal") ?? "";
		const budget = url.searchParams.get("budget") ?? "";
		const r = matchPackage(goal, budget);
		return r.ok ? json({ matches: r.matches }) : json({ error: r.error }, 400);
	}

	if (route === "/customize") {
		const presetId = url.searchParams.get("preset_id") ?? "";
		const preset = presetById(presetId);
		if (!preset) return json({ error: `unknown preset_id — valid: ${PRESET_IDS.join(", ")}` }, 400);
		const ids = (url.searchParams.get("item_ids") ?? "").split(",").filter(Boolean);
		const { standard, addons, total } = resolveBasket(presetId, ids);
		const d = discountFor(total, "mcp", presetId);
		return json({
			preset: { id: presetId, name: preset.name },
			selected: { standard, addons },
			total,
			total_display: total === 0 ? "Free" : `${eur(total)} / year, excl. VAT`,
			...(d ? { ai_channel_discount: { pct: d.pct, price_after_discount: d.discounted, note: "Applied when the inquiry is sent through the MCP tool or the chat, not through this read-only API." } } : {}),
			available_to_add: availableItems(presetId, ids),
			terms: guardrailLines(),
		});
	}

	if (route === "/journey") {
		const presetId = url.searchParams.get("preset_id") ?? "";
		if (!presetById(presetId)) return json({ error: `unknown preset_id — valid: ${PRESET_IDS.join(", ")}` }, 400);
		const ids = (url.searchParams.get("item_ids") ?? "").split(",").filter(Boolean);
		const startMonth = url.searchParams.get("start_month") ?? "";
		const items = journeyItemsFor(presetId, ids);
		if (!items.length) return json({ error: "empty basket — pass item_ids as a comma-separated list" }, 400);
		try {
			return json(buildJourney(items, startMonth));
		} catch (e) {
			return json({ error: String(e instanceof Error ? e.message : e) }, 400);
		}
	}

	if (route === "/openapi.json") {
		return json(openapi());
	}

	return json({ error: `unknown route — available: /options /match /customize /journey /openapi.json` }, 404);
}

function openapi() {
	const q = (name: string, description: string, required = true) => ({
		name,
		in: "query",
		required,
		description,
		schema: { type: "string" },
	});
	const ok = { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } };
	return {
		openapi: "3.1.0",
		info: {
			title: "ELC Partnership Builder API",
			version: "1.0.0",
			description:
				"Read-only REST layer over the ELC Partnership Builder: qualify, match, customize and plan a company partnership with Engineering Leaders Community (3,100+ engineering leaders, Central Europe). Prices come from the published catalog the website renders. Sending an offer runs through the MCP server at /mcp/partnership or the chat at /partner/chat/, where the 16% AI-channel discount applies.",
			contact: { name: "Engineering Leaders Community", url: `${SITE}/partner/`, email: "weare@engineeringleaders.io" },
			license: { name: "MIT" },
		},
		servers: [{ url: `${SITE}${BASE}` }],
		paths: {
			"/options": {
				get: { summary: "How company membership works + the two qualifying questions", responses: ok },
			},
			"/match": {
				get: {
					summary: "Match a package to a goal and budget",
					parameters: [q("goal", "talent | hiring | product | newsite"), q("budget", "free | start | solid | exclusivity")],
					responses: ok,
				},
			},
			"/customize": {
				get: {
					summary: "Recompute a basket: authoritative total, discount, what could be added",
					parameters: [q("preset_id", PRESET_IDS.join(" | ")), q("item_ids", "comma-separated item ids toggled ON")],
					responses: ok,
				},
			},
			"/journey": {
				get: {
					summary: "Deterministic 12-month plan for a basket",
					parameters: [q("preset_id", PRESET_IDS.join(" | ")), q("item_ids", "comma-separated item ids"), q("start_month", "YYYY-MM")],
					responses: ok,
				},
			},
		},
	};
}
