/**
 * TDD tests for Google Calendar sync core.
 * Run with: node test/gcal-sync.test.js
 */

const assert = require('node:assert/strict');
const { parseDtstring, buildEventResource, createEvent, batchSync } = require('../src/gcal-sync');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  ✅ ${name}`);
        passed++;
      }).catch(err => {
        console.log(`  ❌ ${name}`);
        console.log(`     ${err.message}`);
        failed++;
      });
    }
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
  return Promise.resolve();
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEvent(n) {
  return {
    dtstart:    `20260407T09${String(n).padStart(2,'0')}00`,
    dtend:      `20260407T10${String(n).padStart(2,'0')}00`,
    summary:    `Vorlesung ${n}`,
    shortTitle: `Vorlesung ${n}`,
    fingerprint: `fp${n}`,
    moduleCode:  `M${n}`,
    location:    `Raum ${n}`,
    description: `Dozent: Prof. Test`,
  };
}

function makeEvents(count) {
  return Array.from({ length: count }, (_, i) => makeEvent(i + 1));
}

/** Mock fetch that always succeeds */
function successFetch() {
  let calls = 0;
  const fn = async (url, opts) => {
    calls++;
    const body = opts?.body ? JSON.parse(opts.body) : {};
    return { status: 200, json: async () => ({ id: `evt_${calls}`, summary: body.summary }) };
  };
  fn.calls = () => calls;
  return fn;
}

/** Mock fetch: returns 429 for the first `n` calls, then succeeds */
function rateLimitedFetch(failFirstN) {
  let calls = 0;
  const fn = async (url, opts) => {
    calls++;
    if (calls <= failFirstN) {
      return { status: 429, json: async () => ({ error: 'rateLimitExceeded' }) };
    }
    const body = opts?.body ? JSON.parse(opts.body) : {};
    return { status: 200, json: async () => ({ id: `evt_${calls}`, summary: body.summary }) };
  };
  fn.calls = () => calls;
  return fn;
}

/** Mock fetch that always fails with 429 */
function alwaysRateLimitFetch() {
  return async () => ({ status: 429, json: async () => ({ error: 'rateLimitExceeded' }) });
}

// ── parseDtstring ──────────────────────────────────────────────────────────────

console.log('\nparseDtstring');

test('parses valid datetime string', () => {
  const d = parseDtstring('20260407T094500');
  assert.ok(d instanceof Date);
  assert.equal(d.getUTCHours(), 9);
  assert.equal(d.getUTCMinutes(), 45);
  assert.equal(d.getUTCDate(), 7);
  assert.equal(d.getUTCMonth(), 3); // April = 3
});

test('returns null for null input', () => {
  assert.equal(parseDtstring(null), null);
});

test('returns null for invalid string', () => {
  assert.equal(parseDtstring('not-a-date'), null);
});

// ── buildEventResource ─────────────────────────────────────────────────────────

console.log('\nbuildEventResource');

test('title has no [MSH] prefix or any tag', () => {
  const e       = makeEvent(1);
  const start   = parseDtstring(e.dtstart);
  const end     = parseDtstring(e.dtend);
  const resource = buildEventResource(e, start, end);
  assert.ok(!resource.summary.includes('['), `summary should have no brackets: "${resource.summary}"`);
  assert.equal(resource.summary, 'Vorlesung 1');
});

test('description includes dashboard link', () => {
  const e       = makeEvent(1);
  const resource = buildEventResource(e, parseDtstring(e.dtstart), parseDtstring(e.dtend));
  assert.ok(
    resource.description.includes('trainex-sync') || resource.description.includes('Änderungen'),
    'description should reference the dashboard'
  );
});

test('description includes Dozent from event description', () => {
  const e       = makeEvent(1);
  const resource = buildEventResource(e, parseDtstring(e.dtstart), parseDtstring(e.dtend));
  assert.ok(resource.description.includes('Prof. Test'));
});

test('location includes room', () => {
  const e       = makeEvent(1);
  const resource = buildEventResource(e, parseDtstring(e.dtstart), parseDtstring(e.dtend));
  assert.ok(resource.location.includes('Raum 1'));
});

test('extendedProperties mshSync=1', () => {
  const e       = makeEvent(1);
  const resource = buildEventResource(e, parseDtstring(e.dtstart), parseDtstring(e.dtend));
  assert.equal(resource.extendedProperties.private.mshSync, '1');
});

// ── createEvent (single event with retry) ─────────────────────────────────────

console.log('\ncreateEvent');

const tests = [];

tests.push(test('creates event on first attempt', async () => {
  const fetch  = successFetch();
  const id     = await createEvent('primary', { summary: 'Test' }, fetch, { baseDelayMs: 10 });
  assert.ok(id, 'should return an event id');
  assert.equal(fetch.calls(), 1);
}));

tests.push(test('retries on 429 and eventually succeeds', async () => {
  const fetch = rateLimitedFetch(2); // fails first 2, succeeds on 3rd
  const id    = await createEvent('primary', { summary: 'Test' }, fetch, { maxRetries: 4, baseDelayMs: 10 });
  assert.ok(id, 'should succeed after retries');
  assert.equal(fetch.calls(), 3, 'should have made exactly 3 calls');
}));

tests.push(test('returns null after exhausting retries on persistent 429', async () => {
  const fetch = alwaysRateLimitFetch();
  const id    = await createEvent('primary', { summary: 'Test' }, fetch, { maxRetries: 2, baseDelayMs: 10 });
  assert.equal(id, null, 'should give up and return null');
}));

tests.push(test('returns null for 401 without retrying', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return { status: 401, json: async () => ({}) }; };
  const id    = await createEvent('primary', { summary: 'Test' }, fetch, { maxRetries: 3, baseDelayMs: 10 });
  assert.equal(id, null);
  assert.equal(calls, 1, '401 should not be retried');
}));

// ── batchSync (185 events) ─────────────────────────────────────────────────────

console.log('\nbatchSync');

tests.push(test('syncs all 185 events with no rate limiting', async () => {
  const events = makeEvents(185);
  const fetch  = successFetch();
  const synced = await batchSync(events, 'primary', fetch, { batchSize: 8, batchDelayMs: 0 });
  assert.equal(synced.length, 185, `expected 185 synced, got ${synced.length}`);
}));

tests.push(test('syncs all 185 events despite early 429s', async () => {
  const events = makeEvents(185);
  // Fail first 20 calls, then succeed — simulates initial rate limit burst
  const fetch  = rateLimitedFetch(20);
  const synced = await batchSync(events, 'primary', fetch, {
    batchSize: 8,
    batchDelayMs: 0,
    // fast retries for test
  });
  // All 185 should eventually succeed once rate limit clears
  assert.equal(synced.length, 185, `expected 185 synced, got ${synced.length}`);
}));

tests.push(test('progress callbacks report correct totals', async () => {
  const events    = makeEvents(20);
  const fetch     = successFetch();
  const progress  = [];
  await batchSync(events, 'primary', fetch, {
    batchSize: 5,
    batchDelayMs: 0,
    onProgress: (p) => progress.push(p),
  });
  const last = progress[progress.length - 1];
  assert.equal(last.total, 20);
  assert.equal(last.done, 20);
}));

tests.push(test('fingerprints preserved in synced results', async () => {
  const events = makeEvents(5);
  const fetch  = successFetch();
  const synced = await batchSync(events, 'primary', fetch, { batchSize: 5, batchDelayMs: 0 });
  const fps    = synced.map(s => s.fingerprint).sort();
  assert.deepEqual(fps, ['fp1', 'fp2', 'fp3', 'fp4', 'fp5']);
}));

tests.push(test('skips events with invalid dtstart/dtend', async () => {
  const events = [
    makeEvent(1),
    { ...makeEvent(2), dtstart: 'INVALID', dtend: 'INVALID' },
    makeEvent(3),
  ];
  const fetch  = successFetch();
  const synced = await batchSync(events, 'primary', fetch, { batchSize: 5, batchDelayMs: 0 });
  assert.equal(synced.length, 2, 'should skip the invalid event');
}));

// ── Sequential sync (progress shows created count, not just attempted) ─────────

console.log('\nsequential sync (progress accuracy)');

tests.push(test('progress created count never exceeds attempted count', async () => {
  const events   = makeEvents(20);
  const fetch    = rateLimitedFetch(5); // first 5 fail
  const progress = [];
  const synced   = await batchSync(events, 'primary', fetch, {
    batchSize: 1, batchDelayMs: 0, onProgress: (p) => progress.push({ ...p }),
  });
  for (const p of progress) {
    assert.ok(p.synced <= p.done, `synced (${p.synced}) should never exceed attempted (${p.done})`);
  }
  assert.equal(progress[progress.length - 1].done, 20);
}));

tests.push(test('reports 0 created when all events fail', async () => {
  const events  = makeEvents(5);
  const synced  = await batchSync(events, 'primary', alwaysRateLimitFetch(), {
    batchSize: 1, batchDelayMs: 0,
  });
  assert.equal(synced.length, 0);
}));

// ── Run all async tests ────────────────────────────────────────────────────────

Promise.all(tests).then(() => {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
});
