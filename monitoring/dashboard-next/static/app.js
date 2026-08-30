const WAN_META = {
  telecom: {name:'电信', color:'#3867c5'},
  mobile: {name:'移动', color:'#5a9033'},
  unicom: {name:'联通', color:'#b03533'}
};
const RANGE_LABELS = {'1h':'1 小时','6h':'6 小时','24h':'24 小时','7d':'7 天'};
const RANGE_MS = {'1h':3600000,'6h':21600000,'24h':86400000,'7d':604800000};
const savedVps=(()=>{try{return localStorage.getItem('network-monitor-selected-vps')}catch{return null}})();
const requestedVps=(()=>{try{const value=new URLSearchParams(location.search).get('vps');return value&&value===value.trim()&&value.length<=128&&!/[\u0000-\u001f\u007f]/.test(value)?value:null}catch{return null}})();
const state = {type:'icmp', range:'24h', target:'AliDNS', lastVps:requestedVps||savedVps||'DMIT Premium', vpsTargets:[], visible:new Set(['telecom','mobile','unicom']), samples:[], chart:null, liveKey:null, targetRequest:0, chartRequest:0, liveRequest:0, refreshPromise:null, chartController:null, vpsStatusRequest:0, vpsStatusPromise:null, vpsStatusTarget:null};
const routeState={wan:'telecom',direction:'outbound',protocol:'icmp',target:'DMIT Premium',targets:[],hops:[],expanded:false,request:0,controller:null};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const fmt = (value, digits=1, suffix='') => value == null ? '—' : `${Number(value).toFixed(digits)}${suffix}`;
const pct = value => fmt(value, value != null && value % 1 ? 1 : 0, '%');
const escapeHtml = value => String(value ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shanghaiFormatter = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const shortTimeFormatter = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const axisTimeFormatter = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false});
const formatShanghai = value => value ? `${shanghaiFormatter.format(new Date(value)).replaceAll('/','-')} CST` : '—';
const shortShanghai = value => value ? shortTimeFormatter.format(new Date(value)).replaceAll('/','-') : '—';
const axisShanghai = value => value ? (state.range==='7d' ? shortShanghai(value) : axisTimeFormatter.format(new Date(value))) : '—';

