/**
 * MCP briefings: the text an agent reads, rendered at the MCP boundary from the same core data the
 * web chat (src/chat.ts), the REST API (src/api.ts) and A2A consume untouched.
 *
 * Principle (ai-mcp-launch references/response-design.md, 2026-11-19): a tool response is a
 * briefing, not an API payload. Verdict first, a small table or bullets, conditional sections only
 * when their condition holds, a `Next:` line tied to THIS result. Every piece of steering the old
 * JSON carried (`next_tool`, `caveat`, `nearest_upgrade`, `left_out` reasons, `discount_basis`,
 * `scheduling_caveat`) is re-expressed here as prose, not dropped.
 *
 * Terms ride only on price and offer tools (`termsBrief`); the general rules live once in the
 * server `instructions` (`serverInstructions`). The attribution line is appended by index.ts.
 */
import { ELC_FACTS, SITE, andJoin } from "../content";
import type { buildBusinessCase } from "./businesscase";
import { aiDiscount, customizeNextTool, eur, isCreditPreset, meta, presetById, type OneOffQuote } from "./catalog";
import type { fitToBudget } from "./fit";
import { guardrailLines, type GuardrailScope } from "./guardrails";
import type { JourneyResult } from "./journey";
import type { Match } from "./match";
import type { partnershipOptions } from "./options";
import type { reachOptions } from "./reach";
import type { SeatPrice } from "./seats";

// ── terms and server instructions ───────────────────────────────────────────────────────────

/**
 * The terms that change a pricing decision, attached to price and offer tools only. The full
 * `guardrailBlock` (2.6k chars) used to ride on every successful call, about 30% of each response;
 * general rules now live once in `serverInstructions`. Chat and REST keep `guardrailBlock`.
 */
export function termsBrief(scope: GuardrailScope, presetId?: string): string {
	const d = aiDiscount();
	const parts: string[] = ["Prices are fixed, in EUR, excl. VAT."];
	if (scope === "oneoff") {
		const o = meta.oneoff;
		if (o) {
			parts.push(
				`Combo discount by count of qualifying items: ${o.combo_discounts.map((c) => `${c.min_items}+ ${c.pct}% off`).join(", ")}; job board listings never count and are never discounted. The AI-channel percentage does not apply to one-offs. Every one-off is 100% credited against a company membership signed within ${o.credit_days} days.`,
			);
		}
	} else {
		parts.push(`One partner per category per year; ELC takes max ${meta.global_caps.partners_per_year} partners a year.`);
		if (presetId === "team-seats") parts.push("Team Seats are for the company's own named employees only: no vendors, recruiters or agencies.");
		if (presetId && isCreditPreset(presetId)) {
			parts.push(`${presetById(presetId)?.name ?? presetId} is 100% credited against a company membership signed within 90 days; no AI-channel percentage on top.`);
		} else if (d) {
			parts.push(`The only discount is the ${d.pct}% AI-channel discount, applied automatically when the inquiry is sent through this channel${d.expires ? ` (ends ${d.expires})` : ""}. Never offer or negotiate another.`);
		} else {
			parts.push("There is no discount for building the package through this AI channel; list price. Never offer or negotiate one.");
		}
		const t = meta.payment_terms;
		if (t && presetId && t.packages.includes(presetId)) {
			const m = t.month_one;
			const meetupStart = t.meetup_start.includes(presetId);
			parts.push(
				`Payment: nothing is invoiced for the year until the first ${meetupStart ? "meetup" : "session"} has happened${meetupStart ? `, which ELC runs end to end free of charge (the company pays food and drinks at cost, about EUR ${m.food_drinks}, and EUR ${m.elc_venue} for a venue only if ELC has to rent one)` : ""}. If the company is convinced, ELC then invoices the full year in one invoice${t.walk_away ? "; if not, it pays only the catering of its meetup and walks away" : ""}.`,
			);
		}
	}
	parts.push("Nothing here is a contract; Marian confirms all final terms on a call.");
	return `Terms: ${parts.join(" ")}`;
}

