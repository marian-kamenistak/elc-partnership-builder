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
import { handleApi } from "./api";
import { handleChat, type ChatEnv } from "./chat";
import { POSTHOG_KEY } from "./llm-analytics";
import { handleReclaimHook, type ReclaimEnv } from "./reclaim";
import { resolveSecrets } from "./lib/read-secret";
import { aiDiscount, availableItems, discountFor, eur, journeyItemsFor, ONEOFF_IDS, PRESET_IDS, presetById, quoteOneoffs, resolveBasket } from "./core/catalog";
import { reachOptions } from "./core/reach";
import { approvalMemo, buildBusinessCase } from "./core/businesscase";
import { fitToBudget } from "./core/fit";
import { isSeatPriced, priceSeats, seatSpecFor } from "./core/seats";
import { buildJourney } from "./core/journey";
import { detectBoundaryConflicts, guardrailBlock } from "./core/guardrails";
import { matchPackage } from "./core/match";
import { partnershipOptions } from "./core/options";
import { submitOffer, type SubmitEnv } from "./core/submit";
import { docsHtml, type ToolDoc } from "./docs";
import {
	geoFromRequest,
	instrumentMcpUsage,
	type McpGeo,
	type McpUsageConfig,
	type McpUsageEnv,
} from "./mcp-usage";
import { getMoreToolsResult } from "@posthog/mcp";

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const ATTR_PATH = "/partner/";

/**
 * Every successful tool response carries the fixed-terms block and the attribution footer.
 *
 * Error responses do NOT (2026-08-20 persona testing): eleven simulated buyers each hit several
 * validation errors, and stapling twelve lines of VAT law, exclusivity caps and a discount
 * countdown onto `{"error": "unknown preset"}` read as nagging by the third repeat and as
 * desperate by the tenth. One tester named it the single most off-putting thing in the flow —
 * being pitched a deadline while still failing to describe their own problem. Terms belong on
 * priced answers, which is the only place they mean anything.
 */
function toolResult(payload: Record<string, unknown>, note?: string) {
	const isError = "error" in payload;
	const body = [note, JSON.stringify(payload, null, 2), isError ? null : guardrailBlock()].filter(Boolean).join("\n\n");
	return {
		content: [{ type: "text" as const, text: body + (isError ? "" : ATTRIBUTION(ATTR_PATH)) }],
		structuredContent: payload,
	};
}

/** Shared by both `get_started` and `get_more_tools`'s greeting branch (see below) — one
 *  source of truth for the menu text so the two entry points never drift apart. */
function getStartedResult() {
	const menu = TOOL_DOCS.map(
		(d) => `- "${d.question}" → \`${d.name}\`: ${d.description}`,
	).join("\n");
	return toolResult({
		what: "This is the Engineering Leaders Community Partnership Builder — it composes and prices a company membership package with ELC, and quotes single one-off items (a newsletter section, a hosted meetup, a dinner) for companies that want one thing once.",
		menu,
		start_here: "For a company considering a year-long membership, call get_partnership_options next. For one thing once, call get_reach_options.",
	});
}

/** Matches a bare liveness/greeting ping — "hi", "test", "are you there" — as opposed to a
 *  real described capability gap. Deliberately an exact (trimmed, punctuation-stripped)
 *  match, not a "starts with": a genuine gap report is a sentence, and a loose prefix match
 *  would swallow real ones that happen to start with a greeting word. */