async function getJSON(url,{signal}={}){
  const response = await fetch(url,{cache:'no-store',signal});
  if(!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

function setOverall(overall){
  const node = $('#overallStatus');
  node.className = `overall-status ${overall.status}`;
  node.querySelector('b').textContent = overall.label;
}

async function loadOverview(){
  const data = await getJSON('/api/overview');
  setOverall(data.overall);
  $('#lastUpdate').textContent = formatShanghai(data.latest_update);
}

function formatUptime(value){
  if(value==null)return '—';
  const seconds=Math.max(0,Number(value)),days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600),minutes=Math.floor(seconds%3600/60);
  if(days)return `${days} 天`;
  if(hours)return `${hours} 小时`;
  return `${minutes} 分钟`;
}

function formatRate(value){
  if(value==null)return '—';
  const number=Math.max(0,Number(value));
  if(number>=1073741824)return `${(number/1073741824).toFixed(2)}G/s`;
  if(number>=1048576)return `${(number/1048576).toFixed(2)}M/s`;
  return `${(number/1024).toFixed(2)}K/s`;
}

function setMetricBar(selector,value){
  const bar=$(selector),amount=value==null?0:Math.max(0,Math.min(100,Number(value)));
  bar.style.width=`${amount}%`;
  bar.classList.toggle('warn',amount>=85&&amount<95);
  bar.classList.toggle('critical',amount>=95);
}

function renderVpsUnavailable(status,label,target){
  const panel=$('#systemPanel');panel.dataset.status=status;panel.title=`${target} · ${label}`;
  for(const id of ['#vpsUptime','#vpsCpu','#vpsMemory','#vpsStorage','#vpsUpload','#vpsDownload'])$(id).textContent=label;
  setMetricBar('#vpsCpuBar',null);setMetricBar('#vpsMemoryBar',null);setMetricBar('#vpsStorageBar',null);
}

function renderVpsStatus(data){
  const item=data.item;
  if(!item){
    const label=data.source_status==='connecting'?'读取中':'未接入';
    return renderVpsUnavailable(data.source_status==='connecting'?'stale':'missing',label,data.target);
  }
  if(!data.fresh)return renderVpsUnavailable('stale','暂不可用',data.target);
  if(!item.online)return renderVpsUnavailable('offline','离线',data.target);
  const panel=$('#systemPanel');panel.dataset.status='online';panel.title=`${data.target} · 哪吒监控实时数据`;
  $('#vpsUptime').textContent=formatUptime(item.uptime_seconds);
  $('#vpsCpu').textContent=fmt(item.cpu_percent,2,'%');
  $('#vpsMemory').textContent=fmt(item.memory_percent,2,'%');
  $('#vpsStorage').textContent=fmt(item.storage_percent,2,'%');
  $('#vpsUpload').textContent=formatRate(item.upload_bytes_per_second);
  $('#vpsDownload').textContent=formatRate(item.download_bytes_per_second);
  setMetricBar('#vpsCpuBar',item.cpu_percent);setMetricBar('#vpsMemoryBar',item.memory_percent);setMetricBar('#vpsStorageBar',item.storage_percent);
}

async function loadVpsStatus(target=state.lastVps){
  if(state.vpsStatusPromise&&state.vpsStatusTarget===target)return state.vpsStatusPromise;
  const requestId=++state.vpsStatusRequest;state.vpsStatusTarget=target;
  const task=(async()=>{
    try{
      const data=await getJSON(`/api/vps-status?target=${encodeURIComponent(target)}`);
      if(requestId!==state.vpsStatusRequest||target!==state.lastVps)return false;
      renderVpsStatus(data);return true;
    }catch(error){
      if(requestId===state.vpsStatusRequest&&target===state.lastVps)renderVpsUnavailable('stale','暂不可用',target);
      console.error(error);return false;
    }
  })();
  state.vpsStatusPromise=task;
  try{return await task}finally{if(state.vpsStatusPromise===task){state.vpsStatusPromise=null;state.vpsStatusTarget=null}}
}

async function loadTargets(){
  const requestedType=state.type,requestId=++state.targetRequest;
  const data=await getJSON(`/api/targets?type=${encodeURIComponent(requestedType)}`);
  if(requestId!==state.targetRequest || state.type!==requestedType)return false;
  const names=data.targets.map(item=>item.target_name);
  state.target=names.includes(state.lastVps)
    ? state.lastVps
    : requestedType==='icmp' && names.includes('AliDNS')
      ? 'AliDNS'
      : names.includes('DMIT Premium')
        ? 'DMIT Premium'
        : names[0];
  renderVpsPicker();return true;
}

function renderVpsPicker(){
  $('#vpsPicker').innerHTML=state.vpsTargets.map(item=>{
    const active=state.lastVps===item.target_name;
    return `<button class="vps-option${active?' active':''}${item.has_data?'':' no-data'}" data-target="${escapeHtml(item.target_name)}" aria-pressed="${active}" title="${escapeHtml(item.display_name)}"><i></i><span>${escapeHtml(item.display_name)}</span></button>`;
  }).join('');
}

async function loadVpsTargets(){
  const data=await getJSON('/api/vps-targets');
  const order=['DMIT Premium','DMIT Eyeball','NetLab Global US','Zillion Network','Evoxt Premium','Alibaba Cloud','NetLab Global HK','Yecaoyun Cloud'];
  state.vpsTargets=data.targets.filter(item=>item.target_name!=='Yecaoyun Cloud2-current' && !/Yecaoyun Cloud2/i.test(item.display_name ?? '')).sort((a,b)=>{
    const ai=order.indexOf(a.target_name),bi=order.indexOf(b.target_name);
    return (ai<0?99:ai)-(bi<0?99:bi);
  });
  const names=state.vpsTargets.map(item=>item.target_name);
  if(!names.includes(state.lastVps))state.lastVps=names.includes('DMIT Premium')?'DMIT Premium':names[0];
  renderVpsPicker();
}

async function selectVps(target){
  ++state.targetRequest;state.target=target;state.lastVps=target;state.liveKey=null;
  try{localStorage.setItem('network-monitor-selected-vps',target)}catch{}
  renderVpsPicker();clearPreviousSelection();await Promise.all([loadChart(),loadLive(false),loadVpsStatus(target)]);
}

function setLegendValue(wan,row,animate=false){
  const label=$(`#legend${wan[0].toUpperCase()+wan.slice(1)}`);
  const button=label.closest('button');
  const value=!row?'暂无数据':row.success && row.avg_ms!=null ? `${Number(row.avg_ms).toFixed(1)} ms` : '无响应';
  if(animate && label.textContent!==value){
    button.classList.remove('value-change');void button.offsetWidth;button.classList.add('value-change');
  }
  label.textContent=value;button.classList.toggle('latest-failed',!!row && !row.success);
}

function updateLegend(samples){
  for(const wan of Object.keys(WAN_META)){
    const last=samples.filter(item=>item.wan===wan).at(-1);
    setLegendValue(wan,last);
  }
}

function clearPreviousSelection(){
  for(const wan of Object.keys(WAN_META)){
    const label=$(`#legend${wan[0].toUpperCase()+wan.slice(1)}`),button=label.closest('button');
    label.textContent='读取中';button.classList.remove('latest-failed','value-change');
  }
  state.samples=[];
  if(state.chart)drawChart([]);
  $('#chartTooltip').classList.remove('show');clearHover();
}

async function loadLive(refreshChartOnChange=true){
  const requestedType=state.type,requestedTarget=state.target,requestId=++state.liveRequest;
  try{
    const data=await getJSON(`/api/live?type=${requestedType}&target=${encodeURIComponent(requestedTarget)}`);
    if(requestId!==state.liveRequest || requestedType!==state.type || requestedTarget!==state.target)return;
    const nextKey=`${requestedType}|${requestedTarget}|${data.latest_timestamp ?? 'none'}`;
    const changed=state.liveKey!==null && state.liveKey!==nextKey;
    for(const wan of Object.keys(WAN_META))setLegendValue(wan,data.items.find(item=>item.wan===wan),changed);
    $('#liveStatus').classList.remove('stale');
    $('#liveStatus').innerHTML='<i></i>实时同步 · 5 秒轮询';
    state.liveKey=nextKey;
    if(changed && refreshChartOnChange){
      if(!state.refreshPromise){
        state.refreshPromise=Promise.all([loadOverview(),loadChart()]).finally(()=>{state.refreshPromise=null});
      }
      await state.refreshPromise;
    }
  }catch(error){
    if(requestId!==state.liveRequest)return;
    console.error(error);$('#liveStatus').classList.add('stale');$('#liveStatus').innerHTML='<i></i>实时同步暂时失败';
  }
}

function groupSamples(samples){
  const grouped = {telecom:[],mobile:[],unicom:[]};
  for(const sample of samples){
    sample.epoch = new Date(sample.timestamp).getTime();
    if(grouped[sample.wan]) grouped[sample.wan].push(sample);
  }
  return grouped;
}

function chartMax(value){
  const padded = Math.max(100,value*1.08);
  return Math.ceil(padded/100)*100;
}

function drawChart(samples){
  const canvas = $('#latencyChart');
  const stage = $('#chartStage');
  const dpr = Math.min(window.devicePixelRatio || 1,2);
  const width = stage.clientWidth, height = stage.clientHeight;
  const compact = width < 700;
  canvas.width = width*dpr; canvas.height = height*dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const margin = compact ? {left:46,right:8,top:8,bottom:34} : {left:91,right:42,top:13,bottom:38};
  const plot = {x:margin.left,y:margin.top,w:width-margin.left-margin.right,h:height-margin.top-margin.bottom};
  const zeroInset = compact ? 24 : 34;
  const dataHeight = plot.h-zeroInset;
  const zeroY = plot.y+dataHeight;
  const grouped = groupSamples(samples);
  const visibleRows = samples.filter(x => state.visible.has(x.wan));
  const times = visibleRows.map(x=>x.epoch);
  const now = Date.now();
  const rangeMs=RANGE_MS[state.range] ?? RANGE_MS['24h'];
  const maxTime=Math.max(now,times.length ? Math.max(...times) : now);
  const minTime=maxTime-rangeMs;
  const successful = visibleRows.filter(x=>x.success && x.avg_ms!=null);
  const yMax = chartMax(Math.max(...successful.map(x=>Number(x.max_ms ?? x.avg_ms)),0));
  const xAt = epoch => plot.x + (epoch-minTime)/(maxTime-minTime)*plot.w;
  const yAt = value => zeroY-Number(value)/yMax*dataHeight;

  ctx.clearRect(0,0,width,height);
  ctx.font = `${compact ? 12 : 20}px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif`;
  ctx.textBaseline='middle';
  for(let i=0;i<=5;i++){
    const y=plot.y+dataHeight*i/5, value=yMax*(1-i/5);
    ctx.strokeStyle='rgba(115,130,150,.12)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(plot.x,y);ctx.lineTo(plot.x+plot.w,y);ctx.stroke();
    ctx.fillStyle='#a0a5ad';ctx.textAlign='right';ctx.fillText(`${Math.round(value)}ms`,plot.x-(compact?8:18),y);
  }
  const xDivisions = compact ? 3 : 6;
  for(let i=0;i<=xDivisions;i++){
    const x=plot.x+plot.w*i/xDivisions, epoch=minTime+(maxTime-minTime)*i/xDivisions;
    ctx.strokeStyle='rgba(115,130,150,.08)';ctx.beginPath();ctx.moveTo(x,plot.y);ctx.lineTo(x,plot.y+plot.h);ctx.stroke();
    ctx.fillStyle='#a0a5ad';ctx.textAlign=i===0?'left':i===xDivisions?'right':'center';ctx.fillText(axisShanghai(epoch),x,plot.y+plot.h+(compact?18:22));
  }
  ctx.save();ctx.beginPath();ctx.rect(plot.x,plot.y,plot.w,plot.h);ctx.clip();
  for(const [wan,meta] of Object.entries(WAN_META)){
    if(!state.visible.has(wan)) continue;
    const rows=grouped[wan];ctx.lineWidth=1.35;ctx.strokeStyle=meta.color;ctx.shadowBlur=0;ctx.beginPath();
    let pen=false;
    for(const row of rows){
      if(!row.success || row.avg_ms==null){ pen=false; continue; }
      const x=xAt(row.epoch),y=yAt(row.avg_ms);
      if(!pen){ctx.moveTo(x,y);pen=true}else ctx.lineTo(x,y);
    }
    ctx.stroke();
    for(const row of rows.filter(x=>!x.success)){
      const x=xAt(row.epoch),y=zeroY+10;ctx.strokeStyle='#ff4d4f';ctx.lineWidth=1.6;ctx.beginPath();ctx.moveTo(x-3,y-3);ctx.lineTo(x+3,y+3);ctx.moveTo(x+3,y-3);ctx.lineTo(x-3,y+3);ctx.stroke();
    }
  }
  ctx.restore();
  state.chart={ctx,canvas,plot,zeroY,dataHeight,grouped,minTime,maxTime,yMax,xAt,yAt};
}

function nearestRows(clientX){
  if(!state.chart) return [];
  const rect=state.chart.canvas.getBoundingClientRect();
  const x=clientX-rect.left;
  const epoch=state.chart.minTime+(x-state.chart.plot.x)/state.chart.plot.w*(state.chart.maxTime-state.chart.minTime);
  const rows=[];
  for(const wan of Object.keys(WAN_META)){
    if(!state.visible.has(wan)) continue;
    const list=state.chart.grouped[wan];
    if(!list.length) continue;
    let best=list[0];for(const row of list) if(Math.abs(row.epoch-epoch)<Math.abs(best.epoch-epoch)) best=row;
    rows.push(best);
  }
  return rows;
}

function clearHover(){
  const canvas=$('#chartHover'),ctx=canvas.getContext('2d');
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,canvas.width,canvas.height);
}

