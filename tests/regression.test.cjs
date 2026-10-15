const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function vscodeMock() {
  return {
    env: { language: 'en' },
    window: { createOutputChannel: () => ({ appendLine() {} }) },
    workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
    l10n: { t: (s, ...args) => s.replace(/\{(\d+)\}/g, (_, n) => args[n]) },
  };
}
function load(name, mocks = {}, vscode = vscodeMock(), timers = {}) {
  const exports = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'out', `${name}.js`), 'utf8'), {
    exports, require: key => key === 'vscode' ? vscode : key in mocks ? mocks[key] : key.startsWith('./') ? load(key.slice(2), mocks, vscode, timers) : require(key),
    Date, Buffer, URL, setTimeout, clearTimeout, ...timers,
  }, { filename: `${name}.js` });
  return exports;
}
function event(timestamp, model = 'model') {
  return { timestamp, model, kind: 'INCLUDED', inputTokens: 10, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10, totalCents: 0 };
}
function snapshot(overrides = {}) {
  return { timestamp: new Date(), accountId: 'test', membershipType: 'pro',
    billingCycleStart: '2026-09-01T00:00:00Z', billingCycleEnd: '2026-10-01T00:00:00Z',
    isUnlimited: false, displayMode: 'pools', cursorModelsPercent: null, otherModelsPercent: null,
    totalPercent: null, overallUsedCents: null, overallLimitCents: null, onDemandEnabled: false,
    onDemandUsedCents: null, onDemandLimitCents: null,
    events: [], eventsComplete: false, aggregations: [], totalTokens: 0, ...overrides };
}
function success(value = snapshot(), overrides = {}) {
  return { snapshot: value, error: null, eventsError: false, aggError: false, ...overrides };
}
function trackerFixture(results, timers) {
  let calls = [];
  const { UsageTracker } = load('tracker', { './api': { fetchUsage: full => {
    calls.push(full);
    const next = results.shift();
    if (typeof next === 'function') return next(full);
    return Promise.resolve(next);
  } } }, undefined, timers);
  return { tracker: new UsageTracker(), calls };
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('completed polls release their lock; manual refresh works without a scheduler', async () => {
  const { tracker, calls } = trackerFixture([success(), success(), success()]);
  assert.equal(await tracker.poll(), true);
  assert.equal(await tracker.poll(), true);
  assert.equal(await tracker.poll(true, { fullEvents: true }), true);
  assert.deepEqual(calls, [false, false, true]);
});
test('details refresh waits for in-flight polling and performs full fetch', async () => {
  const pending = deferred();
  const { tracker, calls } = trackerFixture([() => pending.promise, success(), success()]);
  const initial = tracker.poll();
  assert.equal(await tracker.poll(), false);
  const details = tracker.poll(true, { fullEvents: true });
  const second = tracker.poll(true, { fullEvents: true });
  assert.deepEqual(calls, [false]);
  pending.resolve(success());
  assert.deepEqual(await Promise.all([initial, details, second]), [true, true, true]);
  assert.deepEqual(calls, [false, true, true]);
});
test('failure and rejection release the lock and update backoff; recovery clears errors', async () => {
  const { tracker } = trackerFixture([() => Promise.reject(new Error('offline')), success()]);
  assert.equal(await tracker.poll(), false);
  assert.equal(tracker.consecutiveFailures, 1);
  assert.equal(tracker.lastError, 'Failed to fetch usage');
  assert.equal(await tracker.poll(true), true);
  assert.equal(tracker.consecutiveFailures, 0);
  assert.equal(tracker.lastError, null);
});
test('timeout is cleared after success and a timed-out poll can recover', async () => {
  let timeoutCallback;
  let cleared = 0;
  const { tracker } = trackerFixture([() => new Promise(() => {}), success()], {
    setTimeout: callback => { timeoutCallback = callback; return 1; }, clearTimeout: () => cleared++,
  });
  const pending = tracker.poll();
  timeoutCallback();
  assert.equal(await pending, false);
  assert.match(tracker.lastError, /Timed out/);
  assert.equal(await tracker.poll(), true);
  assert.equal(cleared, 2);
});
for (const change of [{ billingCycleStart: '2026-10-01T00:00:00Z' }, { accountId: 'another' }]) {
  test(`history and alert baseline reset on ${Object.keys(change)[0]} change`, async () => {
    const { tracker } = trackerFixture([success(snapshot({ events: [event(1)], eventsComplete: true })),
      success(snapshot({ ...change, events: [] }))]);
    let alerts = [];
    tracker.onAlert = a => alerts.push(...a);
    await tracker.poll(); await tracker.poll();
    assert.equal(tracker.lastSnapshot.events.length, 0);
    assert.equal(tracker.lastSnapshot.eventsComplete, false);
    assert.equal(alerts.length, 0);
  });
}
test('lite merge retains history, updates overlapping events and preserves duplicate counts', async () => {
  const { tracker } = trackerFixture([
    success(snapshot({ events: [event(2), event(2), event(1)], eventsComplete: true })),
    success(snapshot({ events: [event(3), { ...event(2), totalTokens: 20 }, event(2)] })),
  ]);
  await tracker.poll(); await tracker.poll();
  const snap = tracker.lastSnapshot;
  assert.deepEqual(Array.from(snap.events, e => e.timestamp), [3, 2, 2, 1]);
  assert.equal(snap.events[1].totalTokens, 20);
  assert.equal(snap.eventsComplete, true);
});
test('lack of overlap and failed full fetches cannot claim complete history', async () => {
  const { tracker } = trackerFixture([
    success(snapshot({ events: [event(1)], eventsComplete: true })),
    success(snapshot({ events: [event(200)] })),
    success(snapshot({ events: [] }), { eventsError: true }),
  ]);
  await tracker.poll(); await tracker.poll();
  assert.equal(tracker.lastSnapshot.eventsComplete, false);
  await tracker.poll(true, { fullEvents: true });
  assert.equal(tracker.lastSnapshot.events.length, 2);
  assert.equal(tracker.lastSnapshot.eventsComplete, false);
  assert.match(tracker.dataWarning, /incomplete/);
});
test('background polling alerts on new requests, but full history and repeated polls do not', async () => {
  const { tracker } = trackerFixture([
    success(snapshot({ events: [event(10)] })),
    success(snapshot({ events: [event(12), event(11), event(10)] })),
    success(snapshot({ events: [event(12), event(11), event(10), event(9), event(8)], eventsComplete: true })),
    success(snapshot({ events: [event(12), event(11)] })),
  ]);
  const alerts = [];
  tracker.onAlert = a => alerts.push(...a);
  await tracker.poll(); await tracker.poll();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'newSession');
  assert.equal(alerts[0].delta, 2);
  await tracker.poll(true, { fullEvents: true }); await tracker.poll();
  assert.equal(alerts.length, 1);
});
test('event failure and recovery do not send misleading request alerts', async () => {
  const { tracker } = trackerFixture([
    success(snapshot({ events: [event(1)] })),
    success(snapshot(), { eventsError: true }),
    success(snapshot({ events: [event(4), event(3), event(2)] })),
  ]);
  const alerts = [];
  tracker.onAlert = a => alerts.push(...a);
  await tracker.poll(); await tracker.poll(); await tracker.poll();
  assert.equal(alerts.length, 0);
});
test('aggregation failure preserves cached totals; errors state cache age', async () => {
  const { tracker } = trackerFixture([
    success(snapshot({ totalTokens: 500, aggregations: [{ model: 'model', totalTokens: 500 }] })),
    success(snapshot({ totalTokens: 10 }), { aggError: true }),
    { snapshot: null, error: 'offline', eventsError: false, aggError: false },
  ]);
  await tracker.poll(); await tracker.poll();
  assert.equal(tracker.lastSnapshot.totalTokens, 500);
  assert.equal(tracker.lastSnapshot.aggregations.length, 1);
  assert.match(tracker.dataWarning, /outdated/);
  await tracker.poll();
  assert.match(tracker.dataWarning, /offline.*Showing cached usage/);
});

