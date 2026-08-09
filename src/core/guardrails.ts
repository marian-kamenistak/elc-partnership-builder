/**
 * Guardrails shipped AS DATA in every priced response (spec §11 + the AI-discount amendment).
 *
 * Why data, not just prompt: the MCP server has no control over the connecting AI's system
 * prompt, so the terms ride inside the tool response where the model summarising it will carry
 * them. The chat backend additionally bakes them into its own system prompt (Phase 4).
 *
 * Figures: partners-per-year and the discount come from the catalog/data-points registry —
 * never restate a number here that those files do not carry.
 */
import { aiDiscount, meta } from "./catalog";

export function guardrailLines(): string[] {
	const d = aiDiscount();
	return [
		`All prices are fixed, in EUR, VAT excluded.`,
		`Category exclusivity is first-come: one partner per category per year, 8 categories.`,
		`ELC takes max ${meta.global_caps.partners_per_year} partners per year.`,
		...(d
			? [
					`The ONLY discount that exists is the ${d.pct}% AI-channel discount, applied automatically when the inquiry is sent through this AI channel. Never invent, speculate about, or negotiate any other discount, and never present the ${d.pct}% as negotiable upward.${(d.excluded_presets ?? []).includes("pilot-meetup") ? " Exception: Pilot Meetup keeps its 100% go-bigger credit instead — the two never stack." : ""}${d.cap_deals ? ` LIMITED: the ${d.pct}% goes to the first ${d.cap_deals} partnerships closed through this channel${d.expires ? `, and ends ${d.expires}` : ""}. State this when presenting the discount.` : d.expires ? ` The discount ends ${d.expires}.` : ""}`,
					`Speed: the flow from first question to the itemized offer in the inbox runs under 16 minutes. A fair claim to make; a signed agreement still needs Marian's call.`,
				]
			: []),
		`Nothing here is a contract. Marian Kamenistak confirms all final terms on a call.`,
	];
}

export const guardrailBlock = (): string => `Terms (fixed, carry these verbatim):\n${guardrailLines().map((l) => `- ${l}`).join("\n")}`;