function valueOnLine(wan,epoch){
  const rows=state.chart?.grouped?.[wan] ?? [];
  if(!rows.length)return null;
  let right=rows.findIndex(row=>row.epoch>=epoch);
  if(right===-1){const row=rows.at(-1);return row.success && row.avg_ms!=null ? Number(row.avg_ms) : null;}
  if(right===0){const row=rows[0];return row.success && row.avg_ms!=null ? Number(row.avg_ms) : null;}
  const after=rows[right],before=rows[right-1];
  if(after.epoch===epoch)return after.success && after.avg_ms!=null ? Number(after.avg_ms) : null;
  if(!before.success || !after.success || before.avg_ms==null || after.avg_ms==null)return null;
  const ratio=(epoch-before.epoch)/(after.epoch-before.epoch);
  return Number(before.avg_ms)+(Number(after.avg_ms)-Number(before.avg_ms))*ratio;
}

function drawHover(rows){
  if(!state.chart || !rows.length)return;
  const canvas=$('#chartHover'),rect=canvas.getBoundingClientRect(),baseRect=state.chart.canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  if(canvas.width!==Math.round(rect.width*dpr) || canvas.height!==Math.round(rect.height*dpr)){
    canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);
  }
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);
  const {plot,zeroY,xAt,yAt}=state.chart;
  const offsetX=baseRect.left-rect.left,offsetY=baseRect.top-rect.top;
  const anchor=rows.reduce((sum,row)=>sum+row.epoch,0)/rows.length;
  const x=Math.max(plot.x,Math.min(plot.x+plot.w,xAt(anchor)))+offsetX;
  ctx.save();ctx.beginPath();ctx.rect(plot.x+offsetX,plot.y+offsetY,plot.w,plot.h);ctx.clip();
  ctx.strokeStyle='rgba(225,231,239,.78)';ctx.lineWidth=1.35;ctx.setLineDash([6,5]);ctx.beginPath();ctx.moveTo(x,plot.y+offsetY);ctx.lineTo(x,plot.y+plot.h+offsetY);ctx.stroke();ctx.setLineDash([]);
  for(const row of rows){
    const meta=WAN_META[row.wan];
    const lineValue=valueOnLine(row.wan,anchor);
    if(lineValue!=null){
      const y=yAt(lineValue)+offsetY;ctx.shadowBlur=0;ctx.fillStyle=meta.color;ctx.beginPath();ctx.arc(x,y,4.5,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#f7fafc';ctx.beginPath();ctx.arc(x,y,2,0,Math.PI*2);ctx.fill();
    }else{
      const y=zeroY+10+offsetY;ctx.strokeStyle='#ff4d4f';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x-5,y-5);ctx.lineTo(x+5,y+5);ctx.moveTo(x+5,y-5);ctx.lineTo(x-5,y+5);ctx.stroke();
    }
  }
  ctx.restore();
}

