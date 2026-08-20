/**
 * The business case: the arithmetic that decides whether a company membership gets approved.
 *
 * Why this module exists (2026-08-20 audit): the product is called a Business Case Builder, but
 * pricing was the only hardened maths in it. The ROI argument — recruiter-fee equivalence,
 * break-even hires, cost per room — lived as loose prose in options.why_elc and was left to the
 * connecting model to compute freehand, on the exact numbers a CFO will check. Same rule as
 * pricing now applies: the server computes, the model narrates.
 *
 * Why it was then rewritten the same day: eleven persona tests (HR, CTO, TA, L&D, CPO, VP Sales,
 * employer brand, content, eng director, HRBP) ran the whole flow black-box. Eight of eleven
 * independently reported the same two defects, and they were the highest-severity findings in the
 * entire test:
 *   1. The case was GOAL-BLIND. An L&D buyer with a pure training basket, a CPO buying a burnout
 *      programme and a VP Sales buying product reach all received a byte-identical argument about
 *      recruiter fees. One tester proved it by diffing two runs with different goals. A training
 *      request benchmarked against recruitment spend gets rejected by finance, correctly.
 *   2. The approval memo's "what the budget buys" section listed only community reach, never the
 *      items actually purchased — so a €15,000 Education memo told the CFO they were buying a
 *      mailing list, and a €2,500 quarterly pilot memo asked for a 12-month membership.
 * Both are fixed below: the argument branches on goal, and the memo itemises what was bought.
 *
 * Number discipline (project rule: every externally-published figure comes from the ELC Data
 * Points registry):
 *   - ELC facts come from ELC_FACTS, which mirrors the registry. Nothing new is invented here.
 *   - The recruiter fee band (EUR 15,000-25,000 per senior hire) is the already-approved figure
 *     carried in options.why_elc.vs_recruiters. It is a market band, not an ELC promise. It is
 *     reused for the retention case because replacing a leader who leaves IS a placement cost.
 *   - Everything else is arithmetic over those constants and the visitor's OWN inputs.
 * Every output number carries a `basis` string naming which of the three it came from.
 *
 * Honesty rules baked in: no projected hire counts, no invented conversion rates, no "you will
 * get X". The case compares a known cost against a known alternative and states what has to be
 * true for it to pay off. That is a business case; a forecast would be a fabrication.
 */
import { ELC_FACTS, andJoin } from "../content";
import { discountFor, eur, presetById, resolveBasket } from "./catalog";

/** Market rate for one senior engineering placement, the band already published in why_elc. */
export const RECRUITER_FEE_LOW = 15000;
export const RECRUITER_FEE_HIGH = 25000;
/** Typical agency fee as a share of first-year salary, used only when a salary is supplied. */
export const RECRUITER_FEE_PCT_LOW = 15;
export const RECRUITER_FEE_PCT_HIGH = 25;

/**
 * What a buyer is actually committing to. Not every package is a year, and saying "/year" or
 * "for 12 months" about a 90-day pilot or a single meetup reads as bait-and-switch — two testers
 * flagged it as the reason they would not forward the memo. Belongs in the catalog eventually;
 * lives here until the YAML carries a `term` field.
 */
const PACKAGE_TERM: Record<string, { label: string; memo: string; annual: boolean }> = {
	"leadership-pilot": { label: "one quarter", memo: "for one quarter (90 days)", annual: false },
	"pilot-meetup": { label: "a single meetup", memo: "as a one-off pilot meetup, not an annual commitment", annual: false },
};
const termFor = (presetId: string) =>
	PACKAGE_TERM[presetId] ?? { label: "12 months", memo: "for 12 months", annual: true };

export type BusinessCaseInput = {
	preset_id: string;
	item_ids: string[];
	/** talent | hiring | product | newsite. Falls back to the preset's own interest group. */
	goal?: string;
	/** Senior roles they need to fill in the next 12 months. Drives the hiring comparison. */
	open_senior_roles?: number;
	/** Average first-year salary for those roles, EUR. Sharpens the fee band into their numbers. */
	avg_first_year_salary?: number;
	/** Their own words for what has to move this year. Echoed into the memo, never invented. */
	kpis?: string;
	company?: string;
};

export type Figure = { label: string; value: string; basis: string };

const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100));

/**
 * Fee band for one senior hire: derived from their salary when given, otherwise the published
 * market band. Returned as a range because a single point estimate would be false precision.
 */