/** The rules that hold on every answer, sent once at initialize instead of on every response. */
export function serverInstructions(conferenceMcp: string): string {
	const lines = guardrailLines("membership");
	const discountRule = lines.find((l) => l.startsWith("The ONLY discount") || l.startsWith("There is no discount")) ?? "";
	const boundary = lines.find((l) => l.startsWith("NOT FOR SALE")) ?? "";
	return [
		`Engineering Leaders Community (ELC) partnership builder: year-round company membership and one-off reach items with the community, priced from the published catalog. ELC Conference 2027 partner packages (Partner, Luminary, Navigator, Pioneer and their add-ons) and conference tickets are a separate offer with their own MCP server: ${conferenceMcp}. Point users there for anything about partnering with or attending the conference day.`,
		`How to use it: start with get_partnership_options for a company considering a year-long membership, or get_reach_options for one thing bought once. Every price comes from a tool: never add prices yourself. Each answer is a briefing that ends with a "Next:" line; relay its numbers and caveats, then follow it.`,
		`Rules that hold on every answer. Prices are fixed, EUR, excl. VAT. Category exclusivity is first-come: one partner per category per year. Nothing here is a contract: Marian confirms all final terms on a call. ${discountRule}`.trim(),
		boundary,
	]
		.filter(Boolean)
		.join("\n\n");
}

// ── shared bits ─────────────────────────────────────────────────────────────────────────────

const priceOf = (n: number): string => (n === 0 ? "included" : eur(n));
const joinItems = (xs: { name: string; price: number; foundation?: boolean }[]): string =>
	xs.map((i) => `${i.name} ${priceOf(i.price)}${i.foundation ? "*" : ""}`).join("; ");

/** Error shape: the problem and what to do about it, no terms, no attribution (2026-08-20). */
export function renderError(p: { error: string; message?: string }): string {
	return p.message ? `Problem: ${p.error}. ${p.message}` : `Problem: ${p.error}`;
}

// ── get_started ─────────────────────────────────────────────────────────────────────────────