function showTooltip(event){
  const rows=nearestRows(event.clientX);if(!rows.length)return;
  drawHover(rows);
  const tooltip=$('#chartTooltip'),stage=$('#chartStage'),rect=stage.getBoundingClientRect();
  tooltip.innerHTML=`<time>${formatShanghai(rows[0].timestamp)}</time>${rows.map(row=>`<div class="tip-line ${row.success?'':'fail'} ${row.wan}"><i></i><span>${WAN_META[row.wan].name}</span><small>${row.success?`丢包 ${fmt(row.loss_percent,0,'%')}`:'失败样本'}</small><b>${row.success?fmt(row.avg_ms,2,' ms'):'无响应'}</b></div>`).join('')}`;
  tooltip.classList.add('show');
  const left=Math.max(12,Math.min(event.clientX-rect.left+14,rect.width-tooltip.offsetWidth-12)),top=2;
  tooltip.style.left=`${left}px`;tooltip.style.top=`${top}px`;
}

async function loadChart(){
  const requestedType=state.type,requestedTarget=state.target,requestedRange=state.range,requestId=++state.chartRequest;
  if(state.chartController)state.chartController.abort();
  const controller=new AbortController();state.chartController=controller;
  $('#chartLoading').classList.remove('hidden');
  const url=`/api/latency?range=${requestedRange}&type=${requestedType}&target=${encodeURIComponent(requestedTarget)}`;
  try{
    const data=await getJSON(url,{signal:controller.signal});
    if(requestId!==state.chartRequest || requestedType!==state.type || requestedTarget!==state.target || requestedRange!==state.range)return false;
    if(data.type!==requestedType || data.target!==requestedTarget || data.range!==requestedRange)return false;
    state.samples=data.samples;
    drawChart(state.samples);updateLegend(state.samples);
    $('#chartCount').textContent=`${data.count.toLocaleString('zh-CN')} 个绘图点 · ${data.bucket_seconds/60} 分钟粒度`;
    $('#chartRangeLabel').textContent=`${RANGE_LABELS[state.range]} · Asia/Shanghai`;
    $('#chartLoading').classList.add('hidden');
    return true;
  }catch(error){
    if(error.name==='AbortError')return false;
    throw error;
  }finally{
    if(state.chartController===controller)state.chartController=null;
  }
}

