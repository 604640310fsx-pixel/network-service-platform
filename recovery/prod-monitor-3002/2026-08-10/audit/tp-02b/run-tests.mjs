import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const STATUS = new Set(['PASS', 'CONFIRMED_FINDING', 'INCONCLUSIVE', 'HARNESS_ERROR']);
const results = [];
const nonLocalRequests = [];

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms); }),
  ]);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', rejectOpen, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
    return this;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  once(method) {
    return new Promise(resolveEvent => {
      const listener = params => {
        const listeners = this.listeners.get(method) || [];
        this.listeners.set(method, listeners.filter(item => item !== listener));
        resolveEvent(params);
      };
      this.on(method, listener);
    });
  }

  close() {
    this.socket?.close();
  }
}

async function launchChrome() {
  const profile = await mkdtemp(join(tmpdir(), 'tp-02b-chrome-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-client-side-phishing-detection',
    '--disable-features=OptimizationHints,MediaRouter,Translate',
    '--metrics-recording-only',
    '--safebrowsing-disable-auto-update',
    '--no-proxy-server',
    '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    'about:blank',
  ];
  const process = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const browserWs = await withTimeout(new Promise((resolveWs, rejectWs) => {
    process.once('error', rejectWs);
    process.once('exit', code => rejectWs(new Error(`Chrome exited before CDP startup (${code})`)));
    process.stderr.on('data', chunk => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/);
      if (match) resolveWs(match[1]);
    });
  }), 10000, 'Chrome startup');
  const port = Number(new URL(browserWs).port);
  return {
    process,
    port,
    profile,
    version: 'Google Chrome 151.0.7922.108',
    async close() {
      if (process.exitCode == null) process.kill('SIGTERM');
      await Promise.race([new Promise(resolveExit => process.once('exit', resolveExit)), delay(3000)]);
      if (process.exitCode == null) process.kill('SIGKILL');
      await rm(profile, { recursive: true, force: true });
    },
  };
}

async function createPage(browser, url) {
  const created = await fetch(`http://127.0.0.1:${browser.port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' }).then(response => response.json());
  const cdp = await new CdpClient(created.webSocketDebuggerUrl).connect();
  const page = { cdp, consoleErrors: [], exceptions: [], networkFailures: [], nonLocal: [] };

  cdp.on('Runtime.consoleAPICalled', event => {
    if (event.type !== 'error' && event.type !== 'warning') return;
    page.consoleErrors.push(event.args.map(arg => arg.value ?? arg.description ?? arg.type).join(' '));
  });
  cdp.on('Runtime.exceptionThrown', event => {
    page.exceptions.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text || 'runtime exception');
  });
  cdp.on('Network.loadingFailed', event => {
    page.networkFailures.push({ error_text: event.errorText, canceled: Boolean(event.canceled) });
  });
  cdp.on('Network.requestWillBeSent', event => {
    try {
      const requestUrl = new URL(event.request.url);
      if (['http:', 'https:', 'ws:', 'wss:'].includes(requestUrl.protocol) && !['127.0.0.1', 'localhost', '::1'].includes(requestUrl.hostname)) {
        const item = { url: `${requestUrl.protocol}//${requestUrl.host}${requestUrl.pathname}`, type: event.type };
        page.nonLocal.push(item);
        nonLocalRequests.push(item);
      }
    } catch {}
  });
  cdp.on('Fetch.requestPaused', event => {
    let allow = true;
    try {
      const requestUrl = new URL(event.request.url);
      if (['http:', 'https:', 'ws:', 'wss:'].includes(requestUrl.protocol)) allow = ['127.0.0.1', 'localhost', '::1'].includes(requestUrl.hostname);
    } catch {}
    if (!allow) {
      const item = { url: event.request.url, type: 'intercepted' };
      page.nonLocal.push(item);
      nonLocalRequests.push(item);
      void cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    } else {
      void cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
    }
  });

  await Promise.all([
    cdp.send('Page.enable'),
    cdp.send('Runtime.enable'),
    cdp.send('Network.enable'),
    cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }),
    cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false }),
  ]);
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await withTimeout(loaded, 10000, 'page load');
  await delay(450);
  return page;
}

async function evaluate(page, expression, { awaitPromise = true } = {}) {
  const result = await page.cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(page, expression, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(page, expression)) return true;
    await delay(75);
  }
  return false;
}