export function renderGetStarted(menu: { question: string; name: string }[], conferenceMcp: string): string {
	return [
		`This is the Engineering Leaders Community Partnership Builder: it composes and prices a company membership with ELC (${ELC_FACTS.membersLabel} engineering leaders in ${andJoin(ELC_FACTS.cities)}), and quotes single one-off items (a newsletter classified, a hosted meetup, a dinner) for companies that want one thing once.`,
		`Questions it answers:\n${menu.map((m) => `- "${m.question}" → \`${m.name}\``).join("\n")}`,
		`ELC Conference 2027 partner packages and tickets are not sold here: they have their own MCP server, ${conferenceMcp}`,
		"Next: get_partnership_options for a company considering a year-long membership, get_reach_options for one thing once. Ask the user which of the two they are.",
	].join("\n\n");
}

// ── get_partnership_options ─────────────────────────────────────────────────────────────────

export function renderOptions(o: ReturnType<typeof partnershipOptions>): string {
	const out: string[] = [];
	out.push(
		`ELC company membership: a package you assemble from priced line items, and the total recalculates as items toggle. ${o.how_membership_works.split(" A company membership")[0]} For companies only.`,
	);
	out.push(`Not for: ${o.not_for}`);
	out.push(
		`Community: ${o.community.members} engineering leaders (${o.community.seniority}) in ${o.community.cities}; ${o.community.meetups}; newsletter ${o.community.newsletter}; conference ${o.community.conference}.`,
	);
	if (o.ai_channel_discount) {
		out.push(`Discount: ${o.ai_channel_discount.what} ${o.ai_channel_discount.exception}${o.ai_channel_discount.limit ? ` ${o.ai_channel_discount.limit}` : ""} Mention it early.`);
	}
	out.push(
		[
			"Ask the user two things (free-text answers are fine, map them to the closest id):",
			`1. ${o.question_1.ask} Goal ids: ${o.question_1.options.map((q) => `${q.id} (${q.label})`).join(" · ")}`,
			`2. ${o.question_2.ask} Budget ids: ${o.question_2.options.map((q) => `${q.id}${q.range ? ` (${q.range})` : ""}`).join(" · ")}`,
		].join("\n"),
	);
	out.push(
		[
			"Other starting points:",
			`- One thing once (classified, hosted meetup, dinner): get_reach_options.`,
			`- ELC runs a meetup in the company's office end to end, or coaches one speaker: ${SITE}/reach/meetup/ and ${SITE}/reach/speaker-program/ (get_reach_options prices both).`,
			`- A recurring community under the company's name in a CEE city (Launch Audit, Community Launch, Launch + Run): ${SITE}/for-companies/community-launch/. These keep a 100% credit within 90 days instead of any AI-channel percentage; lead time two months per meetup.`,
		].join("\n"),
	);
	out.push(
		[
			"Objections (use the answer only when it is raised; every figure is a confirmed data point):",
			`- "We use recruiters": ${o.why_elc.vs_recruiters}`,
			`- "We run our own events": ${o.why_elc.vs_own_events}`,
			`- "We sponsor conferences": ${o.why_elc.vs_conference_booths}`,
			`- "Who else did this?": ${o.why_elc.proof}`,
			`- Scarcity is real: ${o.why_elc.scarcity_is_real}`,
		].join("\n"),
	);
	out.push(
		`Not for sale at any price: pitching from an ELC stage, member contact data for outbound, introductions to sell a product (hiring introductions are sold, and only with the candidate's yes first). If they ask, say no plainly and say why (the room stays senior because nobody is sold to). If they need more than the catalog allows, book_intro_call.`,
	);
	out.push(
		`Endings, every conversation should land on one: request_offer (the itemized offer in their inbox), book_intro_call (a human first, never a downgrade), or the free layer, ${SITE}/partner/membership/free/ (no invoice, no contract; cross-sell it to anyone not ready to buy).`,
	);
	out.push(
		`Next: ask the two questions, then match_package({goal, budget}). If they name an exact figure ("we have 8,000 approved") go to match_package first, then fit_to_budget. Once the package takes shape, ask once: ${o.discovery_question.ask} Pass the answer as request_offer's visibility_interest (company, individual, quiet, undecided); never a condition of anything.`,
	);
	return out.join("\n\n");
}

// ── get_reach_options ───────────────────────────────────────────────────────────────────────

export function renderReach(r: ReturnType<typeof reachOptions>): string {
	const rows = r.items.map((i) => {
		const bits = [`\`${i.id}\``, i.name, i.price_display, `lead time: ${i.lead_time}`];
		if (i.cap) bits.push(i.cap);
		if (!i.counts_toward_combo) bits.push("never counts toward the combo, never discounted");
		return `- ${bits.join(" · ")}`;
	});
	const rungs = r.items.find((i) => "rungs" in i && i.rungs);
	const out: string[] = [];
	out.push(
		`${r.items.length} one-offs a company buys once, no package and no annual commitment: ELC sets the date. For a company that wants one concrete thing in front of engineering leaders in Central Europe (${r.audience.members} members, ${r.audience.seniority}; newsletter ${r.audience.newsletter}; meetups ${r.audience.meetups}).`,
	);
	out.push(rows.join("\n"));
	if (rungs && "rungs" in rungs && rungs.rungs) {
		out.push(
			`Speaker programme ladder (${rungs.id}): ${rungs.rungs.map((g) => `${g.id} ${g.price_display}`).join(" · ")}. Stage is always included; the full programme is one item at its bundle price and never takes the combo percentage.`,
		);
	}
	out.push(
		`Combo discount: ${r.combo_discount.rule}, by count of qualifying items, applied to those items only. Not counted: ${r.combo_discount.excluded}. ${r.credit}`,
	);
	out.push(
		`Heads-up: two or more things across a year is a membership conversation and costs less: hand over to get_partnership_options (every one-off is credited in full). Not for sale: stage pitching, member contact data, introductions without the member's yes. Details per item: ${SITE}/reach/`,
	);
	out.push(
		`Next: quote_reach_combo({oneoff_ids: [...]}) once items are picked; add speaker_rungs to price part of the speaker ladder. Never add the prices yourself. Ask the user: which of these do they want, and is it one thing or several? To lock a date, book_intro_call. Marian confirms every one-off on a call.`,
	);
	return out.join("\n\n");
}

