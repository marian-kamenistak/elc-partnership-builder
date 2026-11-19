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
import { aiDiscount, availableItems, discountFor, eur, isCreditPreset, journeyItemsFor, meta, ONEOFF_IDS, PRESET_IDS, presetById, quoteOneoffs, resolveBasket } from "./core/catalog";
import { reachOptions } from "./core/reach";
import { approvalMemo, buildBusinessCase } from "./core/businesscase";
import { fitToBudget } from "./core/fit";
import { isSeatPriced, priceSeats, seatSpecFor } from "./core/seats";
import { buildJourney } from "./core/journey";
import { detectBoundaryConflicts, type GuardrailScope } from "./core/guardrails";
import { matchPackage } from "./core/match";
import { partnershipOptions } from "./core/options";
import {
	renderBook,
	renderBusinessCase,
	renderCustomize,
	renderError,
	renderFit,
	renderGetStarted,
	renderJourney,
	renderMatch,
	renderOptions,
	renderQuote,
	renderReach,
	renderSubmitted,
	serverInstructions,
	termsBrief,
} from "./core/render";
import { submitOffer, type SubmitEnv } from "./core/submit";
import { docsHtml, type ToolDoc } from "./docs";
import { uptimeTick, type UptimeCheck, type UptimeEnv } from "./uptime";
import {
	geoFromRequest,
	instrumentMcpUsage,
	type McpGeo,
	type McpUsageConfig,
	type McpUsageEnv,
} from "./mcp-usage";
import {
	ignoredNotice,
	normalizeMcpRequest,
	parseArgs,
	permissiveShape,
	type ParseResult,
} from "./mcp-tolerant";
import { getMoreToolsResult } from "@posthog/mcp";

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const ATTR_PATH = "/partner/";

/**
 * Tool responses are briefings (src/core/render.ts), not JSON dumps, and carry no
 * `structuredContent`: some clients put both into context and the duplicate doubled every response
 * (2026-11-19 audit). Machine consumers use the REST API and the chat, which read core data.
 *
 * `terms` is passed only by price and offer tools (`termsBrief`); the general rules live once in
 * the server instructions. The attribution line rides on every successful response.
 *
 * Error responses carry neither terms nor attribution (2026-08-20 persona testing): eleven
 * simulated buyers each hit several validation errors, and stapling VAT law, exclusivity caps and
 * a discount countdown onto an error read as nagging by the third repeat and as desperate by the
 * tenth. Terms belong on priced answers, which is the only place they mean anything.
 */
function reply(text: string, terms?: string) {
	return {
		content: [{ type: "text" as const, text: [text, terms].filter(Boolean).join("\n\n") + ATTRIBUTION(ATTR_PATH) }],
	};
}

/** An error that steers: what went wrong and how to fix it, no terms, no attribution. */
function errorResult(payload: { error: string; message?: string }) {
	return { content: [{ type: "text" as const, text: renderError(payload) }] };
}

/**
 * Renders a `parseArgs` failure through the same envelope every other answer uses, so the shape
 * of a response never depends on whether the arguments were right.
 *
 * `probe` is the difference between a caller asking what the tool wants and a caller getting it
 * wrong, and the two deserve different answers: a bare `{}` is a question and comes back as a
 * normal result carrying the field menu (readable text, not a Zod dump), while arguments that were
 * supplied and rejected stay an error. Neither carries terms or attribution: a message whose entire
 * content is "these are the arguments" is the last place to attach a discount countdown.
 */
function guidance(parsed: Extract<ParseResult<unknown>, { ok: false }>) {
	if (parsed.probe) return { content: [{ type: "text" as const, text: parsed.message }] };
	return { ...errorResult({ error: "invalid_arguments", message: parsed.message }), isError: true as const };
}

/** Staples `ignoredNotice` onto a finished answer. The notice has to read AFTER the answer it
 *  qualifies ("the answer above"), so it is appended to the rendered text here. */
function withIgnored(result: ReturnType<typeof reply>, notice: string) {
	if (!notice) return result;
	return {
		...result,
		content: [{ type: "text" as const, text: result.content.map((c) => c.text).join("") + notice }],
	};
}

/** ELC Conference 2027 partner packages and tickets live in their own MCP server; this one
 *  deliberately excludes conference items and points there instead. */