function apiFixture(pageResponse) {
  const calls = [];
  const https = { request(options, callback) {
    const req = new EventEmitter();
    let body = '';
    req.setTimeout = () => req;
    req.write = chunk => { body += chunk; };
    req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const data = body ? JSON.parse(body) : {};
      calls.push({ path: options.path, data });
      const value = options.path.endsWith('usage-summary') ? { billingCycleStart: '2026-09-01T00:00:00Z' }
        : options.path.includes('aggregated') ? { aggregations: [] } : pageResponse(data.page);
      const res = new EventEmitter();
      res.statusCode = 200;
      res.resume = () => {};
      callback(res);
      res.emit('data', Buffer.from(JSON.stringify(value)));
      res.emit('end');
    });
    return req;
  } };
  const api = load('api', { https, './credentials': { isAutoReadEnabled: () => false } });
  api.initSecretStorage({ get: async () => 'user_12345678901234567890%3A%3Atest' });
  return { api, calls };
}
const rows = count => Array.from({ length: count }, (_, i) => ({ timestamp: i + 1, tokenUsage: { inputTokens: 1 } }));
test('API reports page failure as partial data and an event error', async () => {
  const { api } = apiFixture(page => page === 1 ? { usageEventsDisplay: rows(100), totalUsageEventsCount: 200 } : null);
  const result = await api.fetchUsage(true);
  assert.equal(result.snapshot.events.length, 100);
  assert.equal(result.snapshot.eventsComplete, false);
  assert.equal(result.eventsError, true);
});
test('API first-page failure is incomplete, while an empty successful cycle is complete', async () => {
  let result = await apiFixture(() => null).api.fetchUsage(true);
  assert.equal(result.eventsError, true);
  assert.equal(result.snapshot.eventsComplete, false);
  result = await apiFixture(() => ({ usageEventsDisplay: [], totalUsageEventsCount: 0 })).api.fetchUsage(false);
  assert.equal(result.eventsError, false);
  assert.equal(result.snapshot.eventsComplete, true);
});
test('API full pagination completes and lite request remains incomplete', async () => {
  const f = apiFixture(page => ({ usageEventsDisplay: rows(page === 1 ? 100 : 50), totalUsageEventsCount: 150 }));
  const full = await f.api.fetchUsage(true);
  assert.equal(full.snapshot.events.length, 150);
  assert.equal(full.snapshot.eventsComplete, true);
  const lite = await f.api.fetchUsage(false);
  assert.equal(lite.snapshot.events.length, 100);
  assert.equal(lite.snapshot.eventsComplete, false);
});
test('API page cap is explicitly incomplete', async () => {
  const { api, calls } = apiFixture(() => ({ usageEventsDisplay: rows(100), totalUsageEventsCount: 3100 }));
  const result = await api.fetchUsage(true);
  assert.equal(result.snapshot.events.length, 3000);
  assert.equal(result.snapshot.eventsComplete, false);
  assert.equal(calls.filter(c => c.path.includes('filtered')).length, 30);
});