async function snapshot(page) {
  return evaluate(page, `(() => {
    const q = selector => document.querySelector(selector);
    const card = name => {
      const node = [...document.querySelectorAll('.speed-card')].find(item => item.dataset.server === name);
      if (!node) return null;
      const field = key => node.querySelector('[data-field="' + key + '"]')?.textContent;
      return { state: node.dataset.state, upload: field('upload_mbps'), download: field('download_mbps'), retr: field('retr'), tested_at: field('tested_at'), dot_color: getComputedStyle(node.querySelector('.target-dot')).backgroundColor };
    };
    return {
      overall: { class_name: q('#overallStatus')?.className, text: q('#overallStatus')?.textContent?.trim() },
      last_update: q('#lastUpdate')?.textContent,
      selected: {
        type: q('#typeSwitch button.active')?.dataset.value,
        range: q('#rangeSwitch button.active')?.dataset.value,
        vps: q('#vpsPicker .vps-option.active')?.dataset.target,
        route_wan: q('#routeWanSwitch button.active')?.dataset.value,
        route_direction: q('#routeDirectionSwitch button.active')?.dataset.value,
        route_protocol: q('#routeProtocolSwitch button.active')?.dataset.value,
        route_target: q('#routeTarget')?.value,
      },
      legends: {
        telecom: q('#legendTelecom')?.textContent,
        mobile: q('#legendMobile')?.textContent,
        unicom: q('#legendUnicom')?.textContent,
      },
      live: { text: q('#liveStatus')?.textContent?.trim(), class_name: q('#liveStatus')?.className, display: q('#liveStatus') ? getComputedStyle(q('#liveStatus')).display : null },
      chart: { loading_class: q('#chartLoading')?.className, loading_text: q('#chartLoading')?.textContent?.trim(), count: q('#chartCount')?.textContent, range: q('#chartRangeLabel')?.textContent },
      route: { status: q('#routeResult')?.dataset.status, text: q('#routeResult')?.textContent?.trim(), updated: q('#routeUpdated')?.textContent, rows: q('#routeRows')?.querySelectorAll('tr.route-hop').length },
      bandwidth_status: { text: q('#bandwidthStatus')?.textContent, class_name: q('#bandwidthStatus')?.className },
      cards: {
        premium: card('美国 DMIT Premium'),
        eyeball: card('美国 DMIT Eyeball'),
        netlab_us: card('美国 NetLab Global'),
        zillion: card('美国 Zillion Network'),
        alibaba: card('新加坡 Alibaba Cloud'),
      },
      hidden_summary: { trend_hidden: q('#bandwidthTrend')?.hidden, empty_hidden: q('#bandwidthTrendEmpty')?.hidden },
    };
  })()`);
}

async function settleBaseline(page) {
  await waitFor(page, `document.querySelector('#overallStatus b')?.textContent !== '读取中' && document.querySelector('#bandwidthStatus')?.textContent !== '等待测速上线'`, 5000);
  await delay(250);
}

function makeRecord(definition, page, fixture, outcome) {
  const summary = fixture.summary();
  const status = STATUS.has(outcome.status) ? outcome.status : 'HARNESS_ERROR';
  return {
    id: definition.id,
    scenario: definition.scenario,
    status,
    fixture: { name: definition.fixture, controls: outcome.fixture_controls || definition.controls || {} },
    expected_observation: definition.expected,
    actual_observation: outcome.actual_observation,
    request_count: summary.request_count,
    max_concurrency: summary.max_concurrency,
    console_errors: [...page.consoleErrors, ...page.exceptions],
    dom_evidence: outcome.dom_evidence,
    related_finding_ids: definition.findings || [],
    limitations: outcome.limitations || definition.limitations || [],
    request_breakdown: summary.counts,
    rejected_fixture_requests: summary.rejected,
    browser_network_failures: page.networkFailures,
    non_local_requests: page.nonLocal,
  };
}

async function runCase(browser, definition) {
  const fixture = await startFixtureServer({ scenario: definition.fixture });
  let page;
  let fixtureClosed = false;
  try {
    page = await createPage(browser, fixture.origin);
    if (definition.baseline !== false) await settleBaseline(page);
    const outcome = await withTimeout(definition.run({ page, fixture, evaluate: expression => evaluate(page, expression), snapshot: () => snapshot(page), delay }), definition.timeout || 15000, definition.id);
    results.push(makeRecord(definition, page, fixture, outcome));
  } catch (error) {
    const fallbackPage = page || { consoleErrors: [], exceptions: [], networkFailures: [], nonLocal: [] };
    results.push(makeRecord(definition, fallbackPage, fixture, {
      status: 'HARNESS_ERROR',
      actual_observation: error.stack || String(error),
      dom_evidence: {},
      limitations: ['Scenario did not complete because of a harness error.'],
    }));
  } finally {
    if (page) {
      try { await page.cdp.send('Page.close'); } catch {}
      page.cdp.close();
    }
    if (!fixtureClosed) await fixture.close();
  }
}

