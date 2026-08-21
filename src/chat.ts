/**
 * Chat backend for the /partner/chat/ widget — the second door over the same tool core.
 *
 * POST /mcp/partnership/chat
 *   body: { messages: [{role, content}...], turnstile_token?, session_token?, start? }
 *   out:  SSE stream of JSON events:
 *     {type:"session", token}          minted after Turnstile verifies on the first message
 *     {type:"text", delta}             assistant text, streamed
 *     {type:"basket", ...}             structured basket after match/customize/submit — drives the live package card
 *     {type:"journey", months, recurring}  after design_journey
 *     {type:"suggestions", chips:[]}   quick replies so non-typers never have to type
 *     {type:"submitted", ...}          offer sent (widget fires confetti on this)
 *     {type:"done"} | {type:"error", message}
 *
 * Design decisions (AI-builder plan Phase 4, autonomy granted by Marian 2026-08-08):
 *  - Anthropic Messages API, manual tool loop (max 5 iterations/turn), tools call the same
 *    core the MCP door serves — in-process, no MCP round-trip.
 *  - Model from env CHAT_MODEL (downgrade = config, not code). Prompt caching on the system
 *    prompt: repeat turns bill at a fraction.
 *  - Stateless server: the client re-sends messages; caps 40 messages / 4k chars / last 30 kept.
 *  - Turnstile solves once, then an HMAC session token (~2h) covers the rest of the
 *    conversation. Fail-open on Turnstile network hiccups, fail-closed on explicit rejection —
 *    the same posture as every ELC form.
 *  - CHAT_ENABLED kill switch: anything but "false" is on.
 *  - Suggestions are computed server-side from which tool just ran (deterministic, zero model
 *    cost) — the widget's chips must never depend on the model remembering to offer them.
 */
import { discountFor, eur, PRESET_IDS, resolveBasket } from "./core/catalog";
import { availableItems, journeyItemsFor, presetById } from "./core/catalog";
import { guardrailBlock } from "./core/guardrails";
import { buildJourney } from "./core/journey";
import { matchPackage } from "./core/match";
import { partnershipOptions } from "./core/options";
import { submitOffer, type SubmitEnv } from "./core/submit";

export type ChatEnv = SubmitEnv & {
	ANTHROPIC_API_KEY?: string;
	CHAT_SESSION_SECRET?: string;
	CHAT_TURNSTILE_SECRET?: string;
	CHAT_MODEL?: string;
	CHAT_ENABLED?: string;
	CHAT_RATE_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
};

