(() => {
  'use strict';

  const WANS = ['telecom', 'mobile', 'unicom'];
  const NAMES = { telecom: '电信', mobile: '移动', unicom: '联通' };
  const STATUSES = new Set(['healthy', 'degraded', 'unavailable', 'no_data', 'stale']);
  const STATUS_LABELS = {
    healthy: '正常',
    degraded: '存在波动',
    unavailable: '无响应',
    no_data: '暂无数据',
    stale: '数据已过期',
  };
  const REQUIRED = new Set([
    'wanId', 'displayName', 'status', 'packetLossSummary', 'updatedAt', 'stale', 'trend',
  ]);
  const ALLOWED = new Set([...REQUIRED, 'latestLatencyMs']);
  const THEME_MESSAGE_TYPE = 'nsp-monitor-theme:v1';

  function finite(value, min, max) {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  }

  function validate(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('schema');
    if (Object.keys(payload).length !== 1 || !Array.isArray(payload.wans) || payload.wans.length !== 3) {
      throw new Error('schema');
    }
    const seen = new Set();
    for (const item of payload.wans) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('schema');
      const keys = Object.keys(item);
      if (keys.some((key) => !ALLOWED.has(key)) || [...REQUIRED].some((key) => !(key in item))) {
        throw new Error('schema');
      }
      if (!WANS.includes(item.wanId) || seen.has(item.wanId) || item.displayName !== NAMES[item.wanId]) {
        throw new Error('schema');
      }
      seen.add(item.wanId);
      if (!STATUSES.has(item.status) || typeof item.stale !== 'boolean') throw new Error('schema');
      if (item.stale !== (item.status === 'stale')) throw new Error('schema');
      if (item.updatedAt !== null && (typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt)))) {
        throw new Error('schema');
      }
      if (item.packetLossSummary !== null && !finite(item.packetLossSummary, 0, 100)) throw new Error('schema');
      if ('latestLatencyMs' in item && !finite(item.latestLatencyMs, 0, 60000)) throw new Error('schema');
      if (!Array.isArray(item.trend) || item.trend.length > 14 || item.trend.some((point) => point !== null && !finite(point, 0, 60000))) {
        throw new Error('schema');
      }
    }
    return payload.wans;
  }

  function trendPath(values) {
    if (!Array.isArray(values) || values.length < 2) return '';
    const numbers = values.filter((value) => finite(value, 0, 60000));
    if (numbers.length < 2) return '';
    let low = Math.min(...numbers);
    let high = Math.max(...numbers);
    if (low === high) { low = Math.max(0, low - 1); high += 1; }
    const width = 180;
    const height = 44;
    const pad = 4;
    const step = width / Math.max(1, values.length - 1);
    let path = '';
    let drawing = false;
    values.forEach((value, index) => {
      if (!finite(value, 0, 60000)) { drawing = false; return; }
      const x = index * step;
      const y = pad + ((value - low) / (high - low)) * (height - pad * 2);
      path += `${drawing ? ' L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      drawing = true;
    });
    return path.trim();
  }

  function formatTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)
      : '—';
  }

  function normalizeParentOrigin(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.trim() !== value) {
      return null;
    }
    try {
      const parsed = new URL(value);
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username !== '' ||
        parsed.password !== '' ||
        parsed.pathname !== '/' ||
        parsed.search !== '' ||
        parsed.hash !== '' ||
        parsed.origin !== value
      ) {
        return null;
      }
      return parsed.origin;
    } catch (_error) {
      return null;
    }
  }

  function acceptedThemeMessage(configuredOrigin, eventOrigin, fromParent, payload) {
    if (!configuredOrigin || eventOrigin !== configuredOrigin || fromParent !== true) return null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const keys = Object.keys(payload).sort();
    if (keys.length !== 2 || keys[0] !== 'theme' || keys[1] !== 'type') return null;
    if (payload.type !== THEME_MESSAGE_TYPE) return null;
    return payload.theme === 'light' || payload.theme === 'dark' ? payload.theme : null;
  }

  function clearCard(card, label) {
    card.dataset.state = 'unavailable';
    card.querySelector('.latency').textContent = '—';
    card.querySelector('.loss').textContent = '—';
    card.querySelector('.updated').textContent = '—';
    card.querySelector('.trend path').setAttribute('d', '');
    card.querySelector('.wan-status').textContent = label;
  }

  function render(items) {
    for (const item of items) {
      const card = document.querySelector(`.wan-card[data-wan="${item.wanId}"]`);
      if (!card) continue;
      card.dataset.state = item.status;
      card.querySelector('.latency').textContent = 'latestLatencyMs' in item
        ? item.latestLatencyMs.toFixed(1)
        : '—';
      card.querySelector('.loss').textContent = item.packetLossSummary === null
        ? '—'
        : `${item.packetLossSummary.toFixed(1)}%`;
      card.querySelector('.updated').textContent = formatTime(item.updatedAt);
      card.querySelector('.trend path').setAttribute('d', trendPath(item.trend));
      card.querySelector('.wan-status').textContent = STATUS_LABELS[item.status];
    }
  }

  function setSync(state, label) {
    const node = document.querySelector('#syncState');
    node.dataset.state = state;
    node.querySelector('span').textContent = label;
  }

  function clearAll(label) {
    document.querySelectorAll('.wan-card').forEach((card) => clearCard(card, label));
  }

  async function refresh() {
    setSync('loading', '同步中');
    try {
      const response = await fetch('/api/summary', {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('unavailable');
      render(validate(await response.json()));
      setSync('live', '实时数据同步');
    } catch (_error) {
      clearAll('监控暂时不可用');
      setSync('unavailable', '暂时不可用');
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      THEME_MESSAGE_TYPE,
      acceptedThemeMessage,
      formatTime,
      normalizeParentOrigin,
      trendPath,
      validate,
    };
  }
  if (typeof document === 'undefined') return;

  const parameters = new URLSearchParams(window.location.search);
  document.documentElement.dataset.theme = parameters.get('theme') === 'light' ? 'light' : 'dark';
  const requestedView = parameters.get('view');
  if (requestedView === 'mini' || requestedView === 'embed') {
    document.documentElement.dataset.view = requestedView;
  }
  const parentOrigin = normalizeParentOrigin(
    document.querySelector('meta[name="monitor-parent-origin"]')?.getAttribute('content'),
  );
  window.addEventListener('message', (event) => {
    const nextTheme = acceptedThemeMessage(
      parentOrigin,
      event.origin,
      window.parent !== window && event.source === window.parent,
      event.data,
    );
    if (nextTheme) document.documentElement.dataset.theme = nextTheme;
  });
  if (parameters.get('preview') === 'fixture') {
    document.documentElement.dataset.preview = 'fixture';
    document.querySelector('#fixtureNote').hidden = false;
  }
  refresh();
  window.setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
