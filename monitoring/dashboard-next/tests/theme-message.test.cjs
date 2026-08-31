const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  THEME_MESSAGE_TYPE,
  isLoopbackOrigin,
  isTrustedThemeMessage,
  normalizeTheme,
  normalizeVpsCustomerState,
  vpsPickerMonitorState,
  buildMiniSeries,
  miniRowState,
  miniSparkPoints,
} = require('../static/app.js');

const parentWindow = {};
const productionConfig = {
  parentWindow,
  monitorOrigin: 'https://monitor.siqiapparel.com',
  approvedOrigins: ['https://www.siqiapparel.com'],
  allowLoopback: false,
};

function message(overrides = {}) {
  return {
    source: parentWindow,
    origin: 'https://www.siqiapparel.com',
    data: { type: THEME_MESSAGE_TYPE, theme: 'light' },
    ...overrides,
  };
}

test('theme normalization accepts only light and keeps dark as the safe default', () => {
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme('system'), 'dark');
  assert.equal(normalizeTheme(undefined), 'dark');
});

test('production accepts only the exact parent window, origin, message type, and theme', () => {
  assert.equal(isTrustedThemeMessage(message(), productionConfig), true);
  assert.equal(isTrustedThemeMessage(message({ source: {} }), productionConfig), false);
  assert.equal(isTrustedThemeMessage(message({ source: null }), productionConfig), false);
  assert.equal(
    isTrustedThemeMessage(message({ origin: 'https://siqiapparel.com' }), productionConfig),
    false,
  );
  assert.equal(
    isTrustedThemeMessage(message({ origin: 'https://unrelated.example' }), productionConfig),
    false,
  );
  assert.equal(
    isTrustedThemeMessage(message({ data: { type: 'nsp-monitor-theme:v2', theme: 'light' } }), productionConfig),
    false,
  );
  assert.equal(
    isTrustedThemeMessage(message({ data: { type: THEME_MESSAGE_TYPE, theme: 'system' } }), productionConfig),
    false,
  );
  assert.equal(isTrustedThemeMessage(message({ data: null }), productionConfig), false);
});

test('loopback relaxation is available only when the monitor itself is loopback', () => {
  assert.equal(isLoopbackOrigin('http://127.0.0.1:3002'), true);
  assert.equal(isLoopbackOrigin('http://localhost:4173'), true);
  assert.equal(isLoopbackOrigin('https://monitor.siqiapparel.com'), false);

  const loopbackEvent = message({ origin: 'http://127.0.0.1:4173' });
  assert.equal(isTrustedThemeMessage(loopbackEvent, productionConfig), false);
  assert.equal(
    isTrustedThemeMessage(loopbackEvent, {
      ...productionConfig,
      monitorOrigin: 'http://127.0.0.1:3002',
      approvedOrigins: [],
      allowLoopback: true,
    }),
    true,
  );
});

test('static entry binds the canonical parent and exposes no monitor-owned theme toggle', () => {
  const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
  assert.match(
    html,
    /<meta name="monitor-embed-origin" content="https:\/\/www\.siqiapparel\.com">/,
  );
  assert.doesNotMatch(html, /theme[-_ ]?toggle|切换到(?:浅色|深色)主题/i);
  assert.match(html, /master\.css\?v=20260831-mini/);
  assert.match(html, /app\.js\?v=20260831-mini/);
});

test('compact sidebar mini view is a query mode on the same page, not a new route', () => {
  const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
  // 首屏根据 ?view=mini 落 data-view，供同一页面切换紧凑布局。
  assert.match(html, /view'\)==='mini'\)document\.documentElement\.dataset\.view='mini'/);
  // 三条线路都在紧凑视图中被显式标注。
  assert.match(html, /class="mini-row telecom"[^>]*data-wan="telecom"/);
  assert.match(html, /class="mini-row mobile"[^>]*data-wan="mobile"/);
  assert.match(html, /class="mini-row unicom"[^>]*data-wan="unicom"/);

  const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
  // 紧凑视图只跑轻量 mini 逻辑，读取既有同源 /api/latency，每 15 秒刷新，不新增后端。
  assert.match(source, /dataset\.view==='mini'\)initMini\(\)/);
  assert.match(source, /getJSON\('\/api\/latency\?range=6h&type=icmp'\)/);
  assert.match(source, /setInterval\(\(\)=>\{if\(!document\.hidden\)loadMini\(false\)\},15000\)/);

  const css = fs.readFileSync(path.join(__dirname, '../static/master.css'), 'utf8');
  assert.match(css, /html\[data-view="mini"\] \.shell\{display:none\}/);
  // 动效须尊重 prefers-reduced-motion。
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
});

