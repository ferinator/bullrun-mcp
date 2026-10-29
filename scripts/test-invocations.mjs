import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordMcpToolInvocation } from '../dist/usage/invocations.js'
import { getMcpUsage, runWithMcpUsage } from '../dist/usage/context.js'
import { isProbeClient } from '../dist/usage/probes.js'
import { bullrunGet } from '../dist/bullrun.js'

test('concurrent callbacks keep distinct invocation context and report once each', async () => {
  const events = []
  const execute = tool => runWithMcpUsage({ sessionId: 'shared-session' }, () =>
    recordMcpToolInvocation(tool, async () => {
      const before = getMcpUsage()
      await Promise.resolve()
      assert.equal(getMcpUsage().invocationId, before.invocationId)
      assert.equal(getMcpUsage().toolName, tool)
      return { content: [], invocationId: before.invocationId }
    }, async event => { events.push(event) }))
  const results = await Promise.all([execute('first_tool'), execute('second_tool')])
  assert.equal(events.length, 2)
  assert.notEqual(results[0].invocationId, results[1].invocationId)
  assert.equal(events.every(event => event.outcome === 'success' && event.sessionId === 'shared-session'), true)
  assert.equal(getMcpUsage(), undefined)
})

test('tool errors and thrown exceptions retain their actual outcome', async () => {
  const events = []
  const reporter = async event => { events.push(event) }
  const result = await recordMcpToolInvocation('local_error', async () => ({ isError: true, content: [] }), reporter)
  assert.equal(result.isError, true)
  const original = new Error('tool failed')
  await assert.rejects(recordMcpToolInvocation('thrown_error', async () => { throw original }, reporter),
    error => error === original)
  assert.deepEqual(events.map(event => event.outcome), ['error', 'throw'])
})

test('telemetry failure cannot change success or mask a tool exception', async () => {
  const failingReporter = async () => { throw Error('analytics unavailable') }
  assert.equal(await recordMcpToolInvocation('success', async () => 42, failingReporter), 42)
  const original = new Error('original failure')
  await assert.rejects(recordMcpToolInvocation('failure', async () => { throw original }, failingReporter),
    error => error === original)
})

test('directory probes are recognised by their clientInfo name; real clients are not', () => {
  for (const name of ['agentstatus-probe', 'BrickBlueBot', 'rokmcp-probe', 'agent-finder-probe',
    'agent-collector', ' Agent-Collector ', 'FaceabotProbe', 'uptime-probe', 'MCP Healthcheck',
    'health-check'])
    assert.equal(isProbeClient(name), true, name)
  for (const name of [undefined, '', 'claude-ai', 'claude-code', 'mcp', 'cursor-vscode', 'openai-mcp',
    'bullrun-production-smoke', 'bullrun-release-check'])
    assert.equal(isProbeClient(name), false, String(name))
})

test('only a probe client\'s invocation carries the probe class', async () => {
  const classOf = client => recordMcpToolInvocation('tool', async () => getMcpUsage().clientClass,
    async () => {}, client)
  assert.equal(await classOf({ name: 'agentstatus-probe', version: '2.42.170' }), 'probe')
  assert.equal(await classOf({ name: 'claude-ai', version: '0.1.0' }), undefined)
  assert.equal(await classOf(undefined), undefined)
})

test('a failed call is filed as a limit, our fault or the caller\'s request', async t => {
  const events = []
  const reporter = async event => { events.push(event) }
  let answer
  t.mock.method(globalThis, 'fetch', async () => answer())
  const lookup = () => recordMcpToolInvocation('get_stock_metrics', async () => {
    try { await bullrunGet('/api/stocks/ZZZZ') } catch { return { isError: true, content: [] } }
    return { content: [] }
  }, reporter)
  const cases = [
    ['unknown ticker', () => Response.json({ error: 'not_found' }, { status: 404 }), 'caller'],
    ['backend fault', () => Response.json({ error: 'internal' }, { status: 500 }), 'tool'],
    ['busy backend', () => Response.json({ error: 'server_busy', message: 'busy' }, { status: 503 }), 'limit'],
    ['unreachable backend', () => { throw new TypeError('fetch failed') }, 'tool'],
    ['unreadable answer', () => new Response('not json', { status: 200 }), 'tool'],
  ]
  for (const [, respond] of cases) {
    answer = respond
    await lookup()
  }
  assert.deepEqual(events.map(event => event.failure), cases.map(([, , failure]) => failure))
  assert.equal(events.every(event => event.outcome === 'error'), true)

  events.length = 0
  await recordMcpToolInvocation('get_etf_fund', async () => ({ isError: true, content: [] }), reporter)
  await assert.rejects(recordMcpToolInvocation('get_etf_fund', async () => { throw Error('bug') }, reporter))
  await recordMcpToolInvocation('screen_stocks', async () => ({ content: [] }), reporter, undefined,
    { take: () => 30, perMinute: 6 })
  await recordMcpToolInvocation('get_etf_fund', async () => ({ content: [] }), reporter)
  assert.deepEqual(events.map(event => [event.outcome, event.failure]),
    [['error', 'caller'], ['throw', 'tool'], ['error', 'limit'], ['success', undefined]])
})