async function changeType(value){
  ++state.targetRequest;state.type=value;
  $$('#typeSwitch button').forEach(button=>button.classList.toggle('active',button.dataset.value===value));
  state.liveKey=null;renderVpsPicker();clearPreviousSelection();
  await loadTargets();
  await Promise.all([loadChart(),loadLive(false)]);
}

function setRouteSwitch(group,value){
  $$(`${group} button`).forEach(button=>button.classList.toggle('active',button.dataset.value===value));
}

function setRouteExpanded(expanded){
  const canExpand=routeState.hops.length>5;
  routeState.expanded=Boolean(expanded&&canExpand);
  $('#routePanel').classList.toggle('route-expanded',routeState.expanded);
  for(const button of [$('#routeToggle'),$('#routeMore')]){
    button.disabled=!canExpand;
    button.setAttribute('aria-expanded',String(routeState.expanded));
  }
  $('#routeToggle').innerHTML=routeState.expanded?'收起 <span>⌃</span>':'展开 <span>⌄</span>';
  $('#routeMore').innerHTML=routeState.expanded
    ? `收起完整路由（共 ${routeState.hops.length} 跳） <span>⌃</span>`
    : `展开完整路由（共 ${routeState.hops.length} 跳） <span>⌄</span>`;
}

function renderRouteTargets(targets){
  routeState.targets=targets;
  const select=$('#routeTarget');
  const names=targets.map(item=>item.target_name);
  if(!names.includes(routeState.target))routeState.target=names.includes('DMIT Premium')?'DMIT Premium':names[0];
  select.innerHTML=targets.map(item=>`<option value="${escapeHtml(item.target_name)}">${escapeHtml(item.display_name)}</option>`).join('');
  select.value=routeState.target;
  select.disabled=targets.length<2;
  $('#routeTargetWrap').classList.toggle('disabled',select.disabled);
  $('#routeTargetWrap').querySelector('span').textContent=routeState.direction==='return'?'回程 VPS':'去程目标';
}