test('mini series never invents latency and never keeps a stale value as current', () => {
  const samples = [
    { timestamp: '2026-08-31T00:00:00Z', wan: 'telecom', success: 1, avg_ms: 30 },
    { timestamp: '2026-08-31T00:01:00Z', wan: 'telecom', success: 1, avg_ms: 40 },
    // 移动最近一次探测失败：不得把上一成功值当当前值。
    { timestamp: '2026-08-31T00:00:00Z', wan: 'mobile', success: 1, avg_ms: 55 },
    { timestamp: '2026-08-31T00:01:00Z', wan: 'mobile', success: 0, avg_ms: null },
    // 联通窗口内无任何样本。
  ];
  const rows = buildMiniSeries(samples);
  const byWan = Object.fromEntries(rows.map((row) => [row.wan, row]));

  assert.equal(byWan.telecom.current, 40);
  assert.deepEqual(byWan.telecom.values, [30, 40]);
  assert.equal(miniRowState(byWan.telecom), 'ok');

  assert.equal(byWan.mobile.current, null); // 不保留 55 作为当前值
  assert.equal(byWan.mobile.latestFailed, true);
  assert.deepEqual(byWan.mobile.values, [55]); // 历史成功点仍可作趋势
  assert.equal(miniRowState(byWan.mobile), 'down');

  assert.equal(byWan.unicom.hasData, false);
  assert.equal(byWan.unicom.current, null);
  assert.equal(miniRowState(byWan.unicom), 'empty');

  // 无输入时三条线路都是诚实的空态，不产生任何数值。
  const empty = buildMiniSeries(undefined);
  assert.equal(empty.length, 3);
  assert.ok(empty.every((row) => row.current === null && row.values.length === 0));
});

test('miniSparkPoints maps values into the viewBox and stays empty below two points', () => {
  assert.equal(miniSparkPoints([], 100, 26, 2), '');
  assert.equal(miniSparkPoints([12], 100, 26, 2), '');
  const points = miniSparkPoints([0, 10], 100, 26, 2).split(' ');
  assert.equal(points.length, 2);
  const [x0, y0] = points[0].split(',').map(Number);
  const [x1, y1] = points[1].split(',').map(Number);
  assert.equal(x0, 2); // 左内边距
  assert.equal(x1, 98); // 右内边距
  assert.equal(y0, 24); // 最小值落到底部（h-pad）
  assert.equal(y1, 2); // 最大值落到顶部（pad）
  // 全等值时走中线，不制造虚假起伏。
  const flat = miniSparkPoints([5, 5, 5], 100, 26, 2).split(' ');
  assert.ok(flat.every((point) => Number(point.split(',')[1]) === 13));
});

test('embedded layout has a dedicated single-layer shell override', () => {
  const css = fs.readFileSync(path.join(__dirname, '../static/master.css'), 'utf8');
  assert.match(css, /html\[data-embedded="true"\] \.shell/);
  assert.match(css, /width:100%;margin:0/);
  assert.match(css, /border:0;border-radius:0/);
  assert.match(css, /html\[data-theme="light"\] \.system-metric\{[^}]*border-bottom-color:#e7ebf0/);
  assert.match(css, /html\[data-theme="light"\] \.table-wrap\{scrollbar-color:#aab2be transparent\}/);
  assert.match(css, /html\[data-theme="light"\] \.table-wrap::\-webkit-scrollbar-thumb\{background:#aab2be\}/);
  assert.doesNotMatch(css, /body\{[^}]*min-width:1180px/);
});

test('VPS picker maps live, unavailable, and explicitly disabled targets to stable states', () => {
  assert.equal(normalizeVpsCustomerState('active', false), 'active');
  assert.equal(normalizeVpsCustomerState('disabled', true), 'disabled');
  assert.equal(normalizeVpsCustomerState('retired', true), 'retired');
  assert.equal(normalizeVpsCustomerState(undefined, true), 'active');
  assert.equal(normalizeVpsCustomerState(undefined, false), 'disabled');
  assert.equal(normalizeVpsCustomerState('invalid', true), 'disabled');
  assert.equal(
    vpsPickerMonitorState(
      { target_name: 'DMIT Premium', customer_state: 'active' },
      { fresh: true, item: { online: true } },
    ),
    'online',
  );
  assert.equal(
    vpsPickerMonitorState(
      { target_name: 'NetLab Global US', customer_state: 'active' },
      { fresh: true, item: { online: false } },
    ),
    'offline',
  );
  assert.equal(
    vpsPickerMonitorState(
      { target_name: 'NetLab Global US', customer_state: 'active' },
      { fresh: false, item: { online: true } },
    ),
    'offline',
  );
  assert.equal(
    vpsPickerMonitorState(
      { target_name: 'Alibaba Cloud', customer_state: 'disabled' },
      { fresh: true, item: { online: true } },
    ),
    'disabled',
  );
  assert.equal(
    vpsPickerMonitorState(
      { target_name: 'Removed VPS', customer_state: 'retired' },
      { fresh: true, item: { online: true } },
    ),
    'disabled',
  );

  const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
  assert.match(source, /setInterval\(\(\)=>\{if\(!document\.hidden\)loadVpsTargets\(\)\},15000\)/);
  assert.doesNotMatch(source, /disabledVpsTargets|Yecaoyun Cloud2-current/);
});
