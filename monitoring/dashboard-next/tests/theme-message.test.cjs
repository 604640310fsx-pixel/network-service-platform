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
  buildMiniDomain,
  buildMiniPath,
  buildMiniAverage,
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
  assert.match(html, /master\.css\?v=20260901-mini-r2/);
  assert.match(html, /app\.js\?v=20260901-mini-r2/);
});

test('compact sidebar mini view is a query mode on the same page, not a new route', () => {
  const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
  // 首屏根据 ?view=mini 落 data-view，供同一页面切换紧凑布局。
  assert.match(html, /view'\)==='mini'\)document\.documentElement\.dataset\.view='mini'/);
  // 三条线路在曲线与胶囊中都被显式标注。
  for (const wan of ['telecom', 'mobile', 'unicom']) {
    assert.match(html, new RegExp(`<path class="mini-line" data-wan="${wan}"`));
    assert.match(html, new RegExp(`<span class="mini-chip" data-wan="${wan}"`));
  }
  // 批准设计的结构：标题 + LIVE 状态、平均值、共用刻度的 260x46 折线画布。
  assert.match(html, /class="mini-caption">网络状态监控</);
  assert.match(html, /id="miniStatus"/);
  assert.match(html, /id="miniAvg"/);
  assert.match(html, /viewBox="0 0 260 46" preserveAspectRatio="none"/);
  // 单一标题：外层官网卡片不再重复大标题，紧凑视图内也只有一处标题（避免卡中卡）。
  assert.equal(html.match(/class="mini-caption"/g).length, 1);
  assert.doesNotMatch(html, /<polyline/);

  const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
  // 紧凑视图只跑轻量 mini 逻辑，读取既有同源 /api/latency，每 15 秒刷新，不新增后端。
  assert.match(source, /dataset\.view==='mini'\)initMini\(\)/);
  assert.match(source, /getJSON\('\/api\/latency\?range=6h&type=icmp'\)/);
  assert.match(source, /setInterval\(\(\)=>\{if\(!document\.hidden\)loadMini\(false\)\},15000\)/);
  // 绘图盒与批准设计一致。
  assert.match(source, /const MINI_W=260,MINI_H=46,MINI_PAD=5,MINI_MAX_POINTS=14;/);

  const css = fs.readFileSync(path.join(__dirname, '../static/master.css'), 'utf8');
  assert.match(css, /html\[data-view="mini"\] \.shell\{display:none\}/);
  // 98px 的紧凑高度由三段固定高度构成，与官网 .cc-monitor-embed 对齐。
  assert.match(css, /\.mini-top\{[^}]*height:15px\}/);
  assert.match(css, /\.mini-figure\{[^}]*height:41px;margin:10px 0 11px\}/);
  assert.match(css, /\.mini-chips\{[^}]*height:21px\}/);
  // 原设计是自然宽度胶囊，不再压成三等分。
  assert.match(css, /\.mini-chips\{display:flex;gap:6px;height:21px\}/);
  // 动效须尊重 prefers-reduced-motion。
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  // 浅色主题下线路色单独压暗，保证 10.5px 小字号对比度。
  assert.match(css, /html\[data-theme="light"\]\[data-view="mini"\] \.mini-monitor\{/);
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

test('mini chart shares one honest scale across the three carriers', () => {
  const rows = [
    { wan: 'telecom', values: [10, 20], current: 20 },
    { wan: 'mobile', values: [40, 60], current: 60 },
    { wan: 'unicom', values: [], current: null },
  ];
  const domain = buildMiniDomain(rows, 14);
  // 正常值沿用设计源的 6..60 基准，避免把轻微波动夸张成全高尖峰。
  assert.deepEqual(domain, { lo: 6, hi: 60 });

  // 有效点少于两个：不画线，保持诚实空态。
  assert.equal(buildMiniPath([], domain, 260, 46, 5, 14), '');
  assert.equal(buildMiniPath([12], domain, 260, 46, 5, 14), '');
  assert.equal(buildMiniPath([12, 13], null, 260, 46, 5, 14), '');

  // 与设计一致：y 随延迟增大而下移，上下各留 5；最新样本贴右边缘。
  const telecom = buildMiniPath([6, 60], domain, 260, 46, 5, 14);
  assert.equal(telecom, 'M240.0 5.0 L260.0 41.0');
  // 超出定域的值截断到边界，不会画到画布外。
  assert.equal(buildMiniPath([-5, 999], domain, 260, 46, 5, 14), 'M240.0 5.0 L260.0 41.0');
  // 点数达到上限时起点回到左边缘，步长与设计一致（260 / 13）。
  const full = buildMiniPath(Array.from({ length: 14 }, () => 35), domain, 260, 46, 5, 14);
  assert.ok(full.startsWith('M0.0 '));
  assert.ok(full.endsWith('L260.0 24.3'));

  // 超出设计基准的真实值扩展边界，不裁掉数据；全等正常值保持基准范围。
  assert.deepEqual(buildMiniDomain([{ wan: 'telecom', values: [2, 90] }], 14), { lo: 2, hi: 90 });
  assert.deepEqual(buildMiniDomain([{ wan: 'telecom', values: [30, 30] }], 14), { lo: 6, hi: 60 });
  // 完全没有真实样本时没有定域，也就没有任何线条。
  assert.equal(buildMiniDomain([{ wan: 'telecom', values: [] }], 14), null);
  assert.equal(buildMiniDomain(undefined, 14), null);
});

test('mini average only counts carriers whose latest probe actually succeeded', () => {
  assert.equal(buildMiniAverage([{ current: 10 }, { current: 20 }, { current: 60 }]), 30);
  // 最新失败 / 无样本的线路不计入，也不用历史值顶替。
  assert.equal(buildMiniAverage([{ current: 10 }, { current: null }, { current: 30 }]), 20);
  assert.equal(buildMiniAverage([{ current: null }, { current: null }, { current: null }]), null);
  assert.equal(buildMiniAverage(undefined), null);
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
