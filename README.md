# Bullrun MCP

Research global stocks and UCITS ETFs from your MCP client. **Public research needs no API key or Bullrun account.** Sign in with Google when you want to read your own portfolios or save a paper-portfolio draft.

| | |
| --- | --- |
| Hosted endpoint | `https://mcp.bull-run.org/mcp` (Streamable HTTP) |
| Web app | [bull-run.org](https://bull-run.org) |
| Registry | [`org.bull-run/bullrun`](https://registry.modelcontextprotocol.io/v0.1/servers?search=org.bull-run%2Fbullrun) |
| Glama | [Server](https://glama.ai/mcp/servers/ferinator/bullrun-mcp) · [Connector](https://glama.ai/mcp/connectors/org.bull-run/bullrun) |
| Privacy | [Privacy policy](https://bull-run.org/privacy) |

## Connect

Add the hosted endpoint as a remote MCP server in your client. Public market research is anonymous. Clients that offer an OAuth connection can also authorize access to your personal portfolios; those tools require a Bullrun account. AI-generated portfolio drafts require Pro. Saving an explicit basket with `create_portfolio_from_positions` is free after sign-in.

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

## Tools

The hosted and local builds share one tool catalog. The exact tools and parameters are available through MCP `tools/list`.

| Workflow | Tools |
| --- | --- |
| Find stocks and screen | `search_stocks`, `screen_stocks`, `screen_stock_presets`, `find_stock_peers` |
| Prices and news | `get_stock_price_history`, `get_company_news`, `get_stock_metrics` |
| Fundamentals | `compare_stocks`, `get_financial_history`, `get_quality_moat_metrics`, `get_revenue_breakdown` |
| Coverage and optional datasets | `get_company_data_coverage`, `get_forward_estimates`, `get_operating_kpis`, `get_earnings_call_transcript` |
| Company risk and dependencies | `get_company_risk`, `get_company_relationships`, `compare_company_exposures`, `get_company_risk_history`, `screen_risk_board`, `get_risk_movers` |
| Corporate calendar | `get_corporate_calendar` |
| ETF discovery | `search_etfs`, `screen_etfs`, `get_etf_filter_options`, `get_etf_index_group`, `get_etf_fund` |
| ETF research | `get_etf_snapshot`, `get_etf_holdings`, `get_etf_timeseries`, `get_etf_exposures`, `get_etf_risk`, `compare_etfs`, `analyze_etf_overlap`, `simulate_etf_cost`, `query_etfs` |
| Macro | `get_global_markets_overview`, `get_country_macro`, `get_macro_indicators`, `get_macro_history` |
| Bullrun valuation models | `get_valuation_model`, `screen_valuation_model` |
| Personal portfolios (sign-in) | `list_portfolios`, `get_portfolio_context`, `get_portfolio_analytics`, `analyze_portfolio_fit`, `get_capabilities` |
| Reviewable paper drafts (sign-in) | `create_portfolio_from_positions`, `create_portfolio_draft`, `create_position_draft` |

Read the returned coverage and dates. Stored prices are daily observations, not live stock quotes. Technical indicators and price returns use stored closes; an adjusted total-return series is not implied. Weekly/monthly bars are aggregated from daily data. News reads return cached articles and can request a bounded background refresh; an empty result is not proof that no news exists.

Consensus estimates use available Yahoo revenue/EPS targets and EPS revisions; EBITDA, management guidance and revenue revisions are not supplied by this feed. US transcript reads can queue a bounded import of the latest two calls from the existing free DefeatBeta source; the first cached response may be empty while that runs. Non-US transcript coverage is not configured. Operating KPI observations remain limited to stored rows, with no broad KPI ingestion pipeline. Use `get_company_data_coverage` before relying on an optional dataset. Missing data is unknown. A risk band describes measured strain, and a model valuation gap describes relative pricing; neither is a price target or buy/sell recommendation.

The same UCITS fund can trade on several venues under different symbols. Resolve ISINs with `get_etf_fund` and treat those listings as one holding when evaluating overlap.

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
