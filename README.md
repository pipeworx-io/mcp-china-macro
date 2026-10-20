# @pipeworx/china-macro

China's PBOC Loan Prime Rate (贷款市场报价利率, LPR), National Bureau of
Statistics headline indicators, 70-city house prices, SHIBOR and the
government-bond yield curve — all keyless, sourced live.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1854+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `china_lpr({ months? })` — up to the last 12 monthly LPR announcements
  (1-year and 5-year rate, plus reference date), newest first, and a `latest`
  field. The upstream only exposes a rolling ~1-year window — `months` caps at
  12.
- `china_lpr_latest()` — the current 1-year/5-year LPR print and its reference
  date only, without the history. Cheaper when a caller just wants "the
  current rate".
- `china_macro_indicator({ indicator, periods? })` — one tool across nine
  headline indicators: `cpi`, `ppi`, `pmi` (manufacturing +
  non-manufacturing), `gdp` (year-to-date cumulative, by sector), `industrial_production`
  (industrial value-added growth), `retail_sales`, `fixed_asset_investment`,
  `money_supply` (M0/M1/M2), and `trade` (monthly export/import totals).
  Returns the latest period first, then up to `periods` (default 12, max 36)
  months/quarters of history — every field translated from its Chinese NBS
  name to an English name with its unit.
- `china_house_prices({ city?, month? })` — the 70-city new-build and resale
  residential price indexes. `city` (English name) for one city's history
  (up to 24 months); `month` ("YYYY-MM") to pin a release; neither for the
  latest month's full 70-city cross-section.
- `china_rates({ series, days?, periods? })` — `series: "shibor"` for the
  Shanghai Interbank Offered Rate across all 8 tenors (latest fixing + daily
  history); `series: "yield_curve"` for the China Government Bond yield
  curve (dated 1-year/10-year benchmark history plus the full real-time
  quoted curve across all actively-traded maturities).

## Auth

Keyless. No cookie or session — the LPR/SHIBOR/rates tools send a same-site
`Referer` header; the macro-indicator and house-price tools send only a
`User-Agent` and `Referer`.

## Data sources

- National Interbank Funding Center, under PBOC authorization — the Loan
  Prime Rate (`china_lpr`, `china_lpr_latest`).
- National Bureau of Statistics of China — CPI, PPI, PMI, GDP, industrial
  value-added growth, retail sales, fixed-asset investment, money supply, and
  the 70-city residential price index (`china_macro_indicator`,
  `china_house_prices`).
- General Administration of Customs of China — monthly export/import totals
  (`china_macro_indicator({ indicator: "trade" })`).
- China Foreign Exchange Trade System / National Interbank Funding Center —
  the SHIBOR fixing and China Government Bond yields (`china_rates`).

The LPR endpoints are the JSON calls chinamoney.com.cn's own chart widget
makes, found via a browser network tab (fleet #1311) — the guessed export
path (`LprHisExcel`) 200s with an empty body and is not usable. The LPR
history call ignores date-range query parameters and always returns the same
rolling ~12-row window ending at the latest announcement; there is no deeper
history available through it. LPR is announced monthly on the 20th (or the
next business day) — expect `china_lpr_latest`'s `reference_date` to move
roughly once a month.

The NBS/Customs indicators and the 70-city house-price index are served by
the same republisher the broader China-equities catalog already calls live
(fleet #3298) — the host is shared with `china-stocks`'s billboard/earnings
reports, confirmed reachable from Cloudflare's edge since 2026-07-17. The
SHIBOR history call and the government-bond yield curve calls are found the
same way the LPR ones were, on chinamoney.com.cn's own SHIBOR and bond-yield
pages; the real-time yield curve defaults to Treasury bonds. The 1-year/10-year
benchmark series is the daily update chinamoney publishes under the IMF's
Special Data Dissemination Standard (SDDS); it only exposes a page at a time
(capped at 60 rows per call here) — request `periods` close to what you need
rather than the daily maximum.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "china-macro": {
      "url": "https://gateway.pipeworx.io/china-macro/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/china-macro/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1854+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/china_lpr \
  -H 'Content-Type: application/json' \
  -d '{"months":12}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/china_lpr`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "china-macro": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-china-macro"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-china-macro
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about China Macro data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