// ── quote_reach_combo ───────────────────────────────────────────────────────────────────────

export function renderQuote(q: OneOffQuote): string {
	const out: string[] = [];
	const n = q.items.length;
	out.push(
		q.combo
			? `One-off basket of ${n}: ${eur(q.total)} after the ${q.combo.pct}% combo (list ${eur(q.list_total)}), excl. VAT.`
			: `One-off basket of ${n}: ${eur(q.total)}, excl. VAT. No combo discount applies.`,
	);
	out.push(q.items.map((i) => `- ${i.name} ${eur(i.price)} · lead time: ${i.lead_time}${i.counts_toward_combo ? "" : " · never counts toward the combo, never discounted"}`).join("\n"));
	// State the base, always: "15% off" against the list total does not reconcile by hand whenever a
	// non-qualifying item is in the basket, and a CFO who cannot reproduce a number stops trusting the rest.
	const qualifying = q.items.filter((i) => i.counts_toward_combo).length;
	const lowest = Math.min(...(meta.oneoff?.combo_discounts ?? [{ min_items: 2 }]).map((c) => c.min_items));
	out.push(
		q.combo
			? `Discount basis: ${q.combo.pct}% applies to the ${q.combo.qualifying_items} qualifying item(s) only, ${eur(q.combo.saved)} off. Items marked as not counting (job board listings and the like) never count toward the threshold and are never discounted, so the total will not reconcile against the list total.`
			: `Discount basis: ${qualifying} qualifying item(s), and the lowest threshold is ${lowest}. Items marked as not counting (job board listings and the like) never count toward it and are never discounted.`,
	);
	const heads: string[] = [];
	if (q.duplicate_ids.length) heads.push(`Sent more than once and counted once: ${q.duplicate_ids.join(", ")}. Each one-off is a single placement sold once; to run the same placement repeatedly, say so and it is quoted as separate dated placements.`);
	if (q.unknown_ids.length) heads.push(`Not a one-off, ignored: ${q.unknown_ids.join(", ")}. Valid ids come from get_reach_options.`);
	if (q.unknown_rungs.length) heads.push(`Not on the speaker programme ladder, ignored: ${q.unknown_rungs.join(", ")}.`);
	if (n >= 3) heads.push("Three or more one-offs is usually the point where a company membership costs less for more. Say so and offer get_partnership_options; the one-offs are 100% credited if they take it.");
	if (heads.length) out.push(`Heads-up: ${heads.join(" ")}`);
	out.push(`Credit: 100% against a company membership signed within ${q.credit_days} days.`);
	out.push(
		n >= 3
			? "Next: get_partnership_options to compare against a year, or book_intro_call to fix the dates with Marian. Ask the user: is this a one-time plan or something they would repeat across the year?"
			: "Next: book_intro_call to fix the date with Marian, or get_partnership_options if the basket is starting to look like a year.",
	);
	return out.join("\n\n");
}

// ── match_package ───────────────────────────────────────────────────────────────────────────

