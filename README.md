# Bullrun MCP

A hosted **remote [MCP](https://modelcontextprotocol.io) server** that turns Claude (and other
MCP clients) into a stock-research analyst over global market data and your own portfolios.

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
| `search_etfs` | Discover ETFs by listing, classification, index, distribution policy, AUM, expense ratio and yield, with explicit scan coverage. |
| `get_etf_snapshot` | Modular identity, classification, market, fund-data, cost, income and benchmark snapshot for one ETF listing. |
| `get_etf_timeseries` | Daily/weekly/monthly price and price-return history; unsupported NAV and total-return series are reported explicitly. |
| `get_etf_holdings` | Latest stored holdings with cursor pagination, covered weight and completeness assessment. |
| `get_etf_exposures` | Holdings-derived sector, country, currency and asset exposure with resolution and weight coverage. |
| `get_etf_risk` | Close-price drawdown, volatility, ratios and optional benchmark-relative risk. |
| `compare_etfs` | Normalized side-by-side comparison across fund structure, costs, performance, risk and holdings. |
| `analyze_etf_overlap` | Pairwise weighted overlap, economic similarity and price-behavior similarity with a separate confidence score. |
| `analyze_portfolio_fit` | Signed-in portfolio versus candidate ETF using price history and holdings look-through. *(sign-in)* |
| `simulate_etf_cost` | Expense, spread, commission and recurring-contribution cost simulation. |
| `query_etfs` | Compatibility search/profile tool; new clients should prefer the focused ETF tools above. |
| `list_portfolios` | Your virtual portfolios with value, day change, cost basis and total return. *(sign-in)* |
| `get_portfolio_context` | Deep snapshot of one portfolio: every holding with weight, sector and return, plus Bullrun's insights. *(sign-in)* |
| `get_portfolio_analytics` | Correlation/covariance, contribution-to-risk, factor exposure, sector/currency/country concentration, stress scenarios, and candidate-fit analysis. *(sign-in)* |
| `create_portfolio_draft` | Draft a new paper portfolio from a plain-English brief. **Draft-only** — saved for review, never changes a live position. *(Pro)* |
| `create_position_draft` | Suggest additions to an existing portfolio. **Draft-only** — saved for review. *(Pro)* |

ETF results carry explicit coverage and warning fields. Historical NAV, distribution-adjusted
total return, premium/discount, factor and thematic series are not synthesized when their source
data is unavailable. Partial holdings make overlap and look-through figures lower bounds, while
risk and behavior metrics are labeled as close-price returns.

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
