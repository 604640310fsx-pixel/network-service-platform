const WAN_META = {
  telecom: {name:'电信', color:'#3867c5'},
  mobile: {name:'移动', color:'#5a9033'},
  unicom: {name:'联通', color:'#b03533'}
};
const RANGE_LABELS = {'1h':'1 小时','6h':'6 小时','24h':'24 小时','7d':'7 天'};
const RANGE_MS = {'1h':3600000,'6h':21600000,'24h':86400000,'7d':604800000};
const savedVps=(()=>{try{return localStorage.getItem('network-monitor-selected-vps')}catch{return null}})();
const requestedVps=(()=>{try{const value=new URLSearchParams(location.search).get('vps');return value&&value===value.trim()&&value.length<=128&&!/[\u0000-\u001f\u007f]/.test(value)?value:null}catch{return null}})();
const state = {type:'icmp', range:'24h', target:'AliDNS', lastVps:requestedVps||savedVps||'DMIT Premium', vpsTargets:[], visible:new Set(['telecom','mobile','unicom']), samples:[], chart:null, liveKey:null, targetRequest:0, chartRequest:0, liveRequest:0, refreshPromise:null, chartController:null, vpsCatalogRequest:0, vpsStatusRequest:0, vpsStatusPromise:null, vpsStatusTarget:null};
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
  if(data.customer_state==='disabled')return renderVpsUnavailable('disabled','已停用',data.target);
  if(data.customer_state==='retired')return renderVpsUnavailable('missing','已退役',data.target);
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
  const targetItem=state.vpsTargets.find(item=>item.target_name===target);
  if(targetItem?.customer_state==='retired'){
    renderVpsUnavailable('missing','已退役或移除',target);
    return true;
  }
  if(targetItem?.customer_state==='disabled'){
    renderVpsUnavailable('disabled','已停用',target);
    return true;
  }
  if(state.vpsStatusPromise&&state.vpsStatusTarget===target)return state.vpsStatusPromise;
  const requestId=++state.vpsStatusRequest;state.vpsStatusTarget=target;
  const task=(async()=>{
    try{
      const data=await getJSON(`/api/vps-status?target=${encodeURIComponent(target)}`);
      if(requestId!==state.vpsStatusRequest||target!==state.lastVps)return false;
      renderVpsStatus(data);return true;
    }catch(error){
      if(requestId===state.vpsStatusRequest&&target===state.lastVps){
        const currentTarget=state.vpsTargets.find(item=>item.target_name===target);
        const removed=currentTarget?.customer_state==='retired';
        renderVpsUnavailable(removed?'missing':'stale',removed?'已退役或移除':'暂不可用',target);
      }
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
    const monitorState=['online','offline','disabled'].includes(item.monitor_state)?item.monitor_state:'loading';
    const monitorLabel=item.customer_state==='retired'
      ? '已退役'
      : {online:'在线',offline:'离线或连接不上',disabled:'已停用',loading:'读取中'}[monitorState];
    return `<button class="vps-option ${monitorState}${active?' active':''}${item.has_data?'':' no-data'}" data-target="${escapeHtml(item.target_name)}" aria-pressed="${active}" title="${escapeHtml(item.display_name)} · ${monitorLabel}"><i></i><span>${escapeHtml(item.display_name)}</span></button>`;
  }).join('');
}

function normalizeVpsCustomerState(value,collectorEnabled){
  if(value==='active'||value==='disabled'||value==='retired')return value;
  if(value==null)return collectorEnabled===false?'disabled':'active';
  return 'disabled';
}

function vpsPickerMonitorState(item,data){
  if(normalizeVpsCustomerState(item.customer_state,item.collector_enabled)!=='active')return 'disabled';
  return data?.fresh&&data?.item?.online?'online':'offline';
}

async function refreshVpsPickerStatus(){
  const targets=[...state.vpsTargets];
  if(!targets.length)return false;

  const statuses=await Promise.all(targets.map(async item=>{
    if(item.customer_state!=='active')return [item.target_name,'disabled'];
    try{
      const data=await getJSON(`/api/vps-status?target=${encodeURIComponent(item.target_name)}`);
      return [item.target_name,vpsPickerMonitorState(item,data)];
    }catch(error){
      console.error(error);
      return [item.target_name,'offline'];
    }
  }));

  const byTarget=new Map(statuses);
  state.vpsTargets=state.vpsTargets.map(item=>({
    ...item,
    monitor_state:byTarget.get(item.target_name)||item.monitor_state||'offline'
  }));
  renderVpsPicker();
  return true;
}