export function renderMatch(matches: Match[], goal: string, budget: string): string {
	const goalLabel = (meta.interest_groups as Record<string, string>)[goal] ?? goal;
	const out: string[] = [];
	out.push(
		matches.length > 1
			? `Two ways to start for "${goalLabel}" at budget "${budget}". Both real: present both.`
			: `One package fits "${goalLabel}" at budget "${budget}": ${matches[0].name}.`,
	);
	for (const m of matches) {
		const lines = [`### ${m.name} (\`${m.preset_id}\`): ${m.price_display}`];
		if (m.ai_channel_price) lines.push(`AI channel: ${m.ai_channel_price.display}`);
		lines.push(m.summary);
		if (m.default_items.length) {
			const addon = new Set(m.included_addons);
			lines.push(
				m.default_items
					.map((i) => `- ${i.name} ${priceOf(i.price)}${i.foundation ? " (foundation)" : ""}${addon.has(i.id) ? " (add-on)" : ""}`)
					.join("\n"),
			);
			lines.push(`item_ids: ${m.default_item_ids.join(", ")}`);
		}
		out.push(lines.join("\n"));
	}
	if (matches.some((m) => m.default_items.some((i) => i.foundation))) {
		out.push("Foundation items anchor the package: advise keeping them when the user trims.");
	}
	out.push(
		matches.length > 1
			? `Next: ask the user which start fits, then ${matches.map((m) => `customize_package with preset_id "${m.preset_id}"`).join(" or ")} and that package's item_ids above. fit_to_budget if they name an exact figure; request_offer to send one as it is.`
			: `Next: ${matches[0].next_tool}${matches[0].preset_id === "free" ? "" : " Ask the user: do they have an exact figure rather than a band?"}`,
	);
	return out.join("\n\n");
}

// ── customize_package ───────────────────────────────────────────────────────────────────────

export type CustomizeView = {
	presetId: string;
	presetName: string;
	bundlePrice: number;
	standard: { name: string; price: number; foundation: boolean; id: string }[];
	addons: { name: string; price: number; foundation: boolean; id: string }[];
	total: number;
	totalDisplay: string;
	discount: { pct: number; discounted: number } | null;
	seatPricing: SeatPrice | null;
	seatsPending: { minimumSeats?: number } | null;
	dropped: string[];
	creditNote: string | null;
	available: { id: string; name: string; price: number; addon: boolean; foundation: boolean }[];
};

