import { describe, expect, it } from "vitest";
import { STREAK_KEY, uptimeTick, type UptimeCheck, type UptimeEnv } from "../src/uptime";

const DAILY = Date.UTC(2026, 10, 14, 0, 0); // first tick after 00:00 UTC
const QUIET = Date.UTC(2026, 10, 14, 10, 15);

function fakeControlRoom(pause?: { by: string; why: string }) {
	const calls: { method: string; path: string; body: any }[] = [];
	return {
		calls,
		binding: {
			fetch: async (u: string, init: RequestInit = {}) => {
				const path = new URL(u).pathname;
				calls.push({ method: init.method ?? "GET", path, body: init.body ? JSON.parse(String(init.body)) : null });
				if (path.startsWith("/api/pause/")) return new Response(JSON.stringify({ ok: true, paused: !!pause, ...pause }), { status: 200 });
				return new Response("{}", { status: 202 });
			},
		},
		posts: () => calls.filter((c) => c.method === "POST").map((c) => c.body),
	};
}
function fakeKv() {
	const m = new Map<string, string>();
	return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k) };
}
const ctx = () => { const p: Promise<unknown>[] = []; return { waitUntil: (x: Promise<unknown>) => void p.push(x), done: () => Promise.all(p) }; };
const ok = (name: string): UptimeCheck => ({ name, run: async () => true });
const bad = (name: string): UptimeCheck => ({ name, run: async () => false });
const mkEnv = (cr: ReturnType<typeof fakeControlRoom>, kv = fakeKv(), extra = {}) =>
	({ CONTROL_ROOM: cr.binding, CONTROL_ROOM_TOKEN: "t", CF_VERSION_METADATA: { id: "ver-1" }, UPTIME_STATE: kv, ...extra }) as unknown as UptimeEnv;

