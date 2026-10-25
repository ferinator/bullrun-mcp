# Connect Bullrun to your AI client

Bullrun runs a hosted **remote MCP server** at:

```
https://mcp.bull-run.org/mcp
```

It speaks **Streamable HTTP**. **Public research needs no API key or Bullrun account.**
The hosted endpoint accepts anonymous research connections. OAuth 2.1 + PKCE is available
for personal portfolios and saved drafts: authorize with Google when you need those tools.
For account connections, use **`https://mcp.bull-run.org/account/mcp`** instead.
That endpoint challenges the client into OAuth and supports the public research tools too.
Use one of these endpoints per client: `/mcp` to try research anonymously, or
`/account/mcp` to read portfolios and save research. Adding the public endpoint does not
guarantee that a client will offer login. Anonymous stdio is also available.

The [MCP product page](https://bull-run.org/mcp) explains the workflows and endpoint choices.
Free use includes **700 successful MCP tool calls per rolling 30 days**, per free account
or anonymous network, shared across the official public, research and OAuth endpoints.
Connected Pro and active-trial accounts get **1,000 successful tool calls per rolling 5 hours**.
Each successful call counts once, regardless of how much data it loads; failed calls use no
allowance. Every feature is available on a free Bullrun account; signing in enables personal
tools without increasing the free account's 700-call cap. Allowances refill automatically as
earlier calls leave the rolling window. Temporary capacity limits and tool pacing may ask you
to wait; follow the retry guidance in the reply. MCP allowances are separate from website
and marketplace policies, which are unchanged.

> No JSON editing required for Claude — add the remote URL in the connector settings. The configs
> below are for clients that connect via a file.

## What you can do once connected

- **Find the right company** by name, native ticker or ISIN (`search_stocks`), inspect
  transparent stock-screen presets (`screen_stocks` with `action=list_presets`), and discover peers with their
  selection criteria (`find_stock_peers`).
- **Inspect price history and technicals** (`get_stock_price_history`) using stored daily
  bars, optionally aggregated weekly/monthly. **Read company news** (`get_company_news`)
  with publication dates and freshness; reads may request a bounded background refresh.

- **Screen the global universe** — filter by sector / industry / country / market cap, sort by
  P/E, dividend yield, revenue or revenue growth (`screen_stocks`).
- **Pull a full company snapshot** — identity (ISIN/LEI/CIK), latest price, valuation,
  financials and a description for one ticker (`get_stock_metrics`), or 1–15 years of history
  (`get_financial_history`), quality/moat & capital-allocation metrics (`get_quality_moat_metrics`),
  revenue breakdowns and available forward revenue/EPS estimates. US transcript reads
  can queue the latest two calls from the free DefeatBeta source; cached reads can be
  empty before refresh completes. Operating KPI observations and non-US transcripts
  remain limited; check `get_company_data_coverage` before promising these datasets.
- **Read Bullrun's valuation model** — the gap between the P/E (or price/sales) a stock's
  fundamentals typically command and what it trades at, the implied model-typical P/E, and a
  relative 1-year forecast signal, for any ticker (`get_valuation_model`) or ranked across the
  universe from either end (`screen_valuation_model`).
- **Assess company risk and relationships** — a 0-100 composite risk score and six mechanism
  dials (market expectation, operating pressure, cash conversion, leverage, competitive
  position, concentration), filing risk factors and supplier concentration
  (`get_company_risk`); named competitors, suppliers, customers and partners with verified
  evidence and quantified dependence (`get_company_relationships`); the universe ranked by any
  dial (`screen_risk_board`) and this week's band changes (`get_risk_movers`).
- **Follow global markets and macro** — indices, policy rates, 10Y yields, FX, commodities, the
  economic calendar and news in one call (`get_global_markets_overview`); a country's macro
  stress score and its inputs (`get_country_macro`); countries ranked on GDP growth, inflation,
  debt, unemployment, housing, credit or confidence (`get_macro_indicators`); and decades of
  history for any of those series (`get_macro_history`).
- **Research ETFs and UCITS funds** — screen the whole fund universe on cost, size, yield,
  returns, volatility, liquidity and concentration, or by what a fund *holds*
  (`screen_etfs`); find the cheapest fund tracking an index with venue duplicates collapsed
  (`get_etf_index_group`); resolve an ISIN to the fund and every exchange it trades on
  (`get_etf_fund`); then drill into holdings, exposures, risk, overlap and cost scenarios
  (`get_etf_snapshot`, `get_etf_holdings`, `get_etf_exposures`, `get_etf_risk`,
  `compare_etfs` with optional `include: ["overlap"]`, `simulate_etf_cost`).
- **Analyze your real holdings** — list your portfolios, get a deep per-portfolio snapshot and
  risk/factor analytics (`list_portfolios`, `get_portfolio_context`, `get_portfolio_analytics`).
  Pass `candidateTicker` and `includeLookThrough=true` to add direct/ETF-contained duplicate-underlying analysis with separate coverage. *Requires sign-in.*
- **Draft new ideas safely** — generate a reviewable paper-portfolio or position draft from a
  plain-English brief (`create_portfolio_draft`, `create_position_draft`). **Draft-only:** these
  never change a live position — they save a pending draft you accept (or discard) in the
  Bullrun GUI. *Requires a connected free Bullrun account and draft-write permission; usage limits apply.*
- **Keep a research queue** — explicitly save exact stock/ETF tickers with
  `save_research_shortlist`, then read them with `list_research_shortlist`. These use
  `write:shortlist` / `read:shortlist`; reconnect if an older grant lacks those scopes.
  Saving a shortlist does not schedule monitoring, send email or create a portfolio.

## Version 0.8 compatibility

The modern catalog contains 48 tools. Older clients can reconnect to
`https://mcp.bull-run.org/legacy/mcp` to retain `query_etfs`,
`screen_stock_presets`, `analyze_etf_overlap`, and `analyze_portfolio_fit`.
Use `https://mcp.bull-run.org/account/legacy/mcp` when an OAuth login challenge
is required. Authentication rules and legacy response units are retained;
modern and compatibility sessions cannot be shared. Local stdio clients can
select the same compatibility catalog with `node dist/stdio.js --legacy-tools`.

For modern calls, use named presets on `screen_stocks`, the optional overlap
module on `compare_etfs`, and `includeLookThrough=true` on
`get_portfolio_analytics`. Use the focused ETF search, snapshot, holdings and
timeseries tools in place of `query_etfs`.

## Claude (claude.ai web, Desktop, mobile)

Claude supports custom remote connectors on Free, Pro, Max, Team and Enterprise;
Free is limited to one custom connector. Organization controls may apply.
See [Claude's current setup guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

1. Open **Customize → Connectors → Add custom connector** (the location can vary by client).
2. Name it `Bullrun`. For anonymous research paste `https://mcp.bull-run.org/mcp`;
   for portfolios and saving paste `https://mcp.bull-run.org/account/mcp`.
3. Review the detected authentication settings. The account endpoint opens Bullrun sign-in
   and authorization; anonymous research does not require that step.
4. In a chat, open the tools menu to confirm the Bullrun tools are available.

## Claude Code (CLI)

```bash
claude mcp add --transport http bullrun https://mcp.bull-run.org/mcp
```

For portfolios and saved research, add the account endpoint instead:

```bash
claude mcp add --transport http bullrun https://mcp.bull-run.org/account/mcp
```

Then run `/mcp` inside Claude Code and choose **Authenticate** next to `bullrun`.
If the public endpoint is already configured, replace that configuration using the client's
server-management controls rather than adding two copies of the same tool catalog.

## Cursor

One-click — paste this into your browser (or use an "Add to Cursor" button that points here):

```
cursor://anysphere.cursor-deeplink/mcp/install?name=bullrun&config=eyJ1cmwiOiJodHRwczovL21jcC5idWxsLXJ1bi5vcmcvbWNwIn0=
```

Or edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "bullrun": {
      "url": "https://mcp.bull-run.org/mcp"
    }
  }
}
```

This configuration is anonymous. For portfolios and saved research, change the URL to
`https://mcp.bull-run.org/account/mcp`, then open **Cursor → Settings → MCP** and use
the authentication control next to Bullrun.

