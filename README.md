# Bullrun MCP

A hosted **remote [MCP](https://modelcontextprotocol.io) server** that turns Claude (and other
MCP clients) into a research analyst over global stocks, ETFs, company risk, the global macro
backdrop and your own portfolios, with Bullrun's own machine-learning valuation model built in.

| | |
|---|---|
| **Endpoint** | `https://mcp.bull-run.org/mcp` — Streamable HTTP, OAuth 2.1 + PKCE |
| **Web app** | https://bull-run.org |
| **Official MCP Registry** | [`org.bull-run/bullrun`](https://registry.modelcontextprotocol.io/v0.1/servers?search=org.bull-run%2Fbullrun) |
| **Glama connector** | https://glama.ai/mcp/connectors/org.bull-run/bullrun |
| **Privacy policy** | https://bull-run.org/privacy |

> Bullrun is primarily a **hosted service** — there is nothing to install and no API key to
> manage for normal use. You point your MCP client at the remote endpoint and sign in with
> Google. This repository holds the connector's public metadata ([`server.json`](server.json)),
> connection docs, and a local stdio build of the MCP layer for directory/security checks. The
> Bullrun application and data services remain maintained separately.

## Connect

**Claude (web, Desktop, mobile)** — requires a paid Claude plan:

1. **Settings → Connectors → Add custom connector**
2. Name it `Bullrun`, paste `https://mcp.bull-run.org/mcp`, and add it.
3. Click **Connect** and complete the Google sign-in / authorize step.

**Claude Code:**

```bash
claude mcp add --transport http bullrun https://mcp.bull-run.org/mcp
```

Full setup for **Cursor, VS Code, and the MCP Inspector** is in
[docs/mcp-connect.md](docs/mcp-connect.md).

## What you can do once connected

Public market-data tools work for any connected client. The portfolio tools resolve **your own**
Bullrun account after Google sign-in; the two draft tools require a Bullrun Pro account.

### Stocks

| Tool | What it does |
|---|---|
| `screen_stocks` | Screen the global universe by sector / industry / country / market cap; sort by P/E, dividend yield, revenue or revenue growth. |
| `get_stock_metrics` | Consolidated snapshot for one ticker — identity (ISIN/LEI/CIK), latest price, valuation, most recent financials, description. |
| `get_financial_history` | 1–15 fiscal years of annual/quarterly statements, per-share metrics, margins, CAGRs and consistency checks. |
| `get_quality_moat_metrics` | ROIC, ROIC-vs-WACC spread, ROE/ROA, accruals, cash conversion, capex intensity, dividend payout/growth, buyback proxy. |
| `get_forward_estimates` | Consensus revenue / EPS / EBITDA, guidance, estimate revisions, and derived forward P/E & PEG context. |
| `get_operating_kpis` | Domain KPIs — ARR, net revenue retention, RPO, billings, customer counts, payment & cross-border volume. |
| `get_revenue_breakdown` | Segment, geography, product or customer revenue splits. |
| `get_earnings_call_transcript` | Speaker-tagged earnings-call transcript chunks, fiscal-period filters and text search. |

### Bullrun valuation model

Bullrun's own LightGBM models, rescored every night across the global stock universe. The
**valuation** model predicts the P/E (or price/sales, for companies without earnings) that
businesses with similar fundamentals typically trade at a year out; the **gap** is that
model-typical multiple over the current one, minus one. The **forecast** model is a relative
1-year return-rank signal. Both run on quarterly and on annual financials, so most non-US
companies are covered too.

| Tool | What it does |
|---|---|
| `get_valuation_model` | For 1-10 tickers: valuation gap, implied model-typical P/E vs current P/E, percentile and rank in the scored universe, and the forecast signal, with data-quality and financials-through date. |
| `screen_valuation_model` | Rank the universe (market cap ≥ $100M) from either end: furthest below or above the typical multiple, or strongest/weakest forecast, filtered by sector, country and exchange. |

The valuation gap describes how a stock is priced next to fundamentally similar companies. In
walk-forward tests it has not predicted forward returns, and the tools say so in every response:
it is context for a decision, not a price target.

### Company risk and relationships

| Tool | What it does |
|---|---|
| `get_company_risk` | A 0-100 composite risk score and six mechanism dials (market expectation, operating pressure, cash conversion, leverage & coverage, competitive position, concentration), each with band, direction, driving input and explanation; filing-derived risk factors by severity; identified supplier concentration (share of cost base covered, HHI, sole-source count); recent material events. |
| `get_company_relationships` | Named competitors, suppliers, customers and partners, each with its ticker when listed, VERIFIED (primary filing/source) or SUGGESTED status, confidence, sole-source flag and quantified dependence where disclosed, e.g. *Cirrus Logic gets 91% of its revenue from Apple*. |
| `screen_risk_board` | Rank ~9,000 scored companies by the composite or any one dial, filtered by band, sector, country and how many dials are measured, with sector and country averages. |
| `get_risk_movers` | Companies whose composite crossed into a different band in the last N days, worsening or improving. |

Bands run Contained → Normal → Elevated → Stretched → Acute and describe measured strain, never
a buy/sell view. A dial with no reading is reported as unmeasured, never as safe.

### Global markets and macro

| Tool | What it does |
|---|---|
| `get_global_markets_overview` | One-call briefing: 19 world equity indices (live intraday when open), Fed/ECB/BoE/BoJ/SNB/BoC policy rates and next decisions, 16 sovereign 10Y yields, 20 FX pairs, oil/gas/gold/copper, headline macro tiles (global GDP, inflation, debt, VIX, DXY, 2s10s), the economic calendar, news and the US housing balance. |
| `get_country_macro` | A country's 0-100 macro stress score across six pillars (labour, housing, credit, fiscal, external, cycle), with every input's value, period and source (OECD, IMF, BIS, World Bank, Eurostat). |
| `get_macro_indicators` | Rank or compare ~200 countries on GDP growth, inflation, government debt, unemployment, youth unemployment, house prices vs income and rents, the BIS credit gap, household debt, business/consumer confidence or macro stress. |
| `get_macro_history` | Decades of history for any of those series, by code, by name ("Fed", "Brent", "Germany 10Y", "S&P 500") or by indicator + country, with 1M/3M/1Y/5Y changes and resampled points. |

### ETFs and funds

Built for the way European investors actually shop for funds: by ISIN, by tracked index, and by
total cost — with venue duplicates collapsed so one fund listed on six exchanges reads as one
choice rather than six.

| Tool | What it does |
|---|---|
| `screen_etfs` | Screen the **whole** fund universe by expense ratio, AUM, yield, trailing returns, volatility, liquidity, top-10 concentration and fund age, combined with issuer, index, domicile, UCITS status, distribution policy and currency hedging — plus look-through (`holdingSearch`) to find funds *by what they hold*. |
| `get_etf_index_group` | "Cheapest way to track the S&P 500 / MSCI World?" — every fund on one index, cheapest first, one row per **fund** with its venues, and an explicit count of funds that publish no fee. |
| `get_etf_fund` | Resolve an ISIN (or any venue ticker) to the fund and every exchange it trades on. |
| `get_etf_filter_options` | The exact values the categorical filters accept, so a screen never silently returns nothing on a guessed string. |
| `search_etfs` | Look up a known fund by name, ticker or ISIN, with classification, index, cost and yield filters. |
| `get_etf_snapshot` | Modular snapshot for one listing — identity, classification, market, NAV/AUM, costs, income, benchmark. |
| `get_etf_holdings` | Paginated constituents with an explicit partial-coverage contract. |
| `get_etf_exposures` | Holdings look-through to sector / country / issuer exposure. |
| `get_etf_timeseries` | Price history, with unavailable NAV / total-return / premium-discount series named rather than synthesized. |
| `get_etf_risk` | Volatility, drawdown, Sharpe/Sortino/Calmar, VaR, and benchmark-relative beta and tracking error. |
| `compare_etfs` | Side-by-side cost, performance, risk and holdings comparison. |
| `analyze_etf_overlap` | Shared holdings and a weighted lower-bound overlap between funds. |
| `simulate_etf_cost` | Deterministic multi-year cost scenario from expense ratio, spread, commission and contributions. |
| `analyze_portfolio_fit` | How a candidate fund would fit your existing portfolio. *(sign-in)* |
| `query_etfs` | Original ETF search. Retained for compatibility; prefer `screen_etfs` or `search_etfs`. |

### Your portfolios

| Tool | What it does |
|---|---|
| `get_capabilities` | Which account is connected, whether Pro is active, granted scopes, and which tools are gated. |
| `list_portfolios` | Your virtual portfolios with value, day change, cost basis and total return. *(sign-in)* |
| `get_portfolio_context` | Deep snapshot of one portfolio: every holding with weight, sector and return, plus Bullrun's insights. *(sign-in)* |
| `get_portfolio_analytics` | Correlation/covariance, contribution-to-risk, factor exposure, sector/currency/country concentration, stress scenarios, and candidate-fit analysis. *(sign-in)* |
| `create_portfolio_from_positions` | Save a portfolio you have **already** decided, from an explicit `{ticker, weight}` basket used verbatim. *(sign-in, no Pro needed)* |
| `create_portfolio_draft` | Draft a new paper portfolio from a plain-English brief. **Draft-only** — saved for review, never changes a live position. *(Pro)* |
| `create_position_draft` | Suggest additions to an existing portfolio. **Draft-only** — saved for review. *(Pro)* |

### Prompts

Selectable starting points in your client's prompt menu: `stock_deep_dive` (fundamentals,
valuation model, risk dials and relationships for one ticker), `market_briefing` (markets,
macro and this week's risk movers), `build_portfolio`, `suggest_positions` and
`analyze_portfolio`.

### Try asking

- "Is ASML expensive by Bullrun's valuation model, and what are its biggest risks?"
- "Who are Apple's suppliers, and which of them depend on Apple for most of their revenue?"
- "Which large US companies have stretched or acute leverage right now?"
- "Brief me on global markets this morning, with a focus on Europe."
- "Rank G7 countries by government debt and show me Italy's 10-year yield since 2010."
- "Find the cheapest German stocks relative to their fundamentals."

## Continue your research in Bullrun

Successful research results include a contextual link to the matching page on
[Bullrun](https://bull-run.org). Explore company charts and networks, adjust a stock
screen, compare funds, or open a macro chart from the answer you already have.

Stock-screen links preserve normalized filters, reporting windows, listing scope and
sorting. Risk-board links preserve mechanism, multiple bands, coverage and sorting.
Link descriptions disclose settings the destination cannot reproduce. Clients receive
`platformLink` (`label`, `url`, `description`), `webPage`, readable Markdown and an MCP
`resource_link`; whether the assistant displays a link depends on the client.

Saved portfolio drafts link directly to the exact pending draft. Sign-in preserves
the destination, and accepting or discarding the draft remains your choice. Opening a
link never changes holdings.

Links carry fixed campaign labels and the originating tool name, without tokens,
account identity, portfolio values or free-text briefs. Website activity and completed
tool invocations are measured separately from upstream API requests. Run `npm test`
for the connector's URL, telemetry, authentication and integration checks, or
`npm run test:links` for focused handoff checks.

## Authentication & privacy

The server is an OAuth 2.0 protected resource (RFC 9728). On first connect your client runs an
automatic discovery handshake and sends you through Google sign-in; after you authorize, per-user
tools resolve your Bullrun account. The MCP layer is a thin proxy with no database of its own —
read tools return market data and your own holdings, the per-user read tools accept a `privacyMode`
(`full` by default, or `weights_only` to return only relative figures), and the draft tools never
mutate live holdings. See the [privacy policy](https://bull-run.org/privacy).

## Local stdio build

The hosted endpoint above is the recommended integration. For directories that require building
and running a local MCP server, this repo can run the MCP layer over stdio:

```bash
npm ci
npm run build
BULLRUN_API_BASE=https://bull-run.org node dist/stdio.js
```

Public market-data tools work without credentials. Portfolio and draft tools still require a
Bullrun OAuth token in hosted clients and return an authentication-required error in anonymous
stdio checks.

## License

[MIT](LICENSE).
