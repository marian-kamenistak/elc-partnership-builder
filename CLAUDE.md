# elc-partnership-builder

## What this is
The Partnership AI Builder for the **elc** stream: an authless MCP server at
`https://www.engineeringleaders.io/mcp/partnership` plus the chat backend for the
`/partner/chat/` widget on elc-web. Eleven tools: `get_started` (routes a greeting/test/unclear
message to the right tool below), `get_partnership_options`, `match_package`,
`customize_package`, `book_intro_call`, `fit_to_budget`, `build_business_case`,
`design_journey`, `request_offer` — price a partnership from the published catalog with a 16%
AI-channel discount — plus `get_reach_options` and `quote_reach_combo` (2026-09-03), the one-off
menu behind engineeringleaders.io/reach: single items bought once, combo discount by item count,
no AI-channel percentage. Registered on the MCP Registry and Smithery.

## Stack
- Cloudflare Worker + Durable Object `ElcPartnershipBuilder` (`MCP_OBJECT`), `McpAgent` (`agents` ^0.17), streamable HTTP
- TypeScript 6, zod 4, vitest 3, `@posthog/mcp` + `posthog-node`; chat via Claude API (`CHAT_MODEL` = `claude-sonnet-5`)
- wrangler ^4.105, npm (pnpm lockfile also present)
- KV `UPTIME_STATE` (`d07fc3148192400f890345abe1f05cca`); rate limiters `OFFER_RATE_LIMITER` (2001), `CHAT_RATE_LIMITER` (2002)
- Cron `*/15 * * * *` uptime probe, Slack on failure only

## Run / build / deploy / test
```bash
# dev:    npm run dev
# build:  npm run type-check
# test:   npm test                                  # vitest run (test/*.test.ts)
# tools:  npx tsx scripts/tool.mjs list             # local harness, request_offer stubbed
# deploy: set -a && source ~/.env && set +a && npm run deploy   # runs secret-sync first
```

## Sources of truth
| Data | Lives in | Id / path |
|---|---|---|
| Offer catalog (prices, presets) | `business/elc/partnerships/offers/catalog.yaml` → `npm run offers:sync` in `web/elc-web` | generates `src/data/offer-catalog.json` (not in repo) |
| Public catalog | engineeringleaders.io | `/partner/offer-catalog.json` |
| Inquiries | Attio | Partners pipeline |
| Secrets (1Password → Worker) | `.op-secrets` | `ANTHROPIC_API_KEY`, `ATTIO_TOKEN`, `RESEND_API_KEY`, `SLACK_BOT_TOKEN_ELC`, `SLACK_WEBHOOK_URL` |
| Secrets (CF Secrets Store `e5f76638…`) | `wrangler.jsonc` | `PARTNER_CHAT_TURNSTILE_SECRET`, `RECLAIM_WEBHOOK_SECRET` |
| Unmanaged Worker secrets | Cloudflare only | `CHAT_SESSION_SECRET`, `SLACK_PARTNERS_CHANNEL`, `MCP_USAGE_SLACK_CHANNEL` |

## Definition of done
- [ ] `npm test` and `npm run type-check` exit 0
- [ ] `wrangler deploy` exits 0
- [ ] `tools/list` POST to `https://www.engineeringleaders.io/mcp/partnership` returns **12** — the 11 tools above plus `get_more_tools`, which `instrumentMcpUsage` injects; GET returns 200 HTML
- [ ] `wrangler tail --format json` for 60s: zero `console.error`, zero exceptions
- [ ] Any offer change also walked through the stream checklist in `business/elc/CLAUDE.md` (pages, elc-web, llms, schemas)

## Gotchas
- Do not re-push Secrets Store secrets via `.op-secrets` — a same-name plain secret collides with the binding (2026-08-25).
- `CHAT_ENABLED=false` is the kill switch for the widget; `CHAT_TURNSTILE_SECRET` is the "ELC Partner Chat" widget, not elc-web's "Partner Offer" one.
