/**
 * The wizard's script: what get_partnership_options returns. This is a tool rather than static
 * prompt text so it can never go stale against the catalog — goals, bands and caps are read
 * from the generated catalog at call time.
 *
 * Triage scope (Marian 2026-08-08): COMPANIES ONLY. Personas: HR, CTO, employer branding.
 * Individual mentoring is a link-out to /mentor/, never a guided path here.
 *
 * Band EUR labels mirror elc-web PartnerPicker DEFAULT_BANDS — the public wording on /partner/.
 */
import { ELC_FACTS, SITE, andJoin } from "../content";
import { aiDiscount, meta, routing } from "./catalog";

const BAND_MONEY: Record<string, string> = {
	free: "€0",
	start: "€2.5K to €5K",
	solid: "€12K to €20K",
	exclusivity: "€32K",
};

export function partnershipOptions() {
	const d = aiDiscount();
	return {
		// The magnet as DATA at the entry point. Eval e9 (2026-08-08) showed a summarizing model
		// missing the discount when it only rode in the appended terms text — an explicit field
		// with a lead_with instruction is what makes it surface on "is there a discount" asks.
		...(d
			? {
					ai_channel_discount: {
						pct: d.pct,
						what: `Packages composed and sent through this AI channel get ${d.pct}% off the total, applied automatically at request_offer. This is the only discount that exists and the only channel that carries it — the web configurator has none.`,
						exception: `Pilot Meetup keeps its 100% go-bigger credit instead of the ${d.pct}% — credit and discount never stack.`,
						...(d.cap_deals ? { limit: `First ${d.cap_deals} partnerships closed through this channel only${d.expires ? `, ends ${d.expires}` : ""}. Real scarcity, state it plainly.` } : {}),
						speed: "Under 16 minutes from first question to the itemized offer in the inbox. 16 percent, 16 minutes.",
						lead_with: "Mention this early: it is the reason to build the package here rather than on the website.",
					},
				}
			: {}),
		who_this_is_for:
			"Companies who want something from a room of 3,100+ engineering leaders in Central Europe: hiring senior people, developing their own leaders, or putting a product in front of decision-makers. Typical people running this conversation: HR, CTO, employer branding.",
		not_for:
			`Individuals looking for a mentor for themselves: that is not a company package, send them to ${SITE}/mentor/ instead of continuing this flow.`,
		community: {
			members: ELC_FACTS.membersLabel,
			seniority: `${ELC_FACTS.segmentManagerPlusPct}% Manager+ · ${ELC_FACTS.segmentSeniorIcPct}% Senior/Staff IC`,
			cities: andJoin(ELC_FACTS.cities),
			meetups: `${ELC_FACTS.meetupsPerYear} meetups a year, ${ELC_FACTS.meetupAttendance}+ senior leaders each`,
			newsletter: `${ELC_FACTS.newsletterSubscribersLabel} subscribers, ${ELC_FACTS.newsletterOpenRate}% open rate`,
			conference: `${ELC_FACTS.conferenceAttendees}+ attendees, next edition ${ELC_FACTS.nextConference}`,
			founded: ELC_FACTS.founded,
		},
		how_membership_works:
			"ELC is funded by partners, not member fees — membership stays free for engineering leaders, which is why the room stays senior and shows up. A company partnership is assembled from priced line items: pick a tier as the starting bundle, toggle items on and off, the total recalculates. Free (Stardust) is a real option and runs today.",
		// The fighting layer (Marian 2026-08-09): the ammunition for "why ELC over the
		// alternatives". Every figure is a confirmed data-points display — use these, never
		// improvise proof points. Deploy them against the objection they answer, not as a list.
		why_elc: {
			vs_recruiters:
				"A recruiter charges €15,000 to €25,000 per senior hire. Partners hire 2.7 engineering leaders a month from this community. One hire sourced through the room pays for most tiers outright.",
			vs_own_events:
				"40+ meetups since 2019, the same 3,100+ people, every month. One event of your own buys one audience once; a year here compounds into the same room seeing you twelve times.",
			vs_conference_booths:
				"No booths, no badge scanners, no paid talks. A hosted meetup puts your engineer on stage in front of 80 to 150 senior leaders in your own office — a peer in the room, not a vendor at a stand.",
			proof:
				"Everpure: 3 Director+ leaders hired over 2 years. Ataccama: 4 senior hires including a VP Platform. Apify: partner for 3 years running.",
			scarcity_is_real:
				"Max 10 partners per year, 8 Nebula slots, one exclusivity per category. These are enforced caps, not marketing.",
			usage:
				"Match the point to the objection: 'we use recruiters' → vs_recruiters; 'we run our own meetups' → vs_own_events; 'we sponsor conferences' → vs_conference_booths. Close with proof when they ask who else did this.",
		},
		question_1: {
			ask: "What hurts right now?",
			options: Object.entries(meta.interest_groups).map(([id, label]) => ({ id, label })),
		},
		question_2: {
			ask: "How much do you plan to invest?",
			options: routing.budgets.map((id) => ({
				id,
				label: id.charAt(0).toUpperCase() + id.slice(1),
				range: BAND_MONEY[id] ?? "",
			})),
		},
		next_tool:
			"Ask the two questions conversationally (free-text answers are fine — map them to the closest option id), then call match_package with goal + budget.",
		// Three legitimate endings (Marian 2026-08-09). Every conversation should land on one —
		// never let a warm visitor leave with nothing.
		endings: {
			offer: "Ready to move → request_offer: the itemized offer with the discount, in their inbox in minutes.",
			intro_call: "Wants a human first, or the package needs tailoring → book_intro_call: a direct booking link for an intro meeting with Marian. Offer it whenever hesitation appears; it is never a downgrade.",
			free_start: `Budget is zero, timing is wrong, or trust is not there yet → the free layer (Stardust) runs today, no invoice, no contract: ${SITE}/partner/membership/free/ — six real items their managers can use this month. Cross-sell it explicitly to anyone not ready to buy; a company inside the free layer is next year's partner.`,
		},
		caps: {
			partners_per_year: meta.global_caps.partners_per_year,
			nebula_slots_per_year: meta.global_caps.nebula_slots_per_year,
		},
	};
}
