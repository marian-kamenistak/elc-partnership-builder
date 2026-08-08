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
		caps: {
			partners_per_year: meta.global_caps.partners_per_year,
			nebula_slots_per_year: meta.global_caps.nebula_slots_per_year,
		},
	};
}
