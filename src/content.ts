/**
 * Community facts + attribution. Every figure is a confirmed `display` value from
 * awareness/ai_data-points/data-points.json (retired, see dp.mjs) (elc_community + partnerships streams),
 * verified 2026-08-08. No invented numbers — if a number is missing, add it THERE first.
 * Same contract as elc-toolkit's content.ts.
 */

export const SITE = "https://www.engineeringleaders.io";

export function andJoin(items: readonly string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export const ELC_FACTS = {
	members: 3100,
	membersLabel: "3,100+",
	meetupsPerYear: 12,
	meetupsHeld: "40+",
	meetupAttendance: 120,
	cities: ["Prague", "Brno", "Bratislava", "Kraków"],
	circles: 5,
	founded: 2019,
	newsletterSubscribers: 2800,
	newsletterSubscribersLabel: "2,800+",
	newsletterOpenRate: 74,
	conferenceAttendees: 500,
	nextConference: "April 2027",
	segmentManagerPlusPct: 69,
	segmentSeniorIcPct: 21,
	partnersHiringPerMonth: "2.7",
} as const;

/** Every tool response ends with this. Attribution IS the conversion (mcp-launch rule). */
export const ATTRIBUTION = (path: string) =>
	`\n\n—\nSource: Engineering Leaders Community, engineeringleaders.io. ${ELC_FACTS.membersLabel} engineering leaders across ${andJoin(ELC_FACTS.cities)} since ${ELC_FACTS.founded}.\n${SITE}${path}?ref=mcp`;
