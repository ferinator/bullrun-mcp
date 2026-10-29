# Bullrun: Global Stock & UCITS ETF Research

Research global stocks and UCITS ETFs in Claude with [Bullrun](https://bull-run.org). Compare fund fees and holdings, or explore a company's financials, risks and valuation signals. The plugin includes Bullrun's public research connector and two research skills. Results show their dates and coverage limits. No account or API key is needed.

Find the [Bullrun research connector in Claude's directory](https://claude.ai/directory/11ba8b53-a2ec-4029-87d6-030719898503), or follow the [three-step setup guide](https://bull-run.org/connect-claude) for a custom connection. The same research server is also available through [Glama](https://glama.ai/mcp/connectors/org.bull-run/bullrun) and [Bullrun Research on mcprush](https://mcprush.com/bull-run/bullrun-research-mcp). The mcprush connection has its own plans and usage limits.

## Skills

- **ucits-etf-chooser**: finds every UCITS fund that tracks an index, ranked by disclosed fee with one row per fund rather than per exchange listing. It shows which ticker trades on your exchange and in your currency, checks overlap between funds, and illustrates fee drag over a holding period when you supply an amount and horizon.
- **company-deep-dive**: resolves a company or ISIN to the right listing, checks which datasets Bullrun holds, and then reads metrics, ten years of financials, quality and capital-allocation measures, Bullrun's model valuation gap, risk dials, supplier and customer relationships, and recent news. It ends in a dated summary with a required section on data gaps.

The connector's other research tools stay available for anything else: stock and ETF screens, price history, holdings look-through, corporate calendars, global markets and macro data.

## Install

In Claude Code 2.1.275 or later, install it from this repository's marketplace in one step:

```
/plugin install bullrun --marketplace ferinator/bullrun-mcp
```

On earlier versions, run `/plugin marketplace add ferinator/bullrun-mcp` first, then `/plugin install bullrun@bullrun`.

## Use it

Ask in plain language, for example:

- "What's the cheapest accumulating MSCI World UCITS ETF on Xetra, and do the top two overlap?"
- "Give me a deep dive on ASML with its main risks and suppliers."
- "Which exchanges list IE00B4L5Y983, and in which currencies?"

Claude loads the matching skill from your request. In Claude Code you can also run a skill directly, for example `/bullrun:company-deep-dive`.

## Connection

The plugin declares one remote MCP server, `https://mcp.bull-run.org/research/mcp`. It serves Bullrun's 39 read-only research tools and needs no account, API key or sign-in. Free use includes 700 successful tool calls per rolling 30 days, shared across official Bullrun connections by anonymous network. Each successful call counts once regardless of internal data reads; failed calls use no allowance. Temporary capacity limits and tool pacing may ask you to wait; follow the reply's retry guidance. This plugin has no portfolio, shortlist or other account tools, and it never writes anything. To use the Pro or active-trial allowance of 1,000 successful tool calls per rolling 5 hours, connect your account separately using the [setup guide](https://bull-run.org/mcp#mcp-connect).

## Data and privacy

The plugin contains only Markdown skills, this README, a license, an icon and the connector reference. It runs no code on your machine and fetches nothing else.

When Claude calls a Bullrun tool, the tool arguments (tickers, ISINs, search text, filters) go to `mcp.bull-run.org`, which reads only Bullrun's own database and calls no third-party service at request time. Bullrun uses the caller's IP address to apply the per-caller allowance. It records one analytics row per call (tool name, client name, outcome and number of reads), without the arguments or the results. No account data is involved. See the [privacy policy](https://bull-run.org/privacy).

## Coverage limits

Prices are stored daily closes, not live quotes. Financials keep their reporting currency, and listings keep their trading currency. Optional datasets (consensus estimates, operating KPIs, US-only call transcripts, relationship graphs) exist only for some companies. Bullrun's risk bands and model valuation gaps describe measured data; they are not price targets or buy or sell views.

## Support

Report problems at [github.com/ferinator/bullrun-mcp/issues](https://github.com/ferinator/bullrun-mcp/issues) or email bullrun-info@protonmail.com. The connector's full tool list is in the [repository README](https://github.com/ferinator/bullrun-mcp#readme).