function renderRouteEmpty(title,description,status='no_data'){
  $('#routeTableWrap').classList.add('empty-table');
  $('#routeRows').innerHTML=`<tr><td colspan="6"><div class="empty-state"><span class="route-icon">⌁</span><b>${escapeHtml(title)}</b><p>${escapeHtml(description)}<span class="premium-route-note">精品线路将以金色突出。</span></p></div></td></tr>`;
  routeState.hops=[];setRouteExpanded(false);
  const result=$('#routeResult');result.dataset.status=status;result.querySelector('b').textContent=title;result.querySelector('span').textContent='';
}

function renderRoute(data){
  renderRouteTargets(data.targets||[]);
  const summary=data.summary||{status:'no_data',label:'暂无路由数据',hop_count:0};
  const result=$('#routeResult');result.dataset.status=summary.status;result.querySelector('b').textContent=summary.label;
  const details=[];
  if(summary.hop_count)details.push(`${summary.hop_count} 跳`);
  if(summary.final_latency_ms!=null)details.push(`${Number(summary.final_latency_ms).toFixed(2)} ms`);
  if(summary.error&&summary.status!=='incomplete')details.push(summary.error);
  result.querySelector('span').textContent=details.join(' · ');
  $('#routeUpdated').textContent=data.item?formatShanghai(data.item.timestamp):'—';
  const hops=Array.isArray(data.hops)?data.hops:[];
  if(!hops.length){
    const descriptions={
      no_data:'当前线路、方向、协议与目标组合没有已入库记录。',
      failed:summary.error?`失败原因：${summary.error}`:'本次探测没有返回可展示的逐跳数据。',
      unavailable:'数据库有摘要，但对应的标准化逐跳文件不可用。'
    };
    renderRouteEmpty(summary.label,descriptions[summary.status]||'当前没有可展示的逐跳数据。',summary.status);
    return;
  }
  $('#routeTableWrap').classList.remove('empty-table');
  routeState.hops=hops;
  $('#routeRows').innerHTML=hops.map((hop,index)=>{
    const premium=hop.quality==='premium';
    const premiumMatches=new Set(hop.premium_matches||[]);
    const reverseDisplay=hop.reverse_display||hop.reverse||'—';
    const ptrTitle=hop.reverse&&hop.reverse!==reverseDisplay?` title="${escapeHtml(`PTR: ${hop.reverse}`)}"`:'';
    return `<tr class="route-hop${index>=5?' beyond-preview':''}" data-route-quality="${premium?'premium':'standard'}">
      <td>${escapeHtml(hop.hop)}</td>
      <td class="route-ip">${escapeHtml(hop.ip||'*')}</td>
      <td class="route-latency">${hop.latency_ms==null?'—':`${Number(hop.latency_ms).toFixed(2)} ms`}</td>
      <td class="route-location">${escapeHtml(hop.location||'—')}</td>
      <td><span class="route-asn${premiumMatches.has('asn')?' route-premium-text':''}">${escapeHtml(hop.asn==null?'—':hop.asn)}</span></td>
      <td class="route-reverse${premium?' route-premium-text':''}"${ptrTitle}>${escapeHtml(reverseDisplay)}</td>
    </tr>`;
  }).join('');
  setRouteExpanded(false);
}

