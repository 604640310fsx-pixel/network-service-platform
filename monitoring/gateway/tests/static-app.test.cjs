const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  THEME_MESSAGE_TYPE,
  acceptedThemeMessage,
  formatTime,
  normalizeParentOrigin,
  trendPath,
  validate,
} = require('../static/app.js');

function payload() {
  return {
    wans: [
      {
        wanId: 'telecom', displayName: '电信', status: 'healthy',
        latestLatencyMs: 12.3, packetLossSummary: 0, updatedAt: '2030-01-01T00:00:00Z',
        stale: false, trend: [11, null, 12.3],
      },
      {
        wanId: 'mobile', displayName: '移动', status: 'unavailable',
        packetLossSummary: 5, updatedAt: '2030-01-01T00:00:00Z',
        stale: false, trend: [20, null],
      },
      {
        wanId: 'unicom', displayName: '联通', status: 'no_data',
        packetLossSummary: null, updatedAt: null, stale: false, trend: [],
      },
    ],
  };
}

test('client accepts only the frozen three-WAN allowlist', () => {
  assert.equal(validate(payload()).length, 3);
  const extra = payload();
  extra.wans[0].internal = 'not allowed';
  assert.throws(() => validate(extra), /schema/);
  const duplicate = payload();
  duplicate.wans[1].wanId = 'telecom';
  assert.throws(() => validate(duplicate), /schema/);
});

test('failed latest probe has no current latency and trend gaps stay gaps', () => {
  const items = validate(payload());
  assert.equal('latestLatencyMs' in items[1], false);
  const pathValue = trendPath([10, 11, null, 15, 16]);
  assert.match(pathValue, /^M/);
  assert.equal((pathValue.match(/M/g) || []).length, 2);
  assert.doesNotMatch(pathValue, /NaN|Infinity/);
  assert.equal(trendPath([12]), '');
});

test('runtime fetch is same-origin, credential-free, and clears values on failure', () => {
  const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
  assert.match(source, /fetch\('\/api\/summary'/);
  assert.match(source, /credentials: 'omit'/);
  assert.match(source, /cache: 'no-store'/);
  assert.match(source, /redirect: 'error'/);
  assert.match(source, /catch \(_error\) \{\s*clearAll\('监控暂时不可用'\)/);
  assert.doesNotMatch(source, /localStorage|document\.cookie|console\./);
});

test('static shell keeps styles and behavior when previewed from a local file', () => {
  const source = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
  assert.match(source, /name="monitor-parent-origin" content="__MONITOR_PARENT_ORIGIN__"/);
  assert.match(source, /href="\.\/master\.css"/);
  assert.match(source, /src="\.\/app\.js"/);
  assert.doesNotMatch(source, /(?:href|src)="\/(?:master\.css|app\.js)"/);
});

test('parent theme messages require the exact injected origin, source, type, and fields', () => {
  const parent = 'https://website.example';
  assert.equal(normalizeParentOrigin(parent), parent);
  for (const value of [
    '',
    ' https://website.example',
    'https://website.example/',
    'https://website.example/path',
    'https://user:pass@website.example',
    '__MONITOR_PARENT_ORIGIN__',
    "'none'",
  ]) {
    assert.equal(normalizeParentOrigin(value), null);
  }

  const payload = { type: THEME_MESSAGE_TYPE, theme: 'light' };
  assert.equal(acceptedThemeMessage(parent, parent, true, payload), 'light');
  assert.equal(acceptedThemeMessage(parent, parent, true, { ...payload, theme: 'dark' }), 'dark');
  assert.equal(acceptedThemeMessage(parent, 'https://other.example', true, payload), null);
  assert.equal(acceptedThemeMessage(parent, parent, false, payload), null);
  assert.equal(acceptedThemeMessage(parent, parent, true, { ...payload, extra: true }), null);
  assert.equal(acceptedThemeMessage(parent, parent, true, { type: 'wrong', theme: 'light' }), null);
  assert.equal(acceptedThemeMessage(parent, parent, true, { type: THEME_MESSAGE_TYPE, theme: 'system' }), null);
});

test('embed view is explicit and removes the duplicate gateway banner', () => {
  const app = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../static/master.css'), 'utf8');
  assert.match(app, /requestedView === 'mini' \|\| requestedView === 'embed'/);
  assert.match(css, /html\[data-view="embed"\] \.monitor-head/);
  assert.match(css, /html\[data-view="embed"\] \.footnote/);
  assert.match(css, /html\[data-view="embed"\]\[data-preview="fixture"\] \.monitor-head/);
  assert.match(css, /data-preview="fixture"\]\s+\.monitor-head > div:first-child/);
});

test('offline fixture preview is visibly labeled and cannot become a silent fallback', () => {
  const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
  assert.match(html, /id="fixtureNote" hidden>演示数据 · 非报价</);
  assert.match(source, /parameters\.get\('preview'\) === 'fixture'/);
  assert.match(source, /querySelector\('#fixtureNote'\)\.hidden = false/);
  const previewBlock = source.match(
    /if \(parameters\.get\('preview'\) === 'fixture'\) \{([\s\S]*?)\n  \}/,
  );
  assert.ok(previewBlock);
  assert.doesNotMatch(previewBlock[1], /fetch|render|refresh|latestLatencyMs|wans/);
});

test('update time formatting never exposes an invalid raw value', () => {
  assert.equal(formatTime(null), '—');
  assert.equal(formatTime('not-a-date'), '—');
});
