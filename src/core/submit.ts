/**
 * Offer submission — port of elc-web src/pages/partner/api/offer.ts (the reviewed, live web
 * pipeline). Keep the two in step; that file carries the mirror comment. Deltas here, both
 * deliberate (AI-builder plan §10):
 *
 *   1. channel: 'chat' | 'mcp' → added_from on the Attio queue entry, and it gates the
 *      16% AI-channel discount (discountFor), which the web configurator never gets.
 *   2. No Turnstile in this module — the chat backend verifies Turnstile before calling
 *      (Phase 4), the MCP door is rate-limited at the tool layer instead.
 *
 * Everything else is the offer.ts behaviour: server-side recompute (client/model totals are
 * never trusted), test-mode guard, Attio person upsert + no_go gate + company find-or-create +
 * record-reference link + queue duplicate check, Resend pair, Slack post by channel ID with
 * the body `ok` flag as the source of truth.
 */
import { discountFor, eur, presetById, PRESET_IDS, resolveBasket, type ResolvedItem } from "./catalog";
import { guardrailBlock } from "./guardrails";

const PARTNERS_QUEUE_SLUG = "elc_partners_queue";
const PARTNERS_QUEUE_URL = "https://app.attio.com/elc/list/b4c5827b-95f8-4307-9921-5d28f6d8bedc";
const BOOK_CALL = "https://app.reclaim.ai/m/meet-marian/now";
const TIER_FIT: Record<string, string> = { starter: "Starter", hiring: "Talent reach", education: "Education", vital: "Vital", visibility: "Visibility", story: "Story", product: "Product" };

export type SubmitEnv = {
	ATTIO_TOKEN?: string;
	RESEND_API_KEY?: string;
	SLACK_BOT_TOKEN_ELC?: string;
	SLACK_PARTNERS_CHANNEL?: string;
	OFFER_NOTIFY_TO?: string;
};

export type SubmitInput = {
	name: string;
	email: string;
	company: string;
	kpis?: string;
	presetId: string;
	itemIds: string[];
	channel: "chat" | "mcp";
};

export type SubmitResult =
	| { ok: true; presetName: string; listTotal: number; discountPct: number | null; finalTotal: number; test: boolean }
	| { ok: false; error: string };

function splitName(full: string): { first: string; last: string } {
	const clean = full.trim().replace(/\s+/g, " ");
	const parts = clean.split(" ");
	return { first: parts[0] ?? "", last: parts.length > 1 ? parts.slice(1).join(" ") : "" };
}

async function postSlack(token: string | undefined, channel: string | undefined, text: string): Promise<void> {
	if (!token || !channel) return;
	try {
		const res = await fetch("https://slack.com/api/chat.postMessage", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
		});
		// Slack returns HTTP 200 even on failure — the body's ok flag is the source of truth.
		const data: any = await res.json().catch(() => ({ ok: false, error: "bad_json" }));
		if (!data.ok) console.error("slack post failed", data.error);
	} catch (e) {
		console.error("slack post exception", String(e));
	}
}