function panelFixture({ snap = snapshot(), config = {}, storage } = {}) {
  const vscode = vscodeMock();
  vscode.workspace.getConfiguration = () => ({ get: (key, fallback) => config[key] ?? fallback });
  const helpers = { formatCents: String, formatEventTime: String, formatPct: String,
    formatEventCost: (cents) => (cents === null || cents === 0) ? "API did not return a cost" : String(cents),
    formatTokens: String, isZh: () => false, membershipLabel: String, shortenModel: String };
  const { UsagePanel } = load('panel', { './treeView': helpers }, vscode);
  const posted = [];
  let receive;
  const view = { webview: { html: '', postMessage: m => posted.push(m), onDidReceiveMessage(callback) { receive = callback; } }, onDidDispose() {} };
  let error = 'offline <example>';
  const panel = new UsagePanel(view, () => snap, () => error, () => {}, undefined, storage);
  return { panel, view, posted, receive, recover: () => { error = null; } };
}
test('panel shows cached-data errors and incomplete history and receives failure/recovery updates', () => {
  const { panel, view, posted, recover } = panelFixture();
  assert.match(view.webview.html, /offline &lt;example&gt;/);
  assert.match(view.webview.html, /Usage history is incomplete/);
  panel.updateStatus(false);
  assert.equal(posted[0].error, 'offline <example>');
  recover(); panel.updateStatus(true);
  assert.equal(posted[1].error, null);
  assert.equal(posted[1].stale, true);
  // Execute the actual webview listener to verify the visible banner changes safely.
  const script = view.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const elements = { 'stale-banner': { hidden: true }, 'error-banner': { hidden: false } };
  let listener;
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({}), window: { addEventListener: (_, cb) => { listener = cb; } },
    document: { getElementById: id => elements[id], querySelectorAll: () => [] },
  });
  listener({ data: posted[0] });
  assert.equal(elements['error-banner'].textContent, 'offline <example>');
  assert.equal(elements['error-banner'].hidden, false);
  listener({ data: posted[1] });
  assert.equal(elements['error-banner'].hidden, true);
  assert.equal(elements['stale-banner'].hidden, false);
});

test('status bar warns about stale data and clears warning after recovery', async () => {
  const vscode = vscodeMock();
  const bar = { show() {}, hide() {}, dispose() {} };
  vscode.StatusBarAlignment = { Left: 1, Right: 2 };
  vscode.ThemeColor = class { constructor(id) { this.id = id; } };
  vscode.window.createStatusBarItem = () => bar;
  vscode.window.onDidChangeWindowState = () => ({});
  vscode.workspace.onDidChangeConfiguration = () => ({});
  vscode.commands = { registerCommand: () => ({}) };
  const updates = [];
  let tracker;
  class Tracker {
    constructor() {
      tracker = this;
      this.lastSnapshot = snapshot({ cursorModelsPercent: 20 });
      this.lastError = null;
      this.dataWarning = null;
      this.consecutiveFailures = 0;
    }
    async poll() { return true; }
  }
  const extension = load('extension', {
    './api': { initSecretStorage() {} }, './credentials': { setAutoReadEnabled() {} },
    './tracker': { UsageTracker: Tracker },
    './panel': { UsagePanel: { current: { updateStatus: stale => updates.push(stale) } } },
    './treeView': { formatPct: String, formatTokens: String, membershipLabel: String },
  }, vscode, { setTimeout: () => 1, clearTimeout() {} });
  extension.activate({ secrets: {}, subscriptions: [], globalState: { get: () => 'denied' } });
  await new Promise(resolve => setImmediate(resolve));
  tracker.lastError = 'offline';
  tracker.dataWarning = 'offline; Showing cached usage';
  tracker.onUpdate();
  assert.match(bar.text, /\$\(warning\)/);
  assert.match(bar.tooltip, /Showing cached usage/);
  assert.equal(bar.backgroundColor.id, 'statusBarItem.warningBackground');
  assert.equal(updates.at(-1), false);
  tracker.lastError = null;
  tracker.dataWarning = null;
  tracker.onUpdate();
  assert.doesNotMatch(bar.text, /warning/);
  assert.doesNotMatch(bar.tooltip, /cached/);
  assert.equal(bar.backgroundColor, undefined);
  assert.equal(updates.at(-1), true);
  extension.deactivate();
});

