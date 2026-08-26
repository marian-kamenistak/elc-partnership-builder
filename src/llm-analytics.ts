/**
 * LLM analytics for the /partner/chat/ widget — PostHog AI observability over the chat door.
 *
 * The MCP door has had usage analytics since launch (mcp-usage.ts). The chat door had none:
 * Workers observability counts requests to /mcp/partnership/chat, and posthog-js on elc-web
 * counts `chat_opened` / `chat_offer_submitted`. Between those two lines sat the part that
 * actually does the selling — what the visitor asked, which tools ran, what it cost, where the
 * loop dead-ended — and none of it was recorded anywhere.
 *
 * What this adds, per model turn:
 *   $ai_generation  one per iteration of the agent loop, with tokens, cache hits, latency,
 *                   time-to-first-token, stop reason and the messages either side of the call
 *   $ai_span        one per tool invocation, parented to the generation that requested it —
 *                   this is what turns "the chat is slow" into "design_journey took 900ms"
 *
 * No $ai_trace event is sent. A trace here is a CONVERSATION, and a conversation spans many
 * HTTP requests (the server is stateless; the widget re-sends history every turn). One explicit
 * trace event per request would mint N duplicate traces for one conversation. PostHog's
 * pseudo-traces aggregate the children into a single trace on $ai_trace_id instead, which is
 * exactly the grouping we want and costs nothing to maintain.
 *
 * Identity and consent — the part to read before changing anything here:
 *
 * elc-web loads PostHog only for visitors who have not opted out (Layout.astro: a rejecting
 * visitor never downloads the library). So the widget can only hand us a distinct_id when
 * consent exists. Two modes follow from that, and the difference is deliberate:
 *
 *   consented   → real distinct_id, person profile, full conversation content. The trace joins
 *                 the same person as the pageviews and the form submit, so "did chatting make
 *                 them convert" is answerable in a funnel.
 *   opted out   → the conversation id doubles as an anonymous distinct_id,
 *                 $process_person_profile: false, and NO message content. Cost, latency, token
 *                 counts and errors still land, because those are operational telemetry about
 *                 our own Worker — the same thing a server log records — and losing them would
 *                 mean the spend on a public unauthenticated LLM endpoint is unmeasurable for
 *                 an unknown share of traffic. Nothing the visitor typed is stored.
 *
 * CHAT_AI_CONTENT overrides the content half of that (`consented` default, `never` to store no
 * message content at all, `always` to store it regardless). Config, not code — same posture as
 * CHAT_MODEL and CHAT_ENABLED.
 *
 * Redaction runs on content in BOTH modes, mirroring mcp-usage.ts: a work email and a person's
 * name never reach the analytics store, a company name deliberately does ("which company was
 * pricing a partnership" is the most useful property on the event). The regexes below are a
 * copy of that module's, not an import — mcp-usage.ts is byte-identical across five server
 * repos by convention, so it does not grow exports for one of them.
 */

import { PostHog } from "posthog-node";

/** Project *write* key — public by design; it already ships in elc-web's client bundle. Same
 *  project as the site's web analytics and the MCP door, so chat traces, `?ref=mcp` traffic and
 *  pageviews sit in one funnel. index.ts feeds this to USAGE_CONFIG too, so there is one
 *  source of truth for it in this repo. */
export const POSTHOG_KEY = "phc_waN4oTJtyBpZyMFNDNkk54QmmqmePyRDghKGcTkPfWPY";
/** Every ELC property is on PostHog EU. Note this is the ingestion host, NOT elc-web's
 *  view.engineeringleaders.io reverse proxy — that proxy exists to survive ad blockers in a
 *  browser, and a Worker has no such problem. Going direct saves a hop and cannot loop. */
export const POSTHOG_HOST = "https://eu.i.posthog.com";

/* ────────────────────────── redaction (see header) ────────────────────────── */

const PII_KEYS = /^(email|e_mail|mail|name|full_name|first_name|last_name|contact_name|phone|tel|linkedin)$/i;
const EMAIL_IN_TEXT = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const REDACTED = "[redacted]";