const GREETING_PING =
	/^(hi+|hello+|hey+|yo+|sup|howdy|hola|ahoy|ping|test(ing)?|are you (there|working|alive)|is (this|anyone) (working|there)|still there|you there|greetings|what('?s| is) up)[.!?\s]*$/i;

/** See src/mcp-usage.ts. Note this server ALREADY Slacks on conversion (see reclaim.ts and
 *  core/submit.ts). This instrumentation covers the other ~95% — every session that explores
 *  packages and leaves without submitting, which until now was completely invisible. */
const USAGE_CONFIG: McpUsageConfig = {
	serverName: "elc-partnership-builder",
	domain: "engineeringleaders.io",
	// One source of truth for the project key across both doors — the MCP door here and the
	// chat door's LLM analytics. They must stay the same project or the two halves of the
	// funnel stop joining.
	posthogKey: POSTHOG_KEY,
};

export class ElcPartnershipBuilder extends McpAgent<Env, unknown, McpGeo> {
	server = new McpServer({
		name: "elc-partnership-builder",
		version: "1.0.0",
	});

	async init() {
		instrumentMcpUsage({
			server: this.server,
			config: USAGE_CONFIG,
			env: this.env as McpUsageEnv,
			geo: this.props ?? {},
			waitUntil: (p) => this.ctx.waitUntil(p),
		});

		this.server.registerTool(
			"get_started",
			{
				title: "Start here — what can this MCP server do?",
				annotations: { ...READ_ONLY },
				description:
					"Call this for a greeting (hi, hello), a connectivity/liveness test, 'what can you do', or any message too general to match a specific tool below. Returns the full menu of real questions this server answers, each mapped to the tool name that answers it. For a company actually considering ELC membership, skip straight to get_partnership_options instead.",
				inputSchema: {},
			},
			async () => getStartedResult(),
		);

		this.server.registerTool(
			"get_more_tools",
			{
				title: "Report a missing capability — also answers a bare hello/liveness ping",
				annotations: { ...READ_ONLY },
				description:
					"Check for additional tools whenever your task might benefit from specialized capabilities, even if existing tools could work as a fallback. Also the right tool for a bare greeting (hi, hello), a connectivity/liveness test, or any message too general to match a specific tool below — pass it as `context` and this returns the full menu instead of a dead end.",
				inputSchema: {
					context: z
						.string()
						.describe(
							"A description of your goal and what kind of tool would help accomplish it, OR a plain greeting/liveness ping like 'hi' or 'test'.",
						),
				},
			},
			async ({ context }) =>
				GREETING_PING.test(context.trim()) ? getStartedResult() : { content: getMoreToolsResult().content },
		);

		this.server.registerTool(
			"get_reach_options",
			{
				title: "One-offs: single items a company buys once, with prices",
				annotations: { ...READ_ONLY },
				description:
					"START HERE when a company wants ONE thing once, not a year-long membership: a section or a dedicated send in the Leaders' Brief newsletter, a meetup hosted in their office, a podcast episode, a decision-maker dinner, a community survey, a demo session, a LinkedIn post, a job board listing. Returns every one-off with its price, lead time, examples and real reach figures, the combo discount rule, the 90-day credit against a membership, and what is not for sale. Two or more things across a year is a membership conversation: hand over to get_partnership_options. Next: quote_reach_combo once items are picked.",
				inputSchema: {},
			},
			async () => toolResult(reachOptions()),
		);

		this.server.registerTool(
			"quote_reach_combo",
			{
				title: "Price a one-off basket (authoritative total with the combo discount)",
				annotations: { ...READ_ONLY },
				description:
					"Pass the one-off ids the visitor picked; returns each item's price, the list total, the combo discount by item count (job board listings never count), and the final total. This is the only arithmetic that counts — never add prices yourself. The AI-channel percentage does not apply to one-offs. Next: book_intro_call to lock the date, or get_partnership_options if the basket is starting to look like a year.",
				inputSchema: {
					oneoff_ids: z.array(z.enum(ONEOFF_IDS as [string, ...string[]])).min(1).describe("One-off ids from get_reach_options"),
				},
			},
			async ({ oneoff_ids }) => {
				const q = quoteOneoffs(oneoff_ids);
				if (!q.items.length) return toolResult({ error: `no known one-offs in ${JSON.stringify(oneoff_ids)} — valid: ${ONEOFF_IDS.join(", ")}` });
				const membershipHint =
					q.items.length >= 3
						? "Three or more one-offs is usually the point where a company membership costs less for more. Say so and offer get_partnership_options; the one-offs are 100% credited if they take it."
						: undefined;
				return toolResult({
					...q,
					list_total_display: eur(q.list_total),
					total_display: `${eur(q.total)} one-off, excl. VAT`,
					credit_note: `100% credited against a company membership signed within ${q.credit_days} days.`,
					...(membershipHint ? { membership_hint: membershipHint } : {}),
					next: "book_intro_call to fix the date with Marian.",
				});
			},
		);

		this.server.registerTool(
			"get_partnership_options",
			{
				title: "How ELC company membership works + the two qualifying questions",
				annotations: { ...READ_ONLY },
				description:
					"START HERE for any company considering an ELC membership (personas: HR, CTO, employer branding). Returns how company membership works, real community reach figures, and the two qualifying questions with their valid answers. Companies only — individuals seeking a mentor for themselves get pointed to /mentor/ instead. After the visitor answers both questions, call match_package.",
				inputSchema: {},
			},
			async () => toolResult(partnershipOptions()),
		);

		this.server.registerTool(
			"match_package",
			{
				title: "Match a membership package to a goal and budget",
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
					seats: z
						.number()
						.optional()
						.describe("Starter only: how many people they are enrolling. Starter is priced per seat with volume bands, so ALWAYS ask for a headcount before quoting it — the bundle price is only the 3-seat entry."),
				},
			},
			async ({ preset_id, item_ids, seats }) => {
				const preset = presetById(preset_id);
				if (!preset) return toolResult({ error: `unknown preset "${preset_id}" — valid: ${PRESET_IDS.join(", ")}` });
				// An empty basket used to price a €12,000 package as "Free" (2026-08-20 persona testing:
				// every one of eleven testers hit this, and several briefly believed it). A paid preset
				// rendering as €0 is the worst failure mode a configurator has, so it is now a guiding
				// error instead of a confident wrong answer.
				if (!item_ids.length) {
					return toolResult({
						error: "empty_basket",
						message: `Nothing is selected, so there is nothing to price — this is NOT a free package. ${preset.name} lists at ${eur(preset.price)}. Pass default_item_ids from match_package to price the standard bundle, then toggle from there.`,
					});
				}
				const { standard, addons, total } = resolveBasket(preset_id, item_ids);
				// Unknown or wrong-tier ids used to vanish silently, so a basket could quietly lose items and
				// still return a confident total. Name them: "this package does not sell that" is a real
				// answer, and the silence let testers believe they had bought things they had not.
				const resolvedIds = new Set([...standard, ...addons].map((i) => i.id));
				const dropped = item_ids.filter((id) => !resolvedIds.has(id));
				// Starter is sold per seat, so the fixed bundle total is only right at the 3-seat minimum.
				// Quoting it to a buyer with eight leaders under-delivers by five people, and neither side
				// finds out until kickoff (2026-08-20 persona finding). When a headcount is given, seats are
				// the price; when it is not, say so rather than letting the bundle figure stand as a quote.
				const seatPricing = isSeatPriced(preset_id) && seats !== undefined ? priceSeats(preset_id, seats) : null;
				if (seatPricing && "error" in seatPricing) return toolResult(seatPricing as unknown as Record<string, unknown>);
				const effectiveTotal = seatPricing ? seatPricing.total : total;
				const d = discountFor(effectiveTotal, "mcp", preset_id);
				return toolResult({
					...(seatPricing
						? { seat_pricing: seatPricing }
						: isSeatPriced(preset_id)
							? {
								seats_not_yet_known: {
									minimum_seats: seatSpecFor(preset_id)?.minimum_seats,
									note: `${preset.name} is priced per seat. The total below is the ${seatSpecFor(preset_id)?.minimum_seats}-seat entry only. Ask how many people they are enrolling, then call again with seats — do not present this figure as their price.`,
								},
								}
							: {}),
					...(dropped.length
						? {
							not_available_in_this_package: {
								item_ids: dropped,
								note: `Not sold in ${preset.name}, so NOT included in the total below. Tell the visitor plainly rather than letting them assume it is in there — some items exist only in other packages.`,
							},
							}
						: {}),
					preset: { id: preset_id, name: preset.name, bundle_price: preset.price },
					selected: { standard, addons },
					total: effectiveTotal,
					total_display: seatPricing ? seatPricing.total_display : effectiveTotal === 0 ? "Free" : `${eur(effectiveTotal)} / year, excl. VAT`,
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
				"book_intro_call",
				{
					title: "Book an intro meeting with Marian (the human ending)",
					annotations: { ...READ_ONLY },
					description:
						"The second legitimate ending besides request_offer: a direct booking link for a 1:1 intro meeting with Marian Kamenistak, ELC's founder. Offer it whenever the visitor hesitates, wants a human, or the package needs tailoring beyond the catalog. No contact details collected here — the booking page handles everything. Pass preset_id and item_ids if a package was composed: the response then carries a paste-ready booking note, so the call starts from their numbers instead of from scratch.",
					inputSchema: {
						preset_id: z
							.enum(PRESET_IDS as [string, ...string[]])
							.optional()
							.describe("Optional: the package composed so far, if any"),
						item_ids: z.array(z.string()).optional().describe("Optional: the basket composed so far, if any"),
					},
				},
				// 2026-08-20: this used to return a bare link plus a tip telling the visitor to remember
				// their own basket and recite it on the call. Anyone who booked instead of requesting an
				// offer therefore arrived with nothing attached, losing the composed package at exactly
				// the moment intent was highest. The basket now comes back as a paste-ready line. Still
				// no contact details collected here.
				async ({ preset_id, item_ids }) => {
					const base = {
						booking_url: "https://app.reclaim.ai/m/meet-marian/now",
						what: "Direct calendar booking, 30 minutes with Marian. No form before it, no qualification call script — the conversation starts from whatever was built here.",
						also: "Not ready for either? The free layer runs today, no invoice: https://www.engineeringleaders.io/partner/membership/free/",
					};
					if (!preset_id || !item_ids?.length) {
						return toolResult({
							...base,
							tip: "No package composed yet — that is fine, the call can start from the two questions. If one gets built first, call this tool again with the basket so the booking note carries it.",
						});
					}
					const preset = presetById(preset_id);
					const { standard, addons, total } = resolveBasket(preset_id, item_ids);
					const d = discountFor(total, "mcp", preset_id);
					const count = standard.length + addons.length;
					return toolResult({
						...base,
						composed_package: {
							package: preset?.name ?? preset_id,
							items: count,
							list_total: total,
							...(d ? { ai_channel_total: d.discounted, discount_pct: d.pct } : {}),
						},
						booking_note: `${preset?.name ?? preset_id} package, ${count} items, ${eur(d ? d.discounted : total)}/year${d ? ` (incl. ${d.pct}% AI-channel discount)` : ""}. Built with the ELC membership builder.`,
						tip: "Give the visitor the booking_note verbatim and tell them to paste it into the booking form's note field. That is what carries their basket to Marian — do not rely on them remembering it.",
						...(d
							? {
									discount_caveat:
										"Booking a call does not itself lock the AI-channel discount; sending the offer through request_offer is what registers it. Say so plainly rather than implying the call preserves it.",
								}
							: {}),
					});
				},
			);

			this.server.registerTool(
				"fit_to_budget",
				{
					title: "Compose the best package for an exact budget",
					annotations: { ...READ_ONLY },
					description:
						"Use when the visitor names a NUMBER rather than a band — 'we have 8,000 approved', 'can we do this for five thousand'. Returns a deterministic best-value composition under that ceiling: what fits, what was left out AND why, how much budget is unspent, and what the cheapest excluded item costs. Foundation items are kept first, then the remaining items cheapest-first so the budget buys as much as possible. Priced against the AI-channel figure by default, since that is what they would actually pay. Never hand-pick a basket yourself when a budget is stated — this tool is the authoritative composition, the same way customize_package is the authoritative total.",
					inputSchema: {
						preset_id: z.enum(PRESET_IDS as [string, ...string[]]).describe("The package to trim to budget (from match_package)"),
						budget: z.number().describe("The visitor's ceiling in EUR, as a number (8000, not '8K')"),
						must_have: z
							.array(z.string())
							.optional()
							.describe("Optional: item ids the visitor explicitly asked for; kept first if they fit"),
						against: z
							.enum(["discounted", "list"])
							.optional()
							.describe("Price the budget against the AI-channel figure (default) or the list price"),
					},
				},
				async ({ preset_id, budget, must_have, against }) =>
					toolResult(fitToBudget({ preset_id, budget, must_have, against }) as unknown as Record<string, unknown>),
			);

			this.server.registerTool(
				"build_business_case",
				{
					title: "Compute the ROI case and a forwardable approval memo",
					annotations: { ...READ_ONLY },
					description:
						"Turns a composed basket into the argument that gets it approved: recruiter-fee equivalence, break-even hire count, cost per room, cost per month, what the spend replaces, and every assumption behind those numbers. Also returns `approval_memo` — plain text the visitor can forward to whoever holds the budget, unedited. Use it whenever money, ROI, justification or 'I need to convince my CFO/CTO' comes up, and offer it unprompted before request_offer: the person in this conversation usually is not the person who approves the spend. Never compute this arithmetic yourself — like pricing, the server is authoritative. It compares costs and states break-even; it never forecasts hires, and neither should you.",
					inputSchema: {
						preset_id: z.enum(PRESET_IDS as [string, ...string[]]).describe("The package being justified"),
						item_ids: z.array(z.string()).describe("The basket: item ids toggled ON"),
						company: z.string().optional().describe("Optional: company name, for the memo"),
						requester_name: z.string().optional().describe("Optional: who is asking for approval, signed at the memo's foot"),
						open_senior_roles: z
							.number()
							.optional()
							.describe("Optional: senior roles they need to fill in 12 months — sharpens the comparison into their numbers"),
						avg_first_year_salary: z
							.number()
							.optional()
							.describe("Optional: average first-year salary in EUR for those roles; turns the generic fee band into their own"),
						kpis: z.string().optional().describe("Optional: what has to move this year, in their words"),
					},
				},
				async ({ preset_id, item_ids, company, requester_name, open_senior_roles, avg_first_year_salary, kpis }) => {
					const c = buildBusinessCase({ preset_id, item_ids, company, open_senior_roles, avg_first_year_salary, kpis });
					if ("error" in c) return toolResult(c as Record<string, unknown>);
					return toolResult({
						...(c as unknown as Record<string, unknown>),
						approval_memo: approvalMemo(c, requester_name),
						approval_memo_usage:
							"Offer this as something they can forward as-is. Do not rewrite the numbers into prose of your own; hand it over whole, then ask whether they want it sent with the offer.",
					});
				},
			);

		this.server.registerTool(
			"design_journey",
			{
				title: "Lay out the 12-month membership journey for a basket",
				annotations: { ...READ_ONLY },
				description:
					"The moment the package becomes a year: deterministic month-by-month plan of what lands when, computed from the basket's own scheduling metadata (lead times, anchors like the April 2027 conference, spacing, and heavy-event collision rules). Returns placed months, the recurring-every-month layer, and anything unplaceable WITH its reason. The plan contains ONLY items in the basket — narrate around it, never add or move an event. Call after customize_package, before request_offer.",
				inputSchema: {
					preset_id: z.enum(PRESET_IDS as [string, ...string[]]),
					item_ids: z.array(z.string()).describe("The basket: item ids toggled ON"),
					start_month: z
						.string()
						.regex(/^\d{4}-\d{2}$/)
						.describe("First membership month, YYYY-MM (ask the visitor; default to the month after the current one)"),
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
					"The ONLY tool that collects contact details, and the step that makes the AI-channel discount real. Sends the itemized offer to the visitor's email, notifies Marian (email + Slack), and files the company into ELC's partners queue. Ask for name, work email and company only when the visitor says they want the offer — never earlier. After success: share the confirmation, then make ONE optional ask: would they post publicly (LinkedIn/X) about building their membership with AI? Optional means optional — the discount is already theirs.",
				inputSchema: {
					name: z.string().describe("Visitor's full name"),
					email: z.string().describe("Work email the offer goes to"),
					company: z.string().describe("Company name"),
					kpis: z.string().optional().describe("Optional: what they need to move this year, in their words"),
					visibility_interest: z
						.enum(["company", "individual", "quiet", "undecided"])
						.optional()
						.describe("From the discovery question: do they want to invest in their visibility through the cooperation — as a company, through individual leaders, or stay quiet?"),
					final_price_confirmed: z
						.boolean()
						.describe("REQUIRED TRUE: set only after the visitor has seen and explicitly confirmed the exact final total (the discounted figure if the discount applies). Sending without this confirmation is refused."),
					preset_id: z.enum(PRESET_IDS as [string, ...string[]]),
					item_ids: z.array(z.string()).describe("The final basket: item ids toggled ON"),
				},
			},
			async ({ name, email, company, kpis, visibility_interest, final_price_confirmed, preset_id, item_ids }) => {
				if (final_price_confirmed !== true) {
					return toolResult({
						error: "price_not_confirmed",
						message:
							"Show the visitor the exact final total first (list and discounted figures) and get an explicit yes. Then call again with final_price_confirmed: true.",
					});
				}
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
				// Flag asks ELC does not sell, without blocking the send. Silence used to read as consent:
				// four community-destroying conditions once submitted with no comment (2026-08-20).
				const conflicts = detectBoundaryConflicts(kpis);
				const result = await submitOffer(this.env as SubmitEnv, {
					name,
					email,
					company,
					kpis:
						[
							kpis,
							visibility_interest ? `Visibility interest: ${visibility_interest}` : "",
							conflicts.length ? `BOUNDARY FLAG: they asked for something not for sale (${conflicts.length} item${conflicts.length > 1 ? "s" : ""}). Read their own words above before the call.` : "",
						]
							.filter(Boolean)
							.join(" | ") || undefined,
					presetId: preset_id,
					itemIds: item_ids,
					channel: "mcp",
				});
				if (!result.ok) return toolResult({ error: result.error });
				return toolResult({
					submitted: true,
					...(conflicts.length
						? {
							boundary_conflict: {
								rules: conflicts.map((c) => c.rule),
								note: "The offer was sent, but they asked for something ELC does not sell. Tell them now, plainly, before they assume it was agreed. Marian has the same flag, so he will not walk into the call thinking these were accepted.",
							},
							}
						: {}),
					preset: result.presetName,
					list_total: result.listTotal,
					...(result.discountPct
						? { ai_channel_discount_pct: result.discountPct, final_total: result.finalTotal }
						: { final_total: result.finalTotal }),
					offer_email_sent_to: email,
					next_step: `The offer is in their inbox and Marian has the same list. The discounted figure becomes the contract price on the confirmation call — booking it is the real close: https://app.reclaim.ai/m/meet-marian/now`,
					optional_social_ask:
						"If they enjoyed this, ONE optional ask: a public post about building their ELC membership through AI. It is not a condition of anything.",
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
		name: "get_reach_options",
		question: "We want one thing once (a newsletter send, a meetup in our office, a dinner). What does it cost?",
		description:
			"Every one-off with price, lead time, examples and reach figures; the combo discount; the 90-day credit against a membership; what is not for sale",
	},
	{
		name: "quote_reach_combo",
		question: "What do these one-offs cost together?",
		description: "Authoritative total for a one-off basket with the combo discount by item count applied",
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
		name: "book_intro_call",
		question: "Can we just talk to a human first?",
		description: "Direct booking link for an intro meeting with ELC's founder — the second ending besides the offer; the free layer is the third",
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

// Secrets moved to the Cloudflare Secrets Store 2026-08-25. A store binding is an object
// with an async .get(), not a string, so both are normalised to plain strings ONCE here.
// That leaves ChatEnv / ReclaimEnv and every downstream comparison unchanged — and avoids
// the failure where a missed usage sends "[object Object]" into a Turnstile verify (which
// answers invalid-input-secret and fails the gate CLOSED) or an HMAC check.
// CHAT_SESSION_SECRET is deliberately absent: it is unmanaged, Cloudflare-only, and stays a
// plain Worker secret. readSecret passes plain strings through untouched either way.
const STORE_BACKED_SECRETS = ["CHAT_TURNSTILE_SECRET", "RECLAIM_WEBHOOK_SECRET"] as const;

async function handleFetch(request: Request, env: Env, ctx: ExecutionContext) {
	env = (await resolveSecrets(env as unknown as Record<string, unknown>, STORE_BACKED_SECRETS)) as unknown as Env;
	const url = new URL(request.url);
	const path = url.pathname.replace(/\/$/, "");

	// REST layer (mcp-launch P9): read-only, GET-only, before the chat/MCP branches.
	if (path.startsWith("/mcp/partnership/api")) {
		if (request.method !== "GET") {
			return new Response(JSON.stringify({ ok: false, error: "read_only_api_use_get" }), {
				status: 405,
				headers: { "content-type": "application/json; charset=utf-8" },
			});
		}
		const apiRes = handleApi(path, url);
		if (apiRes) return apiRes;
	}

	// Reclaim booking webhook (2026-08-10): POST-only, signed, log-only until the secret is set.
	if (path === "/mcp/partnership/reclaim-hook") {
		if (request.method !== "POST") {
			return new Response(JSON.stringify({ ok: false, error: "use_post" }), {
				status: 405,
				headers: { "content-type": "application/json; charset=utf-8" },
			});
		}
		return handleReclaimHook(request, env as unknown as ReclaimEnv);
	}

	if (path === "/mcp/partnership/chat") {
		if (request.method !== "POST") {
			return new Response(JSON.stringify({ ok: false, error: "use_post" }), {
				status: 405,
				headers: { "content-type": "application/json; charset=utf-8" },
			});
		}
		// ctx is handed down so the chat's PostHog flush can run on waitUntil — without it the
		// isolate can be torn down with the LLM analytics events still in memory.
		return handleChat(request, env as unknown as ChatEnv, ctx);
	}

	if (path === "/mcp/partnership") {
		const accept = request.headers.get("accept") ?? "";
		// Serve HTML to every GET that is not explicitly an SSE ask — the one thing only a real
		// MCP client requests. Accept: */* (curl, crawlers, registry health-checks) gets HTML.
		// HEAD is handled alongside GET, added 2026-08-25 — same fix as elc-toolkit, same reason.
		// HEAD used to fall through to the MCP transport, which 404s it, so `HEAD /mcp/partnership`
		// returned 404 while GET returned 200. Link checkers and Slack/Discord unfurlers read HEAD
		// first, so an endpoint linked from mcpservers.org looked dead to every one of them.
		// Per RFC 9110 a HEAD response carries the GET headers and NO body.
		if (
			(request.method === "GET" || request.method === "HEAD") &&
			!accept.includes("text/event-stream")
		) {
			const html = docsHtml(TOOL_DOCS, aiDiscount()?.pct ?? null);
			return new Response(request.method === "HEAD" ? null : html, {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"content-length": String(new TextEncoder().encode(html).length),
				},
			});
		}
		// request.cf only exists on the edge request; hand it to the DO via ctx.props.
		(ctx as ExecutionContext & { props?: McpGeo }).props = geoFromRequest(request);
		return ElcPartnershipBuilder.serve("/mcp/partnership").fetch(request, env, ctx);
	}

	return new Response(`Not found. MCP endpoint: ${SITE}/mcp/partnership`, { status: 404 });
}

const workerHandlers = {
	fetch: handleFetch,

	/**
	 * Uptime monitor (ai-mcp-launch P7.5), every 15 min via the cron trigger. Registries
	 * health-check remote servers and a failing check tanks listing rank — this catches the
	 * 406-class regressions before they do. Silent when green; posts to the partners Slack
	 * channel on any failure.
	 *
	 * The partnership checks call `handleFetch` in-process rather than `fetch()`-ing the public
	 * URL. Found the hard way (2026-08-11): a Cron Trigger calling `fetch()` on this Worker's own
	 * route resolves through Cloudflare's same-zone routing, which sent every self-fetch to the
	 * sibling elc-toolkit Worker's broader `/mcp*` route instead of back to this script — 404 on
	 * GET, 403 on POST, every single tick, for hours (confirmed via temporary diagnostic logging
	 * to UPTIME_STATE KV). Real external clients (curl, registries) never hit this: Cloudflare's
	 * public edge resolves the same URL to the correct, more specific route every time. Cloudflare
	 * only supports Worker-to-Worker fetch on the same zone via service bindings or the
	 * `global_fetch_strictly_public` compat flag (docs: developers.cloudflare.com/workers/runtime-apis/fetch/)
	 * — so a same-zone self-fetch from inside a Worker isn't reliable full-stack "front door"
	 * coverage regardless. Calling the handler directly still catches real app-level regressions
	 * (the 406-class bug this probe exists for) without the same-zone footgun. The sibling
	 * elc-toolkit check stays a real network fetch — that's genuinely a different Worker/route,
	 * and it has never false-failed.
	 *
	 * (Earlier same-day fix, still in effect: cancel the response body right after reading status
	 * — an un-drained fetch() body is a known Workers footgun that throws inside a fresh Cron
	 * Trigger isolate. Plus a 5s timeout + one retry per check for genuine transient blips, plus
	 * requiring 2 consecutive failed ticks — persisted in UPTIME_STATE KV, since every tick is a
	 * fresh isolate with no other memory — before paging Slack.)
	 */
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		const probeInternal = async (url: string, init?: RequestInit) => {
			const r = await handleFetch(new Request(url, init), env, ctx);
			await r.body?.cancel().catch(() => {});
			return r.status === 200;
		};

		const probeExternal = async (url: string, init?: RequestInit) => {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5000);
			try {
				const r = await fetch(url, { ...init, signal: controller.signal });
				await r.body?.cancel().catch(() => {});
				return r.status === 200;
			} finally {
				clearTimeout(timeout);
			}
		};

		const checks: { name: string; run: () => Promise<boolean> }[] = [
			{
				name: "partnership docs GET (wildcard Accept)",
				run: () => probeInternal(`${SITE}/mcp/partnership`, { headers: { accept: "*/*" } }),
			},
			{
				name: "partnership MCP initialize POST",
				run: () =>
					probeInternal(`${SITE}/mcp/partnership`, {
						method: "POST",
						headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: 1,
							method: "initialize",
							params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "uptime-probe", version: "1.0" } },
						}),
					}),
			},
			{
				name: "elc-toolkit docs GET (sibling /mcp)",
				run: () => probeExternal(`${SITE}/mcp`, { headers: { accept: "*/*" } }),
			},
		];

		const failures: string[] = [];
		for (const c of checks) {
			try {
				// One retry before calling it a failure — absorbs a single transient blip without
				// needing the cross-tick counter below.
				if (!(await c.run()) && !(await c.run())) failures.push(c.name);
			} catch (e) {
				failures.push(`${c.name} (${String(e).slice(0, 80)})`);
			}
		}

		const STREAK_KEY = "uptime:consecutive-fail-count";
		if (!failures.length) {
			await env.UPTIME_STATE.delete(STREAK_KEY);
			return;
		}

		console.error("[UPTIME_FAIL]", failures);
		const prevStreak = Number((await env.UPTIME_STATE.get(STREAK_KEY)) ?? "0");
		const streak = prevStreak + 1;
		await env.UPTIME_STATE.put(STREAK_KEY, String(streak), { expirationTtl: 3600 });
		if (streak < 2) return; // one bad tick alone doesn't page — wait for the next tick to confirm

		const cf = env as unknown as { SLACK_BOT_TOKEN_ELC?: string; SLACK_PARTNERS_CHANNEL?: string };
		if (cf.SLACK_BOT_TOKEN_ELC && cf.SLACK_PARTNERS_CHANNEL) {
			await fetch("https://slack.com/api/chat.postMessage", {
				method: "POST",
				headers: { Authorization: `Bearer ${cf.SLACK_BOT_TOKEN_ELC}`, "content-type": "application/json; charset=utf-8" },
				body: JSON.stringify({
					channel: cf.SLACK_PARTNERS_CHANNEL,
					text: `:rotating_light: MCP uptime probe failing (${streak} consecutive ticks): ${failures.join(" · ")} — registries health-check these URLs, fix before listings derank.`,
					unfurl_links: false,
				}),
			}).catch((e) => console.error("uptime slack post failed", String(e)));
		}
	},
};

export default workerHandlers;