describe("uptimeTick (operating standard v2)", () => {
	it("daily green tick: pause check, then start, a step per check, one end report with iterations and the deploy version", async () => {
		const cr = fakeControlRoom(); const c = ctx();
		const r = await uptimeTick(mkEnv(cr), DAILY, c, [ok("a"), ok("b"), ok("c")], async () => {}, 0);
		await c.done();
		expect(r.failures).toEqual([]);
		expect(cr.calls[0].path).toBe("/api/pause/elc-partnership-builder");
		expect(cr.posts().map((b) => b.event ?? "end")).toEqual(["start", "step", "step", "step", "end"]);
		const end = cr.posts().at(-1);
		expect(end).toMatchObject({ job_id: "elc-partnership-builder", status: "success", iterations: 3, version: "ver-1", kpi_pass: "yes", run_id: `elc-partnership-builder:${DAILY}` });
		expect(end.steps).toHaveLength(3);
	});

	it("a green tick outside the daily summary reports nothing but still asks the pause flag", async () => {
		const cr = fakeControlRoom(); const c = ctx();
		await uptimeTick(mkEnv(cr), QUIET, c, [ok("a")], async () => {}, 0);
		await c.done();
		expect(cr.posts()).toEqual([]);
		expect(cr.calls.map((x) => x.path)).toEqual(["/api/pause/elc-partnership-builder"]);
	});

	it("gate path: paused from the web probes nothing, pages nothing, reports paused (not a failure) on a reporting tick", async () => {
		const cr = fakeControlRoom({ by: "marian@kamenistak.com", why: "registry migration" }); const c = ctx(); let ran = 0; let paged = 0;
		const r = await uptimeTick(mkEnv(cr), DAILY, c, [{ name: "a", run: async () => (ran++, false) }], async () => void paged++, 0);
		await c.done();
		expect(r.paused).toBe(true);
		expect(ran).toBe(0); expect(paged).toBe(0);
		expect(cr.posts()).toHaveLength(1);
		expect(cr.posts()[0]).toMatchObject({ status: "paused" });
		expect(cr.posts()[0].detail).toMatch(/paused by marian: registry migration/);
	});

	it("gate path: paused on a quiet tick stays silent", async () => {
		const cr = fakeControlRoom({ by: "marian@kamenistak.com", why: "x" }); const c = ctx();
		await uptimeTick(mkEnv(cr), QUIET, c, [bad("a")], async () => {}, 0);
		await c.done();
		expect(cr.posts()).toEqual([]);
	});

	it("failure path: the first failed tick does not page; the second pages once and reports failed with the errors", async () => {
		const cr = fakeControlRoom(); const kv = fakeKv(); const pages: [number, string[]][] = [];
		let c = ctx();
		const first = await uptimeTick(mkEnv(cr, kv), QUIET, c, [ok("a"), bad("b")], async (s, f) => void pages.push([s, f]), 0);
		await c.done();
		expect(first.paged).toBe(false); expect(pages).toEqual([]); expect(kv.m.get(STREAK_KEY)).toBe("1");
		expect(cr.posts()).toEqual([]);
		c = ctx();
		const second = await uptimeTick(mkEnv(cr, kv), QUIET + 900_000, c, [ok("a"), bad("b")], async (s, f) => void pages.push([s, f]), 0);
		await c.done();
		expect(second.paged).toBe(true); expect(pages).toEqual([[2, ["b"]]]);
		const end = cr.posts().at(-1);
		expect(end).toMatchObject({ status: "failed", kpi_pass: "no", errors: ["b"], iterations: 2, version: "ver-1" });
		expect(end.steps.map((s: any) => s.items_out)).toEqual([1, 0]); // not live: the end report alone carries the steps
	});

	it("a first failed tick that is also the daily summary closes its live run as skipped, never leaves it running", async () => {
		const cr = fakeControlRoom(); const c = ctx();
		const r = await uptimeTick(mkEnv(cr), DAILY, c, [bad("a")], async () => {}, 0);
		await c.done();
		expect(r.paged).toBe(false);
		expect(cr.posts().map((b) => b.event ?? "end")).toEqual(["start", "step", "end"]);
		expect(cr.posts().at(-1)).toMatchObject({ status: "skipped" });
	});

	it("a check that throws counts as a failure; a check that fails once then passes does not", async () => {
		const cr = fakeControlRoom(); const c = ctx(); let n = 0;
		const flaky: UptimeCheck = { name: "flaky", run: async () => ++n > 1 };
		const boom: UptimeCheck = { name: "boom", run: async () => { throw new Error("socket closed"); } };
		const r = await uptimeTick(mkEnv(cr), DAILY, c, [flaky, boom], async () => {}, 0);
		await c.done();
		expect(n).toBe(2);
		expect(r.failures).toEqual(["boom (Error: socket closed)"]);
	});

	it("a green tick clears the failure streak", async () => {
		const kv = fakeKv(); kv.m.set(STREAK_KEY, "1"); const c = ctx();
		await uptimeTick(mkEnv(fakeControlRoom(), kv), QUIET, c, [ok("a")], async () => {}, 0);
		await c.done();
		expect(kv.m.has(STREAK_KEY)).toBe(false);
	});

	it("fails open: no binding, or a control-room that throws, never stops the probe", async () => {
		const kv = fakeKv(); let c = ctx();
		const none = await uptimeTick({ UPTIME_STATE: kv } as unknown as UptimeEnv, DAILY, c, [ok("a")], async () => {}, 0);
		await c.done();
		expect(none.failures).toEqual([]);
		c = ctx();
		const down = { UPTIME_STATE: kv, CONTROL_ROOM_TOKEN: "t", CONTROL_ROOM: { fetch: async () => { throw new Error("down"); } } } as unknown as UptimeEnv;
		const r = await uptimeTick(down, DAILY, c, [ok("a"), bad("b")], async () => {}, 0);
		await c.done();
		expect(r.failures).toEqual(["b"]);
	});

	it("a zz- REPORT_JOB_ID (test deploys) reports every tick, live, under that id", async () => {
		const cr = fakeControlRoom(); const c = ctx();
		await uptimeTick(mkEnv(cr, fakeKv(), { REPORT_JOB_ID: "zz-pb-proof" }), QUIET, c, [ok("a")], async () => {}, 0);
		await c.done();
		expect(cr.posts().map((b) => b.event ?? "end")).toEqual(["start", "step", "end"]);
		expect(cr.posts().every((b) => b.job_id === "zz-pb-proof" && b.is_test === true)).toBe(true);
	});
});
