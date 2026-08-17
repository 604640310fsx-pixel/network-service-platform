import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(HERE, '../../raw');
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const API_PATHS = new Set([
  '/api/overview',
  '/api/vps-targets',
  '/api/targets',
  '/api/routes',
  '/api/bandwidth',
  '/api/latency',
  '/api/live',
  '/api/vps-status',
]);

const rawFiles = {
  '/': { path: resolve(RAW_DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  '/master.css': { path: resolve(RAW_DIR, 'master.css'), type: 'text/css; charset=utf-8' },
  '/app.js': { path: resolve(RAW_DIR, 'app.js'), type: 'text/javascript; charset=utf-8' },
};

const FIXED_TIME = '2026-08-10T00:00:00.000Z';
const NEWER_TIME = '2026-08-10T00:05:00.000Z';
const OLDER_TIME = '2026-08-09T23:55:00.000Z';

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

function localAddress(value) {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function latencyPayload(url, overrides = {}) {
  const type = url.searchParams.get('type') || 'icmp';
  const target = url.searchParams.get('target') || 'DMIT Premium';
  const range = url.searchParams.get('range') || '24h';
  const samples = [
    { wan: 'telecom', success: true, timestamp: OLDER_TIME, avg_ms: 21.25, max_ms: 25.5, loss_percent: 0 },
    { wan: 'mobile', success: true, timestamp: OLDER_TIME, avg_ms: 31.5, max_ms: 35.5, loss_percent: 0 },
    { wan: 'unicom', success: false, timestamp: OLDER_TIME, avg_ms: null, max_ms: null, loss_percent: 100 },
    { wan: 'telecom', success: true, timestamp: FIXED_TIME, avg_ms: 22.25, max_ms: 26.5, loss_percent: 0 },
    { wan: 'mobile', success: true, timestamp: FIXED_TIME, avg_ms: 32.5, max_ms: 36.5, loss_percent: 0 },
    { wan: 'unicom', success: true, timestamp: FIXED_TIME, avg_ms: 42.75, max_ms: 46.5, loss_percent: 0 },
  ];
  return { type, target, range, count: samples.length, bucket_seconds: 300, samples, ...overrides };
}

function livePayload(url, marker = 0) {
  return {
    type: url.searchParams.get('type') || 'icmp',
    target: url.searchParams.get('target') || 'DMIT Premium',
    latest_timestamp: marker ? NEWER_TIME : FIXED_TIME,
    items: [
      { wan: 'telecom', success: true, avg_ms: 20 + marker, loss_percent: 0 },
      { wan: 'mobile', success: true, avg_ms: 30 + marker, loss_percent: 0 },
      { wan: 'unicom', success: true, avg_ms: 40 + marker, loss_percent: 0 },
    ],
  };
}

function routePayload(url, overrides = {}) {
  const query = {
    wan: url.searchParams.get('wan') || 'telecom',
    direction: url.searchParams.get('direction') || 'outbound',
    protocol: url.searchParams.get('protocol') || 'icmp',
    target_name: url.searchParams.get('target_name') || 'DMIT Premium',
  };
  const hops = Array.from({ length: 6 }, (_, index) => ({
    hop: index + 1,
    ip: `192.0.2.${index + 1}`,
    latency_ms: 4.5 + index,
    location: `Fixture Location ${index + 1}`,
    asn: 64500 + index,
    reverse: `hop-${index + 1}.fixture.invalid`,
    reverse_display: `fixture-hop-${index + 1}`,
    quality: index === 2 ? 'premium' : 'standard',
    premium_matches: index === 2 ? ['asn'] : [],
  }));
  return {
    query,
    targets: [
      { target_name: query.target_name, display_name: `Fixture ${query.target_name}` },
      { target_name: 'DMIT Eyeball', display_name: 'Fixture VPS B' },
    ],
    summary: { status: 'ok', label: 'Fixture route ready', hop_count: hops.length, final_latency_ms: 9.5 },
    item: { timestamp: FIXED_TIME },
    hops,
    ...overrides,
  };
}

function bandwidthRow(server_name, direction, receiver_mbps, timestamp = FIXED_TIME, extra = {}) {
  return { server_name, direction, receiver_mbps, sender_mbps: receiver_mbps, retransmits: 1, completed: 1, error: null, timestamp, ...extra };
}

function baselineBandwidth(marker = 0) {
  const names = ['dmit-premium', 'dmit-eyeball', 'netlab-us', 'zillion-us', 'evoxt-my', 'netlab-hk', 'yecaoyun-hk1'];
  return {
    items: names.flatMap((name, index) => [
      bandwidthRow(name, 'upload', 40 + index + marker),
      bandwidthRow(name, 'download', 80 + index + marker),
    ]),
  };
}

function baseline(pathname, url) {
  switch (pathname) {
    case '/api/overview':
      return { body: { overall: { status: 'healthy', label: 'Fixture healthy' }, latest_update: FIXED_TIME } };
    case '/api/vps-targets':
      return { body: { targets: [
        { target_name: 'DMIT Premium', display_name: 'Fixture VPS A', has_data: true },
        { target_name: 'DMIT Eyeball', display_name: 'Fixture VPS B', has_data: true },
      ] } };
    case '/api/targets':
      return { body: { targets: [
        { target_name: 'DMIT Premium' },
        { target_name: 'DMIT Eyeball' },
        { target_name: 'AliDNS' },
      ] } };
    case '/api/routes':
      return { body: routePayload(url) };
    case '/api/bandwidth':
      return { body: baselineBandwidth() };
    case '/api/latency':
      return { body: latencyPayload(url) };
    case '/api/live':
      return { body: livePayload(url) };
    case '/api/vps-status':
      return { body: {
        target: url.searchParams.get('target') || 'DMIT Premium',
        source_status: 'ok',
        fresh: true,
        item: { online: true, uptime_seconds: 90061, cpu_percent: 12.5, memory_percent: 34.5, storage_percent: 56.5, upload_bytes_per_second: 123456, download_bytes_per_second: 654321 },
      } };
    default:
      return { status: 404, body: { error: 'unmatched fixture path' } };
  }
}

function scenarioReply(name, pathname, url, count) {
  const ordinary = baseline(pathname, url);

  if (name === 'fail-live-sequence' && pathname === '/api/live' && count > 1) {
    return count === 2 ? { status: 503, body: { error: 'fixture failure' } } : { invalidJson: true };
  }
  if (name === 'fail-latency-sequence' && pathname === '/api/latency' && count > 1) {
    return count === 2 ? { status: 503, body: { error: 'fixture failure' } } : { invalidJson: true };
  }
  if (name === 'fail-route-sequence' && pathname === '/api/routes' && count > 1) {
    return count === 2 ? { status: 503, body: { error: 'fixture failure' } } : { invalidJson: true };
  }
  if (name === 'fail-bandwidth-sequence' && pathname === '/api/bandwidth' && count > 1) {
    return count === 2 ? { status: 503, body: { error: 'fixture failure' } } : { invalidJson: true };
  }
  if (name === 'init-latency-failure' && pathname === '/api/latency') return { status: 503, body: { error: 'fixture failure' } };
  if ((name === 'latency-range-failure' || name === 'latency-vps-failure') && pathname === '/api/latency' && count > 1) {
    return { status: 503, body: { error: 'fixture failure' } };
  }
  if (name === 'timeout-live' && pathname === '/api/live' && count > 1) return { ...ordinary, delayMs: 11000 };
  if (name === 'timeout-bandwidth' && pathname === '/api/bandwidth' && count > 1) return { ...ordinary, delayMs: 61000 };
  if (name === 'visibility-collision' && (pathname === '/api/live' || pathname === '/api/vps-status') && count > 1) {
    return { ...ordinary, delayMs: 350 };
  }
  if (name === 'race-switches') {
    if (pathname === '/api/latency') {
      const slow = url.searchParams.get('range') === '6h' || url.searchParams.get('target') === 'DMIT Premium';
      return { body: latencyPayload(url), delayMs: count > 1 && slow ? 900 : 40 };
    }
    if (pathname === '/api/live') {
      const slow = url.searchParams.get('target') === 'DMIT Premium';
      return { body: livePayload(url, slow ? 1 : 7), delayMs: count > 1 && slow ? 900 : 40 };
    }
    if (pathname === '/api/routes') {
      const slow = url.searchParams.get('wan') === 'telecom' || url.searchParams.get('protocol') === 'icmp';
      return { body: routePayload(url), delayMs: count > 1 && slow ? 900 : 40 };
    }
  }
  if (name === 'bandwidth-out-of-order' && pathname === '/api/bandwidth' && count > 1) {
    return count === 2
      ? { body: baselineBandwidth(-20), delayMs: 900 }
      : { body: baselineBandwidth(50), delayMs: 50 };
  }
  if (name === 'malformed-missing-arrays' && pathname === '/api/vps-targets') return { body: {} };
  if (name === 'malformed-null-overview' && pathname === '/api/overview') return { body: { overall: null, latest_update: null } };
  if (name === 'malformed-nonobject-live' && pathname === '/api/live') return { body: null };
  if (name === 'malformed-latency-null' && pathname === '/api/latency') return { body: { ...latencyPayload(url), samples: null } };
  if (name === 'malformed-values') {
    if (pathname === '/api/overview') return { body: { overall: { status: 'healthy injected-class', label: null }, latest_update: FIXED_TIME } };
    if (pathname === '/api/live') return { body: { latest_timestamp: 'not-a-time', items: [
      { wan: 'telecom', success: true, avg_ms: 'NaN', loss_percent: -1 },
      { wan: 'mobile', success: true, avg_ms: -999999, loss_percent: 999999 },
      { wan: 'unknown-wan', success: true, avg_ms: 1e300, loss_percent: 0 },
    ] } };
    if (pathname === '/api/latency') return { body: latencyPayload(url, { samples: [
      { wan: 'unknown-wan', success: true, timestamp: 'not-a-time', avg_ms: 'NaN', max_ms: 1e300, loss_percent: -1 },
      { wan: 'telecom', success: true, timestamp: 'not-a-time', avg_ms: -100, max_ms: 1e300, loss_percent: 999999 },
    ], count: 2 }) };
    if (pathname === '/api/vps-status') return { body: { target: 'DMIT Premium', fresh: true, item: { online: true, uptime_seconds: -1, cpu_percent: 'NaN', memory_percent: -500, storage_percent: 1e300, upload_bytes_per_second: -1, download_bytes_per_second: 1e300 } } };
    if (pathname === '/api/bandwidth') return { body: { items: [bandwidthRow('dmit-premium', 'upload', 50, 'not-a-time')] } };
  }
  if (name === 'string-safety') {
    const marker = `&<>'\" <script type=\"application/json\">fixture</script> <img src=\"data:,\" onerror>`;
    if (pathname === '/api/overview') return { body: { overall: { status: 'healthy', label: marker }, latest_update: FIXED_TIME } };
    if (pathname === '/api/vps-targets') return { body: { targets: [
      { target_name: `DMIT Premium${marker}`, display_name: marker, has_data: true },
      { target_name: 'DMIT Premium', display_name: `Fixture ${marker}`, has_data: true },
    ] } };
    if (pathname === '/api/routes') {
      const payload = routePayload(url);
      payload.targets = [{ target_name: payload.query.target_name, display_name: marker }];
      payload.summary = { status: 'failed', label: marker, hop_count: 1, final_latency_ms: null, error: marker };
      payload.hops = [{ hop: marker, ip: marker, latency_ms: 1, location: marker, asn: marker, reverse: marker, reverse_display: marker, quality: 'premium', premium_matches: ['asn'] }];
      return { body: payload };
    }
  }
  if (name === 'bandwidth-selection' && pathname === '/api/bandwidth') {
    return { body: { items: [
      bandwidthRow('dmit-premium', 'upload', 11, OLDER_TIME),
      bandwidthRow('dmit-premium', 'upload', 99, NEWER_TIME),
      bandwidthRow('dmit-premium', 'download', 88, NEWER_TIME),
      bandwidthRow('dmit-eyeball', 'upload', 21, FIXED_TIME),
      bandwidthRow('netlab-us', 'download', 61, FIXED_TIME),
      bandwidthRow('zillion-us', 'upload', null, FIXED_TIME, { completed: 0, error: 'fixture failure' }),
      bandwidthRow('zillion-us', 'download', 71, FIXED_TIME),
      bandwidthRow('alibaba-sg', 'upload', 500, FIXED_TIME),
      bandwidthRow('unknown-fixture-node', 'upload', 777, FIXED_TIME),
    ] } };
  }
  if (name === 'route-recursion' && pathname === '/api/routes') {
    const nextTarget = `Fixture recursive target ${count}`;
    if (count > 8) return { status: 429, body: { error: 'fixture recursion ceiling reached' } };
    return { body: routePayload(url, { targets: [{ target_name: nextTarget, display_name: nextTarget }] }) };
  }
  return ordinary;
}

function responseBody(reply) {
  if (reply.invalidJson) return Buffer.from('{ fixture invalid json', 'utf8');
  return Buffer.from(JSON.stringify(reply.body ?? {}), 'utf8');
}

export async function startFixtureServer({ scenario = 'baseline' } = {}) {
  const assets = new Map(await Promise.all(Object.entries(rawFiles).map(async ([route, meta]) => [route, { ...meta, bytes: await readFile(meta.path) }])));
  const state = {
    scenario,
    requests: [],
    counts: new Map(),
    activeApi: 0,
    maxConcurrency: 0,
    rejected: [],
  };
  const sockets = new Set();
  let closing = false;
  let releaseDelays;
  const closingSignal = new Promise(resolveClosing => { releaseDelays = resolveClosing; });

  const server = http.createServer(async (request, response) => {
    const started = Date.now();
    const hostHeader = request.headers.host || '';
    const host = hostHeader.replace(/:\d+$/, '');
    const url = new URL(request.url || '/', `http://${hostHeader || '127.0.0.1'}`);
    const entry = { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), started_at_ms: started, status: null, mode: null, duration_ms: null };
    state.requests.push(entry);

    const finish = (status, mode) => {
      entry.status = status;
      entry.mode = mode;
      entry.duration_ms = Date.now() - started;
    };

    if (!localAddress(request.socket.remoteAddress) || !LOCAL_HOSTS.has(host) || request.method !== 'GET') {
      state.rejected.push({ path: url.pathname, host, remote: request.socket.remoteAddress, method: request.method });
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      response.end('fixture request rejected');
      finish(403, 'rejected');
      return;
    }

    const asset = assets.get(url.pathname);
    if (asset) {
      response.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.bytes.length, 'Cache-Control': 'no-store', Connection: 'close' });
      response.end(asset.bytes);
      finish(200, 'raw-asset');
      return;
    }

    if (!API_PATHS.has(url.pathname)) {
      state.rejected.push({ path: url.pathname, host, reason: 'unmatched' });
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
      response.end(JSON.stringify({ error: 'unmatched fixture request' }));
      finish(404, 'unmatched');
      return;
    }

    const count = (state.counts.get(url.pathname) || 0) + 1;
    state.counts.set(url.pathname, count);
    state.activeApi += 1;
    state.maxConcurrency = Math.max(state.maxConcurrency, state.activeApi);
    const reply = scenarioReply(scenario, url.pathname, url, count);
    entry.mode = reply.invalidJson ? 'invalid-json' : reply.delayMs ? `delay-${reply.delayMs}ms` : 'json';

    try {
      if (reply.delayMs) await Promise.race([sleep(reply.delayMs), closingSignal]);
      if (closing) {
        finish(null, `${entry.mode}-fixture-closed`);
        return;
      }
      if (response.destroyed) {
        finish(null, `${entry.mode}-client-closed`);
        return;
      }
      const bytes = responseBody(reply);
      const status = reply.status || 200;
      response.writeHead(status, {
        'Content-Type': reply.invalidJson ? 'application/json; charset=utf-8' : 'application/json; charset=utf-8',
        'Content-Length': bytes.length,
        'Cache-Control': 'no-store',
        Connection: 'close',
      });
      response.end(bytes);
      finish(status, entry.mode);
    } finally {
      state.activeApi -= 1;
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    scenario,
    state,
    summary() {
      const apiRequests = state.requests.filter(item => item.path.startsWith('/api/'));
      return {
        request_count: apiRequests.length,
        max_concurrency: state.maxConcurrency,
        counts: Object.fromEntries(state.counts),
        rejected: state.rejected,
        requests: state.requests.map(item => ({ ...item })),
      };
    },
    async close() {
      if (closing) return;
      closing = true;
      releaseDelays();
      const closed = new Promise(resolveClose => server.close(() => resolveClose()));
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await startFixtureServer({ scenario: process.argv[2] || 'baseline' });
  process.stdout.write(`${fixture.origin}\n`);
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