export function recruiterFeeBand(avgFirstYearSalary?: number): { low: number; high: number; basis: string } {
	if (avgFirstYearSalary && avgFirstYearSalary > 0) {
		return {
			low: Math.round((avgFirstYearSalary * RECRUITER_FEE_PCT_LOW) / 100),
			high: Math.round((avgFirstYearSalary * RECRUITER_FEE_PCT_HIGH) / 100),
			basis: `your stated average first-year salary of ${eur(avgFirstYearSalary)} at the standard ${RECRUITER_FEE_PCT_LOW}-${RECRUITER_FEE_PCT_HIGH}% agency fee`,
		};
	}
	return {
		low: RECRUITER_FEE_LOW,
		high: RECRUITER_FEE_HIGH,
		basis: "the published CEE market band for one senior engineering placement",
	};
}

/**
 * What this spend displaces, per goal. Previously a single hardcoded list of recruiting and
 * event costs, returned to every buyer regardless of what they bought — the single most-reported
 * defect in persona testing. A budget line is defended against the alternative on the SAME line,
 * so a training request must be compared to training vendors, not to recruiters.
 */
const REPLACES: Record<string, string[]> = {
	hiring: [
		"Agency fees on senior engineering placements",
		"Running your own recurring event: venue, catering, production and the audience-building that never compounds",
		"Conference booth spend that buys one audience once",
	],
	talent: [
		"External leadership-training programmes, which start around EUR 15,000 to 30,000 for a bespoke cohort",
		"Executive coaching bought per head at day rates",
		"The replacement cost of a leader who leaves because nobody developed them",
	],
	product: [
		"Conference booth spend that buys one audience once",
		"Paid media aimed at a technical audience that mostly blocks it",
		"Bought contact lists, which reach the same people without the trust",
	],
	newsite: [
		"Local recruitment agency retainers in a market where you have no brand yet",
		"Building an employer brand from zero in a new city",
		"Conference booth spend that buys one audience once",
	],
};

/**
 * KPIs worth tracking, per goal. Suggestions the buyer can adopt or ignore — never promises, and
 * never numbers. Persona testing found `kpis: null` on every run, which left the one column a
 * budget review always asks for completely empty.
 */
const KPIS: Record<string, string[]> = {
	hiring: [
		"Senior roles filled from the community rather than through an agency",
		"Agency spend avoided over the year",
		"Time-to-hire on senior engineering roles",
	],
	talent: [
		"Retention of the leaders who took part",
		"Manager capability or engagement movement against your current baseline",
		"Promotion readiness of the participants at the next review cycle",
	],
	product: [
		"Qualified conversations started with engineering decision-makers",
		"Category awareness among the buyers you care about",
		"Inbound from the community relative to your other channels",
	],
	newsite: [
		"First senior hires made in the new market",
		"Local brand recognition among engineering leaders",
		"Time from launch to a functioning local leadership bench",
	],
};

/** Goal ids the catalog uses; anything else falls back to the preset's own interest group. */
const KNOWN_GOALS = new Set(["talent", "hiring", "product", "newsite"]);