export async function submitOffer(env: SubmitEnv, input: SubmitInput): Promise<SubmitResult> {
	const name = input.name.trim().slice(0, 150);
	const email = input.email.trim().toLowerCase().slice(0, 200);
	const company = input.company.trim().slice(0, 150);
	const kpis = (input.kpis ?? "").trim().slice(0, 1000);
	const { presetId, channel } = input;
	const itemIds = input.itemIds.map(String).slice(0, 120);

	if (!name) return { ok: false, error: "missing_name" };
	if (!/^\S+@\S+\.\S+$/.test(email)) return { ok: false, error: "invalid_email" };
	if (!company) return { ok: false, error: "missing_company" };
	if (!PRESET_IDS.includes(presetId)) return { ok: false, error: `unknown_preset — valid: ${PRESET_IDS.join(", ")}` };

	const { standard, addons, total: listTotal } = resolveBasket(presetId, itemIds);
	if (!standard.length && !addons.length) return { ok: false, error: "empty_basket — pass the item_ids being purchased" };
	const discount = discountFor(listTotal, channel, presetId);
	const finalTotal = discount ? discount.discounted : listTotal;
	const presetName = presetById(presetId)?.name ?? presetId;
	const { first, last } = splitName(name);

	// Test-mode guard (offer.ts precedent): "test" or Marian's own name previews both emails and
	// a [TEST] Slack post end-to-end without polluting the CRM.
	const isTest = /marian kamenistak|test/i.test(`${name} ${company}`);
	if (isTest) console.log("[OFFER_TEST_MODE] skipping Attio for", { name, company, email, channel });

	const notifyTo = env.OFFER_NOTIFY_TO ?? "marian@marian.coach";
	const notifyFrom = "weare@engineeringleaders.io";

	const priceLines = discount
		? [
				`List total: ${eur(listTotal)} / year (excl. VAT)`,
				`AI-channel discount (-${discount.pct}%): ${eur(finalTotal)} / year (excl. VAT)`,
			]
		: [`${eur(listTotal)} / year (excl. VAT)`];

	const basketLines = [
		`${presetName} — built via ${channel === "chat" ? "the /partner/chat/ widget" : "the MCP server"}`,
		...priceLines,
		"",
		"Standard:",
		...standard.map((i) => `• ${i.name} — ${i.price === 0 ? "included" : eur(i.price)}`),
		...(addons.length ? ["", "Add-ons:", ...addons.map((i) => `• ${i.name} — ${eur(i.price)}`)] : []),
	].join("\n");

	const slackPrice = discount ? `~${eur(listTotal)}~ → *${eur(finalTotal)}* (AI channel, -${discount.pct}%)` : `*${eur(listTotal)}*`;
	const slackText = [
		`${isTest ? "[TEST] " : ""}:robot_face: *${name}* (${company}) built a *${presetName}* offer via *${channel}* at ${slackPrice}`,
		`${standard.length} items, ${addons.length} add-ons · ${email}${kpis ? " · shared their KPIs" : ""}`,
		`<${PARTNERS_QUEUE_URL}|Partners queue>`,
	].join("\n");

	// ── Attio: person upsert + no-go gate + company find-or-create + queue entry ──────────────
	const attioPromise =
		env.ATTIO_TOKEN && !isTest
			? (async () => {
					try {
						const headers = { Authorization: `Bearer ${env.ATTIO_TOKEN}`, "content-type": "application/json" };

						const personRes = await fetch(
							"https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses",
							{
								method: "PUT",
								headers,
								body: JSON.stringify({
									data: { values: { email_addresses: [email], name: [{ first_name: first, last_name: last, full_name: name }] } },
								}),
							},
						);
						if (!personRes.ok) {
							console.error("attio person upsert failed", personRes.status, await personRes.text().catch(() => ""));
							return null;
						}
						const personRec: any = await personRes.json();
						const personId: string | undefined = personRec?.data?.id?.record_id;

						// No-Go gate: memberships in one call (never a parent_record path filter — 500s).
						if (personId) {
							const entriesRes = await fetch(`https://api.attio.com/v2/objects/people/records/${personId}/entries?limit=100`, {
								headers: { Authorization: `Bearer ${env.ATTIO_TOKEN}` },
							});
							const entriesData: any = entriesRes.ok ? await entriesRes.json().catch(() => ({ data: [] })) : { data: [] };
							if ((entriesData.data ?? []).some((e: any) => e.list_api_slug === "no_go")) {
								console.log("[OFFER_NO_GO] skipping queue entry + Slack for", { email, name });
								return { noGo: true };
							}
						}

						// Company find-or-create by name ($contains keeps "Acme" matching "Acme s.r.o.").
						let companyId: string | undefined;
						const companyQueryRes = await fetch("https://api.attio.com/v2/objects/companies/records/query", {
							method: "POST",
							headers,
							body: JSON.stringify({ filter: { name: { $contains: company } }, limit: 1 }),
						});
						if (companyQueryRes.ok) {
							const companyData: any = await companyQueryRes.json().catch(() => ({ data: [] }));
							companyId = companyData?.data?.[0]?.id?.record_id;
						}
						if (!companyId) {
							const companyCreateRes = await fetch("https://api.attio.com/v2/objects/companies/records", {
								method: "POST",
								headers,
								body: JSON.stringify({ data: { values: { name: company } } }),
							});
							if (companyCreateRes.ok) {
								const created: any = await companyCreateRes.json();
								companyId = created?.data?.id?.record_id;
							} else {
								console.error("attio company create failed", companyCreateRes.status, await companyCreateRes.text().catch(() => ""));
							}
						}
						if (!companyId) return null;

						// Best-effort person→company link — record reference, never a string (400s).
						if (personId) {
							await fetch(`https://api.attio.com/v2/objects/people/records/${personId}`, {
								method: "PATCH",
								headers,
								body: JSON.stringify({
									data: { values: { company: [{ target_object: "companies", target_record_id: companyId }] } },
								}),
							}).catch((e) => console.error("attio person-company link exception", String(e)));
						}

						const entryValues: Record<string, unknown> = {
							status: "To evaluate",
							tier_fit: TIER_FIT[presetId] ?? "Unclear",
							added_from: channel,
							why_relevant: discount
								? `Built a ${presetName} offer via ${channel}: ${eur(listTotal)} list, ${eur(finalTotal)} after the ${discount.pct}% AI-channel discount`
								: `Built a ${eur(listTotal)} ${presetName} offer via ${channel}`,
							queue_notes: [`Contact: ${name} <${email}>`, ...(kpis ? [`KPIs: ${kpis}`] : []), "", basketLines].join("\n"),
						};

						// Duplicate check first — Attio happily duplicates list entries for one parent.
						const companyEntriesRes = await fetch(
							`https://api.attio.com/v2/objects/companies/records/${companyId}/entries?limit=100`,
							{ headers: { Authorization: `Bearer ${env.ATTIO_TOKEN}` } },
						);
						const companyEntries: any = companyEntriesRes.ok
							? await companyEntriesRes.json().catch(() => ({ data: [] }))
							: { data: [] };
						const existing = (companyEntries.data ?? []).find((e: any) => e.list_api_slug === PARTNERS_QUEUE_SLUG);

						if (existing) {
							const patchRes = await fetch(`https://api.attio.com/v2/lists/${PARTNERS_QUEUE_SLUG}/entries/${existing.entry_id}`, {
								method: "PATCH",
								headers,
								body: JSON.stringify({ data: { entry_values: entryValues } }),
							});
							if (!patchRes.ok) console.error("attio queue update failed", patchRes.status, await patchRes.text().catch(() => ""));
							return { updated: true };
						}
						const postRes = await fetch(`https://api.attio.com/v2/lists/${PARTNERS_QUEUE_SLUG}/entries`, {
							method: "POST",
							headers,
							body: JSON.stringify({
								data: { parent_record_id: companyId, parent_object: "companies", entry_values: entryValues },
							}),
						});
						if (!postRes.ok) console.error("attio queue create failed", postRes.status, await postRes.text().catch(() => ""));
						return { created: postRes.ok };
					} catch (e) {
						console.error("attio exception", String(e));
						return null;
					}
				})()
			: Promise.resolve(null);

	const slackPromise = attioPromise.then((attio: any) => {
		if (attio?.noGo) return;
		const text = attio?.updated ? slackText.replace("built a", "updated their") : slackText;
		return postSlack(env.SLACK_BOT_TOKEN_ELC, env.SLACK_PARTNERS_CHANNEL, text);
	});

	// ── Internal notify: durable lead record even if Attio is down ────────────────────────────
	const notifyPromise = env.RESEND_API_KEY
		? fetch("https://api.resend.com/emails", {
				method: "POST",
				headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
				body: JSON.stringify({
					from: `ELC AI Builder <${notifyFrom}>`,
					to: notifyTo,
					subject: `${isTest ? "[TEST, not in Attio] " : ""}Partner offer built via ${channel}: ${company} — ${presetName} ${eur(finalTotal)}`,
					reply_to: email,
					text: [
						`New offer built through the AI channel (${channel})`,
						``,
						`Name:    ${name}`,
						`Email:   ${email}`,
						`Company: ${company}`,
						...(kpis ? [``, `KPIs: ${kpis}`] : []),
						``,
						basketLines,
						``,
						`Partners queue: ${PARTNERS_QUEUE_URL}`,
					].join("\n"),
				}),
			}).catch((e) => {
				console.error("resend notify exception", e);
				return null;
			})
		: Promise.resolve(null);

	const offerEmailPromise = env.RESEND_API_KEY
		? fetch("https://api.resend.com/emails", {
				method: "POST",
				headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
				body: JSON.stringify({
					from: `Marian Kamenistak <${notifyFrom}>`,
					to: email,
					subject: `Your ${presetName} offer: ${eur(finalTotal)} / year`,
					reply_to: notifyFrom,
					html: offerEmailHtml({ first, presetName, standard, addons, listTotal, finalTotal, discountPct: discount?.pct ?? null }),
				}),
			}).catch((e) => {
				console.error("resend offer email exception", e);
				return null;
			})
		: Promise.resolve(null);

	await Promise.all([notifyPromise, offerEmailPromise, attioPromise, slackPromise]);

	if (!env.RESEND_API_KEY) {
		// Last-resort durable record when even Resend is unset.
		console.log("[OFFER_SUBMIT_LOG]", { name, email, company, presetId, listTotal, finalTotal, itemIds, kpis, channel });
	}
	return { ok: true, presetName, listTotal, discountPct: discount?.pct ?? null, finalTotal, test: isTest };
}