function memoryState() {
  const state = new Map();
  return { get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
    update: async (key, value) => { state.set(key, value); }, state };
}
test('budget milestones fire once at 50/80/100 and survive reloads', async () => {
  const { BudgetMonitor } = load('budget');
  const storage = memoryState();
  let monitor = new BudgetMonitor(storage);
  const usage = cents => snapshot({ onDemandUsedCents: cents });
  assert.equal(await monitor.check(usage(4900), 100, 'onDemand'), null);
  assert.equal((await monitor.check(usage(5000), 100, 'onDemand')).milestone, 50);
  monitor = new BudgetMonitor(storage);
  assert.equal(await monitor.check(usage(6000), 100, 'onDemand'), null);
  assert.equal((await monitor.check(usage(8000), 100, 'onDemand')).milestone, 80);
  assert.equal((await monitor.check(usage(11000), 100, 'onDemand')).milestone, 100);
  assert.equal(await monitor.check(usage(12000), 100, 'onDemand'), null);
  assert.equal(await monitor.check(usage(6000), 100, 'onDemand'), null);
});
test('budget jump emits only highest reached milestone, including concurrent checks', async () => {
  const { BudgetMonitor } = load('budget');
  const monitor = new BudgetMonitor(memoryState());
  const usage = snapshot({ onDemandUsedCents: 11000 });
  const notices = await Promise.all([monitor.check(usage, 100, 'onDemand'), monitor.check(usage, 100, 'onDemand')]);
  assert.equal(notices.filter(Boolean).length, 1);
  assert.equal(notices[0].milestone, 100);
});
test('budget basis stays separate; missing money and disabled budgets never alert', async () => {
  const { BudgetMonitor, budgetProgress } = load('budget');
  const monitor = new BudgetMonitor(memoryState());
  const usage = snapshot({ onDemandUsedCents: 2000, overallUsedCents: 9000 });
  assert.equal(budgetProgress(usage, 100, 'onDemand').percent, 20);
  assert.equal(budgetProgress(usage, 100, 'included').percent, 90);
  assert.equal(await monitor.check(usage, 100, 'onDemand'), null);
  assert.equal((await monitor.check(usage, 100, 'included')).milestone, 80);
  for (const amount of [0, -1, NaN, Infinity]) assert.equal(await monitor.check(usage, amount, 'included'), null);
  assert.equal(await monitor.check(snapshot(), 100, 'onDemand'), null);
  assert.equal(await monitor.check(snapshot({ onDemandUsedCents: NaN }), 100, 'onDemand'), null);
});
test('budget scope resets for cycle, account, amount and metric; storage contains no raw account ID', async () => {
  const { BudgetMonitor } = load('budget');
  const storage = memoryState();
  const monitor = new BudgetMonitor(storage);
  const usage = snapshot({ accountId: 'private-account', onDemandUsedCents: 10000, overallUsedCents: 10000 });
  for (const [snap, amount, metric] of [
    [usage, 100, 'onDemand'], [usage, 200, 'onDemand'], [usage, 100, 'included'],
    [{ ...usage, accountId: 'other-account' }, 100, 'onDemand'],
    [{ ...usage, billingCycleStart: '2026-10-01T00:00:00Z', billingCycleEnd: '2026-11-01T00:00:00Z' }, 100, 'onDemand'],
  ]) assert.ok(await monitor.check(snap, amount, metric));
  assert.doesNotMatch(JSON.stringify([...storage.state]), /private-account|other-account/);
  assert.equal(await monitor.check({ ...usage, billingCycleStart: '' }, 100, 'onDemand'), null);
  assert.equal(await monitor.check({ ...usage, billingCycleEnd: usage.billingCycleStart }, 100, 'onDemand'), null);
});
test('failed budget-state persistence can retry without consuming the milestone', async () => {
  const { BudgetMonitor } = load('budget');
  const storage = memoryState();
  const update = storage.update;
  storage.update = async () => { throw new Error('disk'); };
  const monitor = new BudgetMonitor(storage);
  const usage = snapshot({ onDemandUsedCents: 5000 });
  await assert.rejects(monitor.check(usage, 100, 'onDemand'), /disk/);
  storage.update = update;
  assert.equal((await monitor.check(usage, 100, 'onDemand')).milestone, 50);
});
test('pool milestones alert each included pool once and ignore a missing percent', async () => {
  const { BudgetMonitor } = load('budget');
  const storage = memoryState();
  let monitor = new BudgetMonitor(storage);
  const usage = snapshot({ cursorModelsPercent: 12.3, otherModelsPercent: 95.9 });
  const first = await monitor.checkPools(usage);
  assert.equal(first.length, 1);
  assert.equal(first[0].pool, 'otherModels');
  assert.equal(first[0].milestone, 80);
  monitor = new BudgetMonitor(storage);
  assert.equal((await monitor.checkPools(usage)).length, 0);
  const both = await monitor.checkPools(snapshot({ cursorModelsPercent: 100, otherModelsPercent: 96 }));
  assert.equal(both.length, 1);
  assert.equal(both[0].pool, 'cursorModels');
  assert.equal(both[0].milestone, 100);
  assert.equal((await monitor.checkPools(snapshot({ cursorModelsPercent: 10 }))).length, 0);
  assert.equal((await monitor.checkPools(snapshot({ isUnlimited: true, cursorModelsPercent: 100, otherModelsPercent: 100 }))).length, 0);
  assert.equal((await monitor.checkPools(snapshot({ cursorModelsPercent: null, otherModelsPercent: 49 }))).length, 0);
  const dollar = await monitor.check(snapshot({ cursorModelsPercent: 100, onDemandUsedCents: 5000 }), 100, 'onDemand');
  assert.equal(dollar.milestone, 50);
  const enterprise = await monitor.checkPools(snapshot({
    displayMode: 'overall', overallUsedCents: 8000, overallLimitCents: 10000,
  }));
  assert.equal(enterprise.length, 1);
  assert.equal(enterprise[0].pool, 'included');
  assert.equal(enterprise[0].milestone, 80);
  const mixed = await monitor.checkPools(snapshot({
    displayMode: 'overall', overallUsedCents: 9600, overallLimitCents: 10000,
    cursorModelsPercent: 90, otherModelsPercent: 10,
  }));
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].pool, 'cursorModels');
});
test('today respects local midnight, second timestamps, billing cycle and top-model ordering', () => {
  const { summarizeToday } = load('today');
  const now = new Date(2026, 8, 10, 18, 0);
  const midnight = new Date(2026, 8, 10).getTime();
  const usage = snapshot({ timestamp: now, billingCycleStart: new Date(2026, 8, 1).toISOString(), eventsComplete: true,
    events: [event(midnight - 1), { ...event(midnight / 1000, 'a'), totalTokens: 20, totalCents: 10 },
      { ...event(midnight + 3600000, 'b'), totalTokens: 50, totalCents: 20 }, event(now.getTime() + 1)] });
  const today = summarizeToday(usage, now);
  assert.equal(today.requests, 2);
  assert.equal(today.tokens, 70);
  assert.equal(today.reportedCents, 30);
  assert.equal(today.models[0].model, 'b');
  assert.equal(today.historyComplete, true);
  const laterCycle = summarizeToday({ ...usage, billingCycleStart: new Date(midnight + 1800000).toISOString() }, now);
  assert.equal(laterCycle.requests, 1);
  const endedCycle = summarizeToday({ ...usage, billingCycleEnd: new Date(midnight + 3600000).toISOString() }, now);
  assert.equal(endedCycle.requests, 1);
});
test('today preserves unknown costs, known zero, partial data and stale-day boundaries', () => {
  const { summarizeToday } = load('today');
  const now = new Date(2026, 8, 10, 18);
  const first = { ...event(new Date(2026, 8, 10, 12).getTime()), totalCents: null };
  const usage = snapshot({ timestamp: now, events: [first], eventsComplete: false });
  const today = summarizeToday(usage, now);
  assert.equal(today.reportedCents, null);
  assert.equal(today.missingCosts, 1);
  assert.equal(today.historyComplete, false);
  const mixed = summarizeToday({ ...usage, events: [first, { ...first, totalCents: 0 }] }, now);
  assert.equal(mixed.reportedCents, 0);
  assert.equal(mixed.missingCosts, 1);
  const tomorrow = summarizeToday({ ...usage, eventsComplete: true }, new Date(2026, 8, 11, 1));
  assert.equal(tomorrow.requests, 0);
  assert.equal(tomorrow.historyComplete, false);
});
test('API preserves unavailable event costs and reports the actual credential source', async () => {
  const { api } = apiFixture(() => ({ usageEventsDisplay: [
    { timestamp: 1, tokenUsage: { inputTokens: 1 } },
    { timestamp: 2, chargedCents: 0, tokenUsage: { inputTokens: 1 } },
    { timestamp: 3, chargedCents: 20, tokenUsage: { inputTokens: 1 } },
  ] }));
  assert.equal(api.getAuthSource(), 'unavailable');
  const result = await api.fetchUsage();
  assert.equal(api.getAuthSource(), 'manual');
  assert.deepEqual(Array.from(result.snapshot.events, e => e.totalCents), [null, 0, 20]);
});
test('diagnostic states distinguish successful, partial, failed and skipped endpoints', async () => {
  const { tracker } = trackerFixture([
    success(snapshot(), { aggError: true }),
    { snapshot: null, error: 'Failed to fetch usage-summary', eventsError: false, aggError: false },
    success(snapshot({ eventsComplete: true })),
  ]);
  assert.equal(tracker.diagnostics.summary, 'notRequested');
  await tracker.poll();
  assert.equal(tracker.diagnostics.summary, 'ok');
  assert.equal(tracker.diagnostics.events, 'partial');
  assert.equal(tracker.diagnostics.aggregations, 'failed');
  await tracker.poll();
  assert.equal(tracker.diagnostics.summary, 'failed');
  assert.equal(tracker.diagnostics.events, 'notRequested');
  assert.equal(tracker.diagnostics.failures, 1);
  await tracker.poll();
  assert.equal(tracker.diagnostics.events, 'ok');
  assert.equal(tracker.diagnostics.aggregations, 'ok');
  assert.equal(tracker.diagnostics.failures, 0);
  assert.equal(tracker.diagnostics.running, false);
});
test('recent usage table shows API cost next to tokens and labels a zero as not returned', () => {
  const { view } = panelFixture({ snap: snapshot({ eventsComplete: true, totalTokens: 168000, aggregations: [
    { model: 'grok', inputTokens: 168000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 168000 },
  ], events: [
    { ...event(1_700_000_000_000, 'grok'), totalCents: 168, totalTokens: 168000 },
    { ...event(1_700_000_100_000, 'composer'), totalCents: null, totalTokens: 1000 },
    { ...event(1_700_000_200_000, 'auto'), totalCents: 0, totalTokens: 500 },
  ] }) });
  const html = view.webview.html;
  const eventsTable = html.slice(html.indexOf('id="events-table"'));
  assert.match(eventsTable, /<th>Time<\/th><th>Model<\/th><th>Kind<\/th><th>Tokens<\/th><th>Cost<\/th>/);
  assert.match(eventsTable, /<td class="num">168000<\/td>\s*<td class="num">168<\/td>/);
  assert.equal(eventsTable.split('class="num missing">API did not return a cost').length - 1, 2);
  assert.match(html, /data-cmd="exportCsv"/);
  assert.match(html, /Click a model row to filter the trend/);
  assert.doesNotMatch(html, /id="model-table"/);
  assert.match(html, /class="stat-pill">Requests<strong>3<\/strong>/);
  assert.match(html, /class="stat-pill">Cost<strong>168<\/strong>/);
  assert.match(html, /id="model-metric"[\s\S]*value="token"/);
  assert.match(html, /class="row-tip"[^>]*>[\s\S]*Input 168000[\s\S]*Output 0[\s\S]*Cache 0/);
});
test('recent usage defaults to every category and lists model and automation separately', () => {
  const { view } = panelFixture({ snap: snapshot({ eventsComplete: true, events: [
    { ...event(3, 'grok-bot-automation'), totalTokens: 0, totalCents: null },
    { ...event(2, 'grok-4.7-high'), totalTokens: 100, totalCents: 250 },
  ] }) });
  const html = view.webview.html;
  assert.match(html, /id="recent-category"[\s\S]*?<option value="all" selected>All<\/option>/);
  assert.match(html, /<option value="model">Models<\/option>/);
  assert.match(html, /<option value="automation">Automation<\/option>/);
  assert.match(html, /data-category="automation"/);
  assert.match(html, /data-category="model"/);
  const payload = JSON.parse(html.match(/id="recent-data">([^<]+)<\/script>/)[1]);
  assert.deepEqual(payload.rows.map(row => row.category), ['automation', 'model']);
  assert.equal(payload.rows.filter(row => row.category === 'automation').length, 1);
});
test('today labels a zero event-cost total as not returned and keeps a positive sum', () => {
  const now = new Date();
  const cycle = {
    billingCycleStart: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
    billingCycleEnd: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
  };
  const zero = panelFixture({ snap: snapshot({ timestamp: now, eventsComplete: true, ...cycle,
    events: [{ ...event(now.getTime()), totalCents: 0 }] }) });
  assert.match(zero.view.webview.html, /Reported cost<strong>API did not return a cost<\/strong>/);
  const paid = panelFixture({ snap: snapshot({ timestamp: now, eventsComplete: true, ...cycle,
    events: [{ ...event(now.getTime()), totalCents: 250 }] }) });
  assert.match(paid.view.webview.html, /Reported cost<strong>250<\/strong>/);
});
test('event cost treats an API zero as withheld and formats a positive amount', () => {
  const vscode = vscodeMock();
  vscode.TreeItem = class {};
  const { formatEventCost } = load('treeView', {}, vscode);
  assert.equal(formatEventCost(null), 'API did not return a cost');
  assert.equal(formatEventCost(0), 'API did not return a cost');
  assert.equal(formatEventCost(168), '$1.68');
});
test('panel exposes today, budget and diagnostics even when budget is disabled', () => {
  const { view } = panelFixture();
  assert.match(view.webview.html, /Top models today|Reported cost/);
  assert.match(view.webview.html, /No dollar alert configured/);
  assert.match(view.webview.html, /Configure Amount Alert/);
  assert.match(view.webview.html, /data-cmd="budget"/);
  assert.match(view.webview.html, /data-cmd="diagnostics"/);
});