export function renderCustomize(v: CustomizeView): string {
	const out: string[] = [];
	const count = v.standard.length + v.addons.length;
	out.push(
		`${v.presetName}: ${v.totalDisplay}${v.discount ? `, ${eur(v.discount.discounted)} after the ${v.discount.pct}% AI-channel discount (applied automatically at request_offer; present both figures)` : ""}. ${count} item${count === 1 ? "" : "s"} on.`,
	);
	const on = [...v.standard, ...v.addons];
	const found = on.filter((i) => i.foundation);
	out.push(
		[
			v.standard.length ? `On (standard): ${joinItems(v.standard)}` : "",
			v.addons.length ? `On (add-ons): ${joinItems(v.addons)}` : "",
			found.length ? `Foundation items anchor the package (marked *): advise keeping them.` : "",
			`item_ids on: ${on.map((i) => i.id).join(", ")}`,
		]
			.filter(Boolean)
			.join("\n"),
	);
	const heads: string[] = [];
	if (v.seatPricing) {
		const s = v.seatPricing;
		heads.push(
			`Seat pricing: ${s.seats} seats at ${eur(s.per_seat)} (${s.band}); minimum ${s.minimum_seats}. Bands: ${s.bands.map((b) => `${b.seats} at ${eur(b.per_seat)}`).join(", ")}.${s.next_break ? ` ${s.next_break.note}` : ""}`,
		);
	}
	if (v.seatsPending) {
		heads.push(
			`${v.presetName} is priced per seat. The total above is only the ${v.seatsPending.minimumSeats}-seat entry. Ask how many people they are enrolling, then call again with seats; do not present this figure as their price.`,
		);
	}
	if (v.dropped.length) {
		heads.push(`Not sold in ${v.presetName}, so NOT in the total: ${v.dropped.join(", ")}. Tell the visitor plainly rather than letting them assume it is in there; some items exist only in other packages.`);
	}
	if (v.creditNote) heads.push(v.creditNote);
	if (heads.length) out.push(`Heads-up: ${heads.join("\n")}`);
	if (v.available.length) {
		out.push(`Could still add (${v.available.length}): ${v.available.map((i) => `${i.name} \`${i.id}\` ${priceOf(i.price)}${i.addon ? " (add-on)" : ""}`).join("; ")}`);
	}
	out.push(`Next: ${customizeNextTool(v.presetId, { seatsPending: Boolean(v.seatsPending), free: v.total === 0 })}`);
	return out.join("\n\n");
}

// ── book_intro_call ─────────────────────────────────────────────────────────────────────────

export function renderBook(o: {
	bookingUrl: string;
	freeUrl: string;
	composed?: { name: string; count: number; listTotal: number; discount: { pct: number; discounted: number } | null; note: string };
}): string {
	const out: string[] = [];
	out.push(`Booking link for a 30-minute intro with Marian, ELC's founder: ${o.bookingUrl}. Direct calendar booking, no form before it and no qualification script; the conversation starts from whatever was built here.`);
	if (o.composed) {
		const c = o.composed;
		out.push(`Composed so far: ${c.name}, ${c.count} items, ${eur(c.discount ? c.discount.discounted : c.listTotal)} / year${c.discount ? ` (list ${eur(c.listTotal)})` : ""}.\nBooking note, paste-ready: ${c.note}`);
		out.push("Give the visitor the booking note verbatim and tell them to paste it into the booking form's note field. That is what carries their basket to Marian; do not rely on them remembering it.");
		if (c.discount) {
			out.push("Heads-up: booking a call does not itself lock the AI-channel discount; sending the offer through request_offer is what registers it. Say so plainly rather than implying the call preserves it.");
		}
	} else {
		out.push("No package composed yet, which is fine: the call can start from the two questions. If one gets built first, call this tool again with the basket so the booking note carries it.");
	}
	out.push(`Not ready for either? The free layer runs today, no invoice: ${o.freeUrl}`);
	out.push(
		o.composed
			? "Next: hand over the link and the booking note. If they would rather have the offer in writing first, request_offer."
			: "Next: hand over the link. Ask the user: would they like to build a package first (get_partnership_options) so the call starts from their numbers?",
	);
	return out.join("\n\n");
}

// ── fit_to_budget ───────────────────────────────────────────────────────────────────────────

export function renderFit(r: Exclude<ReturnType<typeof fitToBudget>, { error: string }>): string {
	const out: string[] = [];
	const f = r.fits;
	const n = f.standard.length + f.addons.length;
	const fullFits = r.full_package_for_comparison.payable_total <= r.budget;
	out.push(
		fullFits
			? `The complete ${r.package.name} package already fits inside ${eur(r.budget)} at ${f.total_display}: recommend it whole, not a trimmed version.`
			: `Best fit under ${eur(r.budget)} in ${r.package.name}: ${n} of ${r.full_package_for_comparison.full_item_count} items at ${f.total_display}. ${f.headroom_display}.`,
	);
	out.push(`Priced against ${r.priced_against}.\nKept (${n}; * = foundation): ${joinItems([...f.standard, ...f.addons])}\nitem_ids: ${f.item_ids.join(", ")}`);
	if (r.left_out.length) {
		const generic = r.left_out.filter((e) => e.reason.startsWith("Would take"));
		const special = r.left_out.filter((e) => !e.reason.startsWith("Would take"));
		const lines: string[] = [];
		if (generic.length) lines.push(`Left out (each would take the total past ${eur(r.budget)}): ${generic.map((e) => `${e.name} ${priceOf(e.price)}`).join("; ")}`);
		for (const e of special) lines.push(`- ${e.name} ${priceOf(e.price)}: ${e.reason}`);
		out.push(lines.join("\n"));
	}
	if (!fullFits) out.push(r.full_package_for_comparison.note);
	if ("nearest_upgrade" in r && r.nearest_upgrade) out.push(`Nearest upgrade: ${r.nearest_upgrade.note}`);
	const heads: string[] = [];
	if ("must_haves_that_did_not_fit" in r && r.must_haves_that_did_not_fit) heads.push(`Asked for but did not fit: ${r.must_haves_that_did_not_fit.join(", ")}.`);
	if ("unknown_must_have_ids" in r && r.unknown_must_have_ids) heads.push(`Not items in this package, ignored: ${r.unknown_must_have_ids.join(", ")}.`);
	if (heads.length) out.push(`Heads-up: ${heads.join(" ")}`);
	out.push(`Method: ${r.method}`);
	out.push(`Caveat: ${r.caveat}`);
	out.push(
		`Next: ${r.next_tool.replace("customize_package", `customize_package (preset_id "${r.package.id}", item_ids above)`)}${r.left_out.length && !fullFits ? " Ask the user: is anything left out a must-have? If so, pass it as must_have and re-run." : ""}`,
	);
	return out.join("\n\n");
}

