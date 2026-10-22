import assert from 'node:assert/strict'
import { test } from 'node:test'

// One slot makes the queue/deadline boundary explicit. No test sends network traffic.
process.env.MCP_SCREEN_CONCURRENCY = '1'
const { bullrunGet, bullrunPost } = await import('../dist/bullrun.js')
const { runWithGateway, getGateway } = await import('../dist/gateway/context.js')
const { runWithAuth } = await import('../dist/auth/context.js')
const { runWithMcpUsage } = await import('../dist/usage/context.js')
const { createGate, screenGate } = await import('../dist/usage/screenGate.js')

function clock(t) {
  let now = 1_000_000
  const timers = new Set()
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, at: now + delay }
    timers.add(timer)
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', timer => { timers.delete(timer) })
  return {
    timers,
    now: () => now,
    advance(ms, deliverTimers = true) {
      now += ms
      if (deliverTimers) {
        for (const timer of timers) {
          if (timer.at > now) continue
          timers.delete(timer)
          timer.callback()
        }
      }
    },
  }
}

function captureFetch(t) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: new URL(url), options, gateway: getGateway() })
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
  })
  return calls
}

function holdSlot(gate = screenGate) {
  let release
  const done = gate.run(() => new Promise(resolve => { release = resolve }))
  return { release, done }
}

const marketplace = (deadline, run) => runWithGateway({ listingId: 'deadline-test', installationId: 'buyer', deadline }, run)

test('a marketplace screen expires while queued and never sends its backend request', async t => {
  const time = clock(t)
  const calls = captureFetch(t)
  const holder = holdSlot()
  const deadline = time.now() + 1_000
  const pending = marketplace(deadline, () => bullrunPost('/api/screener/filter', {}))
  const outcome = pending.then(value => ({ value }), error => ({ error }))
  try {
    assert.equal(screenGate.waiting, 1)
    assert.deepEqual([...time.timers].map(timer => timer.delay), [1_000])
    time.advance(1_000)
    assert.match((await outcome).error?.message ?? '', /busy running other screens|deadline reached/)
    assert.equal(screenGate.waiting, 0)
    assert.equal(screenGate.active, 1, 'expiry does not release another request\'s slot')
    assert.equal(calls.length, 0)
  } finally {
    holder.release()
    await Promise.allSettled([holder.done, pending])
  }
  assert.equal(screenGate.active, 0)
  assert.equal(calls.length, 0, 'releasing the occupied slot cannot revive an expired screen')
})

test('a slot released after an overdue queue deadline skips expired work and serves the next waiter', async t => {
  const time = clock(t)
  const gate = createGate(1)
  const holder = holdSlot(gate)
  let ran = false
  const expired = gate.run(async () => { ran = true }, 1_000)
  const outcome = expired.then(value => ({ value }), error => ({ error }))
  const next = gate.run(async () => 'next', 5_000)
  try {
    // Model an event-loop stall: slot release runs before the overdue timer callback.
    time.advance(1_001, false)
    holder.release()
    assert.match((await outcome).error?.message ?? '', /busy running other screens/)
    assert.equal(await next, 'next')
    assert.equal(ran, false)
  } finally {
    holder.release()
    await Promise.allSettled([holder.done, expired, next])
  }
  assert.equal(gate.active, 0)
  assert.equal(gate.waiting, 0)
  assert.equal(time.timers.size, 0)
})

test('already-expired marketplace reads and posts are refused even when a slot is free', async t => {
  const time = clock(t)
  const calls = captureFetch(t)
  for (const request of [
    () => bullrunGet('/api/stocks/AAPL'),
    () => bullrunPost('/api/screener/filter', {}),
    () => bullrunPost('/api/etfs/screener', {}),
    () => bullrunPost('/api/analytics/mcp-tools', {}, 750),
  ]) {
    await marketplace(time.now(), () => assert.rejects(request(), /Marketplace research deadline reached/))
  }
  assert.equal(calls.length, 0)
  assert.equal(screenGate.active, 0)
  assert.equal(screenGate.waiting, 0)
})

test('a screen released before its deadline retains the waiting caller\'s identity', async t => {
  const time = clock(t)
  const calls = captureFetch(t)
  const holder = holdSlot()
  const deadline = time.now() + 5_000
  const pending = marketplace(deadline, () => runWithAuth({ token: 'test-caller', userId: 7, scopes: [] }, () =>
    runWithMcpUsage({ invocationId: 'waiting-call', toolName: 'screen_stocks' }, () =>
      bullrunPost('/api/screener/filter', { rules: [] }))))
  try {
    time.advance(1_000)
    assert.equal(calls.length, 0)
    holder.release()
    assert.deepEqual(await pending, { ok: true })
  } finally {
    holder.release()
    await Promise.allSettled([holder.done, pending])
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-caller')
  assert.equal(calls[0].options.headers['X-Bullrun-Mcp-Invocation'], 'waiting-call')
  assert.equal(calls[0].gateway.deadline, deadline)
  assert.equal(screenGate.active, 0)
  assert.equal(screenGate.waiting, 0)
  assert.equal(time.timers.size, 0)
})

test('a short analytics timeout does not shorten the gateway deadline for subsequent queued research', async t => {
  const time = clock(t)
  const calls = captureFetch(t)
  const deadline = time.now() + 10_000
  await marketplace(deadline, async () => {
    await bullrunPost('/api/analytics/mcp-tools', {}, 750)
    assert.equal(getGateway().deadline, deadline)
    const holder = holdSlot()
    const pending = bullrunPost('/api/etfs/screener', {}, 5_000)
    try {
      assert.deepEqual([...time.timers].map(timer => timer.delay), [10_000])
      time.advance(1_000)
      holder.release()
      assert.deepEqual(await pending, { ok: true })
      assert.equal(getGateway().deadline, deadline)
    } finally {
      holder.release()
      await Promise.allSettled([holder.done, pending])
    }
  })
  assert.deepEqual(calls.map(call => call.url.pathname), ['/api/analytics/mcp-tools', '/api/etfs/screener'])
  assert.equal(screenGate.active, 0)
  assert.equal(screenGate.waiting, 0)
})
