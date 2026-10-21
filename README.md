# Bullrun: Global Stock & UCITS ETF Research

An MCP server for researching stocks and ETFs beyond the US. Find global stock candidates, compare UCITS ETF costs and overlap, and inspect company risks from your MCP client. Every figure shows its date, reporting period and native currency, and missing data is reported as unknown. **Public research needs no API key or Bullrun account.** Connect your free Bullrun account when you want to save research, read your portfolios or create a reviewable paper-portfolio draft.

[![Bullrun MCP server](https://mcprush.com/badge/bullrun-mcp/card.svg)](https://mcprush.com/to/bullrun-mcp?ref=badge) [![Bullrun Research MCP server](https://mcprush.com/badge/bullrun-research-mcp/card.svg)](https://mcprush.com/to/bullrun-research-mcp?ref=badge)

| | |
| --- | --- |
| Public research | `https://mcp.bull-run.org/mcp` (Streamable HTTP) |
| Personal research and portfolios | `https://mcp.bull-run.org/account/mcp` (OAuth) |
| Research tools only, no sign-in | `https://mcp.bull-run.org/research/mcp` (the 39 research tools, no account tools or prompts) |
| Web app | [bull-run.org](https://bull-run.org) |
| Registry | [`org.bull-run/bullrun`](https://registry.modelcontextprotocol.io/v0.1/servers?search=org.bull-run%2Fbullrun) |
| Glama | [Server](https://glama.ai/mcp/servers/ferinator/bullrun-mcp) · [Connector](https://glama.ai/mcp/connectors/org.bull-run/bullrun) |
| mcprush | [Bullrun MCP](https://mcprush.com/bull-run/bullrun-mcp) · [Bullrun Research](https://mcprush.com/bull-run/bullrun-research-mcp) (research tools only, with quotas per installation) |
| Privacy | [Privacy policy](https://bull-run.org/privacy) |

## Connect

Add the hosted endpoint as a remote MCP server in your client. Public market research is anonymous. To save a research shortlist or work with your portfolios, add the account endpoint above and authorize the requested OAuth scopes. These features, including AI-generated drafts, are available to signed-in free accounts. Without an account you get about 50-100 tool calls a day and at least a week of use each month; a free account triples that, and Pro removes the daily and monthly caps (fair use applies). Your shortlist persists in [Research Shortlist](https://bull-run.org/short-list), and paper drafts remain pending until you review and accept them. Saving never enables monitoring or email.

```json
{
  "mcpServers": {
    "bullrun": { "url": "https://mcp.bull-run.org/mcp" }
  }
}
```

Configuration formats vary by client. See the [connection guide](docs/mcp-connect.md).

## Start with a research question

- “Find Nestlé's stock listing and show the available company data.”
- “List your preset stock screens, then find European companies with positive earnings and free cash flow.”
- “Show six months of Apple's daily prices, RSI and moving averages.”
- “Find peers for Microsoft and compare their fundamentals.”
- “Show recent company news for NVIDIA, with publication dates and freshness.”
- “Which UCITS funds track the S&P 500 at the lowest ongoing cost?”
- “Compare the underlying overlap of these two ETFs.”
- “Which companies share suppliers or customers with Apple?”

Use the prompt menu for `find_ml_candidates` (compare model candidates with business fundamentals), `compare_ucits_costs` (fund-level cost comparison) and `research_shortlist_briefing` (review your saved queue). These workflows retrieve research; saving requires your instruction.

## Tools

Version 0.8.1 exposes 48 focused tools in both hosted and local builds (39 research tools on the marketplace connection). The exact tools and parameters are available through MCP `tools/list`.

| Workflow | Tools |
| --- | --- |
| Find stocks and screen | `search_stocks`, `screen_stocks`, `find_stock_peers` |
| Prices and news | `get_stock_price_history`, `get_company_news`, `get_stock_metrics` |
| Fundamentals | `compare_stocks`, `get_financial_history`, `get_quality_moat_metrics`, `get_revenue_breakdown` |
| Coverage and optional datasets | `get_company_data_coverage`, `get_forward_estimates`, `get_operating_kpis`, `get_earnings_call_transcript` |
| Company risk and dependencies | `get_company_risk`, `get_company_relationships`, `compare_company_exposures`, `get_company_risk_history`, `screen_risk_board`, `get_risk_movers` |
| Corporate calendar | `get_corporate_calendar` |
| ETF discovery | `search_etfs`, `screen_etfs`, `get_etf_filter_options`, `get_etf_index_group`, `get_etf_fund` |
| ETF research | `get_etf_snapshot`, `get_etf_holdings`, `get_etf_timeseries`, `get_etf_exposures`, `get_etf_risk`, `compare_etfs`, `simulate_etf_cost` |
| Macro | `get_global_markets_overview`, `get_country_macro`, `get_macro_indicators`, `get_macro_history` |
| Bullrun valuation models | `get_valuation_model`, `screen_valuation_model` |
| Research Shortlist (sign-in) | `save_research_shortlist`, `list_research_shortlist` |
| Personal portfolios (sign-in) | `list_portfolios`, `get_portfolio_context`, `get_portfolio_analytics`, `get_capabilities` |
| Reviewable paper drafts (sign-in) | `create_portfolio_from_positions`, `create_portfolio_draft`, `create_position_draft` |

The consolidated tools preserve existing defaults and fetch extra analysis only when requested:

- `screen_stocks({action: "list_presets"})` lists transparent rules without running a screen. Pass a `preset` such as `profitable_value` to run it, or supply custom `rules`; do not combine preset and custom rule inputs.
- `compare_etfs({tickers: [...], include: ["overlap"]})` returns pairwise shared holdings, weighted overlap, snapshot dates and partial-coverage warnings. Other comparison modules can be requested alongside overlap.
- `get_portfolio_analytics({portfolioId, candidateTicker, includeLookThrough: true})` adds ETF/direct-holding duplicate exposure. It requires portfolio access and retains the selected `privacyMode`; ordinary analytics does not fetch holdings look-through.

### Migrating older clients

The four retired names remain available in the opt-in compatibility catalog at `https://mcp.bull-run.org/legacy/mcp`. OAuth clients that need a login challenge can use `https://mcp.bull-run.org/account/legacy/mcp`. Both retain the existing authentication rules. The modern endpoints omit these aliases:

| Legacy name | Modern call |
| --- | --- |
| `screen_stock_presets` | `screen_stocks` with `action: "list_presets"` or a named `preset` |
| `analyze_etf_overlap` | `compare_etfs` with `include: ["overlap"]` |
| `analyze_portfolio_fit` | `get_portfolio_analytics` with `candidateTicker` and `includeLookThrough: true` |
| `query_etfs` | `search_etfs`, `get_etf_snapshot`, `get_etf_holdings`, and `get_etf_timeseries`, according to the requested operation |

Reconnect after changing endpoints; modern and compatibility sessions cannot be shared. For local compatibility, run `node dist/stdio.js --legacy-tools`. Legacy responses retain their existing fields and units, including raw fractional ratios in `query_etfs`; modern ETF ratios use percentage points.

Read the returned coverage and dates. Stored prices are daily observations, not live stock quotes. Technical indicators and price returns use stored closes; an adjusted total-return series is not implied. Weekly/monthly bars are aggregated from daily data. News reads return cached articles and can request a bounded background refresh; an empty result is not proof that no news exists.

Consensus estimates use available Yahoo revenue/EPS targets and EPS revisions; EBITDA, management guidance and revenue revisions are not supplied by this feed. US transcript reads can queue a bounded import of the latest two calls from the existing free DefeatBeta source; the first cached response may be empty while that runs. Non-US transcript coverage is not configured. Operating KPI observations remain limited to stored rows, with no broad KPI ingestion pipeline. Use `get_company_data_coverage` before relying on an optional dataset. Missing data is unknown. A risk band describes measured strain, and a model valuation gap describes relative pricing; neither is a price target or buy/sell recommendation.

The same UCITS fund can trade on several venues under different symbols. Resolve ISINs with `get_etf_fund` and treat those listings as one holding when evaluating overlap.

Shortlist access uses `read:shortlist` and `write:shortlist`. Reconnect the account endpoint to grant these scopes if you connected an older version. `save_research_shortlist` takes 1-20 exact stock or ETF listing tickers; confirmed saves and individual failures are returned separately.

Successful answers offer an optional contextual link to Bullrun's charts, screens, company networks or saved draft. Link descriptions identify settings that the app cannot reproduce. Opening a draft link never accepts it or changes holdings.

## Local stdio build

The remote endpoint is the simplest connection. To build the connector for local clients or directory inspection:

```sh
npm ci
npm run build
node dist/stdio.js
```

The stdio build reads public data from `https://bull-run.org` by default. Set `BULLRUN_API_BASE` to use another Bullrun API deployment. Anonymous stdio clients cannot read personal portfolios or create drafts.

## Release verification

```sh
npm test
npm run test:catalog
```

The public repository contains the MCP connector, not the application database or data services. The connector source, version and catalog are synchronized from the application repository's release process. [MIT license](LICENSE).