/** Longest string we keep in any single field. A tool_result for design_journey is a page of
 *  JSON, and a 40-turn conversation carries 30 of them — without a cap one event can exceed
 *  PostHog's payload limit and be dropped whole, which is the worst failure mode available
 *  (silent, and it takes the token counts with it). */
const MAX_FIELD_CHARS = 2000;
/** Turns kept in $ai_input. The last 20 carry the shape of the conversation; the earlier ones
 *  are already on the previous generations of the same trace. */
const MAX_INPUT_MESSAGES = 20;

function redact(value: unknown, depth = 0): unknown {
	if (depth > 6) return value;
	if (typeof value === "string") {
		const clean = value.replace(EMAIL_IN_TEXT, REDACTED);
		return clean.length > MAX_FIELD_CHARS ? `${clean.slice(0, MAX_FIELD_CHARS)}…[truncated]` : clean;
	}
	if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = PII_KEYS.test(k) ? REDACTED : redact(v, depth + 1);
		}
		return out;
	}
	return value;
}

/* ────────────────────────── tracer ────────────────────────── */

export interface LlmTracerOptions {
	/** Stable across every HTTP request of one conversation — the widget mints it on load and
	 *  re-sends it. Without it each turn would look like its own conversation. */
	traceId: string;
	/** PostHog distinct_id from the widget, present only when the visitor has not opted out. */
	distinctId?: string;
	/** PostHog session id from the widget — links the trace to the session recording. */
	sessionId?: string;
	/** `CHAT_AI_CONTENT`: "consented" (default) | "always" | "never". */
	contentMode?: string;
	/** `ctx.waitUntil` — capture and flush must not hold the SSE stream open. */
	waitUntil?: (p: Promise<unknown>) => void;
}

export interface GenerationRecord {
	model: string;
	/** Messages sent to Anthropic for this turn. */
	input: unknown[];
	/** Assistant content blocks that came back (text + tool_use). */
	output: unknown[];
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	/** Seconds. */
	latency: number;
	/** Seconds to the first streamed token, when one arrived. */
	timeToFirstToken?: number;
	stopReason?: string | null;
	httpStatus?: number;
	isError?: boolean;
	error?: string;
	/** 1-based index of this turn within the request's agent loop. */
	iteration: number;
	/** Names of the tools this generation asked for, for at-a-glance filtering. */
	toolsCalled?: string[];
}

export interface SpanRecord {
	name: string;
	/** tool_use id — already unique per call, so it doubles as the span id. */
	spanId: string;
	/** $ai_span_id of the generation that requested this tool. */
	parentId: string;
	latency: number;
	input: unknown;
	isError?: boolean;
}

/**
 * One tracer per HTTP request. Cheap to construct and safe to construct unconditionally —
 * every method is a no-op when PostHog is not configured.
 */
export class LlmTracer {
	private readonly client: PostHog | null;
	private readonly distinctId: string;
	private readonly anonymous: boolean;
	private readonly storeContent: boolean;

	constructor(private readonly opts: LlmTracerOptions) {
		if (!POSTHOG_KEY) {
			// Never throw: this sits on a revenue surface and a missing analytics key must not
			// cost a partnership enquiry. Loud in the log instead — `observability` is on for
			// this Worker, so this is visible in `wrangler tail` rather than truly silent.
			console.error(
				"POSTHOG_KEY variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once POSTHOG_KEY is configured",
			);
			this.client = null;
		} else {
			this.client = new PostHog(POSTHOG_KEY, {
				host: POSTHOG_HOST,
				// Same reasoning as mcp-usage.ts: posthog-node's default batching assumes a
				// long-lived process. A Workers isolate can be torn down the moment the response
				// finishes, and a batch still in memory is simply lost.
				flushAt: 1,
				flushInterval: 0,
			});
		}
		this.anonymous = !opts.distinctId;
		this.distinctId = opts.distinctId ?? opts.traceId;
		const mode = opts.contentMode ?? "consented";
		this.storeContent = mode === "always" || (mode !== "never" && !this.anonymous);
	}