async function loadRoute(){
  const requestId=++routeState.request;
  if(routeState.controller)routeState.controller.abort();
  const controller=new AbortController();routeState.controller=controller;
  const result=$('#routeResult');result.dataset.status='loading';result.querySelector('b').textContent='正在读取';result.querySelector('span').textContent='';
  const params=new URLSearchParams({wan:routeState.wan,direction:routeState.direction,protocol:routeState.protocol,target_name:routeState.target});
  try{
    const data=await getJSON(`/api/routes?${params}`,{signal:controller.signal});
    if(requestId!==routeState.request)return false;
    if(data.query.wan!==routeState.wan||data.query.direction!==routeState.direction||data.query.protocol!==routeState.protocol||data.query.target_name!==routeState.target)return false;
    renderRoute(data);return true;
  }catch(error){
    if(error.name==='AbortError')return false;
    if(requestId===routeState.request){
      $('#routeUpdated').textContent='—';
      renderRouteEmpty('路由数据读取失败','候选只读 API 暂时不可用，请稍后刷新。','unavailable');
    }
    console.error(error);return false;
  }finally{
    if(routeState.controller===controller)routeState.controller=null;
  }
}

async function changeRouteFilter(field,value){
  routeState[field]=value;
  if(field==='direction'){
    if(value==='outbound')routeState.target='DMIT Premium';
  }
  if(field!=='target')setRouteSwitch(field==='wan'?'#routeWanSwitch':field==='direction'?'#routeDirectionSwitch':'#routeProtocolSwitch',value);
  setRouteExpanded(false);
  await loadRoute();
}

