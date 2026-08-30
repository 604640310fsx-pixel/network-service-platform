const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  THEME_MESSAGE_TYPE,
  isLoopbackOrigin,
  isTrustedThemeMessage,
  normalizeTheme,
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
  assert.match(html, /master\.css\?v=20260831-theme-sync/);
  assert.match(html, /app\.js\?v=20260831-theme-sync/);
});

test('embedded layout has a dedicated single-layer shell override', () => {
  const css = fs.readFileSync(path.join(__dirname, '../static/master.css'), 'utf8');
  assert.match(css, /html\[data-embedded="true"\] \.shell/);
  assert.match(css, /width:100%;margin:0/);
  assert.match(css, /border:0;border-radius:0/);
  assert.doesNotMatch(css, /body\{[^}]*min-width:1180px/);
});