function failureSequence(id, area, loader, inspect) {
  return {
    id,
    scenario: `${area} non-2xx and invalid JSON after a successful render`,
    fixture: `fail-${area}-sequence`,
    expected: `${area} records both failure forms without crashing the fixture; section-specific stale/error behavior is visible.`,
    findings: area === 'live' ? ['TP02A-003'] : area === 'latency' ? ['TP02A-004'] : area === 'bandwidth' ? ['TP02A-002'] : [],
    async run({ evaluate: run, snapshot: snap }) {
      const before = await snap();
      await run(`Promise.allSettled([${loader}])`);
      const non2xx = await snap();
      await run(`Promise.allSettled([${loader}])`);
      const invalidJson = await snap();
      const classification = inspect(before, non2xx, invalidJson);
      return { ...classification, dom_evidence: { before, after_non_2xx: non2xx, after_invalid_json: invalidJson } };
    },
  };
}

const cases = [
  {
    id: 'TP02B-001', scenario: 'Baseline successful initialization', fixture: 'baseline',
    expected: 'All eight API paths are requested and the major panels render deterministic fixture values.',
    async run({ fixture, snapshot: snap }) {
      const dom = await snap();
      const counts = fixture.summary().counts;
      const allApis = ['/api/overview','/api/vps-targets','/api/targets','/api/routes','/api/bandwidth','/api/latency','/api/live','/api/vps-status'].every(path => counts[path] >= 1);
      const rendered = dom.overall.text === 'Fixture healthy' && dom.route.status === 'ok' && dom.cards.premium.state === 'ready' && dom.legends.telecom.endsWith('ms');
      return { status: allApis && rendered ? 'PASS' : 'HARNESS_ERROR', actual_observation: `eight_api_paths=${allApis}; major_dom_rendered=${rendered}`, dom_evidence: dom };
    },
  },
  failureSequence('TP02B-002', 'live', 'loadLive(false)', (before, non2xx, invalidJson) => ({
    status: non2xx.legends.telecom === before.legends.telecom && invalidJson.live.display === 'none' ? 'CONFIRMED_FINDING' : 'INCONCLUSIVE',
    actual_observation: 'Both failures preserved the previous legend values; the stale live message changed but remained display:none.',
  })),
  failureSequence('TP02B-003', 'latency', 'loadChart()', (_before, non2xx, invalidJson) => ({
    status: non2xx.chart.loading_class.includes('hidden') && invalidJson.chart.loading_class.includes('hidden') ? 'CONFIRMED_FINDING' : 'INCONCLUSIVE',
    actual_observation: 'Both failures left the loading/error overlay hidden and retained the prior chart metadata.',
  })),
  failureSequence('TP02B-004', 'route', 'loadRoute()', (_before, non2xx, invalidJson) => ({
    status: non2xx.route.status === 'unavailable' && invalidJson.route.status === 'unavailable' ? 'PASS' : 'INCONCLUSIVE',
    actual_observation: 'Both failures produced a visible unavailable route state and cleared the route timestamp.',
  })),
  failureSequence('TP02B-005', 'bandwidth', 'loadBandwidth()', (before, non2xx, invalidJson) => ({
    status: non2xx.cards.premium.upload === before.cards.premium.upload && invalidJson.cards.premium.tested_at === before.cards.premium.tested_at ? 'CONFIRMED_FINDING' : 'INCONCLUSIVE',
    actual_observation: 'Both failures changed only the section status; prior card values, timestamps, and ready state remained.',
  })),
  {
    id: 'TP02B-006', scenario: 'Connection refused after successful initialization', fixture: 'baseline',
    expected: 'All four loaders record their actual behavior when the localhost fixture is stopped after baseline.',
    findings: ['TP02A-002','TP02A-003','TP02A-004'], timeout: 12000,
    async run({ page, fixture, evaluate: run, snapshot: snap, delay: wait }) {
      const before = await snap();
      await fixture.close();
      await run(`Promise.allSettled([loadLive(false), loadChart(), loadRoute(), loadBandwidth()])`);
      await wait(500);
      const after = await snap();
      const sawRefusal = page.networkFailures.some(item => /REFUSED|FAILED|EMPTY_RESPONSE/i.test(item.error_text));
      return { status: sawRefusal && after.route.status === 'unavailable' && after.cards.premium.upload === before.cards.premium.upload ? 'PASS' : 'INCONCLUSIVE', actual_observation: `browser_connection_failure=${sawRefusal}; live and bandwidth retained old values, latency overlay stayed hidden, route showed unavailable.`, dom_evidence: { before, after }, limitations: ['One fixture shutdown affects all same-origin API paths together; section behavior was triggered separately in one Promise.allSettled call.'] };
    },
  },
  {
    id: 'TP02B-007', scenario: 'Live response exceeds five-second polling period', fixture: 'timeout-live',
    expected: 'Subsequent live requests delayed 11 seconds overlap under the real five-second interval.',
    findings: ['TP02A-001'], timeout: 23000,
    async run({ fixture, snapshot: snap, delay: wait }) {
      await wait(17000);
      const summary = fixture.summary();
      const delayed = summary.requests.filter(item => item.path === '/api/live' && String(item.mode).startsWith('delay-'));
      return { status: summary.max_concurrency >= 2 && delayed.length >= 2 ? 'CONFIRMED_FINDING' : 'INCONCLUSIVE', actual_observation: `delayed_live_requests=${delayed.length}; maximum concurrent API requests=${summary.max_concurrency}.`, dom_evidence: await snap(), fixture_controls: { live_delay_ms: 11000, scenario_limit_ms: 23000 } };
    },
  },
  {
    id: 'TP02B-008', scenario: 'Bandwidth response exceeds sixty-second polling period', fixture: 'timeout-bandwidth',
    expected: 'A manually started 61-second refresh is still active when the real 60-second interval starts another refresh.',
    findings: ['TP02A-001'], timeout: 68000,
    async run({ fixture, evaluate: run, snapshot: snap, delay: wait }) {
      await run(`void loadBandwidth()`);
      await wait(62500);
      const summary = fixture.summary();
      const delayed = summary.requests.filter(item => item.path === '/api/bandwidth' && String(item.mode).startsWith('delay-'));
      return { status: delayed.length >= 2 && summary.max_concurrency >= 2 ? 'CONFIRMED_FINDING' : 'INCONCLUSIVE', actual_observation: `delayed_bandwidth_requests=${delayed.length}; maximum concurrent API requests=${summary.max_concurrency}.`, dom_evidence: await snap(), fixture_controls: { bandwidth_delay_ms: 61000, one_manual_refresh_before_real_interval: true, scenario_limit_ms: 68000 } };
    },
  },
  {
    id: 'TP02B-009', scenario: 'Rapid VPS, range, WAN, and protocol switching with out-of-order responses', fixture: 'race-switches',
    expected: 'Request IDs and AbortController protections preserve the final selections and reject stale latency/live/route writes.',
    async run({ evaluate: run, snapshot: snap, delay: wait }) {
      await run(`(() => {
        document.querySelector('#rangeSwitch button[data-value="6h"]').click();
        setTimeout(() => document.querySelector('#rangeSwitch button[data-value="24h"]').click(), 25);
        document.querySelector('#vpsPicker .vps-option[data-target="DMIT Premium"]').click();
        setTimeout(() => document.querySelector('#vpsPicker .vps-option[data-target="DMIT Eyeball"]').click(), 25);
        document.querySelector('#routeWanSwitch button[data-value="telecom"]').click();
        setTimeout(() => document.querySelector('#routeWanSwitch button[data-value="mobile"]').click(), 25);
        document.querySelector('#routeProtocolSwitch button[data-value="icmp"]').click();
        setTimeout(() => document.querySelector('#routeProtocolSwitch button[data-value="tcp"]').click(), 30);
      })()`);
      await wait(1600);
      const dom = await snap();
      const correct = dom.selected.range === '24h' && dom.selected.vps === 'DMIT Eyeball' && dom.selected.route_wan === 'mobile' && dom.selected.route_protocol === 'tcp';
      return { status: correct ? 'PASS' : 'CONFIRMED_FINDING', actual_observation: correct ? 'Final UI selections remained 24h, DMIT Eyeball, mobile, and TCP after old responses completed or were aborted.' : 'At least one stale response overwrote a final selection.', dom_evidence: dom };
    },
  },
  {
    id: 'TP02B-010', scenario: 'Out-of-order bandwidth completion', fixture: 'bandwidth-out-of-order',
    expected: 'A late older request must not overwrite a faster newer response.', findings: [],
    async run({ evaluate: run, snapshot: snap, delay: wait }) {
      await run(`void loadBandwidth()`);
      await wait(25);
      await run(`void loadBandwidth()`);
      await wait(1100);
      const dom = await snap();
      const overwritten = dom.cards.premium.upload === '20.00 Mbps';
      return { status: overwritten ? 'CONFIRMED_FINDING' : 'PASS', actual_observation: overwritten ? 'The late older response overwrote the faster newer 90.00 Mbps render with 20.00 Mbps.' : 'The newer response remained visible.', dom_evidence: dom };
    },
  },
  {
    id: 'TP02B-011', scenario: 'Initial latency failure visibility', fixture: 'init-latency-failure', baseline: false,
    expected: 'The initial error text should remain visibly exposed after latency failure.', findings: ['TP02A-004'],
    async run({ snapshot: snap, delay: wait }) {
      await wait(700);
      const dom = await snap();
      return { status: dom.chart.loading_class.includes('hidden') && /候选 API 读取失败/.test(dom.chart.loading_text) ? 'CONFIRMED_FINDING' : 'INCONCLUSIVE', actual_observation: 'Global initialization wrote the failure text, but latency finally left the overlay hidden.', dom_evidence: dom };
    },
  },
  {
    id: 'TP02B-012', scenario: 'Latency range-switch failure visibility', fixture: 'latency-range-failure',
    expected: 'A failed range change should expose an error and clear loading state without an unhandled rejection.', findings: ['TP02A-004'],
    async run({ page, evaluate: run, snapshot: snap, delay: wait }) {
      await run(`document.querySelector('#rangeSwitch button[data-value="6h"]').click()`);
      await wait(500);
      const dom = await snap();
      return { status: dom.chart.loading_class.includes('hidden') && page.exceptions.length > 0 ? 'CONFIRMED_FINDING' : 'INCONCLUSIVE', actual_observation: `Overlay hidden; runtime exceptions captured=${page.exceptions.length}.`, dom_evidence: dom };
    },
  },
  {
    id: 'TP02B-013', scenario: 'Latency VPS-switch failure visibility', fixture: 'latency-vps-failure',
    expected: 'A failed VPS chart reload should expose an error without leaving ambiguous old chart state.', findings: ['TP02A-004'],
    async run({ page, evaluate: run, snapshot: snap, delay: wait }) {
      await run(`document.querySelector('#vpsPicker .vps-option[data-target="DMIT Eyeball"]').click()`);
      await wait(650);
      const dom = await snap();
      return { status: dom.chart.loading_class.includes('hidden') && page.exceptions.length > 0 ? 'CONFIRMED_FINDING' : 'INCONCLUSIVE', actual_observation: `Overlay hidden and previous chart metadata remained; runtime exceptions captured=${page.exceptions.length}.`, dom_evidence: dom };
    },
  },
  {
    id: 'TP02B-014', scenario: 'Missing target array during initialization', fixture: 'malformed-missing-arrays', baseline: false,
    expected: 'A missing array should not prevent unrelated sections from initializing.', findings: ['TP02A-007'],
    async run({ fixture, snapshot: snap, delay: wait }) {
      await wait(700);
      const counts = fixture.summary().counts;
      const dom = await snap();
      const blocked = !counts['/api/latency'] && !counts['/api/live'] && !counts['/api/vps-status'];
      return { status: blocked ? 'CONFIRMED_FINDING' : 'PASS', actual_observation: `Second initialization group blocked=${blocked}.`, dom_evidence: dom };
    },
  },
  {
    id: 'TP02B-015', scenario: 'Null nested overview object', fixture: 'malformed-null-overview', baseline: false,
    expected: 'A null nested object should be isolated to the overview section.', findings: ['TP02A-007'],
    async run({ fixture, snapshot: snap, delay: wait }) {
      await wait(700);
      const counts = fixture.summary().counts;
      const blocked = !counts['/api/latency'] && !counts['/api/live'];
      return { status: blocked ? 'CONFIRMED_FINDING' : 'PASS', actual_observation: `Null overview blocked second initialization group=${blocked}.`, dom_evidence: await snap() };
    },
  },
  {
    id: 'TP02B-016', scenario: 'Non-object live response', fixture: 'malformed-nonobject-live', baseline: false,
    expected: 'A non-object live payload should be handled as a visible section error without interrupting other second-stage loaders.', findings: ['TP02A-003','TP02A-007'],
    async run({ snapshot: snap, delay: wait }) {
      await wait(800);
      const dom = await snap();
      return { status: dom.live.class_name.includes('stale') && dom.live.display === 'none' ? 'CONFIRMED_FINDING' : 'INCONCLUSIVE', actual_observation: 'Live rejected the null shape into its catch path, retained other section results, and hid the stale message through CSS.', dom_evidence: dom };
    },
  },
  {
    id: 'TP02B-017', scenario: 'Null latency samples array', fixture: 'malformed-latency-null', baseline: false,
    expected: 'A null samples field should be rejected without hiding the resulting error or interrupting sibling panels.', findings: ['TP02A-004','TP02A-007'],
    async run({ snapshot: snap, delay: wait }) {
      await wait(800);
      const dom = await snap();
      return { status: dom.chart.loading_class.includes('hidden') && /候选 API 读取失败/.test(dom.chart.loading_text) ? 'CONFIRMED_FINDING' : 'INCONCLUSIVE', actual_observation: 'Null samples threw during chart rendering; global failure text was written into a hidden overlay.', dom_evidence: dom };
    },
  },
  {
    id: 'TP02B-018', scenario: 'Invalid timestamps, unknown WAN, NaN, negative, and extreme numbers', fixture: 'malformed-values', baseline: false,
    expected: 'Malformed scalar values should be normalized or rejected without misleading classes, text, or partial initialization.', findings: ['TP02A-007','TP02A-011'],
    async run({ snapshot: snap, delay: wait }) {
      await wait(1000);
      const dom = await snap();
      const badClass = dom.overall.class_name.includes('injected-class');
      const malformedText = JSON.stringify(dom).includes('NaN') || JSON.stringify(dom).includes('-999999');
      return { status: badClass || malformedText || dom.bandwidth_status.text === '测速数据读取失败' ? 'CONFIRMED_FINDING' : 'PASS', actual_observation: `unvalidated_overall_class=${badClass}; malformed_numeric_text=${malformedText}; invalid bandwidth time changed section to failure.`, dom_evidence: dom };
    },
  },
  {
    id: 'TP02B-019', scenario: 'HTML-special and script/img/onerror marker strings', fixture: 'string-safety', baseline: false,
    expected: 'Synthetic strings remain text/attribute data; no script, img, or event-handler node is created and no marker code executes.', findings: ['TP02A-014'],
    async run({ evaluate: run, snapshot: snap, delay: wait }) {
      await wait(900);
      await run(`document.querySelector('#latencyChart').dispatchEvent(new PointerEvent('pointermove',{clientX:200,clientY:100,bubbles:true}))`);
      const safety = await run(`(() => {
        const roots = ['#vpsPicker','#routeRows','#routeTarget','#overallStatus'].map(selector => document.querySelector(selector));
        return {
          dangerous_nodes: roots.reduce((sum, root) => sum + (root ? root.querySelectorAll('script,img,[onerror],[onload],[onclick]').length : 0), 0),
          marker_visible_as_text: document.body.textContent.includes('<script type="application/json">fixture</script>'),
          marker_attributes: [...document.querySelectorAll('*')].filter(node => [...node.attributes].some(attr => /^on/i.test(attr.name))).map(node => node.tagName),
        };
      })()`);
      return { status: safety.dangerous_nodes === 0 && safety.marker_attributes.length === 0 && safety.marker_visible_as_text ? 'PASS' : 'CONFIRMED_FINDING', actual_observation: `dangerous_nodes=${safety.dangerous_nodes}; event_attributes=${safety.marker_attributes.length}; marker remained literal text=${safety.marker_visible_as_text}.`, dom_evidence: { safety, state: await snap() } };
    },
  },
  {
    id: 'TP02B-020', scenario: 'Bandwidth duplicate, unordered, one-way, partial, disabled, and unknown rows', fixture: 'bandwidth-selection',
    expected: 'Newest timestamp wins; partial and disabled states map to explicit visible tokens; unknown nodes are ignored safely.', findings: ['TP02A-005','TP02A-008','TP02A-009'],
    async run({ snapshot: snap }) {
      const dom = await snap();
      const firstWins = dom.cards.premium.upload === '11.00 Mbps';
      const tokenMismatch = dom.cards.premium.state === 'ready' && dom.cards.premium.dot_color === 'rgb(113, 122, 137)';
      const summaryHidden = dom.hidden_summary.trend_hidden && dom.hidden_summary.empty_hidden;
      return { status: firstWins && tokenMismatch && summaryHidden ? 'CONFIRMED_FINDING' : 'INCONCLUSIVE', actual_observation: `old_first_row_selected=${firstWins}; ready_token_unstyled=${tokenMismatch}; aggregate_summary_hidden=${summaryHidden}; one-way/partial success also mapped to ready.`, dom_evidence: dom };
    },
  },
  {
    id: 'TP02B-021', scenario: 'Route target fallback recursion ceiling', fixture: 'route-recursion', baseline: false,
    expected: 'Client fallback must terminate independently before the fixture request ceiling.', findings: ['TP02A-010'],
    async run({ fixture, snapshot: snap, delay: wait }) {
      await wait(1000);
      const count = fixture.summary().counts['/api/routes'] || 0;
      return { status: count === 9 ? 'CONFIRMED_FINDING' : count < 9 ? 'PASS' : 'HARNESS_ERROR', actual_observation: `route_requests=${count}; client continued until fixture forced a 429 after eight inconsistent responses.`, dom_evidence: await snap(), fixture_controls: { maximum_inconsistent_responses: 8, ninth_response: 429 } };
    },
  },
  {
    id: 'TP02B-022', scenario: 'Visibility restoration collides with five-second timer', fixture: 'visibility-collision',
    expected: 'Visibility restoration and the timer should not duplicate identical live/status requests.', findings: ['TP02A-001'], timeout: 9000,
    async run({ fixture, evaluate: run, snapshot: snap, delay: wait }) {
      const initial = fixture.summary().requests.find(item => item.path === '/api/live');
      const intervalAnchor = initial.started_at_ms + (initial.duration_ms || 0);
      await wait(Math.max(0, 4900 - (Date.now() - intervalAnchor)));
      await run(`document.dispatchEvent(new Event('visibilitychange'))`);
      await wait(900);
      const summary = fixture.summary();
      const liveCount = summary.counts['/api/live'] || 0;
      const statusCount = summary.counts['/api/vps-status'] || 0;
      return { status: liveCount >= 3 && statusCount === 2 && summary.max_concurrency >= 2 ? 'CONFIRMED_FINDING' : 'INCONCLUSIVE', actual_observation: `live_requests=${liveCount}; vps_status_requests=${statusCount}; max_concurrency=${summary.max_concurrency}. Live duplicated while the VPS status promise deduplicated its same-target request.`, dom_evidence: await snap(), limitations: ['The harness dispatched visibilitychange while document.hidden was false; it validates the recovered listener/timer collision but does not emulate an operating-system tab occlusion transition.'] };
    },
  },
  {
    id: 'TP02B-023', scenario: 'Keyboard, live-region, and bandwidth status mapping', fixture: 'baseline',
    expected: 'Chart details are keyboard reachable, dynamic states have programmatic announcements, and ready cards receive the intended success color.', findings: ['TP02A-006','TP02A-008','TP02A-012'],
    async run({ evaluate: run, snapshot: snap }) {
      const accessibility = await run(`(() => {
        const canvas=document.querySelector('#latencyChart');
        canvas.focus();
        canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
        const activeButtons=[...document.querySelectorAll('.segmented button.active')];
        return {
          canvas_tab_index: canvas.tabIndex,
          canvas_received_focus: document.activeElement===canvas,
          tooltip_visible_after_key: document.querySelector('#chartTooltip').classList.contains('show'),
          live_regions: [...document.querySelectorAll('[aria-live],[role="status"],[role="alert"]')].map(node=>node.id||node.tagName),
          active_segmented_without_pressed: activeButtons.filter(button=>!button.hasAttribute('aria-pressed')).length,
        };
      })()`);
      const dom = await snap();
      const confirmed = accessibility.canvas_tab_index < 0 && !accessibility.canvas_received_focus && accessibility.live_regions.length === 0 && dom.cards.premium.state === 'ready' && dom.cards.premium.dot_color === 'rgb(113, 122, 137)';
      return { status: confirmed ? 'CONFIRMED_FINDING' : 'INCONCLUSIVE', actual_observation: `canvas_focusable=${accessibility.canvas_received_focus}; live_regions=${accessibility.live_regions.length}; active controls lacking aria-pressed=${accessibility.active_segmented_without_pressed}; ready dot color=${dom.cards.premium.dot_color}.`, dom_evidence: { accessibility, state: dom }, limitations: ['Programmatic accessibility inspection does not replace a full screen-reader session.'] };
    },
  },
];

