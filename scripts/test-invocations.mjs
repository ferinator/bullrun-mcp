import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordMcpToolInvocation } from '../dist/usage/invocations.js'
import { getMcpUsage, runWithMcpUsage } from '../dist/usage/context.js'

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