	/** Properties every event in this request shares. */
	private base(): Record<string, unknown> {
		return {
			$ai_trace_id: this.opts.traceId,
			...(this.opts.sessionId ? { $ai_session_id: this.opts.sessionId } : {}),
			// An opted-out visitor gets telemetry but no person row.
			...(this.anonymous ? { $process_person_profile: false } : {}),
			// Distinguishes these traces from anything the MCP door or a future surface emits.
			ai_surface: "partner_chat",
		};
	}

	private send(event: string, properties: Record<string, unknown>): void {
		if (!this.client) return;
		try {
			this.client.capture({ distinctId: this.distinctId, event, properties });
		} catch (e) {
			console.error("[LLM_ANALYTICS] capture", String(e));
		}
	}

	/** Record one model turn. Returns the span id to parent this turn's tool spans onto. */
	generation(rec: GenerationRecord): string {
		const spanId = `${this.opts.traceId}-gen-${rec.iteration}`;
		this.send("$ai_generation", {
			...this.base(),
			$ai_span_id: spanId,
			$ai_span_name: `partner_chat_turn_${rec.iteration}`,
			$ai_model: rec.model,
			$ai_provider: "anthropic",
			$ai_input_tokens: rec.inputTokens,
			$ai_output_tokens: rec.outputTokens,
			$ai_cache_read_input_tokens: rec.cacheReadTokens,
			$ai_cache_creation_input_tokens: rec.cacheCreationTokens,
			$ai_latency: rec.latency,
			...(rec.timeToFirstToken !== undefined ? { $ai_time_to_first_token: rec.timeToFirstToken } : {}),
			$ai_stream: true,
			$ai_max_tokens: 1500,
			...(rec.stopReason ? { $ai_stop_reason: rec.stopReason } : {}),
			...(rec.httpStatus ? { $ai_http_status: rec.httpStatus } : {}),
			...(rec.isError ? { $ai_is_error: true, $ai_error: rec.error ?? "unknown" } : {}),
			$ai_base_url: "https://api.anthropic.com/v1",
			...(this.storeContent
				? {
						$ai_input: redact(rec.input.slice(-MAX_INPUT_MESSAGES)),
						$ai_output_choices: redact([{ role: "assistant", content: rec.output }]),
					}
				: {}),
			// Tool names are not personal data and are the highest-signal filter on the list
			// view, so they ride along even when content is withheld.
			...(rec.toolsCalled?.length ? { ai_tools_called: rec.toolsCalled } : {}),
			ai_iteration: rec.iteration,
		});
		return spanId;
	}

	/** Record one tool invocation, parented to the generation that asked for it. */
	span(rec: SpanRecord): void {
		this.send("$ai_span", {
			...this.base(),
			$ai_span_id: rec.spanId,
			$ai_parent_id: rec.parentId,
			$ai_span_name: rec.name,
			$ai_latency: rec.latency,
			...(rec.isError ? { $ai_is_error: true } : {}),
			...(this.storeContent ? { ai_tool_input: redact(rec.input) } : {}),
			ai_tool_name: rec.name,
		});
	}

	/**
	 * Hand the flush to the runtime. Must be called once per request, after the last capture:
	 * with flushAt 1 the events are already in flight, and shutdown() is what awaits them.
	 * Wrapped in waitUntil so the visitor never waits on PostHog.
	 */
	flush(): void {
		if (!this.client) return;
		const p = this.client.shutdown().catch((e) => console.error("[LLM_ANALYTICS] flush", String(e)));
		if (this.opts.waitUntil) this.opts.waitUntil(p);
	}
}

/** PostHog rejects trace/session ids outside this set, and a rejected event is dropped whole.
 *  The widget sends a crypto.randomUUID(), but the field is visitor-controlled input over a
 *  public endpoint, so it is validated here rather than trusted. */
const ID_SAFE = /^[A-Za-z0-9\-_~.@()!':|]{1,200}$/;

export function safeId(value: unknown): string | undefined {
	return typeof value === "string" && ID_SAFE.test(value) ? value : undefined;
}
