const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MonitorI18n: I18n,
  LANG_MESSAGE_TYPE,
  THEME_MESSAGE_TYPE,
  isTrustedLangMessage,
  isTrustedThemeMessage,
} = require('../static/app.js');

const STATIC = path.join(__dirname, '..', 'static');
const CJK = /[一-鿿]/;

function shape(value) {
  if (typeof value === 'function') return `fn${value.length}`;
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]));
  }
  return typeof value;
}

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'function') out.push(String(value(2, 3)));
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => strings(item, out));
  return out;
}

test('zh and en dictionaries have identical key shapes (except lookup tables)', () => {
  const { regions: _zr, server: _zs, ...zh } = I18n.M.zh;
  const { regions: _er, server: _es, ...en } = I18n.M.en;
  assert.deepEqual(shape(en), shape(zh));
});

test('English dictionary contains no Chinese characters in values', () => {
  const { regions, server, ...en } = I18n.M.en;
  for (const value of [...strings(en), ...Object.values(regions), ...Object.values(server)]) {
    assert.ok(!CJK.test(value), `Chinese text left in en: ${value}`);
  }
});

test('every data-i18n key in index.html resolves to a string in both languages', () => {
  const html = fs.readFileSync(path.join(STATIC, 'index.html'), 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(keys.length > 20);
  const lookup = (object, key) => key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), object);
  for (const lang of ['zh', 'en']) {
    for (const key of keys) assert.equal(typeof lookup(I18n.M[lang], key), 'string', `${lang}:${key}`);
  }
});

test('index.html only references statics the VPS monitor proxy allows, and exposes a zh/en toggle', () => {
  const html = fs.readFileSync(path.join(STATIC, 'index.html'), 'utf8');
  // monitor.siqiapparel.com proxies exact paths only: / /app.js /master.css (+ /api/*, /__monitor_mini/).
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"?#]*)/g)].map((match) => match[1]);
  assert.ok(refs.length >= 2);
  for (const ref of refs) assert.ok(['/', '/app.js', '/master.css'].includes(ref), `not proxied publicly: ${ref}`);
  assert.match(html, /id="langToggle"[^>]*>.*data-lang="zh".*data-lang="en"/);
});

test('every speed card region translates to English', () => {
  const html = fs.readFileSync(path.join(STATIC, 'index.html'), 'utf8');
  const regions = [...html.matchAll(/data-i18n-region="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(regions.length, 8);
  for (const region of regions) {
    const prefix = region.split(/\s+/)[0];
    assert.ok(I18n.M.en.regions[prefix], `missing region ${prefix}`);
  }
});

test('language resolution: URL > stored nsp.lang > browser language', () => {
  assert.equal(I18n.STORAGE_KEY, 'nsp.lang');
  assert.equal(I18n.resolveLang('en', 'zh', 'zh-CN'), 'en');
  assert.equal(I18n.resolveLang(null, 'en', 'zh-CN'), 'en');
  assert.equal(I18n.resolveLang('fr', 'bogus', 'zh-TW'), 'zh');
  assert.equal(I18n.resolveLang(null, null, 'en-GB'), 'en');
  assert.equal(I18n.resolveLang(null, null, ''), 'zh');
});

test('server labels and VPS region prefixes translate; unknown text passes through', () => {
  I18n.setLang('en', { persist: false });
  assert.equal(I18n.serverText('正常'), 'Normal');
  assert.equal(I18n.serverText('探测完成 · 终点未回应'), 'Probe complete · endpoint did not reply');
  assert.equal(I18n.serverText('美国 DMIT Premium'), 'US DMIT Premium');
  assert.equal(I18n.serverText('新加坡 Sakura Cloud'), 'Singapore Sakura Cloud');
  assert.equal(I18n.serverText('AS4134 中国电信'), 'AS4134 中国电信');
  I18n.setLang('zh', { persist: false });
  assert.equal(I18n.serverText('正常'), '正常');
});

const parentWindow = {};
const config = {
  parentWindow,
  monitorOrigin: 'https://monitor.siqiapparel.com',
  approvedOrigins: ['https://www.siqiapparel.com'],
  allowLoopback: false,
};
const langMessage = (overrides = {}) => ({
  source: parentWindow,
  origin: 'https://www.siqiapparel.com',
  data: { type: LANG_MESSAGE_TYPE, lang: 'en' },
  ...overrides,
});

test('lang message uses the shared protocol name and the same origin checks as theme', () => {
  assert.equal(LANG_MESSAGE_TYPE, I18n.LANG_MESSAGE_TYPE);
  assert.equal(isTrustedLangMessage(langMessage(), config), true);
  assert.equal(isTrustedLangMessage(langMessage({ data: { type: LANG_MESSAGE_TYPE, lang: 'zh' } }), config), true);
  assert.equal(isTrustedLangMessage(langMessage({ origin: 'https://evil.example.net' }), config), false);
  assert.equal(isTrustedLangMessage(langMessage({ source: {} }), config), false);
  assert.equal(isTrustedLangMessage(langMessage({ data: { type: LANG_MESSAGE_TYPE, lang: 'fr' } }), config), false);
  assert.equal(isTrustedLangMessage(langMessage({ data: { type: THEME_MESSAGE_TYPE, theme: 'light' } }), config), false);
  assert.equal(
    isTrustedThemeMessage(langMessage({ data: { type: THEME_MESSAGE_TYPE, theme: 'light' } }), config),
    true,
  );
});
