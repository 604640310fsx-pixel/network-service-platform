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
  miniThin,
  miniDomain,
  buildMiniCurve,
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
  assert.match(html, /master\.css\?v=20260831-mini-r3/);
  assert.match(html, /app\.js\?v=20260831-mini-r3/);
});

test('compact sidebar mini view is a query mode on the same page, not a new route', () => {
  const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
  // 首屏根据 ?view=mini 落 data-view，供同一页面切换紧凑布局。
  assert.match(html, /view'\)==='mini'\)document\.documentElement\.dataset\.view='mini'/);
  // 三条线路共用同一观测面，并各自保留曲线与读数标识。
  assert.match(html, /class="mini-line" data-wan="telecom"/);
  assert.match(html, /class="mini-line" data-wan="mobile"/);
  assert.match(html, /class="mini-line" data-wan="unicom"/);
  assert.match(html, /class="mini-readout" data-wan="telecom"/);
  assert.match(html, /class="mini-readout" data-wan="mobile"/);
  assert.match(html, /class="mini-readout" data-wan="unicom"/);

  // 单一标题由外层官网卡片承担，紧凑视图内不再重复大标题（避免卡中卡）。
  assert.doesNotMatch(html, /class="mini-title"/);
  assert.doesNotMatch(html, /<polyline/); // 已改用平滑路径而非锯齿折线
  assert.match(html, /<path class="mini-line"/);
  assert.match(html, /<path class="mini-flow"/); // 高光只沿同一条真实路径移动
  assert.match(html, /class="mini-endpoint"/); // 末端活跃点

  const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
  // 紧凑视图只跑轻量 mini 逻辑，读取既有同源 /api/latency，每 15 秒刷新，不新增后端。
  assert.match(source, /dataset\.view==='mini'\)initMini\(\)/);
  assert.match(source, /getJSON\('\/api\/latency\?range=6h&type=icmp'\)/);
  assert.match(source, /setInterval\(\(\)=>\{if\(!document\.hidden\)loadMini\(false\)\},15000\)/);

  const css = fs.readFileSync(path.join(__dirname, '../static/master.css'), 'utf8');
  assert.match(css, /html\[data-view="mini"\] \.shell\{display:none\}/);
  assert.match(css, /\.mini-flow\[data-state="ok"\]\{[^}]*animation:mini-flow/);
  // 动效须尊重 prefers-reduced-motion。
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css, /\.mini-flow,\.mini-flow\[data-state="ok"\]\{display:none;animation:none\}/);
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

test('buildMiniCurve smooths real points without exaggerating small changes', () => {
  // 少于两个有效点：不画线、不给端点（诚实空态）。
  assert.deepEqual(buildMiniCurve([], 100, 30, 3), { d: '', endpoint: null });
  assert.deepEqual(buildMiniCurve([12], 100, 30, 3), { d: '', endpoint: null });

  const curve = buildMiniCurve([0, 10], 100, 30, 3);
  // 平滑曲线（三次贝塞尔 C 指令），而非锯齿折线。
  assert.match(curve.d, /^M3,27C/);
  // 曲线严格从第一个真实点出发、止于最后一个真实点（不外插）。视觉域带缓冲，
  // 因而最大值不再被强制顶到上边界。
  assert.ok(curve.d.startsWith('M3,27'));
  assert.ok(curve.d.endsWith('97,10.2'));
  assert.deepEqual(curve.endpoint, { x: 0.97, y: 0.34 });

  // 只有亚毫秒级变化时，所有路径控制点也保持在安静的小范围内，不夸张成全高山峰。
  const subtle = buildMiniCurve([24, 24.5, 24.2, 24.6], 100, 30, 3);
  const subtleYs = (subtle.d.match(/,(-?\d+(?:\.\d+)?)/g) || []).map((m) => Number(m.slice(1)));
  assert.ok(Math.max(...subtleYs) - Math.min(...subtleYs) < 5);

  // 全等值走中线，不制造虚假起伏；端点归一化 y=0.5，且每个 y 坐标都恰为中线 15。
  const flat = buildMiniCurve([5, 5, 5], 100, 30, 3);
  assert.equal(flat.endpoint.y, 0.5);
  assert.ok(/^M3,15C/.test(flat.d));
  assert.ok(flat.d.endsWith('97,15'));
  const ys = (flat.d.match(/,(-?\d+(?:\.\d+)?)/g) || []).map((m) => Number(m.slice(1)));
  assert.ok(ys.length > 0 && ys.every((y) => y === 15));
});

test('mini series thinning keeps real endpoints and uses one shared visual domain', () => {
  assert.deepEqual(miniThin([1, 2, 3, 4, 5, 6], 4), [1, 3, 4, 6]);
  assert.deepEqual(miniThin([1, null, 2, Number.NaN, 3], 8), [1, 2, 3]);

  const domain = miniDomain([[24, 25], [30, 31], []]);
  assert.ok(domain.min < 24);
  assert.ok(domain.max > 31);
  const low = buildMiniCurve([24, 25], 100, 30, 3, domain);
  const high = buildMiniCurve([30, 31], 100, 30, 3, domain);
  assert.ok(low.endpoint.y > high.endpoint.y);
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
