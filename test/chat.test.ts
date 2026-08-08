/**
 * Chat backend units: the session-token HMAC roundtrip and expiry. The agent loop itself is
 * exercised live (scripted SSE conversations, plan §Phase 4 eval) — mocking Anthropic's stream
 * here would test the mock.
 */
import { describe, expect, it } from "vitest";
import { mintSession, verifySession } from "../src/chat";

const SECRET = "test-secret";

describe("chat session tokens", () => {
	it("roundtrip verifies", async () => {
		const now = 1_700_000_000_000;
		const token = await mintSession(SECRET, now);
		expect(await verifySession(SECRET, token, now + 1000)).toBe(true);
	});
	it("expires after TTL", async () => {
		const now = 1_700_000_000_000;
		const token = await mintSession(SECRET, now);
		expect(await verifySession(SECRET, token, now + 3 * 60 * 60 * 1000)).toBe(false);
	});
	it("rejects tampered and malformed tokens", async () => {
		const now = 1_700_000_000_000;
		const token = await mintSession(SECRET, now);
		const [exp, sig] = token.split(".");
		expect(await verifySession(SECRET, `${Number(exp) + 9999}.${sig}`, now)).toBe(false);
		expect(await verifySession(SECRET, "garbage", now)).toBe(false);
		expect(await verifySession("other-secret", token, now)).toBe(false);
	});
});
