# @pipeworx/china-macro

China's PBOC Loan Prime Rate (贷款市场报价利率, LPR) — the 1-year and 5-year
benchmark lending rates, with official reference dates, sourced live from
chinamoney.com.cn (the National Interbank Funding Center, under PBOC
authorization).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

- `china_lpr({ months? })` — up to the last 12 monthly LPR announcements
  (1-year and 5-year rate, plus reference date), newest first, and a `latest`
  field. The upstream only exposes a rolling ~1-year window — `months` caps at
  12.
- `china_lpr_latest()` — the current 1-year/5-year LPR print and its reference
  date only, without the history. Cheaper when a caller just wants "the
  current rate".

## Auth

Keyless. No cookie or session — just a same-site `Referer` header, which the
pack sends on every call.

## Data sources

- `https://www.chinamoney.com.cn/ags/ms/cm-u-bk-currency/LprHis?lang=CN` —
  rolling ~1-year monthly history (`china_lpr`).
- `https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/currency/bk-lpr.json`
  — latest print only (`china_lpr_latest`).

Both are the JSON endpoints chinamoney.com.cn's own chart widget calls, found
via a browser network tab (fleet #1311) — the guessed export path
(`LprHisExcel`) 200s with an empty body and is not usable. The history
endpoint ignores date-range query parameters and always returns the same
rolling ~12-row window ending at the latest announcement; there is no deeper
history available through this call. LPR is announced monthly on the 20th (or
the next business day) — expect `china_lpr_latest`'s `reference_date` to move
roughly once a month.

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

Both URLs reach the same gateway and the same 1679+ data sources. The
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
