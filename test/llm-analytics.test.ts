/**
 * LLM analytics units. The tracer itself talks to PostHog over the network, so what is worth
 * testing here is the two pure decisions that guard it: which ids are allowed to reach
 * PostHog (a rejected id drops the whole event, silently), and whether message content is
 * stored for a given consent state — the privacy rule this instrumentation rests on.
 */
import { describe, expect, it } from "vitest";
import { LlmTracer, safeId } from "../src/llm-analytics";

describe("safeId", () => {
	it("accepts the ids the widget actually sends", () => {
		expect(safeId("d9222e05-8708-41b8-98ea-d4a21849e761")).toBe("d9222e05-8708-41b8-98ea-d4a21849e761");
		expect(safeId("c-k3j4h5-lx8p2q")).toBe("c-k3j4h5-lx8p2q");
		expect(safeId("0198f3aa-1234-7000-8000-abcdefabcdef")).toBeDefined();
	});

	it("rejects what PostHog would reject, and non-strings", () => {
		// The endpoint is public: these are the shapes a hand-rolled POST can carry.
		expect(safeId("has space")).toBeUndefined();
		expect(safeId("semi;colon")).toBeUndefined();
		expect(safeId("a".repeat(201))).toBeUndefined();
		expect(safeId("")).toBeUndefined();
		expect(safeId(undefined)).toBeUndefined();
		expect(safeId(null)).toBeUndefined();
		expect(safeId(42)).toBeUndefined();
		expect(safeId({ toString: () => "ok" })).toBeUndefined();
	});
});

/** Reach past the private fields — these are internal decisions with external consequences,
 *  and the alternative is asserting on captured network payloads. */
const storesContent = (t: LlmTracer) => (t as unknown as { storeContent: boolean }).storeContent;
const isAnonymous = (t: LlmTracer) => (t as unknown as { anonymous: boolean }).anonymous;
const distinctIdOf = (t: LlmTracer) => (t as unknown as { distinctId: string }).distinctId;

describe("consent posture", () => {
	it("stores content for a consented visitor", () => {
		const t = new LlmTracer({ traceId: "trace-1", distinctId: "person-1" });
		expect(isAnonymous(t)).toBe(false);
		expect(storesContent(t)).toBe(true);
		expect(distinctIdOf(t)).toBe("person-1");
	});

	it("withholds content and the person profile when the visitor opted out", () => {
		// No distinct_id is what an opt-out looks like from here: elc-web never loaded PostHog.
		const t = new LlmTracer({ traceId: "trace-2" });
		expect(isAnonymous(t)).toBe(true);
		expect(storesContent(t)).toBe(false);
		// The trace id doubles as the anonymous id so the turns still group.
		expect(distinctIdOf(t)).toBe("trace-2");
	});

	it("honours the CHAT_AI_CONTENT override in both directions", () => {
		expect(storesContent(new LlmTracer({ traceId: "t", contentMode: "always" }))).toBe(true);
		expect(storesContent(new LlmTracer({ traceId: "t", distinctId: "p", contentMode: "never" }))).toBe(false);
		// Anything unrecognised must fall back to the safe default, not to "always".
		expect(storesContent(new LlmTracer({ traceId: "t", contentMode: "typo" }))).toBe(false);
	});
});