function bindInteractions(){
  $$('#typeSwitch button').forEach(button=>button.addEventListener('click',()=>changeType(button.dataset.value)));
  $$('#rangeSwitch button').forEach(button=>button.addEventListener('click',async()=>{
    state.range=button.dataset.value;$$('#rangeSwitch button').forEach(b=>b.classList.toggle('active',b===button));await loadChart();
  }));
  $('#vpsPicker').addEventListener('click',event=>{const button=event.target.closest('.vps-option[data-target]');if(button)selectVps(button.dataset.target)});
  $$('#wanLegend button').forEach(button=>button.addEventListener('click',()=>{
    const wan=button.dataset.wan;state.visible.has(wan)?state.visible.delete(wan):state.visible.add(wan);button.classList.toggle('active',state.visible.has(wan));drawChart(state.samples);
  }));
  const latencyChart=$('#latencyChart');
  const hideChartTooltip=()=>{$('#chartTooltip').classList.remove('show');clearHover()};
  latencyChart.addEventListener('pointerdown',showTooltip);latencyChart.addEventListener('pointermove',showTooltip);
  latencyChart.addEventListener('pointerleave',event=>{if(event.pointerType!=='touch')hideChartTooltip()});
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('#chartStage'))hideChartTooltip()});
  const toggleRoute=()=>setRouteExpanded(!routeState.expanded);
  $('#routeToggle').addEventListener('click',toggleRoute);
  $('#routeMore').addEventListener('click',toggleRoute);
  $$('#routeWanSwitch button').forEach(button=>button.addEventListener('click',()=>changeRouteFilter('wan',button.dataset.value)));
  $$('#routeDirectionSwitch button').forEach(button=>button.addEventListener('click',()=>changeRouteFilter('direction',button.dataset.value)));
  $$('#routeProtocolSwitch button').forEach(button=>button.addEventListener('click',()=>changeRouteFilter('protocol',button.dataset.value)));
  $('#routeTarget').addEventListener('change',event=>changeRouteFilter('target',event.target.value));
  let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>drawChart(state.samples),120)});
}

async function init(){
  bindInteractions();
  try{await Promise.all([loadOverview(),loadVpsTargets(),loadTargets(),loadRoute()]);await Promise.all([loadChart(),loadLive(false),loadVpsStatus()]);}
  catch(error){console.error(error);$('#chartLoading').innerHTML='<span></span>候选 API 读取失败';setOverall({status:'stale',label:'读取失败'});}
  setInterval(()=>{if(!document.hidden){loadLive(true);loadVpsStatus()}},5000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){loadLive(true);loadVpsStatus()}});
}
init();
