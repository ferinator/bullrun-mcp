# Bullrun MCP

A hosted **remote [MCP](https://modelcontextprotocol.io) server** that turns Claude (and other
MCP clients) into a research analyst over global stocks, ETFs and your own portfolios.

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
