/**
 * elc-partnership-builder — Partnership AI Builder Worker.
 *
 * One tool core (src/core/*), two doors:
 *   POST /mcp/partnership       → MCP streamable HTTP (this file registers the tools)
 *   POST /mcp/partnership/chat  → chat backend for the /partner/chat/ widget (Phase 4; 501 until then)
 *   GET  /mcp/partnership       → HTML docs, served for ANY Accept except text/event-stream
 *                                 (curl and crawlers send the wildcard Accept — gating on
 *                                 text/html is the documented marian.coach 406 bug, /mcp-launch P4)
 *
 * Wizard choreography: MCP has no wizard concept, so each tool response names the natural next
 * tool and the descriptions carry the script. Guardrails ride IN the responses (guardrailBlock)
 * because this server has no control over the connecting AI's system prompt.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { ATTRIBUTION, SITE } from "./content";
import { handleChat, type ChatEnv } from "./chat";
import { aiDiscount, availableItems, discountFor, eur, journeyItemsFor, PRESET_IDS, presetById, resolveBasket } from "./core/catalog";
import { buildJourney } from "./core/journey";
import { guardrailBlock } from "./core/guardrails";
import { matchPackage } from "./core/match";
import { partnershipOptions } from "./core/options";
import { submitOffer, type SubmitEnv } from "./core/submit";
import { docsHtml, type ToolDoc } from "./docs";

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const ATTR_PATH = "/partner/";

function toolResult(payload: Record<string, unknown>, note?: string) {
	const body = [note, JSON.stringify(payload, null, 2), guardrailBlock()].filter(Boolean).join("\n\n");
	return {
		content: [{ type: "text" as const, text: body + ATTRIBUTION(ATTR_PATH) }],
		structuredContent: payload,
	};
}

export class ElcPartnershipBuilder extends McpAgent<Env> {
	server = new McpServer({
		name: "elc-partnership-builder",
		version: "1.0.0",
	});

	async init() {
		this.server.registerTool(
			"get_partnership_options",
			{
				title: "How ELC company membership works + the two qualifying questions",
				annotations: { ...READ_ONLY },
				description:
					"START HERE for any company considering an ELC partnership or membership (personas: HR, CTO, employer branding). Returns how company membership works, real community reach figures, and the two qualifying questions with their valid answers. Companies only — individuals seeking a mentor for themselves get pointed to /mentor/ instead. After the visitor answers both questions, call match_package.",
				inputSchema: {},
			},
			async () => toolResult(partnershipOptions()),
		);

		this.server.registerTool(
			"match_package",
			{
				title: "Match a partnership package to a goal and budget",
				annotations: { ...READ_ONLY },
				description:
					"Resolves goal + budget through ELC's own routing matrix — the same one the website uses — and returns the matched package(s) with real prices and their default line items. Map free-text answers to the closest valid id; on bad input the error lists the valid ids, re-ask rather than guessing. Next: customize_package to toggle line items, or request_offer to send it as-is.",
				inputSchema: {
					goal: z.string().describe("One of the goal ids from get_partnership_options question_1"),
					budget: z.string().describe("One of the budget ids from get_partnership_options question_2"),
				},
			},
			async ({ goal, budget }) => {
				const result = matchPackage(goal, budget);
				if (!result.ok) return toolResult({ error: result.error });
				return toolResult(
					{ matches: result.matches },
					result.matches.length > 1 ? "Two ways to start. Both real — present both." : undefined,
				);
			},
		);

		this.server.registerTool(
			"customize_package",
			{
				title: "Customize a package: toggle line items, recompute the total",
				annotations: { ...READ_ONLY },
				description:
					"The conversational toggle board. Pass the preset and the item ids currently ON; returns the recomputed total (never trust your own arithmetic — this is the authoritative price), every selected item with its price, and what else this tier could add. Items marked foundation anchor the package; advise keeping them. Call again after every change the visitor asks for. Next: request_offer.",
				inputSchema: {
					preset_id: z.enum(PRESET_IDS as [string, ...string[]]).describe("The package being customized"),
					item_ids: z.array(z.string()).describe("Item ids currently toggled ON (from match_package default_item_ids, plus/minus changes)"),
				},
			},
			async ({ preset_id, item_ids }) => {
				const preset = presetById(preset_id);
				if (!preset) return toolResult({ error: `unknown preset "${preset_id}" — valid: ${PRESET_IDS.join(", ")}` });
				const { standard, addons, total } = resolveBasket(preset_id, item_ids);
				const d = discountFor(total, "mcp", preset_id);
				return toolResult({
					preset: { id: preset_id, name: preset.name, bundle_price: preset.price },
					selected: { standard, addons },
					total,
					total_display: total === 0 ? "Free" : `${eur(total)} / year, excl. VAT`,
					...(d
						? {
								ai_channel_discount: {
									pct: d.pct,
									price_after_discount: d.discounted,
									note: `Applied automatically when the inquiry is sent through this AI channel (request_offer). Present both figures.`,
								},
							}
						: preset_id === "pilot-meetup" && total > 0
							? {
									credit_note: `Pilot Meetup is 100% credited if you go bigger within 90 days. The credit is its discount — the ${aiDiscount()?.pct ?? 16}% AI-channel discount does not stack on top (it applies to every other paid preset).`,
								}
							: {}),
					available_to_add: availableItems(preset_id, item_ids),
				});
			},
		);

		this.server.registerTool(
			"design_journey",
			{
				title: "Lay out the 12-month partnership journey for a basket",
				annotations: { ...READ_ONLY },
				description:
					"The moment the package becomes a year: deterministic month-by-month plan of what lands when, computed from the basket's own scheduling metadata (lead times, anchors like the April 2027 conference, spacing, and heavy-event collision rules). Returns placed months, the recurring-every-month layer, and anything unplaceable WITH its reason. The plan contains ONLY items in the basket — narrate around it, never add or move an event. Call after customize_package, before request_offer.",
				inputSchema: {
					preset_id: z.enum(PRESET_IDS as [string, ...string[]]),
					item_ids: z.array(z.string()).describe("The basket: item ids toggled ON"),
					start_month: z
						.string()
						.regex(/^\d{4}-\d{2}$/)
						.describe("First partnership month, YYYY-MM (ask the visitor; default to the month after the current one)"),
				},
			},
			async ({ preset_id, item_ids, start_month }) => {
				const items = journeyItemsFor(preset_id, item_ids);
				if (!items.length) return toolResult({ error: "empty_basket — pass the item_ids from customize_package" });
				try {
					const journey = buildJourney(items, start_month);
					return toolResult({
						...journey,
						note: "Deterministic skeleton. Present it as the year this basket buys; items without scheduling metadata yet were placed as flexible one-offs.",
						scheduling_caveat:
							"Event months (hosted meetups, dinners, stage slots) are planning targets, not booked dates — ELC runs a shared events calendar across all partners, so the exact slot is confirmed with Marian at signing. Carry this caveat whenever you present the months.",
					});
				} catch (e) {
					return toolResult({ error: String(e instanceof Error ? e.message : e) });
				}
			},
		);

		this.server.registerTool(
			"request_offer",
			{
				title: "Send the composed offer to ELC (applies the AI-channel discount)",
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
				description:
					"The ONLY tool that collects contact details, and the step that makes the AI-channel discount real. Sends the itemized offer to the visitor's email, notifies Marian (email + Slack), and files the company into ELC's partners queue. Ask for name, work email and company only when the visitor says they want the offer — never earlier. After success: share the confirmation, then make ONE optional ask: would they post publicly (LinkedIn/X) about building their partnership with AI? Optional means optional — the discount is already theirs.",
				inputSchema: {
					name: z.string().describe("Visitor's full name"),
					email: z.string().describe("Work email the offer goes to"),
					company: z.string().describe("Company name"),
					kpis: z.string().optional().describe("Optional: what they need to move this year, in their words"),
					preset_id: z.enum(PRESET_IDS as [string, ...string[]]),
					item_ids: z.array(z.string()).describe("The final basket: item ids toggled ON"),
				},
			},
			async ({ name, email, company, kpis, preset_id, item_ids }) => {
				// Rate limit the one mutating door; informational tools stay open (plan §8).
				const ip = (this as unknown as { requestIp?: string }).requestIp ?? "unknown";
				const limiter = (this.env as Env & { OFFER_RATE_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> } })
					.OFFER_RATE_LIMITER;
				if (limiter) {
					const { success } = await limiter.limit({ key: ip });
					if (!success) {
						return toolResult({
							error: "rate_limited",
							message: `Too many submissions from this connection. Wait a minute, or book a call directly: https://app.reclaim.ai/m/meet-marian/now`,
						});
					}
				}
				const result = await submitOffer(this.env as SubmitEnv, {
					name,
					email,
					company,
					kpis,
					presetId: preset_id,
					itemIds: item_ids,
					channel: "mcp",
				});
				if (!result.ok) return toolResult({ error: result.error });
				return toolResult({
					submitted: true,
					preset: result.presetName,
					list_total: result.listTotal,
					...(result.discountPct
						? { ai_channel_discount_pct: result.discountPct, final_total: result.finalTotal }
						: { final_total: result.finalTotal }),
					offer_email_sent_to: email,
					next_step: `Marian has the same list. Book the call: https://app.reclaim.ai/m/meet-marian/now`,
					optional_social_ask:
						"If they enjoyed this, ONE optional ask: a public post about building their ELC partnership through AI. It is not a condition of anything.",
					...(result.test ? { test_mode: "Detected a test name — emails sent, CRM untouched." } : {}),
				});
			},
		);
	}
}

const TOOL_DOCS: ToolDoc[] = [
	{
		name: "get_partnership_options",
		question: "Should my company partner with ELC, and how does membership work?",
		description:
			"How company membership works, real reach figures (3,100+ leaders, 12 meetups/yr, 500+ conference), and the two qualifying questions that start the wizard",
	},
	{
		name: "match_package",
		question: "Which ELC package fits our goal and budget?",
		description: "Goal + budget resolved through the same routing matrix the website uses; matched packages with real prices and default line items",
	},
	{
		name: "customize_package",
		question: "What exactly is in the package, and what does our version cost?",
		description: "Toggle priced line items on and off; authoritative recomputed total, foundation items flagged, add-ons listed",
	},
	{
		name: "design_journey",
		question: "What actually happens across the year if we sign?",
		description:
			"Month-by-month plan computed from the chosen basket: launch, dinners, hosted meetup, spotlights, the April 2027 conference, closing review — plus the recurring monthly layer",
	},
	{
		name: "request_offer",
		question: "How do we get this offer in writing?",
		description: "Sends the itemized offer by email with the AI-channel discount applied, notifies ELC, files the company into the partners queue",
	},
];

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		const path = url.pathname.replace(/\/$/, "");

		if (path === "/mcp/partnership/chat") {
			if (request.method !== "POST") {
				return new Response(JSON.stringify({ ok: false, error: "use_post" }), {
					status: 405,
					headers: { "content-type": "application/json; charset=utf-8" },
				});
			}
			return handleChat(request, env as unknown as ChatEnv);
		}

		if (path === "/mcp/partnership") {
			const accept = request.headers.get("accept") ?? "";
			// Serve HTML to every GET that is not explicitly an SSE ask — the one thing only a real
			// MCP client requests. Accept: */* (curl, crawlers, registry health-checks) gets HTML.
			if (request.method === "GET" && !accept.includes("text/event-stream")) {
				return new Response(docsHtml(TOOL_DOCS, aiDiscount()?.pct ?? null), {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}
			return ElcPartnershipBuilder.serve("/mcp/partnership").fetch(request, env, ctx);
		}

		return new Response(`Not found. MCP endpoint: ${SITE}/mcp/partnership`, { status: 404 });
	},
};