export function buildBusinessCase(input: BusinessCaseInput) {
	const preset = presetById(input.preset_id);
	if (!preset) return { error: `unknown preset "${input.preset_id}"` };
	const { standard, addons, total } = resolveBasket(input.preset_id, input.item_ids);
	if (!standard.length && !addons.length) {
		return { error: "empty_basket — pass the item_ids from customize_package" };
	}

	// The Free package needs no business case: nobody asks a CFO to approve zero euros, and a
	// "€0/year approval request" memo made a tester laugh out loud in testing. Route, don't argue.
	if (total === 0) {
		return {
			no_case_needed: true,
			package: { id: preset.id, name: preset.name },
			why: "The Free package costs nothing, so there is nothing to justify and no approval to request. Do not generate an approval memo for it.",
			what_to_say:
				"Tell them it runs today, with no invoice and no contract, and give them the link. A company inside the free layer is next year's member.",
			link: "https://www.engineeringleaders.io/partner/membership/free/",
		};
	}

	const d = discountFor(total, "mcp", input.preset_id);
	const net = d ? d.discounted : total;
	const term = termFor(input.preset_id);
	// Goal drives the whole argument. Explicit input wins; otherwise the preset declares its own
	// interest group in the catalog, which is a better default than assuming everyone is hiring.
	const presetInterest = preset.interest;
	const goal = input.goal && KNOWN_GOALS.has(input.goal) ? input.goal : KNOWN_GOALS.has(presetInterest ?? "") ? (presetInterest as string) : "hiring";

	const fee = recruiterFeeBand(input.avg_first_year_salary);
	const figures: Figure[] = [];

	// ---- Cost side -------------------------------------------------------------------
	figures.push({
		label: term.annual ? "Investment for the year" : `Investment for ${term.label}`,
		value: `${eur(net)} excl. VAT${d ? ` (list ${eur(total)}, less the ${d.pct}% AI-channel discount)` : ""}`,
		basis: "the composed basket, priced by ELC's catalog",
	});
	if (term.annual) {
		figures.push({
			label: "Monthly equivalent",
			value: `${eur(Math.round(net / 12))} a month`,
			basis: "arithmetic on the annual total — the way most budget lines are actually reviewed",
		});
	}

	// ---- The comparison, shaped by the goal -------------------------------------------
	// Hiring items justify the recruiter comparison directly. For a talent/retention basket the
	// same published band still applies, but as the cost of REPLACING a leader who leaves, not
	// the cost of adding one — a distinction a CPO will check and a CFO will respect.
	const hiringItems = ["marians-list", "job-roles-featured", "recruiting-sprint", "hosted-meetup", "attendee-lists"];
	const hasHiring = [...standard, ...addons].some((i) => hiringItems.includes(i.id));
	const breakEvenLow = Math.max(1, Math.ceil(net / fee.high));
	const breakEvenHigh = Math.max(1, Math.ceil(net / fee.low));
	const breakEvenPhrase =
		breakEvenLow === breakEvenHigh ? `${breakEvenLow} senior hire${breakEvenLow > 1 ? "s" : ""}` : `${breakEvenLow} to ${breakEvenHigh} senior hires`;
	const retentionPhrase =
		breakEvenLow === breakEvenHigh ? `${breakEvenLow} leader${breakEvenLow > 1 ? "s" : ""}` : `${breakEvenLow} to ${breakEvenHigh} leaders`;

	const hiring =
		goal === "hiring" && hasHiring
			? {
					fee_band: `${eur(fee.low)} to ${eur(fee.high)} per senior hire`,
					fee_basis: fee.basis,
					break_even_hires: breakEvenPhrase,
					break_even_sentence: `The whole ${term.annual ? "year" : term.label} pays for itself at ${breakEvenPhrase} sourced from the community instead of through an agency.`,
					share_of_one_placement: `${pct(net, fee.high)}% to ${pct(net, fee.low)}% of a single agency placement`,
					...(input.open_senior_roles && input.open_senior_roles > 0
						? {
								your_roles: (() => {
									const n = input.open_senior_roles as number;
									return {
										stated_open_roles: n,
										agency_cost_if_all_placed: `${eur(n * fee.low)} to ${eur(n * fee.high)}`,
										versus_membership: `${eur(net)} for the ${term.annual ? "year" : term.label}, against ${eur(n * fee.low)} to ${eur(n * fee.high)} if all ${n} go through an agency`,
										basis: "your stated open-role count multiplied by the fee band — not a prediction that ELC fills them",
									};
								})(),
							}
						: {}),
					caveat:
						"This is a cost comparison, not a forecast. ELC does not guarantee a number of hires; the case is that the membership costs a fraction of one placement and the room is where these people already are.",
				}
			: null;

	const retention =
		goal === "talent"
			? {
					replacement_cost: `${eur(fee.low)} to ${eur(fee.high)}`,
					basis: `${fee.basis} — the same placement cost applies whether you are adding a leader or replacing one`,
					break_even_sentence: `Retaining ${retentionPhrase} who would otherwise have left covers the whole ${term.annual ? "year" : term.label}, before counting ramp time or the team churn that follows a leader's exit.`,
					share_of_one_replacement: `${pct(net, fee.high)}% to ${pct(net, fee.low)}% of replacing a single leader`,
					versus_training_vendors:
						"A bespoke external leadership programme starts around EUR 15,000 to 30,000 for one cohort, and ends when the cohort ends. This runs for the term and leaves the participants inside a peer community afterwards.",
					caveat:
						"This is a cost comparison, not a forecast. ELC does not guarantee retention; the case is that the programme costs a fraction of one departure, and departures are the risk you are managing.",
				}
			: null;

	const productCase =
		goal === "product" || goal === "newsite"
			? {
					what_can_be_attributed:
						"Rooms entered, conversations started, and content published are all countable. Pipeline is not attributable to a community membership with any honesty, and ELC does not claim it.",
					versus_booths:
						"A conference booth buys one audience once. This buys the same senior room repeatedly across the term, without a booth, a badge scanner or a paid talk.",
					boundary:
						"ELC does not sell pitching rights, member contact data for outbound, or introductions. The room is senior because it is never sold to — that is the asset. State this plainly rather than letting a commercial buyer assume otherwise.",
					caveat:
						"This is a cost and access comparison, not a pipeline forecast. No conversion rate, meeting count or revenue figure is projected anywhere in this case.",
				}
			: null;

	// ---- Reach side, only what the basket actually buys -------------------------------
	const ids = new Set([...standard, ...addons].map((i) => i.id));
	const reach: Figure[] = [];
	if (ids.has("priority-seats")) {
		reach.push({
			label: "Rooms per year",
			value: `${ELC_FACTS.meetupsPerYear} meetups, ${ELC_FACTS.meetupAttendance}+ senior leaders each`,
			basis: "ELC published meetup cadence and attendance",
		});
		if (term.annual) {
			reach.push({
				label: "Cost per room",
				value: `${eur(Math.round(net / ELC_FACTS.meetupsPerYear))} per meetup across the year`,
				basis: "annual total divided by ELC's published meetup count. Note this equals the monthly figure above, since there are 12 of each — it is the same number viewed two ways, not two independent savings",
			});
		}
	}
	if (ids.has("newsletter-logo")) {
		// Rounded on purpose: 24,864 is five significant figures derived from two rounded inputs
		// ("2,800+", "74%"). A CTO tester called the false precision the tell that a number is
		// modelled rather than measured, and discounted the whole memo for it.
		const opens = Math.round(ELC_FACTS.newsletterSubscribers * (ELC_FACTS.newsletterOpenRate / 100)) * ELC_FACTS.meetupsPerYear;
		const readers = Math.round(ELC_FACTS.newsletterSubscribers * (ELC_FACTS.newsletterOpenRate / 100));
		reach.push({
			label: "Newsletter reach",
			value: `~${(Math.round(readers / 100) * 100).toLocaleString("en-US")} people who open it, 12 issues a year (~${(Math.round(opens / 1000) * 1000).toLocaleString("en-US")} opened sends)`,
			basis: `${ELC_FACTS.newsletterSubscribersLabel} subscribers at ELC's published ${ELC_FACTS.newsletterOpenRate}% open rate. Lead with the people figure, not the sends figure — they are the same audience twelve times, not a larger audience`,
		});
	}
	if (ids.has("hosted-meetup")) {
		reach.push({
			label: "Your own stage",
			value: "80 to 150 senior leaders in your office, your speaker on stage",
			basis: "ELC published hosted-meetup attendance range",
		});
	}
	if (ids.has("conference-tickets")) {
		reach.push({
			label: "Conference",
			value: `${ELC_FACTS.conferenceAttendees}+ attendees, ${ELC_FACTS.nextConference}`,
			basis: "ELC published conference figures",
		});
	}
	reach.push({
		label: "Addressable community",
		value: `${ELC_FACTS.membersLabel} engineering leaders, ${ELC_FACTS.segmentManagerPlusPct}% Manager+`,
		basis: "ELC member base, not a rented list or survey panel",
	});

	const assumptions = [
		`Prices are ELC's published catalog figures, EUR, VAT excluded${d ? `, including the ${d.pct}% AI-channel discount` : ""}.`,
		// Only assert the fee band when something in the case actually uses it. A dangling
		// recruiter assumption on a wellbeing case was flagged by a CPO tester as the tell that
		// the template was written for a different buyer.
		...(hiring || retention ? [`Recruiter fee band: ${fee.basis}.`] : []),
		"Community figures are ELC's own member base, verified against its published data points.",
		"No hire count, retention rate, pipeline or conversion rate is forecast anywhere in this case.",
	];

	return {
		company: input.company ?? null,
		package: { id: preset.id, name: preset.name },
		goal,
		term: { label: term.label, annual: term.annual },
		investment: { list_total: total, final_total: net, discount_pct: d?.pct ?? 0, currency: "EUR", vat: "excluded" },
		figures,
		hiring,
		retention,
		product_case: productCase,
		reach,
		/** The purchased line items. The memo lists these; the old memo listed only reach. */
		what_you_are_buying: [...standard, ...addons].map((i) => ({ name: i.name, value: i.value, price: i.price })),
		what_it_replaces: REPLACES[goal] ?? REPLACES.hiring,
		kpis_to_track: KPIS[goal] ?? KPIS.hiring,
		kpis: input.kpis ?? null,
		assumptions,
		honesty_note:
			"Present the break-even framing as what it is: the number of outcomes needed to justify the spend, not a promise of them. Overstating this is the fastest way to lose a CFO who checks.",
		next_tool: "request_offer to send the itemized offer plus this case, or book_intro_call if they want to walk a human through it.",
	};
}