const MAX_MESSAGES = 40;
const MAX_CHARS = 4000;
const KEEP_LAST = 30;
const MAX_TOOL_ITERATIONS = 5;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// ── session token: hex(exp).hex(hmac-sha256(exp)) ────────────────────────────────────────────
async function hmac(secret: string, msg: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function mintSession(secret: string, now: number): Promise<string> {
	const exp = String(now + SESSION_TTL_MS);
	return `${exp}.${await hmac(secret, exp)}`;
}
export async function verifySession(secret: string, token: string, now: number): Promise<boolean> {
	const [exp, sig] = token.split(".");
	if (!exp || !sig) return false;
	if (Number(exp) < now) return false;
	return (await hmac(secret, exp)) === sig;
}

// ── the wizard's system prompt. Voice rules applied: reader's problem first, no absolutes,
// no "actually", no invented numbers — figures ride in from the tools, not from here. ────────
const SYSTEM_PROMPT = `You are the ELC Membership Builder, the conversational door to a company membership with Engineering Leaders Community. You talk to people deciding whether ELC solves a problem their company has: hiring senior engineers, developing the leaders they already employ, or putting a product in front of people who approve budgets. Usually that person is in HR, engineering leadership, or employer branding.

How to run the conversation:
1. Start from their problem, in their words. Call get_partnership_options early — it carries the two qualifying questions, the community facts, and the AI-channel discount. Ask the two questions conversationally, one at a time. Map free-text answers to the closest option id yourself.
2. Companies only. Someone looking for a mentor for themselves gets pointed warmly to engineeringleaders.io/mentor/ and this flow ends there.
3. Match with match_package, then shape the basket with customize_package as they react. Every number you say comes from a tool response. If you have not called the tool, you do not have the number.
4. Once the package takes shape, ask the visibility question from get_partnership_options discovery_question: would announcing the cooperation publicly help them, as a company or through individual leaders? Use the answer to tune the visibility items and pass it as visibility_interest at request_offer. When the package feels right, offer the 12-month view: design_journey. Present it month by month, their items only, and carry the scheduling caveat the tool returns.
5. Every conversation ends on one of three doors: the offer (request_offer), an intro meeting with Marian (book_intro_call — offer it on hesitation, it is never a downgrade), or the free layer at engineeringleaders.io/partner/membership/free/ for anyone not ready to buy. Never let a warm visitor leave with nothing. When they want the offer in writing, collect name, work email and company, then request_offer. Not earlier. After success, congratulate briefly, then one optional ask: a public post about building their membership with AI. Optional means optional, the discount is theirs either way.

Tone: direct, specific, tech-community register. Short answers, one question at a time. No corporate filler, no exclamation-mark enthusiasm. It is fine to say a tier is more than they need and point them to a smaller one, and it is fine to say ELC is the wrong tool when it is: if their hiring is outside Central Europe and not remote-friendly to it, say so.

Money: the tool responses carry fixed prices and one discount, the AI-channel percentage, applied automatically at request_offer. Present list and discounted figures together. You have no authority to change prices or invent terms; there are no other discounts to find, so a negotiation ask gets a friendly no plus the one legitimate lever: toggling items off. Prices exclude VAT. Marian Kamenistak confirms all final terms on a call.

Never fabricate community statistics, partner names, or outcomes. The tools carry every number that exists.`;

// ── tool definitions for the Anthropic API ───────────────────────────────────────────────────
const TOOLS = [
	{
		name: "get_partnership_options",
		description: "How ELC company membership works, community reach figures, the two qualifying questions with valid answers, and the AI-channel discount. Call this first.",
		input_schema: { type: "object" as const, properties: {}, required: [] },
	},
	{
		name: "match_package",
		description: "Resolve goal + budget through ELC's routing matrix. Returns matched package(s) with list and discounted prices plus default item ids.",
		input_schema: {
			type: "object" as const,
			properties: {
				goal: { type: "string", description: "goal id from get_partnership_options" },
				budget: { type: "string", description: "budget id from get_partnership_options" },
			},
			required: ["goal", "budget"],
		},
	},
	{
		name: "customize_package",
		description: "Recompute a basket: authoritative total, per-item prices, discount, what else could be added. Call after every change the visitor asks for.",
		input_schema: {
			type: "object" as const,
			properties: {
				preset_id: { type: "string", enum: PRESET_IDS },
				item_ids: { type: "array", items: { type: "string" } },
			},
			required: ["preset_id", "item_ids"],
		},
	},
	{
		name: "book_intro_call",
		description: "The human ending: a direct booking link for a 1:1 intro meeting with Marian, ELC's founder. Offer on hesitation or when tailoring beyond the catalog is needed.",
		input_schema: { type: "object" as const, properties: {}, required: [] },
	},
	{
		name: "design_journey",
		description: "Deterministic 12-month plan for the basket: what lands in which month plus the recurring layer. Only contains items in the basket.",
		input_schema: {
			type: "object" as const,
			properties: {
				preset_id: { type: "string", enum: PRESET_IDS },
				item_ids: { type: "array", items: { type: "string" } },
				start_month: { type: "string", description: "YYYY-MM" },
			},
			required: ["preset_id", "item_ids", "start_month"],
		},
	},
	{
		name: "request_offer",
		description: "Send the itemized offer (AI-channel discount applied): visitor email, notification to ELC, partners queue. The only tool that takes contact details.",
		input_schema: {
			type: "object" as const,
			properties: {
				name: { type: "string" },
				email: { type: "string" },
				company: { type: "string" },
				kpis: { type: "string" },
				visibility_interest: { type: "string", enum: ["company", "individual", "quiet", "undecided"], description: "From the discovery question: invest in visibility as a company, through individual leaders, or stay quiet?" },
				final_price_confirmed: { type: "boolean", description: "REQUIRED TRUE: only after the visitor explicitly confirmed the exact final total. Refused otherwise." },
				preset_id: { type: "string", enum: PRESET_IDS },
				item_ids: { type: "array", items: { type: "string" } },
			},
			required: ["name", "email", "company", "preset_id", "item_ids"],
		},
	},
];

type SideEvent = Record<string, unknown>;

async function runTool(env: ChatEnv, name: string, input: any, side: SideEvent[]): Promise<unknown> {
	switch (name) {
		case "get_partnership_options": {
			const o = partnershipOptions();
			side.push({ type: "suggestions", chips: ["We need to hire senior engineers", "We want to grow our own leaders", "Our product needs reach", "We are building a CEE site", "What is free?"] });
			return o;
		}
		case "match_package": {
			const r = matchPackage(String(input.goal ?? ""), String(input.budget ?? ""));
			if (r.ok && r.matches.length) {
				const m = r.matches[0];
				side.push({
					type: "basket",
					preset_id: m.preset_id,
					preset: m.name,
					total: m.price,
					discounted: m.ai_channel_price?.price ?? null,
					pct: m.ai_channel_price?.pct ?? null,
					item_ids: m.default_item_ids,
					item_count: m.default_item_ids.length,
				});
				side.push({ type: "suggestions", chips: ["What exactly is inside?", "Show my 12-month year", "Trim it down a bit", "Send me this offer"] });
			}
			return r;
		}
		case "customize_package": {
			const preset = presetById(String(input.preset_id ?? ""));
			if (!preset) return { error: `unknown preset — valid: ${PRESET_IDS.join(", ")}` };
			const ids = Array.isArray(input.item_ids) ? input.item_ids.map(String) : [];
			const { standard, addons, total } = resolveBasket(preset.id, ids);
			const d = discountFor(total, "chat", preset.id);
			side.push({
				type: "basket",
				preset_id: preset.id,
				preset: preset.name,
				total,
				discounted: d?.discounted ?? null,
				pct: d?.pct ?? null,
				item_ids: ids,
				item_count: standard.length + addons.length,
			});
			side.push({ type: "suggestions", chips: ["Show my 12-month year", "What could we add?", "Send me this offer"] });
			return {
				preset: { id: preset.id, name: preset.name },
				selected: { standard, addons },
				total,
				total_display: total === 0 ? "Free" : `${eur(total)} / year, excl. VAT`,
				...(d ? { ai_channel_discount: { pct: d.pct, price_after_discount: d.discounted } } : {}),
				available_to_add: availableItems(preset.id, ids),
				terms: guardrailBlock(),
			};
		}
		case "book_intro_call": {
			side.push({ type: "suggestions", chips: ["Book the intro call", "Back to the package", "Start with the free layer"] });
			return {
				booking_url: "https://app.reclaim.ai/m/meet-marian/now",
				what: "Direct calendar booking, 30 minutes with Marian. The conversation starts from whatever was built here.",
				also: "Not ready for either? The free layer runs today, no invoice: https://www.engineeringleaders.io/partner/membership/free/",
			};
		}
		case "design_journey": {
			const items = journeyItemsFor(String(input.preset_id ?? ""), Array.isArray(input.item_ids) ? input.item_ids.map(String) : []);
			if (!items.length) return { error: "empty basket" };
			try {
				const j = buildJourney(items, String(input.start_month ?? ""));
				side.push({ type: "journey", months: j.months, recurring: j.recurring });
				side.push({ type: "suggestions", chips: ["Looks right, send me the offer", "Move things around", "Back to the items"] });
				return {
					...j,
					scheduling_caveat:
						"Event months are planning targets, not booked dates — exact slots are confirmed with Marian at signing against ELC's shared events calendar.",
				};
			} catch (e) {
				return { error: String(e instanceof Error ? e.message : e) };
			}
		}
		case "request_offer": {
			if (input.final_price_confirmed !== true) {
				return { error: "price_not_confirmed", message: "Show the exact final total and get an explicit yes first, then retry with final_price_confirmed: true." };
			}
			const r = await submitOffer(env, {
				name: String(input.name ?? ""),
				email: String(input.email ?? ""),
				company: String(input.company ?? ""),
				kpis: [input.kpis ? String(input.kpis) : "", input.visibility_interest ? `Visibility interest: ${input.visibility_interest}` : ""].filter(Boolean).join(" | ") || undefined,
				presetId: String(input.preset_id ?? ""),
				itemIds: Array.isArray(input.item_ids) ? input.item_ids.map(String) : [],
				channel: "chat",
			});
			if (r.ok) {
				side.push({
					type: "submitted",
					preset: r.presetName,
					list_total: r.listTotal,
					final_total: r.finalTotal,
					pct: r.discountPct,
					test: r.test,
				});
				side.push({ type: "suggestions", chips: ["Book the call with Marian", "What happens next?"] });
			}
			return r;
		}
		default:
			return { error: `unknown tool ${name}` };
	}
}

export async function handleChat(request: Request, env: ChatEnv): Promise<Response> {
	const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
	const headers = {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache",
		connection: "keep-alive",
	};
	const fail = (message: string, status = 400) =>
		new Response(sse({ type: "error", message }) + sse({ type: "done" }), { status, headers });

	if ((env.CHAT_ENABLED ?? "true") === "false") {
		return fail("The chat is asleep right now. Book a call instead: https://app.reclaim.ai/m/meet-marian/now", 503);
	}
	if (!env.ANTHROPIC_API_KEY) return fail("chat_not_configured", 503);

	let body: any;
	try {
		body = await request.json();
	} catch {
		return fail("invalid_json");
	}

	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	if (env.CHAT_RATE_LIMITER) {
		const { success } = await env.CHAT_RATE_LIMITER.limit({ key: ip });
		if (!success) return fail("Too many messages too fast. Give it a minute.", 429);
	}

	// ── session gate: Turnstile once, HMAC token after ────────────────────────────────────────
	const now = Date.now();
	const secret = env.CHAT_SESSION_SECRET;
	let sessionEvent: string | null = null;
	if (secret) {
		const hasValidSession = typeof body.session_token === "string" && (await verifySession(secret, body.session_token, now));
		if (!hasValidSession) {
			if (env.CHAT_TURNSTILE_SECRET) {
				const token = String(body.turnstile_token ?? "");
				try {
					const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
						method: "POST",
						headers: { "content-type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({ secret: env.CHAT_TURNSTILE_SECRET, response: token, remoteip: ip }),
					});
					const verify: any = await res.json().catch(() => ({ success: false }));
					if (!verify.success) return fail("spam_check_failed", 403);
				} catch (e) {
					// Fail-open on our own network hiccup — same posture as /join, /cfp, /donate.
					console.error("turnstile exception", String(e));
				}
			}
			sessionEvent = sse({ type: "session", token: await mintSession(secret, now) });
		}
	}

	// ── input caps ────────────────────────────────────────────────────────────────────────────
	let messages: { role: "user" | "assistant"; content: any }[] = Array.isArray(body.messages) ? body.messages : [];
	if (!messages.length) return fail("empty_messages");
	if (messages.length > MAX_MESSAGES) return fail("This conversation is long enough — book the call: https://app.reclaim.ai/m/meet-marian/now");
	messages = messages.slice(-KEEP_LAST).map((m) => ({
		role: m.role === "assistant" ? "assistant" : "user",
		content: typeof m.content === "string" ? m.content.slice(0, MAX_CHARS) : m.content,
	}));

	const model = env.CHAT_MODEL ?? "claude-sonnet-5";
	const stream = new ReadableStream({
		async start(controller) {
			const emit = (o: unknown) => controller.enqueue(new TextEncoder().encode(sse(o)));
			if (sessionEvent) controller.enqueue(new TextEncoder().encode(sessionEvent));
			try {
				let iterations = 0;
				// Manual agent loop: stream each model turn; on tool_use, run the tool, feed the
				// result back, continue until an end_turn or the iteration cap.
				while (iterations < MAX_TOOL_ITERATIONS) {
					iterations++;
					const res = await fetch("https://api.anthropic.com/v1/messages", {
						method: "POST",
						headers: {
							"x-api-key": env.ANTHROPIC_API_KEY!,
							"anthropic-version": "2023-06-01",
							"content-type": "application/json",
						},
						body: JSON.stringify({
							model,
							max_tokens: 1500,
							system: [{ type: "text", text: SYSTEM_PROMPT + "\n\n" + guardrailBlock(), cache_control: { type: "ephemeral" } }],
							tools: TOOLS,
							messages,
							stream: true,
						}),
					});
					if (!res.ok || !res.body) {
						const errText = await res.text().catch(() => "");
						console.error("anthropic error", res.status, errText.slice(0, 300));
						emit({ type: "error", message: "The assistant hiccuped. Say that again?" });
						break;
					}

					// Parse the Anthropic SSE stream: accumulate text + tool_use blocks.
					const reader = res.body.getReader();
					const decoder = new TextDecoder();
					let buf = "";
					let stopReason: string | null = null;
					const contentBlocks: any[] = [];
					let currentTool: { id: string; name: string; json: string } | null = null;
					let textAcc = "";

					const processLine = (line: string) => {
						if (!line.startsWith("data: ")) return;
						let ev: any;
						try {
							ev = JSON.parse(line.slice(6));
						} catch {
							return;
						}
						if (ev.type === "content_block_start") {
							if (ev.content_block?.type === "tool_use") {
								currentTool = { id: ev.content_block.id, name: ev.content_block.name, json: "" };
							}
						} else if (ev.type === "content_block_delta") {
							if (ev.delta?.type === "text_delta") {
								textAcc += ev.delta.text;
								emit({ type: "text", delta: ev.delta.text });
							} else if (ev.delta?.type === "input_json_delta" && currentTool) {
								currentTool.json += ev.delta.partial_json;
							}
						} else if (ev.type === "content_block_stop") {
							if (currentTool) {
								contentBlocks.push({ type: "tool_use", id: currentTool.id, name: currentTool.name, input: currentTool.json ? JSON.parse(currentTool.json) : {} });
								currentTool = null;
							} else if (textAcc) {
								contentBlocks.push({ type: "text", text: textAcc });
								textAcc = "";
							}
						} else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
							stopReason = ev.delta.stop_reason;
						}
					};

					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						buf += decoder.decode(value, { stream: true });
						let nl;
						while ((nl = buf.indexOf("\n")) >= 0) {
							processLine(buf.slice(0, nl).trim());
							buf = buf.slice(nl + 1);
						}
					}
					if (textAcc) contentBlocks.push({ type: "text", text: textAcc });

					const toolUses = contentBlocks.filter((b) => b.type === "tool_use");
					if (stopReason !== "tool_use" || !toolUses.length) break;

					messages = [...messages, { role: "assistant", content: contentBlocks }];
					const results: any[] = [];
					for (const tu of toolUses) {
						const side: SideEvent[] = [];
						const out = await runTool(env, tu.name, tu.input ?? {}, side);
						for (const s of side) emit(s);
						results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
					}
					messages = [...messages, { role: "user", content: results }];
				}
				emit({ type: "done" });
			} catch (e) {
				console.error("chat exception", String(e));
				emit({ type: "error", message: "Something broke mid-thought. Try again." });
				emit({ type: "done" });
			} finally {
				controller.close();
			}
		},
	});

	return new Response(stream, { headers });
}