test('budget and diagnostic commands are wired to notifications, global settings and a token-free report', async () => {
  const vscode = vscodeMock();
  const commands = new Map();
  const notices = [];
  const output = [];
  const config = { budgetAmount: 100, budgetMetric: 'onDemand', alertEnabled: true };
  const memory = memoryState();
  let inputOptions;
  const bar = { show() {}, hide() {}, dispose() {} };
  vscode.StatusBarAlignment = { Left: 1, Right: 2 };
  vscode.ConfigurationTarget = { Global: 1 };
  vscode.ThemeColor = class { constructor(id) { this.id = id; } };
  vscode.commands = { registerCommand: (id, callback) => { commands.set(id, callback); return {}; } };
  vscode.window = {
    createOutputChannel: () => ({ appendLine: line => output.push(line), clear: () => { output.length = 0; }, show() {} }),
    createStatusBarItem: () => bar, onDidChangeWindowState: () => ({}),
    showWarningMessage: text => notices.push(text),
    showQuickPick: async () => ({ id: 'onDemand' }),
    showInputBox: async options => { inputOptions = options; return '200'; },
  };
  vscode.workspace = {
    onDidChangeConfiguration: () => ({}), getConfiguration: () => ({
      get: (key, fallback) => config[key] ?? fallback,
      update: async (key, value, target) => { assert.equal(target, 1); config[key] = value; },
    }),
  };
  let tracker;
  class Tracker {
    constructor() {
      tracker = this;
      this.lastSnapshot = snapshot({ accountId: 'private-account-id', onDemandUsedCents: 5000 });
      this.lastError = null; this.dataWarning = null; this.consecutiveFailures = 0;
      this.diagnostics = { lastAttempt: new Date(), lastSuccess: new Date(), summary: 'ok', events: 'partial',
        aggregations: 'ok', failures: 0, running: false };
    }
    async poll() { this.onUpdate(); return true; }
  }
  const extension = load('extension', {
    './api': { initSecretStorage() {}, getAuthSource: () => 'manual' },
    './credentials': { setAutoReadEnabled() {} }, './tracker': { UsageTracker: Tracker },
    './panel': { UsagePanel: {} },
    './treeView': { formatPct: String, formatTokens: String, membershipLabel: String },
  }, vscode, { setTimeout: () => 1, clearTimeout() {} });
  extension.activate({ secrets: {}, subscriptions: [], globalState: {
    get: (key, fallback) => key.includes('Consent') ? 'denied' : memory.get(key, fallback), update: memory.update,
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Amount alert.*50%/);
  tracker.onUpdate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notices.length, 1);
  commands.get('cursor-token-usage.showDiagnostics')();
  assert.match(output.join('\n'), /Manually supplied token/);
  assert.match(output.join('\n'), /Usage events: Partial history/);
  assert.doesNotMatch(output.join('\n'), /private-account-id|WorkosCursorSessionToken/);
  await commands.get('cursor-token-usage.configureBudget')();
  assert.equal(config.budgetAmount, 200);
  for (const value of ['', '-1', 'Infinity', '1.234', '1000000001']) assert.ok(inputOptions.validateInput(value));
  for (const value of ['0', '1.01', '100']) assert.equal(inputOptions.validateInput(value), null);
  config.alertEnabled = false;
  tracker.lastSnapshot = snapshot({ onDemandUsedCents: 25000 });
  tracker.onUpdate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notices.length, 1);
  extension.deactivate();
});

