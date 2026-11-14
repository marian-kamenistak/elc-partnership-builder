/**
 * The uptime tick (ai-mcp-launch P7.5), split out of index.ts so the pause gate, the 2-tick paging rule and the run report can be tested.
 * Behaviour is the one index.ts had: one retry per check, a page only after 2 consecutive failed ticks (streak in UPTIME_STATE KV,
 * since every cron tick is a fresh isolate), a control-room report for every failure that pages plus one summary a day.
 * New (operating standard, 2026-11-14): the web pause flag is read first (a paused tick probes nothing and pages nothing), and a
 * reporting tick is a live v2 run: start, one step per check, end with iterations, errors and the deploy version.
 */
import { endTick, gateTick, isDailyTick, openTick, startTick, stepTick, type RunEnv } from "./run-report";

export const JOB_ID = "elc-partnership-builder";
export const STREAK_KEY = "uptime:consecutive-fail-count";
const EVERY_MIN = 15;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface UptimeCheck {
	name: string;
	run: () => Promise<boolean>;
}
export interface UptimeEnv extends RunEnv {
	UPTIME_STATE: { get(key: string): Promise<string | null>; put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>; delete(key: string): Promise<void> };
}

export async function uptimeTick(
	env: UptimeEnv,
	scheduledTime: number,
	ctx: { waitUntil(p: Promise<unknown>): void },
	checks: UptimeCheck[],
	page: (streak: number, failures: string[]) => Promise<void>,
	retryDelayMs = 400,
): Promise<{ paused?: boolean; failures: string[]; paged: boolean }> {
	// A daily summary on the first tick after 00:00 UTC; a zz- REPORT_JOB_ID (test only) reports every tick.
	const t = openTick(env, { jobId: JOB_ID, host: JOB_ID }, scheduledTime, (job) => isDailyTick(scheduledTime, EVERY_MIN) || job.startsWith("zz-"));
	if (!(await gateTick(t))) return { paused: true, failures: [], paged: false };
	await startTick(t);

	const failures: string[] = [];
	for (const c of checks) {
		const t1 = Date.now();
		let failed: string | null = null;
		try {
			// One retry, after a short backoff, before calling it a failure: absorbs a single transient blip.
			if (!(await c.run()) && !(await pause(retryDelayMs).then(c.run))) failed = c.name;
		} catch (e) {
			failed = `${c.name} (${String(e).slice(0, 80)})`;
		}
		if (failed) failures.push(failed);
		await stepTick(t, { name: c.name, items_in: 1, items_out: failed ? 0 : 1, duration_s: (Date.now() - t1) / 1000, warnings: failed ? [failed] : [] });
	}
	const summary = { iterations: checks.length, kpi: `${checks.length - failures.length}/${checks.length} uptime checks ok` };

	if (!failures.length) {
		await env.UPTIME_STATE.delete(STREAK_KEY);
		if (t.reporting) ctx.waitUntil(endTick(t, "success", { ...summary, kpi_pass: "yes", exit_code: 0, detail: "daily summary: uptime probe every 15 min" }));
		return { failures, paged: false };
	}

	console.error("[UPTIME_FAIL]", failures);
	const prevStreak = Number((await env.UPTIME_STATE.get(STREAK_KEY)) ?? "0");
	const streak = prevStreak + 1;
	await env.UPTIME_STATE.put(STREAK_KEY, String(streak), { expirationTtl: 3600 });
	if (streak < 2) {
		// One bad tick alone does not page: wait for the next tick to confirm. A live run is closed so the dashboard does not show it running.
		if (t.run) ctx.waitUntil(endTick(t, "skipped", { ...summary, kpi_pass: "n/a", detail: `first failed tick, pages only if the next one fails too: ${failures.join(" · ")}`.slice(0, 1000), warnings: failures }));
		return { failures, paged: false };
	}
	ctx.waitUntil(endTick(t, "failed", { ...summary, kpi_pass: "no", exit_code: 1, detail: failures.join(" · ").slice(0, 1000), errors: failures }));
	await page(streak, failures);
	return { failures, paged: true };
}