/**
 * The forwardable artifact. HR rarely holds the budget — they have to convince someone who was
 * never in this conversation, and until 2026-08-20 the flow handed them a total and a calendar
 * link to do it with. This renders the case as plain text they can paste into an email untouched.
 * Plain text on purpose: it survives every mail client, and nothing here should look like a
 * designed asset the recipient has to trust.
 */
export function approvalMemo(caseData: ReturnType<typeof buildBusinessCase>, requesterName?: string): string {
	if ("error" in caseData || "no_case_needed" in caseData) return "";
	const c = caseData;
	const L: string[] = [];
	const termWord = c.term.annual ? "year" : c.term.label;
	L.push(`Subject: Approval request — Engineering Leaders Community membership (${eur(c.investment.final_total)}${c.term.annual ? "/year" : ""})`);
	L.push("");
	L.push(
		`What I am asking for: approval to join the Engineering Leaders Community as a company member ${termFor(c.package.id).memo}, at ${eur(c.investment.final_total)} excl. VAT${c.investment.discount_pct ? ` (list ${eur(c.investment.list_total)}, less a ${c.investment.discount_pct}% discount)` : ""}.${c.term.annual ? ` That is ${eur(Math.round(c.investment.final_total / 12))} a month.` : ""}`,
	);
	L.push("");
	L.push(
		`What it is: ELC is a community of ${ELC_FACTS.membersLabel} engineering leaders across ${andJoin(ELC_FACTS.cities)}, ${ELC_FACTS.segmentManagerPlusPct}% of them Manager+ or above, running ${ELC_FACTS.meetupsPerYear} meetups a year since ${ELC_FACTS.founded}. Membership is free for individual leaders and funded by company members, which is why the room stays senior.`,
	);
	L.push("");
	if (c.kpis) {
		L.push(`Why now: ${c.kpis}`);
		L.push("");
	}

	// What we are actually buying — the section the old memo omitted entirely, which left CFOs
	// reading a reach statistic where the deliverables should have been.
	if (c.what_you_are_buying.length) {
		L.push(`What we get for the ${termWord}:`);
		for (const i of c.what_you_are_buying) L.push(`- ${i.name}${i.value ? ` — ${i.value}` : ""}`);
		L.push("");
	}

	L.push("The financial case:");
	if (c.hiring) {
		L.push(`- A senior engineering placement through an agency costs ${c.hiring.fee_band} (${c.hiring.fee_basis}).`);
		L.push(`- This membership costs ${c.hiring.share_of_one_placement}.`);
		L.push(`- ${c.hiring.break_even_sentence}`);
		if ("your_roles" in c.hiring && c.hiring.your_roles) L.push(`- ${c.hiring.your_roles.versus_membership}.`);
		L.push(`- ${c.hiring.caveat}`);
	} else if (c.retention) {
		L.push(`- Replacing one engineering leader who leaves costs ${c.retention.replacement_cost} (${c.retention.basis}).`);
		L.push(`- This programme costs ${c.retention.share_of_one_replacement}.`);
		L.push(`- ${c.retention.break_even_sentence}`);
		L.push(`- ${c.retention.versus_training_vendors}`);
		L.push(`- ${c.retention.caveat}`);
	} else if (c.product_case) {
		L.push(`- ${c.product_case.versus_booths}`);
		L.push(`- What can honestly be attributed: ${c.product_case.what_can_be_attributed}`);
		L.push(`- ${c.product_case.caveat}`);
	} else {
		L.push(`- ${eur(c.investment.final_total)} for the ${termWord}, against the alternatives listed below.`);
	}
	L.push("");

	if (c.reach.length) {
		L.push("Reach that comes with it:");
		for (const r of c.reach) L.push(`- ${r.label}: ${r.value}`);
		L.push("");
	}
	L.push("What it replaces:");
	for (const w of c.what_it_replaces) L.push(`- ${w}`);
	L.push("");
	L.push("How we would measure it:");
	for (const k of c.kpis_to_track) L.push(`- ${k}`);
	L.push("");
	L.push("Assumptions behind these numbers:");
	for (const a of c.assumptions) L.push(`- ${a}`);
	L.push("");
	L.push(
		`Terms: prices are fixed, EUR, VAT excluded. Nothing is committed until a call with ELC's founder, Marian Kamenistak. Details: https://www.engineeringleaders.io/partner/`,
	);
	if (requesterName) {
		L.push("");
		L.push(`Requested by: ${requesterName}${c.company ? `, ${c.company}` : ""}`);
	}
	return L.join("\n");
}