// ── build_business_case ─────────────────────────────────────────────────────────────────────

type CaseOk = Exclude<ReturnType<typeof buildBusinessCase>, { error: string }>;

export function renderBusinessCase(c: CaseOk, memo: string, hadSalary: boolean): string {
	const out: string[] = [];
	if ("no_case_needed" in c && c.no_case_needed) {
		out.push(`No business case needed for ${c.package.name}: ${c.why}`);
		out.push(`What to say: ${c.what_to_say}\nLink: ${c.link}`);
		out.push("Next: give them the link. If they want more than this, customize_package with a paid preset, or book_intro_call.");
		return out.join("\n\n");
	}
	const k = c as Exclude<CaseOk, { no_case_needed: boolean }>;
	const inv = k.figures[0];
	const head = k.hiring?.break_even_hires
		? `pays for itself at ${k.hiring.break_even_hires}`
		: k.retention
			? "pays for itself if it keeps one leader who would otherwise have left"
			: "compared against what it replaces";
	out.push(`Business case for ${k.package.name}${k.company ? ` (${k.company})` : ""}: ${inv.value}; ${head}. A cost comparison, never a forecast.`);
	const bullets: string[] = [];
	for (const f of k.figures.slice(1)) bullets.push(`- ${f.label}: ${f.value}`);
	if (k.hiring) {
		bullets.push(`- Agency fee ${k.hiring.fee_band} (${k.hiring.fee_basis}); ELC charges ${k.hiring.elc_fee_per_hire}`);
		bullets.push(`- ${k.hiring.break_even_sentence}`);
		bullets.push(`- This membership is ${k.hiring.share_of_one_placement}`);
		if ("your_roles" in k.hiring && k.hiring.your_roles) bullets.push(`- Their ${k.hiring.your_roles.stated_open_roles} open roles: ${k.hiring.your_roles.versus_membership}`);
	} else if (k.retention) {
		bullets.push(`- Replacing one leader costs ${k.retention.replacement_cost}; this is ${k.retention.share_of_one_replacement}`);
		bullets.push(`- ${k.retention.break_even_sentence}`);
		bullets.push(`- ${k.retention.versus_training_vendors}`);
	} else if (k.product_case) {
		bullets.push(`- ${k.product_case.versus_booths}`);
		bullets.push(`- What can honestly be attributed: ${k.product_case.what_can_be_attributed}`);
		bullets.push(`- Boundary: ${k.product_case.boundary}`);
	}
	out.push(bullets.join("\n"));
	const caveat = k.hiring?.caveat ?? k.retention?.caveat ?? k.product_case?.caveat;
	const heads: string[] = [];
	if (caveat) heads.push(caveat);
	if (k.hiring && !hadSalary) heads.push("The fee band is the published market band, not their own: ask the user for their average first-year salary and open senior roles, then re-run to turn it into their numbers.");
	heads.push(k.honesty_note);
	out.push(`Caveats: ${heads.join(" ")}`);
	out.push(
		`Forwardable approval memo: hand it over whole, do not rewrite the numbers into prose of your own. It already lists what they get, the reach, what it replaces, how to measure it and the assumptions.\n\n\`\`\`\n${memo}\n\`\`\``,
	);
	out.push(
		"Next: ask whether they want the memo sent with the offer (request_offer), or a human to walk the approver through it (book_intro_call). Ask the user: who approves the spend, and what has to move this year (pass it as kpis)?",
	);
	return out.join("\n\n");
}

