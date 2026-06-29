# Connect Bullrun to your AI client

Bullrun runs a hosted **remote MCP server** at:

```
https://mcp.bull-run.org/mcp
```

It speaks the **Streamable HTTP** transport and is an **OAuth 2.1 protected resource**.
The first time you connect, your client walks an automatic discovery handshake and sends you
through Google sign-in; after you authorize, the per-user portfolio tools resolve *your*
Bullrun account. Public market-data tools work for any connected user.

> No JSON editing required for Claude — paste the URL and click through the login. The configs
> below are for clients that connect via a file.

## What you can do once connected

- **Screen the global universe** — filter by sector / industry / country / market cap, sort by
  P/E, dividend yield, revenue or revenue growth (`screen_stocks`).
- **Pull a full company snapshot** — identity (ISIN/LEI/CIK), latest price, valuation,
  financials and a description for one ticker (`get_stock_metrics`), or 1–15 years of history
  (`get_financial_history`), quality/moat & capital-allocation metrics (`get_quality_moat_metrics`),
  forward estimates, operating KPIs, revenue breakdowns and earnings-call transcripts.
- **Search ETFs** — by ticker, fund name, category, focus, domicile (`query_etfs`).
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
