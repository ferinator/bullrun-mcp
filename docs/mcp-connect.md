# Connect Bullrun to your AI client

Bullrun runs a hosted **remote MCP server** at:

```
https://mcp.bull-run.org/mcp
```

It speaks **Streamable HTTP**. **Public research needs no API key or Bullrun account.**
The hosted endpoint accepts anonymous research connections. OAuth 2.1 + PKCE is available
for personal portfolios and saved drafts: authorize with Google when you need those tools.
Some clients start an OAuth connection automatically; anonymous stdio is also available.

> No JSON editing required for Claude — add the remote URL in the connector settings. The configs
> below are for clients that connect via a file.

## What you can do once connected

- **Find the right company** by name, native ticker or ISIN (`search_stocks`), inspect
  transparent stock-screen presets (`screen_stock_presets`), and discover peers with their
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
  `compare_etfs`, `analyze_etf_overlap`, `simulate_etf_cost`).
- **Analyze your real holdings** — list your portfolios, get a deep per-portfolio snapshot and
  risk/factor analytics (`list_portfolios`, `get_portfolio_context`, `get_portfolio_analytics`).
  *Requires sign-in.*
- **Draft new ideas safely** — generate a reviewable paper-portfolio or position draft from a
  plain-English brief (`create_portfolio_draft`, `create_position_draft`). **Draft-only:** these
  never change a live position — they save a pending draft you accept (or discard) in the
  Bullrun GUI. *Requires a Bullrun Pro account.*

## Claude (claude.ai web, Desktop, mobile)

Custom connectors require a paid Claude plan (Pro, Max, Team, or Enterprise).

1. **Settings → Connectors → Add custom connector**.
2. Name it `Bullrun`, paste the URL `https://mcp.bull-run.org/mcp`, and add it.
3. Click **Connect** on the new connector and complete the Google sign-in / authorize step.
4. In a chat, open the tools menu to confirm the Bullrun tools are available.

## Claude Code (CLI)

```bash
claude mcp add --transport http bullrun https://mcp.bull-run.org/mcp
```

Then run `/mcp` inside Claude Code and choose **Authenticate** next to `bullrun` to complete
the OAuth flow.

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

Then open **Cursor → Settings → MCP** and click **Login** next to Bullrun to authorize.

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

VS Code prompts for sign-in on first use.

## MCP Inspector (to explore the tools)

```bash
npx -y @modelcontextprotocol/inspector
```

In the UI: **Transport = Streamable HTTP**, **URL = `https://mcp.bull-run.org/mcp`**, Connect,
and complete the OAuth prompt.

## Privacy & data

Bullrun's MCP server is a thin proxy with no database of its own. Read tools return market data
and your own portfolios; the per-user read tools accept a `privacyMode` (`full` by default, or
`weights_only` to hide absolute money and return only relative figures). Draft tools never
mutate live holdings. See the privacy policy at <https://bull-run.org/privacy>.