async function loadVpsTargets(){
  const requestId=++state.vpsCatalogRequest;
  const data=await getJSON('/api/vps-targets');
  if(requestId!==state.vpsCatalogRequest)return false;
  const order=['DMIT Premium','DMIT Eyeball','NetLab Global US','Zillion Network','Evoxt Premium','Alibaba Cloud','NetLab Global HK','Yecaoyun Cloud'];
  const catalog=data.targets.map(item=>({
    ...item,
    customer_state:normalizeVpsCustomerState(item.customer_state,item.collector_enabled)
  }));
  const hasRequested=requestedVps&&catalog.some(item=>item.target_name===requestedVps);
  if(requestedVps&&!hasRequested){
    catalog.push({
      target_name:requestedVps,
      display_name:requestedVps,
      collector_enabled:false,
      customer_state:'retired',
      has_data:false,
      monitor_state:'disabled'
    });
  }
  state.vpsTargets=catalog.filter(item=>item.customer_state!=='retired'||item.target_name===requestedVps).sort((a,b)=>{
    const ai=order.indexOf(a.target_name),bi=order.indexOf(b.target_name);
    const orderDifference=(ai<0?99:ai)-(bi<0?99:bi);
    return orderDifference||String(a.display_name).localeCompare(String(b.display_name),'zh-CN');
  });
  const names=state.vpsTargets.map(item=>item.target_name);
  if(requestedVps){
    state.lastVps=requestedVps;
  }else if(!names.includes(state.lastVps)){
    const activeTargets=state.vpsTargets.filter(item=>item.customer_state==='active');
    state.lastVps=activeTargets.some(item=>item.target_name==='DMIT Premium')
      ? 'DMIT Premium'
      : activeTargets[0]?.target_name||state.vpsTargets[0]?.target_name||state.lastVps;
  }
  renderVpsPicker();
  await refreshVpsPickerStatus();
  return true;
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

  const ct=chartTheme();
  ctx.clearRect(0,0,width,height);
  ctx.font = `${compact ? 12 : 20}px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif`;
  ctx.textBaseline='middle';
  for(let i=0;i<=5;i++){
    const y=plot.y+dataHeight*i/5, value=yMax*(1-i/5);
    ctx.strokeStyle=ct.gridStrong;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(plot.x,y);ctx.lineTo(plot.x+plot.w,y);ctx.stroke();
    ctx.fillStyle=ct.axis;ctx.textAlign='right';ctx.fillText(`${Math.round(value)}ms`,plot.x-(compact?8:18),y);
  }
  const xDivisions = compact ? 3 : 6;
  for(let i=0;i<=xDivisions;i++){
    const x=plot.x+plot.w*i/xDivisions, epoch=minTime+(maxTime-minTime)*i/xDivisions;
    ctx.strokeStyle=ct.gridSoft;ctx.beginPath();ctx.moveTo(x,plot.y);ctx.lineTo(x,plot.y+plot.h);ctx.stroke();
    ctx.fillStyle=ct.axis;ctx.textAlign=i===0?'left':i===xDivisions?'right':'center';ctx.fillText(axisShanghai(epoch),x,plot.y+plot.h+(compact?18:22));
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
  const ct=chartTheme();
  const {plot,zeroY,xAt,yAt}=state.chart;
  const offsetX=baseRect.left-rect.left,offsetY=baseRect.top-rect.top;
  const anchor=rows.reduce((sum,row)=>sum+row.epoch,0)/rows.length;
  const x=Math.max(plot.x,Math.min(plot.x+plot.w,xAt(anchor)))+offsetX;
  ctx.save();ctx.beginPath();ctx.rect(plot.x+offsetX,plot.y+offsetY,plot.w,plot.h);ctx.clip();
  ctx.strokeStyle=ct.hoverLine;ctx.lineWidth=1.35;ctx.setLineDash([6,5]);ctx.beginPath();ctx.moveTo(x,plot.y+offsetY);ctx.lineTo(x,plot.y+plot.h+offsetY);ctx.stroke();ctx.setLineDash([]);
  for(const row of rows){
    const meta=WAN_META[row.wan];
    const lineValue=valueOnLine(row.wan,anchor);
    if(lineValue!=null){
      const y=yAt(lineValue)+offsetY;ctx.shadowBlur=0;ctx.fillStyle=meta.color;ctx.beginPath();ctx.arc(x,y,4.5,0,Math.PI*2);ctx.fill();
      ctx.fillStyle=ct.hoverInner;ctx.beginPath();ctx.arc(x,y,2,0,Math.PI*2);ctx.fill();
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

/* ===== 侧栏紧凑三网视图（?view=mini）=====
   与完整监控同一页面、同一 /api/latency 同源只读数据；仅换一套紧凑呈现，供官网侧栏
   iframe 嵌入。永不编造延迟：数值只反映真实最新样本，最新样本失败或缺失时显示无响应 /
   暂无数据，而非保留过期值当当前；曲线取窗口内成功样本作为趋势。每 15 秒刷新一次。 */
const MINI_WANS=[['telecom','电信'],['mobile','移动'],['unicom','联通']];
const MINI_W=210,MINI_H=38,MINI_PAD=5,MINI_MAX_POINTS=48;

/** 由 /api/latency 的 samples 归约出每条线路的紧凑序列（纯函数，供 node --test 校验）。
    samples 已按时间升序。values 只收集成功且有 avg_ms 的点用于画趋势；current 只在
    最新样本成功时给出，否则为 null（不把过期样本当当前）。 */
function buildMiniSeries(samples){
  const rows=MINI_WANS.map(([wan,name])=>({wan,name,values:[],current:null,latestFailed:false,hasData:false}));
  const byWan={};
  for(const row of rows)byWan[row.wan]=row;
  const list=Array.isArray(samples)?samples:[];
  for(const sample of list){
    if(!sample||typeof sample!=='object')continue;
    const row=byWan[sample.wan];
    if(!row)continue;
    const value=Number(sample.avg_ms);
    const ok=Boolean(sample.success)&&sample.avg_ms!=null&&Number.isFinite(value);
    if(ok)row.values.push(value);
    row.current=ok?value:null;
    row.latestFailed=!ok;
  }
  for(const row of rows)row.hasData=row.values.length>0;
  return rows;
}

/** 线路展示态：ok(最新成功) / down(有测量但最新失败) / empty(窗口内无样本)。纯函数。 */
function miniRowState(row){
  if(!row)return 'empty';
  if(row.current!=null)return 'ok';
  if(row.latestFailed||row.hasData)return 'down';
  return 'empty';
}

/** 等距抽稀：样本多于上限时按均匀步长挑选真实测量点，首尾必取。纯函数。
    /api/latency?range=6h 每分钟一个桶（最多约 360 点），直接取末尾 N 点只会画出最近
    半小时，与「近 6 小时」的标注不符。这里只做取舍，不做平均、不插值、不新增样本，
    因此保留下来的每个顶点仍然是一次真实测量，曲线覆盖完整窗口。 */
function miniThin(values,maxPoints){
  const list=(Array.isArray(values)?values:[]).filter(v=>typeof v==='number'&&Number.isFinite(v));
  const limit=Math.max(2,Math.floor(Number(maxPoints)||2));
  if(list.length<=limit)return list;
  const last=list.length-1;
  const out=[];
  for(let i=0;i<limit;i+=1)out.push(list[Math.round(last*i/(limit-1))]);
  return out;
}

/** 三条线路共享的 ms 视觉域（纯函数）。同单位就该同轴：共享刻度既让「移动确实比电信高」
    这类差异如实可见，也让单条线路 1–2ms 的抖动自然显得很小，而不是各自铺满全高变成
    三座假山。真实范围只占视觉高度的 70%（上下各留 15% 缓冲），并以均值的 45% 和 8ms
    作为跨度下限。只改变坐标尺度，不改变任何样本值。无有效样本时返回 null。 */
function miniDomain(seriesList){
  const all=[];
  for(const values of (Array.isArray(seriesList)?seriesList:[])){
    if(!Array.isArray(values))continue;
    for(const value of values)if(typeof value==='number'&&Number.isFinite(value))all.push(value);
  }
  if(!all.length)return null;
  const min=Math.min(...all),max=Math.max(...all);
  const mean=all.reduce((sum,value)=>sum+value,0)/all.length;
  const span=Math.max((max-min)/.7,Math.abs(mean)*.45,8);
  const center=(min+max)/2;
  let low=center-span/2,high=center+span/2;
  if(low<0){high-=low;low=0;}
  return {min:low,max:high};
}

/** 把真实样本序列映射为平滑 SVG 曲线（viewBox 0 0 w h，上下留 pad）。纯函数。
    用 Catmull-Rom→三次贝塞尔，曲线严格穿过每个真实采样点：只是把已有折线画得顺滑，
    不新增、不插值任何虚构样本。domain 省略时按本序列自算，传入共享域时三条线路可比。
    返回 { d, endpoint }；有效点少于 2 个时 d='' 且 endpoint 为 null（调用方据此不画线、
    隐藏端点，保持诚实空态）。endpoint 为归一化坐标(0..1)。 */
function buildMiniCurve(values,w,h,pad,domain){
  const nums=(Array.isArray(values)?values:[]).filter(v=>typeof v==='number'&&Number.isFinite(v));
  if(nums.length<2)return {d:'',endpoint:null};
  const p=pad==null?3:pad;
  const usable=domain&&Number.isFinite(domain.min)&&Number.isFinite(domain.max)&&domain.max>domain.min;
  const scale=usable?domain:miniDomain([nums]);
  const span=scale.max-scale.min;
  const innerH=h-p*2,stepX=(w-p*2)/(nums.length-1);
  const clampY=value=>Math.max(p,Math.min(h-p,value));
  const pts=nums.map((v,i)=>[p+stepX*i,clampY(p+innerH*(1-(v-scale.min)/span))]);
  const r=n=>Math.round(n*100)/100;
  let d=`M${r(pts[0][0])},${r(pts[0][1])}`;
  for(let i=0;i<pts.length-1;i+=1){
    const p0=pts[i-1]||pts[i],p1=pts[i],p2=pts[i+1],p3=pts[i+2]||pts[i+1];
    const c1x=p1[0]+(p2[0]-p0[0])/8,c1y=clampY(p1[1]+(p2[1]-p0[1])/8);
    const c2x=p2[0]-(p3[0]-p1[0])/8,c2y=clampY(p2[1]-(p3[1]-p1[1])/8);
    d+=`C${r(c1x)},${r(c1y)} ${r(c2x)},${r(c2y)} ${r(p2[0])},${r(p2[1])}`;
  }
  const last=pts[pts.length-1];
  return {d,endpoint:{x:r(last[0]/w),y:r(last[1]/h)}};
}

function setMiniStatus(state){
  document.documentElement.dataset.miniState=state;
  const label=$('#miniStatus b');
  if(label)label.textContent=state==='live'?'实时':state==='stale'?'同步失败':'读取中';
}

function renderMini(rows){
  // 先抽稀再求共享域：三条曲线必须落在同一把尺子上，读数才可比。
  const series=rows.map(row=>miniThin(row.values,MINI_MAX_POINTS));
  const domain=miniDomain(series);
  rows.forEach((row,index)=>{
    const state=miniRowState(row);
    const curve=buildMiniCurve(series[index],MINI_W,MINI_H,MINI_PAD,domain);
    // d 为空时同时把状态降级为无曲线态，避免上一次渲染的样式残留。
    const drawn=curve.d!==''?state:'empty';
    for(const path of $$(`.mini-plot path[data-wan="${row.wan}"]`)){
      path.setAttribute('d',curve.d);
      path.dataset.state=drawn;
    }
    const dot=$(`.mini-endpoint[data-wan="${row.wan}"]`);
    if(dot){
      if(curve.endpoint){dot.style.left=`${curve.endpoint.x*100}%`;dot.style.top=`${curve.endpoint.y*100}%`;}
      dot.dataset.state=drawn;
      dot.hidden=!curve.endpoint;
    }
    const readout=$(`.mini-readout[data-wan="${row.wan}"]`);
    if(!readout)return;
    readout.dataset.state=state;
    const num=readout.querySelector('.mini-num');
    const unit=readout.querySelector('.mini-unit');
    if(num)num.textContent=state==='ok'?String(Math.round(row.current)):state==='down'?'无响应':'暂无数据';
    if(unit)unit.hidden=state!=='ok';
  });
}

let miniRendered=false;
async function loadMini(first){
  if(first)setMiniStatus('loading');
  try{
    const data=await getJSON('/api/latency?range=6h&type=icmp');
    renderMini(buildMiniSeries(data.samples));
    miniRendered=true;
    setMiniStatus('live');
  }catch(error){
    // 失败不回退假数据；已渲染过真实曲线时保留并标记过期，从未成功时显示诚实空态。
    if(!miniRendered)renderMini(buildMiniSeries([]));
    setMiniStatus('stale');
  }
}

function initMini(){
  loadMini(true);
  setInterval(()=>{if(!document.hidden)loadMini(false)},15000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadMini(false)});
}

/* ===== 主题嵌入契约（只读接收，监控内不新增任何主题开关） =====
   监控主题只有两条来源：URL 的 ?theme= 初值（避免首屏闪烁），以及父页面经精确 origin
   校验后单向下发的版本化 postMessage。直接打开（无父 / 无 query）时保持既有默认深色。
   主题消息不含任何客户 / 节点 / 监控 / 凭据 / 业务数据，也不提供任何回读通道。 */
const THEME_MESSAGE_TYPE='nsp-monitor-theme:v1';
function normalizeTheme(value){return value==='light'?'light':'dark';}
function isLoopbackOrigin(origin){
  try{const host=new URL(origin).hostname;return host==='localhost'||host==='127.0.0.1'||host==='[::1]'||host==='::1';}catch{return false;}
}
function chartTheme(){
  const light=typeof document!=='undefined'&&document.documentElement.dataset.theme==='light';
  return light
    ? {gridStrong:'rgba(90,102,122,.18)',gridSoft:'rgba(90,102,122,.10)',axis:'#5c6472',hoverLine:'rgba(40,46,57,.55)',hoverInner:'#ffffff'}
    : {gridStrong:'rgba(115,130,150,.12)',gridSoft:'rgba(115,130,150,.08)',axis:'#a0a5ad',hoverLine:'rgba(225,231,239,.78)',hoverInner:'#f7fafc'};
}
/* 生产可信父源：由 <meta name="monitor-embed-origin"> 绑定已冻结的 canonical 网站
   origin；未配置即对跨源父页面 fail-closed。 */
function approvedParentOrigins(){
  const list=[];
  try{
    const meta=document.querySelector('meta[name="monitor-embed-origin"]');
    const raw=meta&&meta.content?meta.content.trim():'';
    if(raw){for(const item of raw.split(/[\s,]+/)){if(!item)continue;try{list.push(new URL(item).origin);}catch{}}}
  }catch{}
  return list;
}
/* 纯校验：source 必须是本 iframe 的父窗口；type 必须精确匹配版本化类型；theme 只接受
   dark|light；origin 必须命中已批准网站 origin、或与监控同源、或仅当监控自身运行在
   loopback 时接受 loopback 父源。任一不满足即拒绝。 */
function isTrustedThemeMessage(event,config){
  if(!event||event.source==null||event.source!==config.parentWindow)return false;
  const data=event.data;
  if(!data||typeof data!=='object'||data.type!==THEME_MESSAGE_TYPE)return false;
  if(data.theme!=='dark'&&data.theme!=='light')return false;
  const origin=event.origin;
  if(Array.isArray(config.approvedOrigins)&&config.approvedOrigins.includes(origin))return true;
  if(origin===config.monitorOrigin)return true;
  if(config.allowLoopback&&isLoopbackOrigin(origin))return true;
  return false;
}
function applyTheme(theme){document.documentElement.dataset.theme=normalizeTheme(theme);}
function initThemeEmbed(){
  document.documentElement.dataset.embedded=window.parent!==window?'true':'false';
  try{applyTheme(new URLSearchParams(location.search).get('theme'));}catch{applyTheme('dark');}
  const monitorOrigin=location.origin;
  const config={parentWindow:window.parent,monitorOrigin,approvedOrigins:approvedParentOrigins(),allowLoopback:isLoopbackOrigin(monitorOrigin)};
  window.addEventListener('message',event=>{
    if(!isTrustedThemeMessage(event,config))return;
    applyTheme(event.data.theme);
    if(state.chart)drawChart(state.samples);
  });
}

async function init(){
  bindInteractions();
  try{await Promise.all([loadOverview(),loadVpsTargets(),loadTargets(),loadRoute()]);await Promise.all([loadChart(),loadLive(false),loadVpsStatus()]);}
  catch(error){console.error(error);$('#chartLoading').innerHTML='<span></span>候选 API 读取失败';setOverall({status:'stale',label:'读取失败'});}
  setInterval(()=>{if(!document.hidden){loadLive(true);loadVpsStatus()}},5000);
  setInterval(()=>{if(!document.hidden)loadVpsTargets()},15000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){loadLive(true);loadVpsStatus();loadVpsTargets()}});
}
if(typeof window!=='undefined'&&typeof document!=='undefined'){
  initThemeEmbed();
  // 紧凑侧栏视图只跑轻量 mini 逻辑，不加载完整仪表板与其多路轮询。
  if(document.documentElement.dataset.view==='mini')initMini();
  else init();
}
/* 供 node --test 校验纯逻辑；浏览器经典脚本里 module 未定义，短路跳过。 */
if(typeof module!=='undefined'&&module.exports){
  module.exports={THEME_MESSAGE_TYPE,normalizeTheme,isLoopbackOrigin,isTrustedThemeMessage,normalizeVpsCustomerState,vpsPickerMonitorState,buildMiniSeries,miniRowState,miniThin,miniDomain,buildMiniCurve};
}