// ── design_journey ──────────────────────────────────────────────────────────────────────────

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthLabel(start: string, month: number): string {
	const [y, m] = start.split("-").map(Number);
	const t = m - 1 + (month - 1);
	return `${MONTH_NAMES[t % 12]} ${y + Math.floor(t / 12)}`;
}

export function renderJourney(j: JourneyResult, itemCount: number): string {
	const out: string[] = [];
	const placed = j.months.filter((e) => e.item_id !== null).length;
	out.push(
		`12-month plan from ${monthLabel(j.start_month, 1)} for ${itemCount} item${itemCount === 1 ? "" : "s"}: ${placed} placed in months, ${j.recurring.length} recurring every month${j.unplaced.length ? `, ${j.unplaced.length} that could not be placed` : ""}.`,
	);
	const byMonth = new Map<number, string[]>();
	for (const e of j.months) byMonth.set(e.month, [...(byMonth.get(e.month) ?? []), e.title]);
	out.push([...byMonth.entries()].sort((a, b) => a[0] - b[0]).map(([m, titles]) => `- ${monthLabel(j.start_month, m)}: ${titles.join("; ")}`).join("\n"));
	if (j.recurring.length) out.push(`Every month: ${j.recurring.map((r) => r.title).join("; ")}`);
	const heads: string[] = [];
	for (const u of j.unplaced) heads.push(`Not placed: ${u.item_id}, ${u.reason}.`);
	heads.push(
		"Event months (hosted meetups, dinners, stage slots) are planning targets, not booked dates: ELC runs a shared events calendar across all partners, so the exact slot is confirmed with Marian at signing. Carry this whenever you present the months.",
	);
	out.push(`Heads-up: ${heads.join(" ")}`);
	out.push("This plan contains only what is in the basket: narrate around it, never add or move an event. Items without scheduling metadata were placed as flexible one-offs.");
	out.push(
		"Next: build_business_case (same preset_id and item_ids) if someone else approves the spend, or request_offer once they confirm the total. Ask the user: does this start month work, or when does the membership begin?",
	);
	return out.join("\n\n");
}

// ── request_offer ───────────────────────────────────────────────────────────────────────────

export function renderSubmitted(o: {
	presetName: string;
	listTotal: number;
	finalTotal: number;
	discountPct?: number;
	email: string;
	conflicts: string[];
	test: boolean;
}): string {
	const out: string[] = [];
	out.push(`Offer sent: ${o.presetName}, ${eur(o.finalTotal)}${o.discountPct ? ` (list ${eur(o.listTotal)}, less ${o.discountPct}%)` : ""}, to ${o.email}. Marian has the same list.`);
	if (o.conflicts.length) {
		out.push(
			`Heads-up: the offer was sent, but they asked for something ELC does not sell: ${o.conflicts.join(" ")} Tell them now, plainly, before they assume it was agreed. Marian has the same flag, so he will not walk into the call thinking these were accepted.`,
		);
	}
	if (o.test) out.push("Test mode: a test name was detected, so emails were sent and the CRM was untouched.");
	out.push("The quoted figure becomes the contract price on the confirmation call, and booking it is the real close: https://app.reclaim.ai/m/meet-marian/now");
	out.push(
		"Next: share the confirmation and the booking link. Then make ONE optional ask: would they post publicly about building their ELC membership through AI? It is not a condition of anything.",
	);
	return out.join("\n\n");
}