## VS Code (Copilot agent mode)

Add `.vscode/mcp.json` to your workspace (or use the global config):

```json
{
  "servers": {
    "bullrun": {
      "type": "http",
      "url": "https://mcp.bull-run.org/mcp"
    }
  }
}
```

The public URL above is anonymous. Replace it with
`https://mcp.bull-run.org/account/mcp` when you want VS Code to prompt for account authorization.

## MCP Inspector (to explore the tools)

```bash
npx -y @modelcontextprotocol/inspector
```

In the UI: **Transport = Streamable HTTP**, **URL = `https://mcp.bull-run.org/mcp`**, Connect.
For account authorization use `https://mcp.bull-run.org/account/mcp` instead.

## Useful starting prompts

- `find_ml_candidates`: discover a small list from stored ML scores, then compare fundamentals,
  quality and measured risk. Valuation gaps are descriptive context; forecast ranks are not price targets.
- `compare_ucits_costs`: resolve an index, compare distinct funds' costs and available holdings overlap.
- `research_shortlist_briefing`: review up to five saved entries with stored dates and optional company news.

These workflows reuse existing data. They do not save, schedule or create a portfolio unless
the user explicitly requests the corresponding action.

## Privacy & data

Bullrun's MCP server is a thin proxy with no database of its own. Read tools return market data
and your own portfolios; the per-user read tools accept a `privacyMode` (`full` by default, or
`weights_only` to hide absolute money and return only relative figures). Draft tools never
mutate live holdings. See the privacy policy at <https://bull-run.org/privacy>.