const CONFERENCE_MCP = "https://mcp.elc-conference.io/mcp";

/** Shared by both `get_started` and `get_more_tools`'s greeting branch (see below) — one
 *  source of truth for the menu text so the two entry points never drift apart. */
function getStartedResult() {
	return reply(renderGetStarted(TOOL_DOCS, CONFERENCE_MCP));
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
/**
 * Slack response summary for this server specifically.
 *
 * Every briefing opens with its one-line verdict (src/core/render.ts), so the summary is that
 * first line: "Business case for Hiring: €14,000 for the year; pays for itself at 2 senior hires".
 * It used to read `structuredContent`, which the briefings no longer carry. Errors open with
 * "Problem:" and get the warning marker. Cut before the attribution and capped at 200 characters.
 */
function summarizePartnership(_toolName: string, response: unknown): string | undefined {
	const content = (response as { content?: { type?: string; text?: string }[] })?.content;
	const text = content?.find((b) => b?.type === "text")?.text;
	if (!text) return undefined;
	const first = text.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim();
	if (!first) return undefined;
	const line = first.startsWith("Problem:") ? `:warning: ${first.slice("Problem:".length).trim()}` : first;
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

const USAGE_CONFIG: McpUsageConfig = {
	serverName: "elc-partnership-builder",
	domain: "engineeringleaders.io",
	// One source of truth for the project key across both doors — the MCP door here and the
	// chat door's LLM analytics. They must stay the same project or the two halves of the
	// funnel stop joining.
	posthogKey: POSTHOG_KEY,
	summarize: summarizePartnership,
};

/* The real argument contracts. `registerTool` advertises `permissiveShape(…)` of each — every
 * field optional, enums as plain strings — and the handler enforces the shape below through
 * `parseArgs`. Nothing is loosened by this: `parseArgs` runs the same zod object the SDK used to
 * run, so `request_offer`'s `final_price_confirmed` and the three contact fields still refuse an
 * incomplete submission. What changes is only the answer a wrong call gets — the field menu
 * instead of a raw Zod dump. See `src/mcp-tolerant.ts` for the traffic that motivated it. */

const QUOTE_REACH_SHAPE = {
	oneoff_ids: z.array(z.enum(ONEOFF_IDS as [string, ...string[]])).min(1).describe("One-off ids from get_reach_options"),
	// 2026-10-20: the speaker programme is a ladder. Omit = the full programme at its bundle price;
	// pass rung ids to price a subset (Stage is always included).
	speaker_rungs: z.array(z.string()).optional().describe("Speaker programme rung ids (stage, story, coach, amplify, beyond) to price instead of the full programme; stage is always included"),
};

const MATCH_PACKAGE_SHAPE = {
	goal: z.string().describe("One of the goal ids from get_partnership_options question_1"),
	budget: z.string().describe("One of the budget ids from get_partnership_options question_2"),
};

const CUSTOMIZE_PACKAGE_SHAPE = {
	preset_id: z.enum(PRESET_IDS as [string, ...string[]]).describe("The package being customized"),
	item_ids: z.array(z.string()).describe("Item ids currently toggled ON (from match_package default_item_ids, plus/minus changes)"),
	seats: z
		.number()
		.optional()
		.describe("Seat-priced packages only (Team Seats `team-seats`, Team Circle `starter`): how many people they are enrolling. Both are priced per seat, so ALWAYS ask for a headcount before quoting — the bundle price is only the minimum-seat entry (Team Seats 5, Team Circle 3)."),
};

const BOOK_INTRO_CALL_SHAPE = {
	preset_id: z
		.enum(PRESET_IDS as [string, ...string[]])
		.optional()
		.describe("Optional: the package composed so far, if any"),
	item_ids: z.array(z.string()).optional().describe("Optional: the basket composed so far, if any"),
};

const FIT_TO_BUDGET_SHAPE = {
	preset_id: z.enum(PRESET_IDS as [string, ...string[]]).describe("The package to trim to budget (from match_package)"),
	budget: z.number().describe("The visitor's ceiling in EUR, as a number (8000, not '8K')"),
	must_have: z
		.array(z.string())
		.optional()
		.describe("Optional: item ids the visitor explicitly asked for; kept first if they fit"),
	against: z
		.enum(["discounted", "list"])
		.optional()
		.describe("Price the budget against the list price. 'discounted' equals list since the AI channel carries no discount (2026-10-05)"),
};

const BUILD_BUSINESS_CASE_SHAPE = {
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
};

const DESIGN_JOURNEY_SHAPE = {
	preset_id: z.enum(PRESET_IDS as [string, ...string[]]),
	item_ids: z.array(z.string()).describe("The basket: item ids toggled ON"),
	start_month: z
		.string()
		.regex(/^\d{4}-\d{2}$/)
		.describe("First membership month, YYYY-MM (ask the visitor; default to the month after the current one)"),
};

const REQUEST_OFFER_SHAPE = {
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
		.describe("REQUIRED TRUE: set only after the visitor has seen and explicitly confirmed the exact final total . Sending without this confirmation is refused."),
	preset_id: z.enum(PRESET_IDS as [string, ...string[]]),
	item_ids: z.array(z.string()).describe("The final basket: item ids toggled ON"),
};

export class ElcPartnershipBuilder extends McpAgent<Env, unknown, McpGeo> {
	server = new McpServer(
		{
			name: "elc-partnership-builder",
			version: "1.0.0",
		},
		{
			instructions: serverInstructions(CONFERENCE_MCP),
		},
	);

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
				// `permissiveShape({})` rather than a bare `{}`: an empty shape leaves
				// @posthog/mcp free to inject a REQUIRED `context`, so the front door of this
				// server rejected the one call shape every agent tries first — `get_started`
				// with no arguments at all.
				inputSchema: permissiveShape({}),
			},
			async () => getStartedResult(),
		);

		this.server.registerTool(
			"get_more_tools",
			{
				title: "Report a missing capability — also answers a bare hello/liveness ping",
				annotations: { ...READ_ONLY },
				description:
					"Check for additional tools whenever your task might benefit from specialized capabilities, even if existing tools could work as a fallback. Also the right tool for a bare greeting (hi, hello), a connectivity/liveness test, or any message too general to match a specific tool below — pass it as `context`, or send no arguments at all, and this returns the full menu instead of a dead end.",
				// Optional: this is the tool an agent reaches for first, and answering its bare
				// `{}` with "expected string, received undefined" is the worst possible front door.
				inputSchema: {
					context: z
						.string()
						.optional()
						.describe(
							"A description of your goal and what kind of tool would help accomplish it, OR a plain greeting/liveness ping like 'hi' or 'test'. Omit it for the menu.",
						),
				},
			},
			async ({ context }) =>
				!context || GREETING_PING.test(context.trim())
					? getStartedResult()
					: { content: getMoreToolsResult().content },
		);

		this.server.registerTool(
			"get_reach_options",
			{
				title: "One-offs: single items a company buys once, with prices",
				annotations: { ...READ_ONLY },
				description:
					"START HERE when a company wants ONE thing once, not a year-long membership: a classified (30 words and a link, tools and events only) or a dedicated send in the Leaders' Brief newsletter, a meetup hosted in their office, a speaker slot or the coached speaker programme, a conference main-stage talk, a podcast episode, a decision-maker dinner, a community survey, a job board listing. Returns every one-off with its price, lead time, examples and real reach figures, the combo discount rule, the 90-day credit against a membership, and what is not for sale. Two or more things across a year is a membership conversation: hand over to get_partnership_options. Next: quote_reach_combo once items are picked.",
				// See get_started above: a bare `{}` lets @posthog/mcp inject a REQUIRED `context`,
				// which is exactly what made the no-argument call this menu exists for fail.
				inputSchema: permissiveShape({}),
			},
			async () => reply(renderReach(reachOptions())),
		);

		this.server.registerTool(
			"quote_reach_combo",
			{
				title: "Price a one-off basket (authoritative total with the combo discount)",
				annotations: { ...READ_ONLY },
				description:
					"Pass the one-off ids the visitor picked; returns each item's price, the list total, the combo discount by item count (job board listings never count), and the final total. For the speaker programme pass speaker_rungs to price a subset of the ladder (Stage always included); omit it for the full programme at the bundle price. This is the only arithmetic that counts — never add prices yourself. The AI-channel percentage does not apply to one-offs. Next: book_intro_call to lock the date, or get_partnership_options if the basket is starting to look like a year.",
				inputSchema: permissiveShape(QUOTE_REACH_SHAPE),
			},
			async (raw) => {
				const parsed = parseArgs("quote_reach_combo", QUOTE_REACH_SHAPE, raw);
				if (!parsed.ok) return guidance(parsed);
				const { oneoff_ids, speaker_rungs } = parsed.data;
				const q = quoteOneoffs(oneoff_ids, { speaker_rungs });
				if (!q.items.length) return errorResult({ error: `no known one-offs in ${JSON.stringify(oneoff_ids)}`, message: `Valid ids: ${ONEOFF_IDS.join(", ")}. Call get_reach_options for what each one is.` });
				return withIgnored(reply(renderQuote(q), termsBrief("oneoff")), ignoredNotice("quote_reach_combo", parsed.ignored, QUOTE_REACH_SHAPE));
			},
		);

		this.server.registerTool(
			"get_partnership_options",
			{
				title: "How ELC company membership works + the two qualifying questions",
				annotations: { ...READ_ONLY },
				description:
					"START HERE for any company considering an ELC membership (personas: HR, CTO, employer branding). Returns how company membership works, real community reach figures, and the two qualifying questions with their valid answers. Companies only — individuals seeking a mentor for themselves get pointed to /mentor/ instead. After the visitor answers both questions, call match_package. Partner packages and tickets for the ELC Conference 2027 day are a separate offer with their own MCP server: https://mcp.elc-conference.io/mcp",
				// See get_started above: a bare `{}` lets @posthog/mcp inject a REQUIRED `context`,
				// which is exactly what made the no-argument call this menu exists for fail.
				inputSchema: permissiveShape({}),
			},
			async () => reply(renderOptions(partnershipOptions())),
		);

		this.server.registerTool(
			"match_package",
			{
				title: "Match a membership package to a goal and budget",
				annotations: { ...READ_ONLY },
				description:
					"Resolves goal + budget through ELC's own routing matrix — the same one the website uses — and returns the matched package(s) with real prices and their default line items. Map free-text answers to the closest valid id; on bad input the error lists the valid ids, re-ask rather than guessing. Next: customize_package to toggle line items, or request_offer to send it as-is.",
				inputSchema: permissiveShape(MATCH_PACKAGE_SHAPE),
			},
			async (raw) => {
				const parsed = parseArgs("match_package", MATCH_PACKAGE_SHAPE, raw);
				if (!parsed.ok) return guidance(parsed);
				const { goal, budget } = parsed.data;
				const result = matchPackage(goal, budget);
				if (!result.ok) return errorResult({ error: result.error });
				return withIgnored(
					reply(renderMatch(result.matches, goal, budget), termsBrief("membership", result.matches.length === 1 ? result.matches[0].preset_id : undefined)),
					ignoredNotice("match_package", parsed.ignored, MATCH_PACKAGE_SHAPE),
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
				inputSchema: permissiveShape(CUSTOMIZE_PACKAGE_SHAPE),
			},
			async (raw) => {
				const parsed = parseArgs("customize_package", CUSTOMIZE_PACKAGE_SHAPE, raw);
				if (!parsed.ok) return guidance(parsed);
				const { preset_id, item_ids, seats } = parsed.data;
				const preset = presetById(preset_id);
				if (!preset) return errorResult({ error: `unknown preset "${preset_id}"`, message: `Valid presets: ${PRESET_IDS.join(", ")}.` });
				// An empty basket used to price a €12,000 package as "Free" (2026-08-20 persona testing:
				// every one of eleven testers hit this, and several briefly believed it). A paid preset
				// rendering as €0 is the worst failure mode a configurator has, so it is now a guiding
				// error instead of a confident wrong answer.
				if (!item_ids.length) {
					return errorResult({
						error: "empty_basket",
						message: `Nothing is selected, so there is nothing to price — this is NOT a free package. ${preset.name} lists at ${eur(preset.price)}. Pass the item_ids from match_package to price the standard bundle, then toggle from there.`,
					});
				}
				const { standard, addons, total } = resolveBasket(preset_id, item_ids);
				// Unknown or wrong-tier ids used to vanish silently, so a basket could quietly lose items and
				// still return a confident total. Name them: "this package does not sell that" is a real
				// answer, and the silence let testers believe they had bought things they had not.
				const resolvedIds = new Set([...standard, ...addons].map((i) => i.id));
				const dropped = item_ids.filter((id) => !resolvedIds.has(id));
				// Team Seats and Team Circle are sold per seat, so the bundle total is only right at the minimum.
				// Quoting it to a buyer with eight leaders under-delivers by five people, and neither side
				// finds out until kickoff (2026-08-20 persona finding). When a headcount is given, seats are
				// the price; when it is not, say so rather than letting the bundle figure stand as a quote.
				const seatPricing = isSeatPriced(preset_id) && seats !== undefined ? priceSeats(preset_id, seats) : null;
				if (seatPricing && "error" in seatPricing) return errorResult(seatPricing);
				const effectiveTotal = seatPricing ? seatPricing.total : total;
				const d = discountFor(effectiveTotal, "mcp", preset_id);
				const creditNote =
					!d && isCreditPreset(preset_id) && total > 0
						? `${preset.name} is 100% credited against a company membership signed within 90 days.${aiDiscount() ? ` The credit is its discount: the ${aiDiscount()!.pct}% AI-channel discount does not stack on top (it applies to the yearly packages).` : ""}`
						: null;
				return withIgnored(
					reply(
						renderCustomize({
							presetId: preset_id,
							presetName: preset.name,
							bundlePrice: preset.price,
							standard,
							addons,
							total: effectiveTotal,
							totalDisplay: seatPricing ? seatPricing.total_display : effectiveTotal === 0 ? "Free" : `${eur(effectiveTotal)} / year, excl. VAT`,
							discount: d,
							seatPricing,
							seatsPending: !seatPricing && isSeatPriced(preset_id) ? { minimumSeats: seatSpecFor(preset_id)?.minimum_seats } : null,
							dropped,
							creditNote,
							available: availableItems(preset_id, item_ids),
						}),
						termsBrief("membership", preset_id),
					),
					ignoredNotice("customize_package", parsed.ignored, CUSTOMIZE_PACKAGE_SHAPE),
				);
			},
		);

			this.server.registerTool(
				"book_intro_call",
				{
					title: "Book an intro meeting with Marian (the human ending)",
					annotations: { ...READ_ONLY },
					description:
						"The second legitimate ending besides request_offer: a direct booking link for a 1:1 intro meeting with Marian, ELC's founder. Offer it whenever the visitor hesitates, wants a human, or the package needs tailoring beyond the catalog. No contact details collected here — the booking page handles everything. Pass preset_id and item_ids if a package was composed: the response then carries a paste-ready booking note, so the call starts from their numbers instead of from scratch.",
					inputSchema: permissiveShape(BOOK_INTRO_CALL_SHAPE),
				},
				// 2026-08-20: this used to return a bare link plus a tip telling the visitor to remember
				// their own basket and recite it on the call. Anyone who booked instead of requesting an
				// offer therefore arrived with nothing attached, losing the composed package at exactly
				// the moment intent was highest. The basket now comes back as a paste-ready line. Still
				// no contact details collected here.
				async (raw) => {
					const parsed = parseArgs("book_intro_call", BOOK_INTRO_CALL_SHAPE, raw);
					// Both fields are optional and the bare link IS a real answer here — handing a
					// hesitating visitor the field menu instead of the booking URL would break the one
					// ending this tool exists to provide. So a probe falls through to the no-basket
					// branch below; only supplied-and-wrong arguments are an error.
					if (!parsed.ok && !parsed.probe) return guidance(parsed);
					const { preset_id, item_ids } = parsed.ok ? parsed.data : { preset_id: undefined, item_ids: undefined };
					const bookingUrl = "https://app.reclaim.ai/m/meet-marian/now";
					const freeUrl = "https://www.engineeringleaders.io/partner/membership/free/";
					if (!preset_id || !item_ids?.length) return reply(renderBook({ bookingUrl, freeUrl }));
					const preset = presetById(preset_id);
					const { standard, addons, total } = resolveBasket(preset_id, item_ids);
					const d = discountFor(total, "mcp", preset_id);
					const count = standard.length + addons.length;
					const name = preset?.name ?? preset_id;
					return withIgnored(
						reply(
							renderBook({
								bookingUrl,
								freeUrl,
								composed: {
									name,
									count,
									listTotal: total,
									discount: d,
									note: `${name} package, ${count} items, ${eur(d ? d.discounted : total)}/year${d ? ` (incl. ${d.pct}% AI-channel discount)` : ""}. Built with the ELC membership builder.`,
								},
							}),
						),
						ignoredNotice("book_intro_call", parsed.ok ? parsed.ignored : [], BOOK_INTRO_CALL_SHAPE),
					);
				},
			);

			this.server.registerTool(
				"fit_to_budget",
				{
					title: "Compose the best package for an exact budget",
					annotations: { ...READ_ONLY },
					description:
						"Use when the visitor names a NUMBER rather than a band — 'we have 8,000 approved', 'can we do this for five thousand'. Returns a deterministic best-value composition under that ceiling: what fits, what was left out AND why, how much budget is unspent, and what the cheapest excluded item costs. Foundation items are kept first, then the remaining items cheapest-first so the budget buys as much as possible. Priced against the AI-channel figure by default, since that is what they would actually pay. Never hand-pick a basket yourself when a budget is stated — this tool is the authoritative composition, the same way customize_package is the authoritative total.",
					inputSchema: permissiveShape(FIT_TO_BUDGET_SHAPE),
				},
				async (raw) => {
					const parsed = parseArgs("fit_to_budget", FIT_TO_BUDGET_SHAPE, raw);
					if (!parsed.ok) return guidance(parsed);
					const { preset_id, budget, must_have, against } = parsed.data;
					const fit = fitToBudget({ preset_id, budget, must_have, against });
					if ("error" in fit) return errorResult({ error: String(fit.error) });
					return withIgnored(reply(renderFit(fit), termsBrief("membership", preset_id)), ignoredNotice("fit_to_budget", parsed.ignored, FIT_TO_BUDGET_SHAPE));
				},
			);

			this.server.registerTool(
				"build_business_case",
				{
					title: "Compute the ROI case and a forwardable approval memo",
					annotations: { ...READ_ONLY },
					description:
						"Turns a composed basket into the argument that gets it approved: recruiter-fee equivalence, break-even hire count, cost per room, cost per month, what the spend replaces, and every assumption behind those numbers. Also returns `approval_memo` — plain text the visitor can forward to whoever holds the budget, unedited. Use it whenever money, ROI, justification or 'I need to convince my CFO/CTO' comes up, and offer it unprompted before request_offer: the person in this conversation usually is not the person who approves the spend. Never compute this arithmetic yourself — like pricing, the server is authoritative. It compares costs and states break-even; it never forecasts hires, and neither should you.",
					inputSchema: permissiveShape(BUILD_BUSINESS_CASE_SHAPE),
				},
				async (raw) => {
					const parsed = parseArgs("build_business_case", BUILD_BUSINESS_CASE_SHAPE, raw);
					if (!parsed.ok) return guidance(parsed);
					const { preset_id, item_ids, company, requester_name, open_senior_roles, avg_first_year_salary, kpis } = parsed.data;
					const c = buildBusinessCase({ preset_id, item_ids, company, open_senior_roles, avg_first_year_salary, kpis });
					if ("error" in c) return errorResult({ error: String(c.error) });
					return withIgnored(
						reply(renderBusinessCase(c, approvalMemo(c, requester_name), avg_first_year_salary !== undefined), termsBrief("membership", preset_id)),
						ignoredNotice("build_business_case", parsed.ignored, BUILD_BUSINESS_CASE_SHAPE),
					);
				},
			);

		this.server.registerTool(
			"design_journey",
			{
				title: "Lay out the 12-month membership journey for a basket",
				annotations: { ...READ_ONLY },
				description:
					"The moment the package becomes a year: deterministic month-by-month plan of what lands when, computed from the basket's own scheduling metadata (lead times, anchors like the April 2027 conference, spacing, and heavy-event collision rules). Returns placed months, the recurring-every-month layer, and anything unplaceable WITH its reason. The plan contains ONLY items in the basket — narrate around it, never add or move an event. Call after customize_package, before request_offer.",
				inputSchema: permissiveShape(DESIGN_JOURNEY_SHAPE),
			},
			async (raw) => {
				const parsed = parseArgs("design_journey", DESIGN_JOURNEY_SHAPE, raw);
				if (!parsed.ok) return guidance(parsed);
				const { preset_id, item_ids, start_month } = parsed.data;
				const items = journeyItemsFor(preset_id, item_ids);
				if (!items.length) return errorResult({ error: "empty_basket", message: "Pass the item_ids from customize_package." });
				try {
					const journey = buildJourney(items, start_month);
					return withIgnored(reply(renderJourney(journey, items.length)), ignoredNotice("design_journey", parsed.ignored, DESIGN_JOURNEY_SHAPE));
				} catch (e) {
					return errorResult({ error: String(e instanceof Error ? e.message : e) });
				}
			},
		);

		this.server.registerTool(
			"request_offer",
			{
				title: "Send the composed offer to ELC",
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
				description:
					"The ONLY tool that collects contact details. Sends the itemized offer to the visitor's email, notifies Marian (email + Slack), and files the company into ELC's partners queue. Ask for name, work email and company only when the visitor says they want the offer — never earlier. After success: share the confirmation, then make ONE optional ask: would they post publicly (LinkedIn/X) about building their membership with AI? Optional means optional — the discount is already theirs.",
				inputSchema: permissiveShape(REQUEST_OFFER_SHAPE),
			},
			async (raw) => {
				// The one mutating tool, so the tolerance is strictly about the ERROR MESSAGE, never
				// about what gets through: `parseArgs` runs the same zod object the SDK used to run,
				// so a send still needs name, email, company, preset_id, item_ids and a boolean
				// `final_price_confirmed` present — and the close gate below still demands it be
				// literally true. A probe is an ordinary failure here, not a menu shortcut.
				const parsed = parseArgs("request_offer", REQUEST_OFFER_SHAPE, raw);
				if (!parsed.ok) return guidance(parsed);
				const { name, email, company, kpis, visibility_interest, final_price_confirmed, preset_id, item_ids } = parsed.data;
				if (final_price_confirmed !== true) {
					return errorResult({
						error: "price_not_confirmed",
						message:
							"Show the visitor the exact final total first and get an explicit yes. Then call again with final_price_confirmed: true.",
					});
				}
				// Rate limit the one mutating door; informational tools stay open (plan §8).
				const ip = (this as unknown as { requestIp?: string }).requestIp ?? "unknown";
				const limiter = (this.env as Env & { OFFER_RATE_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> } })
					.OFFER_RATE_LIMITER;
				if (limiter) {
					const { success } = await limiter.limit({ key: ip });
					if (!success) {
						return errorResult({
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
				if (!result.ok) return errorResult({ error: result.error });
				return withIgnored(
					reply(
						renderSubmitted({
							presetName: result.presetName,
							listTotal: result.listTotal,
							finalTotal: result.finalTotal,
							discountPct: result.discountPct || undefined,
							email,
							conflicts: conflicts.map((c) => c.rule),
							test: Boolean(result.test),
						}),
						termsBrief("membership", preset_id),
					),
					ignoredNotice("request_offer", parsed.ignored, REQUEST_OFFER_SHAPE),
				);
			},
		);
	}
}

const TOOL_DOCS: ToolDoc[] = [
	{
		name: "get_partnership_options",
		question: "Should my company partner with ELC, and how does membership work?",
		description:
			"How company membership works, real reach figures (3,700+ leaders, 12 meetups/yr, 500+ conference), and the two qualifying questions that start the wizard",
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
		description: "Sends the itemized offer by email, notifies ELC, files the company into the partners queue",
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
		// This MUST run before normalizeMcpRequest, which rebuilds the Request and drops `cf`.
		(ctx as ExecutionContext & { props?: McpGeo }).props = geoFromRequest(request);
		// The MCP spec makes `params.arguments` optional on tools/call; the SDK does not.
		// See normalizeToolCallBody in src/mcp-tolerant.ts.
		const normalized = await normalizeMcpRequest(request);
		return ElcPartnershipBuilder.serve("/mcp/partnership").fetch(normalized, env, ctx);
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
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
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

		const checks: UptimeCheck[] = [
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

		// Pause flag, retry, the 2-tick paging rule and the control-room run report live in src/uptime.ts (tested there).
		await uptimeTick(env as unknown as UptimeEnv, event.scheduledTime, ctx, checks, async (streak, failures) => {
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
		});
	},
};

export default workerHandlers;