test('collapsed cards retain partial-data warnings and budget progress without hiding trend', () => {
  const { view } = panelFixture({ snap: snapshot({ onDemandUsedCents: 8200 }), config: { budgetAmount: 100 } });
  const html = view.webview.html;
  assert.match(html, /<details class="collapsible" data-section="today">/);
  assert.match(html, /<details class="collapsible" data-section="budget">/);
  assert.match(html, />Allowance alerts</);
  const summaries = [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(match => match[1]);
  assert.match(summaries[0], /Cost unavailable.*tokens.*Partial data/);
  assert.match(summaries[1], /8200 \/ 10000.*82/);
  assert.match(summaries[1], /var\(--warn\)/);
  assert.match(html, /Usage Trend/);
  assert.doesNotMatch(html, /data-section="trend"/);
  assert.doesNotMatch(html, /data-section="models"/);
  assert.doesNotMatch(html, /data-section="recent"/);
  assert.doesNotMatch(html, /data-section="billing"/);
  assert.match(html, /class="ring-fg"[^>]*r="54"/);
  assert.match(html, /class="ring-fg"[^>]*r="40"/);
  assert.doesNotMatch(html, /class="ring-caption"/);
  assert.match(html, /ring-face/);
  assert.match(html, /\(\^_\^\)/);
  assert.match(html, /class="face-tip"/);
  assert.match(html, /Included usage is comfortable/);
  assert.match(html, />Model usage</);
  assert.match(html, /class="hero-main"/);
  assert.match(html, /option value="cursor"/);
  assert.match(html, /option value="other"/);
  const paused = panelFixture({ snap: snapshot({ onDemandUsedCents: 11000 }), config: { budgetAmount: 100, alertEnabled: false } });
  assert.match(paused.view.webview.html.match(/data-section="budget">\s*<summary>([\s\S]*?)<\/summary>/)[1], /var\(--err\).*Alerts paused/);
  assert.match(paused.view.webview.html, /amount alerts are paused/);
  const pools = panelFixture({
    snap: snapshot({ cursorModelsPercent: 12.3, otherModelsPercent: 95.9 }),
    config: { budgetAmount: 10, budgetMetric: 'included' },
  });
  assert.match(pools.view.webview.html, /Cursor Models 12\.3/);
  assert.match(pools.view.webview.html, /Other Models 95\.9/);
  assert.match(pools.view.webview.html, /Cursor Models and Other Models alert at 50%/);
  assert.doesNotMatch(pools.view.webview.html, /Selected usage amount is unavailable/);
  const enterprise = panelFixture({
    snap: snapshot({ displayMode: 'overall', overallUsedCents: 9600, overallLimitCents: 10000 }),
  });
  const enterpriseHtml = enterprise.view.webview.html;
  assert.match(enterpriseHtml, /ring-face/);
  assert.match(enterpriseHtml, /\(>_<\)/);
  assert.doesNotMatch(enterpriseHtml, /class="ring-fg"[^>]*r="40"/);
  assert.match(enterpriseHtml, /Included usage alerts at 50%/);
});
test('independent section preferences survive refresh and new panels; invalid messages do not persist', async () => {
  const storage = memoryState();
  const { panel, receive, view } = panelFixture({ storage });
  receive({ command: 'section', section: 'today', open: true });
  receive({ command: 'section', section: 'budget', open: true });
  receive({ command: 'section', section: 'budget', open: false });
  receive({ command: 'section', section: 'unexpected', open: true });
  receive({ command: 'section', section: 'today', open: 'false' });
  receive(null);
  await new Promise(resolve => setImmediate(resolve));
  panel.refresh();
  assert.match(view.webview.html, /data-section="today" open>/);
  assert.match(view.webview.html, /data-section="budget">/);
  const reopened = panelFixture({ storage });
  assert.match(reopened.view.webview.html, /data-section="today" open>/);
  assert.match(reopened.view.webview.html, /data-section="budget">/);
  assert.equal(Object.keys(storage.get('cursorTokenUsage.panelSections')).length, 2);
});
test('folding, chart filters and resize share state without overwriting each other', () => {
  const now = new Date();
  const { view } = panelFixture({ snap: snapshot({
    timestamp: now, events: [event(now.getTime())],
    billingCycleStart: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
    billingCycleEnd: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
  }) });
  const html = view.webview.html;
  const payload = JSON.parse(html.match(/id="trend-data">([^<]+)<\/script>/)[1]);
  let state = { metric: 'token', model: 'model', from: payload.minDay, to: payload.maxDay,
    sections: { today: true, budget: false }, untouched: 123 };
  const posted = [];
  function element(extra = {}) {
    return { handlers: {}, addEventListener(type, callback) { this.handlers[type] = callback; }, ...extra };
  }
  const today = element({ dataset: { section: 'today' }, open: false });
  const budget = element({ dataset: { section: 'budget' }, open: false });
  const chart = element({ clientWidth: 800, innerHTML: '', querySelectorAll: () => [] });
  const select = element({ value: '', options: [{ value: '' }, { value: 'model' }] });
  const from = element(), to = element();
  const nodes = { 'trend-data': { textContent: JSON.stringify(payload) }, 'trend-chart': chart,
    'trend-from': from, 'trend-to': to, 'trend-model': select, 'trend-range': {}, 'trend-legend': {} };
  let resize;
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ getState: () => state, setState: next => { state = next; }, postMessage: message => posted.push(message) }),
    window: { addEventListener() {} },
    document: { getElementById: id => nodes[id], querySelectorAll: selector => selector === 'details[data-section]' ? [today, budget] : [] },
    ResizeObserver: class { constructor(callback) { resize = callback; } observe(target) { assert.equal(target, chart); } },
  });
  assert.equal(today.open, true);
  assert.equal(budget.open, false);
  assert.match(chart.innerHTML, /viewBox="0 0 784 300"/);
  today.open = false; today.handlers.toggle();
  assert.equal(state.model, 'model');
  assert.equal(state.from, payload.minDay);
  assert.equal(state.sections.today, false);
  assert.equal(posted[0].command, 'section');
  from.value = payload.maxDay; from.handlers.change();
  select.value = ''; select.handlers.change();
  assert.equal(state.sections.today, false);
  assert.equal(state.sections.budget, false);
  assert.equal(state.from, payload.maxDay);
  assert.equal(state.model, '');
  assert.equal(state.untouched, 123);
  chart.clientWidth = 360; resize();
  assert.match(chart.innerHTML, /viewBox="0 0 344 300"/);
  assert.equal(state.from, payload.maxDay);
  assert.equal(state.sections.today, false);
});