/**
 * Visitor's own offer email — the /join chassis offer.ts ships (hero photo fused to the card,
 * headline total, itemized basket, teal pill CTA, photo collage, proof stats), plus the
 * AI-discount treatment: struck list total above the discounted headline. Image assets reuse
 * the four email-safe files under /gallery/join. Stats are confirmed data-points displays.
 */
function offerEmailHtml(args: {
	first: string;
	presetName: string;
	standard: ResolvedItem[];
	addons: ResolvedItem[];
	listTotal: number;
	finalTotal: number;
	discountPct: number | null;
}): string {
	const { first, presetName, standard, addons, listTotal, finalTotal, discountPct } = args;
	const assetBase = "https://www.engineeringleaders.io/gallery/join";
	const e = {
		preheader: "Your offer, item by item. The next step is a call.",
		heading: `Here's the offer you built, ${first}.`,
		intro: `Every item you chose is here, priced. Marian has the same list, so the next conversation starts from your selection, not a blank page.${discountPct ? ` Because you built this through the AI channel, the ${discountPct}% discount is already in the total.` : ""}`,
		perYear: "/ year, excl. VAT",
		totalLabel: "Total / year, excl. VAT",
		cta: "Book the call with Marian",
		photosLabel: "What you are buying into",
		photosCaption: "This is the room. 12 meetups a year in Prague, Brno, Bratislava and Kraków.",
		stats: ["3,100+ members", "120+ every meetup", "500+ at the conference"],
		nudgeText:
			"Want the year shaped around your KPIs? Reply to this email with what you need to move, and we build the twelve months around it.",
		footer: "You got this because you built an offer through ELC's Partnership AI Builder.",
	};

	const rowHtml = (i: ResolvedItem) =>
		`<tr>
      <td style="padding:8px 0;font-size:14px;line-height:1.5;color:#d8cfc4;border-bottom:1px solid rgba(255,255,255,0.06);">${i.name}</td>
      <td align="right" style="padding:8px 0 8px 16px;font-size:14px;font-weight:600;color:#efddc9;border-bottom:1px solid rgba(255,255,255,0.06);white-space:nowrap;">${i.price === 0 ? "included" : eur(i.price)}</td>
    </tr>`;
	const sectionHtml = (label: string, list: ResolvedItem[]) =>
		list.length
			? `<tr><td colspan="2" style="padding:20px 0 4px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#149da2;">${label}</td></tr>${list.map(rowHtml).join("")}`
			: "";

	const headlinePrice = discountPct
		? `<p style="margin:0 0 2px;font-size:16px;color:#8a857f;"><s>${eur(listTotal)}</s> <span style="color:#149da2;font-weight:700;">-${discountPct}% AI channel</span></p>
       <p class="big" style="margin:0 0 26px;font-size:42px;line-height:1.05;font-weight:700;letter-spacing:-0.02em;color:#f5f0eb;">${eur(finalTotal)}<span style="font-size:14px;font-weight:500;color:#8a857f;letter-spacing:0;"> ${e.perYear}</span></p>`
		: `<p class="big" style="margin:0 0 26px;font-size:42px;line-height:1.05;font-weight:700;letter-spacing:-0.02em;color:#f5f0eb;">${eur(finalTotal)}<span style="font-size:14px;font-weight:500;color:#8a857f;letter-spacing:0;"> ${e.perYear}</span></p>`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<style>
  @media only screen and (max-width: 620px) {
    .container { width: 100% !important; }
    .px { padding-left: 20px !important; padding-right: 20px !important; }
    .h1 { font-size: 26px !important; }
    .big { font-size: 34px !important; }
    .stack { display: block !important; width: 100% !important; padding: 0 0 12px 0 !important; }
    .statcell { display: block !important; width: 100% !important; padding: 6px 0 !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#030609;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${e.preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#030609;">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
    <tr><td align="center" style="padding:0 0 28px;">
      <a href="https://www.engineeringleaders.io/" style="text-decoration:none;">
        <img src="${assetBase}/email-logo.png" width="240" alt="Engineering Leaders Community" style="display:block;width:240px;height:auto;border:0;">
      </a>
    </td></tr>
    <tr><td style="border-radius:16px 16px 0 0;overflow:hidden;">
      <img src="${assetBase}/email-hero.jpg" width="600" alt="A packed ELC meetup room" style="display:block;width:100%;height:auto;border:0;border-radius:16px 16px 0 0;">
    </td></tr>
    <tr><td class="px" style="background-color:#14181f;border-radius:0 0 16px 16px;padding:36px 44px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <h1 class="h1" style="margin:0 0 18px;font-size:30px;line-height:1.2;font-weight:600;color:#f5f0eb;">${e.heading}</h1>
      <p style="margin:0 0 28px;font-size:15px;line-height:1.65;color:#d8cfc4;">${e.intro}</p>
      <p style="margin:0 0 2px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#149da2;">${presetName}</p>
      ${headlinePrice}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        ${sectionHtml("Standard", standard)}
        ${sectionHtml("Add-ons", addons)}
        <tr>
          <td style="padding:18px 0 0;font-size:15px;font-weight:600;color:#f5f0eb;">${e.totalLabel}</td>
          <td align="right" style="padding:18px 0 0 16px;font-size:22px;font-weight:700;color:#f5f0eb;white-space:nowrap;">${eur(finalTotal)}</td>
        </tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:30px;">
        <tr><td>
          <a href="${BOOK_CALL}" style="display:inline-block;background-color:#149da2;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 26px;border-radius:999px;">${e.cta}</a>
        </td></tr>
      </table>
      <p style="margin:34px 0 12px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#149da2;">${e.photosLabel}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td class="stack" width="50%" style="padding:0 6px 0 0;">
            <img src="${assetBase}/email-pic-a.jpg" width="268" alt="Networking after the talk" style="display:block;width:100%;height:auto;border:0;border-radius:12px;">
          </td>
          <td class="stack" width="50%" style="padding:0 0 0 6px;">
            <img src="${assetBase}/email-pic-b.jpg" width="268" alt="The audience at an ELC meetup" style="display:block;width:100%;height:auto;border:0;border-radius:12px;">
          </td>
        </tr>
      </table>
      <p style="margin:12px 0 0;font-size:13px;line-height:1.6;color:#8a857f;">${e.photosCaption}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:20px;">
        <tr>
          ${e.stats
						.map(
							(s) =>
								`<td class="statcell" align="center" width="33%" style="padding:14px 8px;border:1px solid rgba(255,255,255,0.08);border-radius:12px;font-size:13px;font-weight:600;color:#efddc9;">${s}</td>`,
						)
						.join('<td width="8">&nbsp;</td>')}
        </tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:28px;">
        <tr><td style="border:1px solid rgba(20,157,162,0.45);border-radius:12px;padding:18px 22px;">
          <p style="margin:0;font-size:14px;line-height:1.6;color:#d8cfc4;">${e.nudgeText}</p>
        </td></tr>
      </table>
      <p style="margin:30px 0 4px;font-size:15px;line-height:1.65;color:#d8cfc4;">See you on the call.</p>
      <p style="margin:0;font-size:15px;line-height:1.5;color:#f5f0eb;font-weight:600;">Marian Kamenistak</p>
      <p style="margin:0;font-size:13px;line-height:1.5;color:#8a857f;">Founder @ ELC</p>
    </td></tr>
    <tr><td align="center" style="padding:24px 20px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <p style="margin:0;font-size:12px;line-height:1.6;color:#8a857f;">${e.footer}</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

export { guardrailBlock, BOOK_CALL };
