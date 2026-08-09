/**
 * Human-readable docs page on GET /mcp/partnership.
 *
 * Served for EVERY Accept header except an explicit text/event-stream ask — curl and the
 * crawlers and registry health-checks whose links land here all send the wildcard Accept.
 * Gating on accept.includes("text/html") is the exact 406 bug mcp-launch documents from
 * marian.coach (2026-08-08); the Accept decision itself lives in index.ts.
 */

export interface ToolDoc {
	name: string;
	question: string;
	description: string;
}

const ENDPOINT = "https://www.engineeringleaders.io/mcp/partnership";

export function docsHtml(tools: ToolDoc[], discountPct: number | null): string {
	const rows = tools
		.map((t) => `<tr><td><code>${t.name}</code></td><td>${t.question}</td><td>${t.description}</td></tr>`)
		.join("\n");

	const discountLine = discountPct
		? `<p><strong>Why build it here:</strong> partnerships assembled through this AI channel get <strong>${discountPct}% off</strong> the composed package total, applied automatically when the inquiry is sent.</p>`
		: "";

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ELC Partnership Builder — MCP server | Engineering Leaders Community</title>
<meta name="description" content="Build a tailored ELC partnership package from your own AI assistant: qualify, match a tier, customize priced line items, and send the inquiry${discountPct ? ` with a ${discountPct}% AI-channel discount` : ""}. Free remote MCP server, no auth.">
<link rel="canonical" href="${ENDPOINT}">
<meta property="og:title" content="ELC Partnership Builder — MCP server">
<meta property="og:description" content="Build a tailored ELC partnership from your AI assistant${discountPct ? ` — ${discountPct}% AI-channel discount applied at inquiry` : ""}. 3,100+ engineering leaders in Central Europe.">
<meta property="og:url" content="${ENDPOINT}">
<meta property="og:type" content="website">
<script type="application/ld+json">${JSON.stringify({
		"@context": "https://schema.org",
		"@type": "SoftwareApplication",
		name: "ELC Partnership Builder",
		applicationCategory: "BusinessApplication",
		operatingSystem: "Any (MCP server, streamable HTTP)",
		url: ENDPOINT,
		offers: { "@type": "Offer", price: 0, priceCurrency: "EUR", description: "Free to connect and use, no auth." },
		author: { "@type": "Person", name: "Marian Kamenistak", url: "https://www.marian.coach/" },
		publisher: { "@type": "Organization", name: "Engineering Leaders Community", url: "https://www.engineeringleaders.io/" },
		description: `MCP server that composes and prices ELC partnership packages from the published offer catalog${discountPct ? `, with a ${discountPct}% discount on inquiries sent through the AI channel` : ""}.`,
	})}</script>
<style>
	body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #1a1a1a; }
	code, pre { background: #f4f4f4; border-radius: 4px; font-size: 0.9em; }
	code { padding: 0.1em 0.35em; }
	pre { padding: 0.8em 1em; overflow-x: auto; }
	table { border-collapse: collapse; width: 100%; font-size: 0.92em; }
	th, td { border: 1px solid #ddd; padding: 0.5em 0.7em; text-align: left; vertical-align: top; }
	th { background: #f4f4f4; }
	h1 { font-size: 1.6em; } h2 { font-size: 1.2em; margin-top: 2em; }
	a { color: #0b5fa5; }
	.muted { color: #666; font-size: 0.9em; }
</style>
</head>
<body>
<h1>ELC Partnership Builder — MCP server</h1>
<p>Build a tailored company partnership with Engineering Leaders Community — 3,100+ engineering leaders across Prague, Brno, Bratislava and Kraków — directly from your AI assistant: understand what ELC membership is, match a package to your goal and budget, customize it line item by line item, and send the inquiry.</p>
${discountLine}
<p><strong>Endpoint:</strong> <code>${ENDPOINT}</code> (streamable HTTP, no auth, no signup)</p>

<h2>Tools</h2>
<table>
<tr><th>Tool</th><th>Answers the question</th><th>What it returns</th></tr>
${rows}
</table>

<h2>Connect</h2>
<p><strong>Claude Code</strong></p>
<pre>claude mcp add -t http elc-partnership ${ENDPOINT}</pre>
<p><strong>Claude.ai / Claude Desktop</strong> — Settings → Connectors → Add custom connector → paste <code>${ENDPOINT}</code></p>
<p><strong>Cursor</strong> — add to <code>.cursor/mcp.json</code>:</p>
<pre>{ "mcpServers": { "elc-partnership": { "url": "${ENDPOINT}" } } }</pre>
<p><strong>ChatGPT (developer mode)</strong> — Settings → Connectors → Add → MCP server URL <code>${ENDPOINT}</code></p>
<p><strong>Microsoft 365 Copilot (via Copilot Studio)</strong> — open your agent → Tools → Add a tool → New tool → Model Context Protocol → Server URL <code>${ENDPOINT}</code>, authentication None → Add to agent. Streamable HTTP, which is the one transport Copilot Studio supports.</p>
<p><strong>Perplexity (Pro/Enterprise)</strong> — profile → All settings → Connectors → Custom connector → Remote → MCP Server URL <code>${ENDPOINT}</code>, transport Streamable HTTP, authentication None.</p>
<p>No AI tool that supports MCP? The same builder runs as a chat on <a href="https://www.engineeringleaders.io/partner/chat/?ref=mcp">engineeringleaders.io/partner/chat</a>, and the classic click-through configurator lives at <a href="https://www.engineeringleaders.io/partner/membership/?ref=mcp">/partner/membership/</a>.</p>

<h2>Plain REST, no MCP needed</h2>
<p>The read-only tools double as GET endpoints for scripts and spreadsheets: <code>${ENDPOINT}/api/options</code>, <code>/api/match?goal=hiring&amp;budget=solid</code>, <code>/api/customize</code>, <code>/api/journey</code>. Spec: <a href="${ENDPOINT}/api/openapi.json">openapi.json</a>. Sending an offer stays on the MCP tool and <a href="https://www.engineeringleaders.io/partner/chat/?ref=mcp">the chat</a> — the doors that carry the discount.</p>

<h2>Sibling server</h2>
<p>ELC's general toolkit (leadership-ratio benchmark, partnership business case, community-launch readiness) runs at <a href="https://www.engineeringleaders.io/mcp">engineeringleaders.io/mcp</a> — same pattern, complementary tools.</p>

<h2>Source &amp; method</h2>
<p>Every price comes from ELC's published offer catalog — the same generated file the website's own configurator renders, so this server cannot quote a price the site disagrees with. Community figures come from ELC's member base, no survey panels, no scraped data.</p>
<p class="muted">Built and maintained by <a href="https://www.engineeringleaders.io/partner/?ref=mcp">Engineering Leaders Community</a>. Questions: weare@engineeringleaders.io</p>
</body>
</html>`;
}