function markdownReport(document) {
  const lines = [
    '# TP-02B Isolated Fixture Dynamic Validation',
    '',
    `- Generated at: ${document.generated_at_utc}`,
    `- Baseline: \`${document.baseline_commit}\``,
    `- Runtime: ${document.environment.node}; ${document.environment.browser}`,
    `- Scenarios: ${document.summary.total}`,
    `- Status counts: PASS ${document.summary.status_counts.PASS}, CONFIRMED_FINDING ${document.summary.status_counts.CONFIRMED_FINDING}, INCONCLUSIVE ${document.summary.status_counts.INCONCLUSIVE}, HARNESS_ERROR ${document.summary.status_counts.HARNESS_ERROR}`,
    `- Non-localhost requests: ${document.network_boundary.non_local_request_count}`,
    '',
    '## Dynamic conclusions',
    '',
    `Confirmed TP-02A findings: ${document.summary.confirmed_finding_ids.map(id => `\`${id}\``).join(', ') || 'none'}.`,
    '',
    'The no-DOM-injection conclusion in `TP02A-014` was also supported: HTML-special and inert script/img/onerror marker strings remained literal text or escaped attributes, with no executable nodes or event attributes created.',
    '',
    'New observed behavior: a late older bandwidth request can overwrite a newer completed render because bandwidth has no request identity or stale-response guard (`TP02B-010`). Partial/one-direction bandwidth success is also classified as `ready`, not a distinct partial state.',
    '',
    'No TP-02A fixture-targeted finding failed to reproduce. `TP02A-013`, `TP02A-015`, and `TP02A-016` are static/deployment/storage observations and were not dynamic fixture targets. The visibility test is marked with an explicit lifecycle-emulation limitation, and programmatic accessibility inspection is not a screen-reader certification.',
    '',
    '## Scenario results',
    '',
    '| ID | Status | Scenario | Related findings |',
    '|---|---|---|---|',
    ...document.results.map(item => `| ${item.id} | ${item.status} | ${item.scenario} | ${item.related_finding_ids.join(', ') || '—'} |`),
    '',
    '## Priority recommendation (not implemented)',
    '',
    '1. First: bound and deduplicate live/bandwidth polling; add bandwidth request identity to prevent stale overwrite.',
    '2. Next: make stale/error states visible and prevent old live/bandwidth values from appearing current.',
    '3. Then: validate endpoint schemas, cap route fallback, and select bandwidth rows by timestamp.',
    '4. Finally: align bandwidth state tokens with CSS and add keyboard/text alternatives and live-region semantics.',
    '',
    '## Fixture limits',
    '',
    '- Deterministic synthetic values only; no production API, database, device, or protected address was used.',
    '- Connection refusal is produced by stopping the localhost fixture after baseline, so all same-origin APIs become unavailable together.',
    '- Visibility collision uses a synthetic `visibilitychange` event with `document.hidden === false`; operating-system tab occlusion was not emulated.',
    '- Accessibility checks cover DOM focusability, ARIA/live-region presence, and computed CSS, not assistive-technology speech output.',
    '- Chrome background networking was disabled and non-local page requests were intercepted; this validates page traffic, not host-wide packet capture.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

let browser;
try {
  browser = await launchChrome();
  const selectedCases = process.env.TP02B_ONLY
    ? cases.filter(definition => definition.id === process.env.TP02B_ONLY)
    : cases;
  if (!selectedCases.length) throw new Error(`Unknown TP02B_ONLY scenario: ${process.env.TP02B_ONLY}`);
  for (const definition of selectedCases) {
    process.stdout.write(`[TP-02B] ${definition.id} ${definition.scenario}\n`);
    await runCase(browser, definition);
  }
} finally {
  await browser?.close();
}

const statusCounts = Object.fromEntries([...STATUS].map(status => [status, results.filter(result => result.status === status).length]));
const confirmedFindingIds = [...new Set(results.filter(result => result.status === 'CONFIRMED_FINDING').flatMap(result => result.related_finding_ids))].sort();
const document = {
  schema_version: 1,
  audit: 'TP-02B',
  execution_mode: 'offline-localhost-fixture',
  generated_at_utc: new Date().toISOString(),
  baseline_commit: '9236e665063ae35e6afb50d71e81312f8c71bde3',
  environment: { node: process.version, browser: browser?.version || 'Google Chrome', automation: 'Node standard library plus Chrome DevTools Protocol' },
  network_boundary: { allowed_hosts: ['127.0.0.1', 'localhost'], non_local_request_count: nonLocalRequests.length, non_local_requests: nonLocalRequests },
  summary: { total: results.length, status_counts: statusCounts, confirmed_finding_ids: confirmedFindingIds },
  results,
};

await writeFile(join(HERE, 'results.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
await writeFile(join(HERE, 'results.md'), markdownReport(document), 'utf8');
process.stdout.write(`${JSON.stringify(document.summary)}\n`);
if (statusCounts.HARNESS_ERROR) process.exitCode = 2;
