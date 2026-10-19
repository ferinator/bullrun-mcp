import assert from 'node:assert/strict';
import http from 'node:http';
import { before, after, test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

let api, historyTool, coverageTool, runWithAuth;
let mode = 'normal';
let calls = [];
const term = (key, rawValue) => ({ key, rawValue, mappedScore: 50, weight: 0.2,
  periodKey: 'FY2025', sourceTable: 'financials', excludedWhy: null,
  measurementClass: 'REPORTED', estimateBasis: null });
const changed = Array.from({length: 5}, (_, i) => ({termKey: `input${i}`,
  previous: term(`input${i}`, 0), current: term(`input${i}`, 10)}));

before(async () => {
  api = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    calls.push(url);
    const ticker = decodeURIComponent(url.pathname.split('/')[3] ?? '');
    res.setHeader('content-type', 'application/json');
    if (mode === 'error' || ticker === 'UNKNOWN') {
      res.statusCode = 404; return res.end(JSON.stringify({error: 'PRIVATE_SERVER_DETAIL'}));
    }
    const identity = mode === 'wrong-identity' ? 'OTHER' : ticker;
    if (url.pathname.endsWith('/data-coverage')) return res.end(JSON.stringify({
      ticker: identity, companyName: 'Example', checkedAt: '2026-10-18T12:00:00Z',
      datasets: [{dataset: 'financials', status: 'available', latestPeriod: 'FY2025',
        latestStoredAt: null, latestStoredLocalAt: '2026-10-17T03:00:00', storedAtMeaning: 'Local update time; timezone not recorded', notes: []},
      {dataset: 'prices', status: 'available', latestPeriod: '2026-10-16',
        latestStoredAt: '2026-10-17T01:00:00Z', storedAtMeaning: 'Stored price ingestion time', notes: []},
      {dataset: 'transcripts', status: 'not_stored', latestPeriod: null, latestStoredAt: null}],
      graph: {status: 'not_mapped'}, caveats: ['Coverage is partial'],
    }));
    const history = mode === 'empty' ? [] : [{asOfDate: '2026-10-16', dials: [{
      ticker, riskClass: 'LEVERAGE', score: 0, band: 'CONTAINED', formulaVersion: 'v1',
      computedAt: '2026-10-17T01:00:00Z', observationCoverage: 0.5,
      terms: [term('debt', 0)], change: null,
    }]}, {asOfDate: '2026-10-18', dials: [{
      ticker, riskClass: 'LEVERAGE', score: 25, band: 'NORMAL', formulaVersion: 'v2',
      computedAt: '2026-10-18T01:00:00Z', observationCoverage: 0.8,
      terms: [term('debt', 10)], explanation: 'Stored descriptive explanation',
      change: {previousAsOfDate: '2026-10-16', scoreDelta: 25, formulaChanged: true,
        coverageChanged: true, weightProfileChanged: false, peerGroupChanged: true,
        changedTermCount: 5, totalTermCount: 5, termChanges: changed,
        notes: ['Measurement basis changed']},
    }]}];
    const outputHistory = mode === 'large' ? Array.from({length: 6}, (_, index) => ({
      asOfDate: `2026-10-${String(10 + index).padStart(2, '0')}`,
      dials: Array.from({length: 10}, (_, category) => ({...history[1].dials[0],
        riskClass: `CATEGORY_${category}`, explanation: 'Stored risk explanation. '.repeat(8),
        terms: Array.from({length: 6}, (_, key) => term(`input${key}`, 10))})),
    })) : history;
    res.end(JSON.stringify({ticker: identity, companyName: 'Example', returnedDates: outputHistory.length,
      history: outputHistory, caveats: ['Retained dates only']}));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${api.address().port}`;
  const {registerGetCompanyRiskHistory} = await import('../dist/tools/getCompanyRiskHistory.js');
  const {registerGetCompanyDataCoverage} = await import('../dist/tools/getCompanyDataCoverage.js');
  ({runWithAuth} = await import('../dist/auth/context.js'));
  registerGetCompanyRiskHistory({registerTool(_name, _definition, callback) {historyTool = callback;}});
  registerGetCompanyDataCoverage({registerTool(_name, _definition, callback) {coverageTool = callback;}});
});
after(async () => {api.closeAllConnections(); await new Promise(resolve => api.close(resolve));});

test('risk history preserves zero readings, dates and basis changes while bounding summary inputs', async () => {
  mode = 'normal'; calls = [];
  const result = await historyTool({ticker: ' aapl ', limit: 6, detail: 'summary'});
  assert.ok(CallToolResultSchema.safeParse(result).success);
  const data = result.structuredContent;
  assert.equal(data.ticker, 'AAPL');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/api/stocks/AAPL/risk-history');
  assert.equal(calls[0].searchParams.get('limit'), '6');
  assert.equal(data.history[0].dials[0].score, 0);
  assert.equal(data.history[0].dials[0].change, null);
  const row = data.history[1].dials[0];
  assert.equal(row.formulaVersion, 'v2');
  assert.equal(row.change.formulaChanged, true);
  assert.equal(row.change.coverageChanged, true);
  assert.equal(row.change.peerGroupChanged, true);
  assert.equal(row.change.termChanges.length, 3);
  assert.equal(row.change.changedTermCount, 5);
  assert.equal(row.change.omittedTermChanges, 2);
  assert.equal(row.terms, undefined);
  assert.match(data.warnings.join(' '), /do not establish.*causal loss/);
});

test('full risk history preserves source terms and rejects excessive detail before upstream reads', async () => {
  mode = 'normal'; calls = [];
  const result = await historyTool({ticker: 'AAPL', limit: 2, detail: 'full'});
  const row = result.structuredContent.history[1].dials[0];
  assert.equal(row.terms[0].sourceTable, 'financials');
  assert.equal(row.terms[0].measurementClass, 'REPORTED');
  assert.equal(row.change.termChanges.length, 5);
  assert.equal(row.change.omittedTermChanges, 0);
  calls = [];
  assert.equal((await historyTool({ticker: 'AAPL', limit: 7, detail: 'full'})).isError, true);
  assert.equal(calls.length, 0);
});

test('coverage separates reporting periods, actual ingestion times, missing timestamps and absent datasets', async () => {
  mode = 'normal'; calls = [];
  const result = await coverageTool({ticker: ' aapl '});
  assert.ok(CallToolResultSchema.safeParse(result).success);
  const data = result.structuredContent;
  assert.equal(calls.length, 1, 'coverage must be one cheap summary lookup');
  assert.equal(calls[0].pathname, '/api/stocks/AAPL/data-coverage');
  assert.equal(data.datasets[0].latestStoredAt, null);
  assert.equal(data.datasets[0].latestStoredLocalAt, '2026-10-17T03:00:00');
  assert.equal(data.datasets[0].latestPeriod, 'FY2025');
  assert.equal(data.datasets[1].latestStoredAt, '2026-10-17T01:00:00Z');
  assert.equal(data.datasets[2].status, 'not_stored');
  assert.equal(data.graph.status, 'not_mapped');
  assert.match(data.warnings.join(' '), /manifest was read, not.*collected/);
});

test('realistic multi-category history fits the serialized marketplace budget and keeps the newest whole dates', async () => {
  mode = 'large';
  for (const detail of ['summary', 'full']) {
    const result = await historyTool({ticker: 'AAPL', limit: 6, detail});
    assert.equal(result.isError, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 200 * 1024);
    const data = result.structuredContent;
    assert.ok(data.omittedDatesForResponseBudget > 0);
    assert.equal(data.returnedDates + data.omittedDatesForResponseBudget, 6);
    assert.equal(data.history.at(-1).asOfDate, '2026-10-15');
    assert.equal(data.history[0].dials.length, 10, 'whole categories/dates must remain intact');
    assert.match(data.warnings.join(' '), /previousAsOfDate may refer to an omitted date/);
  }
});

test('empty history is explicit and wrong identities or upstream bodies cannot become research results', async () => {
  mode = 'empty';
  const empty = await historyTool({ticker: 'AAPL', limit: 6, detail: 'summary'});
  assert.equal(empty.structuredContent.status, 'not_stored');
  assert.deepEqual(empty.structuredContent.history, []);
  for (mode of ['wrong-identity', 'error']) {
    for (const result of [await historyTool({ticker: 'AAPL', limit: 6, detail: 'summary'}),
      await coverageTool({ticker: 'AAPL'})]) {
      assert.equal(result.isError, true);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SERVER_DETAIL/);
    }
  }
  mode = 'normal'; calls = [];
  for (const run of [() => coverageTool({ticker: 'AAPL'}),
    () => historyTool({ticker:'AAPL',limit:6,detail:'summary'})]) {
    const denied = await runWithAuth({token: 'unrelated', scopes: ['read:portfolios']}, run);
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /read:market/);
  }
  assert.equal(calls.length, 0);
});

test('SDK exposes safe defaults, read-only tools and validates limits before API requests', async () => {
  const server = new McpServer({name:'history-coverage-test',version:'1'});
  const {registerGetCompanyRiskHistory} = await import('../dist/tools/getCompanyRiskHistory.js');
  const {registerGetCompanyDataCoverage} = await import('../dist/tools/getCompanyDataCoverage.js');
  registerGetCompanyRiskHistory(server); registerGetCompanyDataCoverage(server);
  const client = new Client({name:'research-client',version:'1'});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    mode = 'normal'; calls = [];
    const {tools} = await client.listTools();
    assert.equal(tools.length, 2);
    assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
    const result = await client.callTool({name:'get_company_risk_history',arguments:{ticker:'aapl'}});
    assert.equal(result.structuredContent.requestedDates, 6);
    assert.equal(result.structuredContent.detail, 'summary');
    calls = [];
    const bad = await client.callTool({name:'get_company_risk_history',arguments:{ticker:'AAPL',limit:31}});
    assert.equal(bad.isError, true); assert.equal(calls.length, 0);
  } finally {await client.close(); await server.close();}
});
