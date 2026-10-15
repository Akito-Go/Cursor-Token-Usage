const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { readItemValues } = require('../out/sqlite.js');
const { buildEventsCsv, csvCell } = require('../out/csv.js');
const { summarizeModels } = require('../out/modelBreakdown.js');
const { modelPool, usageCategory } = require('../out/usageCategory.js');
const { buildUsageTooltipMarkdown } = require('../out/tooltip.js');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-db-'));
  return path.join(dir, 'state.vscdb');
}

function createDb(dbPath, setup) {
  const db = new DatabaseSync(dbPath);
  setup(db);
  return db;
}

test('reads ItemTable text and blob values without sqlite CLI', () => {
  const dbPath = tempDb();
  const db = createDb(dbPath, (database) => {
    database.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    database.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('cursorAuth/accessToken', 'jwt-token');
    database.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('cursorAuth/cachedSignUpId', Buffer.from('user_abcdefghijklmnopqrst'));
    database.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('other', 'ignore');
  });
  db.close();

  assert.deepEqual(readItemValues(dbPath, ['cursorAuth/accessToken', 'cursorAuth/cachedSignUpId']), {
    'cursorAuth/accessToken': 'jwt-token',
    'cursorAuth/cachedSignUpId': 'user_abcdefghijklmnopqrst',
  });
});

test('reads auth values that exist only in the WAL', () => {
  const dbPath = tempDb();
  const db = createDb(dbPath, (database) => {
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    database.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('cursorAuth/accessToken', 'wal-jwt-token');
  });

  assert.equal(fs.existsSync(`${dbPath}-wal`), true);
  assert.equal(readItemValues(dbPath, ['cursorAuth/accessToken'])['cursorAuth/accessToken'], 'wal-jwt-token');
  db.close();
});

test('reads a value stored on overflow pages', () => {
  const dbPath = tempDb();
  const token = `jwt-${'a'.repeat(8000)}`;
  const db = createDb(dbPath, (database) => {
    database.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    database.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('cursorAuth/accessToken', token);
  });
  db.close();

  assert.equal(readItemValues(dbPath, ['cursorAuth/accessToken'])['cursorAuth/accessToken'], token);
});

test('csv prefixes formula cells and leaves withheld costs blank', () => {
  assert.equal(csvCell('=cmd|calc'), "'=cmd|calc");
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('normal, "quoted"'), '"normal, ""quoted"""');
  const csv = buildEventsCsv([
    { timestamp: 1_700_000_000_000, model: '=HYPERLINK("http://evil")', kind: 'INCLUDED',
      totalTokens: 10, totalCents: 168, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { timestamp: 1_700_000_100, model: 'composer', kind: 'INCLUDED',
      totalTokens: 4, totalCents: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ]);
  assert.match(csv, /Date,Kind,Model,Tokens,CostUSD/);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /,1\.6800\n/);
  assert.match(csv, /composer,4,\n/);
});

test('usage categories separate automation from model names', () => {
  assert.equal(usageCategory('grok-4.7-high'), 'model');
  assert.equal(usageCategory('Grok BOT Automation'), 'automation');
  assert.equal(usageCategory('grok-bot-automation'), 'automation');
  assert.equal(usageCategory('bugbot'), 'automation');
  assert.equal(usageCategory('unknown'), 'other');
  assert.equal(usageCategory('robotics-model'), 'model');
  assert.equal(modelPool('Composer 2.5 Fast'), 'cursor');
  assert.equal(modelPool('auto'), 'cursor');
  assert.equal(modelPool('Grok 4.7 High'), 'cursor');
  assert.equal(modelPool('Grok BOT Default'), 'cursor');
  assert.equal(modelPool('Claude Opus 5.5 High'), 'other');
  assert.equal(modelPool('GPT-5.6 Sol'), 'other');
});

test('status tooltip uses progress bars and a model table instead of a flat list', () => {
  const markdown = buildUsageTooltipMarkdown({
    title: 'Cursor Token Usage · Pro',
    metrics: [
      { label: 'Cursor Models', value: '40%', ratio: 0.4 },
      { label: 'Other Models', value: '10%', ratio: 0.1 },
    ],
    models: [{ model: 'Grok 4.7 High', requests: '2', tokens: '1.2M', cost: '$2.50' }],
    modelHeading: 'By Model',
    modelHeaders: ['Model', 'Requests', 'Tokens', 'Cost'],
    reset: 'Reset in: 16d 2h',
    today: 'Today: 1.2M tokens, 2 requests (loaded history)',
    detailsLabel: 'Click to view details',
    refreshLabel: 'Refresh Token Usage',
    light: false,
  });
  assert.match(markdown, /<img src="data:image\/svg\+xml;base64,/);
  assert.match(markdown, /Cursor Models/);
  assert.match(markdown, /Grok 4\.7 High/);
  assert.match(markdown, /command:cursor-token-usage\.showDetails/);
  assert.match(markdown, /command:cursor-token-usage\.refresh/);
  assert.equal(markdown.match(/<hr>/g).length, 4);
});

test('model breakdown prefers aggregate tokens and ignores non-positive API costs', () => {
  const rows = summarizeModels({
    events: [
      { model: 'grok', totalTokens: 10, totalCents: 168 },
      { model: 'grok', totalTokens: 5, totalCents: 0 },
      { model: 'auto', totalTokens: 7, totalCents: null },
    ],
    aggregations: [{ model: 'grok', totalTokens: 900 }, { model: 'composer', totalTokens: 50 }],
  });
  assert.deepEqual(rows.map((row) => [row.model, row.requests, row.tokens, row.spendCents]), [
    ['grok', 2, 900, 168],
    ['composer', 0, 50, null],
    ['auto', 1, 7, null],
  ]);
});
