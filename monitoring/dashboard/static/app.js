const app = document.querySelector('#app');
const names = {unicom: '联通', telecom: '电信', mobile: '移动'};
const esc = value => String(value ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = (value, suffix='') => value == null ? '—' : `${Number(value).toFixed(2)}${suffix}`;
async function get(path) { const r = await fetch(path, {cache:'no-store'}); if (!r.ok) throw Error(r.status); return r.json(); }

async function summary() {
  const data = await get('/api/summary');
  app.innerHTML = `<section class="cards">${Object.entries(data.wans).map(([wan,v]) => `<article>
    <h2>${names[wan]}</h2><div class="state ${v.last_sample ? 'ok' : 'none'}">${v.last_sample ? '已有数据' : '无数据'}</div>
    <dl><dt>最新 Ping</dt><dd>${number(v.latest_icmp?.avg_ms,' ms')}</dd><dt>24h 平均</dt><dd>${number(v.ping_avg_ms,' ms')}</dd><dt>24h 丢包</dt><dd>${number(v.loss_percent,'%')}</dd><dt>TCP 成功率</dt><dd>${number(v.tcp_success_percent,'%')}</dd></dl>
  </article>`).join('')}</section>`;
}
async function latency() {
  const data = await get('/api/latency?range=24h');
  app.innerHTML = `<h2>最近 24 小时样本</h2><div class="table"><table><thead><tr><th>时间</th><th>线路</th><th>类型</th><th>目标</th><th>结果</th><th>平均延迟</th><th>丢包</th></tr></thead><tbody>${data.samples.slice(0,200).map(x=>`<tr><td>${esc(x.timestamp)}</td><td>${esc(names[x.wan])}</td><td>${esc(x.test_type)}</td><td>${esc(x.target_name)}</td><td>${x.success?'成功':'失败'}</td><td>${number(x.avg_ms,' ms')}</td><td>${number(x.loss_percent,'%')}</td></tr>`).join('')}</tbody></table></div>`;
}
async function emptyPage(endpoint, title, note) {
  const data = await get(endpoint); const rows = data.items || [];
  app.innerHTML = `<h2>${title}</h2><p class="notice">${note}</p><p>${rows.length ? `已有 ${rows.length} 条记录` : '阶段二 A 不采集此类数据，当前为空。'}</p>`;
}
async function health() {
  const d = await get('/api/health');
  app.innerHTML = `<h2>系统状态</h2><dl class="health"><dt>API</dt><dd>${esc(d.status)}</dd><dt>数据库大小</dt><dd>${number(d.database_bytes/1024,' KiB')}</dd><dt>最后采集</dt><dd>${esc(d.last_sample)}</dd><dt>样本数</dt><dd>${esc(d.sample_count)}</dd><dt>最近采集批次</dt><dd>${esc(JSON.stringify(d.last_collector_run))}</dd></dl>`;
}
const views = {summary, latency, routes:()=>emptyPage('/api/routes','路由','去回程未在阶段二 A 上线。'), bandwidth:()=>emptyPage('/api/bandwidth','电信测速','测速未在阶段二 A 上线；此页仅保留只读骨架。'), health};
async function show(name) { app.innerHTML='<p class="muted">正在读取数据…</p>'; try { await (views[name]||summary)(); } catch { app.innerHTML='<p class="error">读取失败，请检查面板服务与数据库。</p>'; } }
document.querySelectorAll('nav button').forEach(b=>b.addEventListener('click',()=>show(b.dataset.view)));
show('summary');
