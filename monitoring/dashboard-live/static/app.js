/* 监控面板界面语言（内联在 app.js：VPS 监控入口只放行 / /app.js /master.css，不能新增静态路径）：中文（默认）/ English，零依赖。
   语言来源优先级：URL ?lang=（官网 iframe 嵌入时传入）→ 本站 localStorage `nsp.lang`
   （与官网同名同取值；监控是独立子域，浏览器不会与官网共享存储）→ 浏览器语言（zh* → 中文，
   其余 → English）。官网嵌入后切换语言经已校验 origin 的 postMessage 下发。
   只翻译界面文案；服务端返回的少量状态文案按原文查表翻译，查不到时原样显示。 */
const MonitorI18n=(function(root){
  const STORAGE_KEY='nsp.lang';
  const LANG_MESSAGE_TYPE='nsp-monitor-lang:v1';

  const M={
    zh:{
      htmlLang:'zh-CN',
      title:'广州三网线路监控',
      heading:'广州三网监控',
      langGroup:'界面语言',
      reading:'读取中',
      lastUpdate:'最后更新：',
      autoRefresh:'每分钟自动刷新',
      vpsPicker:'TCP VPS 测试点',
      readingVps:'读取 VPS',
      axisLabel:'延迟（ms）',
      city:'广州',
      wan:{telecom:'电信',mobile:'移动',unicom:'联通'},
      chartLabel:'三网延迟趋势图',
      loadingSamples:'正在读取真实样本',
      ranges:{'6h':'最近 6 小时','24h':'最近 24 小时'},
      liveOk:'实时同步 · 5 秒轮询',
      liveFailed:'实时同步暂时失败',
      updateCaption:'数据每分钟更新一次',
      chartCount:(count,minutes)=>`${count} 个绘图点 · ${minutes} 分钟粒度`,
      uptime:'运行时间',
      memory:'内存',
      storage:'存储',
      upload:'上传',
      download:'下载',
      days:n=>`${n} 天`,
      hours:n=>`${n} 小时`,
      minutes:n=>`${n} 分钟`,
      notConnected:'未接入',
      unavailable:'暂不可用',
      offline:'离线',
      nezhaLive:'哪吒监控实时数据',
      picker:{online:'在线',offline:'离线或连接不上',disabled:'已停用',loading:'读取中'},
      noData:'暂无数据',
      noResponse:'无响应',
      loss:value=>`丢包 ${value}`,
      failedSample:'失败样本',
      routeTitle:'路由追踪（广州）',
      routeLead:'每日去回程真实结果 · 只读展示',
      outbound:'去程路由',
      returnRoute:'回程路由',
      expand:'展开',
      collapse:'收起',
      returnVps:'回程 VPS',
      outboundTarget:'去程目标',
      routeReading:'正在读取',
      routeUpdated:'最后更新',
      cols:{hop:'跳数',ip:'IP',latency:'延迟',location:'地区（仅供参考）',asn:'ASN',reverse:'反向解析'},
      routeLoadingTitle:'正在读取真实路由',
      routeLoadingBody:'只展示已入库的标准化逐跳数据。',
      premiumNote:'精品线路将以金色突出。',
      routeMoreExpand:n=>`展开完整路由（共 ${n} 跳）`,
      routeMoreCollapse:n=>`收起完整路由（共 ${n} 跳）`,
      hopCount:n=>`${n} 跳`,
      noRouteData:'暂无路由数据',
      routeDescriptions:{
        no_data:'当前线路、方向、协议与目标组合没有已入库记录。',
        failed:'本次探测没有返回可展示的逐跳数据。',
        unavailable:'数据库有摘要，但对应的标准化逐跳文件不可用。',
        other:'当前没有可展示的逐跳数据。'
      },
      failedReason:error=>`失败原因：${error}`,
      routeLoadFailedTitle:'路由数据读取失败',
      routeLoadFailedBody:'候选只读 API 暂时不可用，请稍后刷新。',
      bandwidthTitle:'广州电信每日 4 线程测速',
      bandwidthLead:'线路带宽：下行 200 Mbps · 上行 100 Mbps · 每项 20 秒',
      bandwidthWaiting:'等待测速上线',
      bandwidthCardNote:'4 线程 · 每项 20 秒',
      testedAt:'测试时间',
      disabled:'已停用',
      paused:'暂停测速',
      failed:'失败',
      roundFailed:'本轮失败',
      bandwidthUpdated:time=>`最近更新 ${time}`,
      bandwidthSuccess:(ok,total)=>`${ok} / ${total} 个启用节点测速成功`,
      bandwidthFailedNote:(failed,disabled)=>`${failed} 个失败，${disabled} 个已停用；失败记录不显示为 0 Mbps。`,
      bandwidthNotLive:total=>`${total} 个启用节点 4 线程测速尚未上线`,
      bandwidthNotLiveNote:disabled=>`${disabled} 个节点已停用；无有效数据时保持 “—”。`,
      bandwidthEmptyTitle:'8 节点 4 线程测速尚未上线',
      bandwidthEmptyBody:'这里展示广州电信到各节点的真实链路结果；无数据时不显示 0 Mbps。',
      trendLabels:['7 天上传','7 天下载','Retr 趋势'],
      bandwidthFailedLoad:'测速数据读取失败',
      footerLeft:'候选前端 · 端口 3003 · 数据库只读',
      footerRight:'不提供测速、重启、切换线路、修改路由或修复操作',
      apiFailed:'候选 API 读取失败',
      readFailed:'读取失败',
      dateLocale:'zh-CN',
      regions:{},
      server:{}
    },
    en:{
      htmlLang:'en',
      title:'Guangzhou Three-Carrier Route Monitor',
      heading:'Guangzhou Three-Carrier Monitor',
      langGroup:'Interface language',
      reading:'Loading',
      lastUpdate:'Last updated: ',
      autoRefresh:'Refreshes every minute',
      vpsPicker:'TCP VPS test points',
      readingVps:'Loading VPS',
      axisLabel:'Latency (ms)',
      city:'Guangzhou ',
      wan:{telecom:'Telecom',mobile:'Mobile',unicom:'Unicom'},
      chartLabel:'Three-carrier latency trend',
      loadingSamples:'Loading real samples',
      ranges:{'6h':'Last 6 hours','24h':'Last 24 hours'},
      liveOk:'Live sync · 5 s polling',
      liveFailed:'Live sync temporarily failed',
      updateCaption:'Data updates every minute',
      chartCount:(count,minutes)=>`${count} points · ${minutes}-minute buckets`,
      uptime:'Uptime',
      memory:'Memory',
      storage:'Storage',
      upload:'Upload',
      download:'Download',
      days:n=>`${n} ${n===1?'day':'days'}`,
      hours:n=>`${n} ${n===1?'hour':'hours'}`,
      minutes:n=>`${n} min`,
      notConnected:'Not connected',
      unavailable:'Unavailable',
      offline:'Offline',
      nezhaLive:'Nezha live data',
      picker:{online:'Online',offline:'Offline or unreachable',disabled:'Disabled',loading:'Loading'},
      noData:'No data',
      noResponse:'No response',
      loss:value=>`Loss ${value}`,
      failedSample:'Failed sample',
      routeTitle:'Route trace (Guangzhou)',
      routeLead:'Real daily outbound and return results · read-only',
      outbound:'Outbound',
      returnRoute:'Return',
      expand:'Expand',
      collapse:'Collapse',
      returnVps:'Return VPS',
      outboundTarget:'Outbound target',
      routeReading:'Loading',
      routeUpdated:'Last updated',
      cols:{hop:'Hop',ip:'IP',latency:'Latency',location:'Location (approx.)',asn:'ASN',reverse:'Reverse DNS'},
      routeLoadingTitle:'Loading real routes',
      routeLoadingBody:'Only stored, normalized hop-by-hop data is shown. ',
      premiumNote:'Premium routes are highlighted in gold.',
      routeMoreExpand:n=>`Show full route (${n} hops)`,
      routeMoreCollapse:n=>`Hide full route (${n} hops)`,
      hopCount:n=>`${n} ${n===1?'hop':'hops'}`,
      noRouteData:'No route data',
      routeDescriptions:{
        no_data:'No stored record for this carrier, direction, protocol and target.',
        failed:'This probe returned no hop-by-hop data to show.',
        unavailable:'A summary exists, but the normalized hop file is unavailable.',
        other:'No hop-by-hop data to show right now.'
      },
      failedReason:error=>`Failure reason: ${error}`,
      routeLoadFailedTitle:'Route data unavailable',
      routeLoadFailedBody:'The read-only API is temporarily unavailable. Please refresh later.',
      bandwidthTitle:'Guangzhou Telecom daily 4-stream speed test',
      bandwidthLead:'Line bandwidth: 200 Mbps down · 100 Mbps up · 20 s per test',
      bandwidthWaiting:'Speed tests coming soon',
      bandwidthCardNote:'4 streams · 20 s per test',
      testedAt:'Tested',
      disabled:'Disabled',
      paused:'Paused',
      failed:'Failed',
      roundFailed:'Last run failed',
      bandwidthUpdated:time=>`Updated ${time}`,
      bandwidthSuccess:(ok,total)=>`${ok} / ${total} enabled nodes tested successfully`,
      bandwidthFailedNote:(failed,disabled)=>`${failed} failed, ${disabled} disabled; failed runs never show as 0 Mbps.`,
      bandwidthNotLive:total=>`4-stream tests for ${total} enabled nodes are not live yet`,
      bandwidthNotLiveNote:disabled=>`${disabled} nodes disabled; values stay “—” without valid data.`,
      bandwidthEmptyTitle:'4-stream tests for 8 nodes are not live yet',
      bandwidthEmptyBody:'Real results from Guangzhou Telecom to each node appear here; no data never shows as 0 Mbps.',
      trendLabels:['7-day upload','7-day download','Retr trend'],
      bandwidthFailedLoad:'Speed test data unavailable',
      footerLeft:'Candidate front end · port 3003 · read-only database',
      footerRight:'No speed tests, restarts, route switching, route changes or repairs are offered',
      apiFailed:'Read-only API unavailable',
      readFailed:'Load failed',
      dateLocale:'en-US',
      regions:{'美国':'US','新加坡':'Singapore','香港':'Hong Kong','马来':'Malaysia'},
      server:{
        '正常':'Normal',
        '存在单目标波动':'Single-target fluctuation',
        '多目标异常':'Multi-target issue',
        '线路异常':'Line issue',
        '数据过期':'Data stale',
        '暂无该组合的路由数据':'No route data for this combination',
        '已到达目标':'Target reached',
        '探测完成 · 终点未回应':'Probe complete · endpoint did not reply',
        '未到达目标':'Target not reached',
        '探测失败':'Probe failed',
        '逐跳文件不可用':'Hop file unavailable',
        '读取失败':'Load failed'
      }
    }
  };

  function resolveLang(urlLang,stored,navigatorLanguage){
    if(urlLang==='zh'||urlLang==='en')return urlLang;
    if(stored==='zh'||stored==='en')return stored;
    if(typeof navigatorLanguage!=='string'||!navigatorLanguage)return 'zh';
    return navigatorLanguage.toLowerCase().startsWith('zh')?'zh':'en';
  }

  function readStored(){try{return root.localStorage?root.localStorage.getItem(STORAGE_KEY):null}catch{return null}}
  function writeStored(lang){try{if(root.localStorage)root.localStorage.setItem(STORAGE_KEY,lang)}catch{}}
  function urlLang(){try{return new URLSearchParams(root.location.search).get('lang')}catch{return null}}

  let lang=typeof document==='undefined'?'zh':resolveLang(urlLang(),readStored(),root.navigator&&root.navigator.language);
  const listeners=[];

  /** 服务端返回的中文文案：中文原样，英文查表；VPS 显示名只翻译开头的地区前缀。 */
  function serverText(text){
    if(lang==='zh'||typeof text!=='string')return text;
    if(Object.prototype.hasOwnProperty.call(M.en.server,text))return M.en.server[text];
    const match=/^(\S+)\s+(.+)$/.exec(text);
    if(match&&Object.prototype.hasOwnProperty.call(M.en.regions,match[1]))return `${M.en.regions[match[1]]} ${match[2]}`;
    return text;
  }

  function applyStatic(){
    if(typeof document==='undefined')return;
    const t=M[lang];
    document.documentElement.lang=t.htmlLang;
    document.title=t.title;
    for(const node of document.querySelectorAll('[data-i18n]')){
      const value=lookup(t,node.dataset.i18n);
      if(typeof value==='string')node.textContent=value;
    }
    for(const node of document.querySelectorAll('[data-i18n-aria]')){
      const value=lookup(t,node.dataset.i18nAria);
      if(typeof value==='string')node.setAttribute('aria-label',value);
    }
    for(const node of document.querySelectorAll('[data-i18n-region]')){
      const original=node.dataset.i18nRegion;
      node.textContent=serverText(original);
    }
    for(const button of document.querySelectorAll('#langToggle button')){
      const active=button.dataset.lang===lang;
      button.setAttribute('aria-pressed',String(active));
      button.classList.toggle('active',active);
    }
    const group=document.getElementById('langToggle');
    if(group)group.setAttribute('aria-label',t.langGroup);
  }

  function lookup(object,path){
    return String(path).split('.').reduce((value,key)=>value==null?undefined:value[key],object);
  }

  function setLang(next,{persist=true}={}){
    if(next!=='zh'&&next!=='en'||next===lang)return;
    lang=next;
    if(persist)writeStored(next);
    applyStatic();
    for(const listener of listeners)listener(lang);
  }

  const api={
    STORAGE_KEY,LANG_MESSAGE_TYPE,M,resolveLang,
    get lang(){return lang},
    get t(){return M[lang]},
    serverText,applyStatic,setLang,
    onChange(listener){listeners.push(listener)}
  };
  root.MonitorI18n=api;
  return api;
})(typeof window!=='undefined'?window:globalThis);

const I18N = MonitorI18n;
const tr = () => I18N.t;
const serverText = text => I18N.serverText(text);
const WAN_META = {
  telecom: {color:'#3867c5'},
  mobile: {color:'#5a9033'},
  unicom: {color:'#b03533'}
};
const wanName = wan => tr().wan[wan];
const RANGE_MS = {'1h':3600000,'6h':21600000,'24h':86400000,'7d':604800000};
// 官网从买家线路点进来时带 ?vps=<target_name>：首屏选中该服务器（不在列表里则按原规则回落），不写入本站 localStorage。
const urlVps=(()=>{try{const v=new URLSearchParams(location.search).get('vps');return v&&v.length<=128&&!/[\u0000-\u001f\u007f]/.test(v)?v:null}catch{return null}})();
const savedVps=(()=>{try{return localStorage.getItem('network-monitor-selected-vps')}catch{return null}})();
const state = {overall:null, chartSignature:null, chartMeta:null, routeData:null, routeError:false, vpsStatusData:null, bandwidthPayload:null, bandwidthFailed:false, type:'icmp', range:'24h', target:'AliDNS', lastVps:urlVps||savedVps||'DMIT Premium', vpsTargets:[], visible:new Set(['telecom','mobile','unicom']), samples:[], chart:null, liveKey:null, targetRequest:0, chartRequest:0, liveRequest:0, refreshPromise:null, chartController:null, vpsStatusRequest:0, vpsStatusPromise:null, vpsStatusTarget:null};
const routeState={wan:'telecom',direction:'outbound',protocol:'icmp',target:state.lastVps,targets:[],hops:[],expanded:false,request:0,controller:null};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const fmt = (value, digits=1, suffix='') => value == null ? '—' : `${Number(value).toFixed(digits)}${suffix}`;
const pct = value => fmt(value, value != null && value % 1 ? 1 : 0, '%');
const escapeHtml = value => String(value ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const targetDisplayName = (target, fallback=target) => serverText(target==='Alibaba Cloud'?'新加坡 Sakura Cloud':fallback);
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
  state.overall = overall;
  node.querySelector('b').textContent = serverText(overall.label);
}

async function loadOverview(){
  const data = await getJSON('/api/overview');
  setOverall(data.overall);
  $('#lastUpdate').textContent = formatShanghai(data.latest_update);
}

function formatUptime(value){
  if(value==null)return '—';
  const seconds=Math.max(0,Number(value)),days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600),minutes=Math.floor(seconds%3600/60);
  if(days)return tr().days(days);
  if(hours)return tr().hours(hours);
  return tr().minutes(minutes);
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
  const panel=$('#systemPanel');panel.dataset.status=status;panel.title=`${targetDisplayName(target)} · ${label}`;
  for(const id of ['#vpsUptime','#vpsCpu','#vpsMemory','#vpsStorage','#vpsUpload','#vpsDownload'])$(id).textContent=label;
  setMetricBar('#vpsCpuBar',null);setMetricBar('#vpsMemoryBar',null);setMetricBar('#vpsStorageBar',null);
}

function renderVpsStatus(data){
  state.vpsStatusData=data;
  const item=data.item;
  if(!item){
    const label=data.source_status==='connecting'?tr().reading:tr().notConnected;
    return renderVpsUnavailable(data.source_status==='connecting'?'stale':'missing',label,data.target);
  }
  if(!data.fresh)return renderVpsUnavailable('stale',tr().unavailable,data.target);
  if(!item.online)return renderVpsUnavailable('offline',tr().offline,data.target);
  const panel=$('#systemPanel');panel.dataset.status='online';panel.title=`${targetDisplayName(data.target)} · ${tr().nezhaLive}`;
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
      if(requestId===state.vpsStatusRequest&&target===state.lastVps){state.vpsStatusData=null;renderVpsUnavailable('stale',tr().unavailable,target)}
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
    const displayName=targetDisplayName(item.target_name,item.display_name);
    const monitorState=['online','offline','disabled'].includes(item.monitor_state)?item.monitor_state:'loading';
    const monitorLabel=tr().picker[monitorState];
    return `<button class="vps-option ${monitorState}${active?' active':''}${item.has_data?'':' no-data'}" data-target="${escapeHtml(item.target_name)}" aria-pressed="${active}" title="${escapeHtml(displayName)} · ${monitorLabel}"><i></i><span>${escapeHtml(displayName)}</span></button>`;
  }).join('');
}

const disabledVpsTargets=new Set();

function vpsPickerMonitorState(item,data){
  if(disabledVpsTargets.has(item.target_name))return 'disabled';
  return data?.fresh&&data?.item?.online?'online':'offline';
}

async function refreshVpsPickerStatus(){
  const targets=[...state.vpsTargets];
  if(!targets.length)return false;

  const statuses=await Promise.all(targets.map(async item=>{
    if(disabledVpsTargets.has(item.target_name))return [item.target_name,'disabled'];
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
  const data=await getJSON('/api/vps-targets');
  const order=['DMIT Premium','DMIT Eyeball','NetLab Global US','Zillion Network','Evoxt Premium','Alibaba Cloud','NetLab Global HK','Yecaoyun Cloud'];
  state.vpsTargets=data.targets.filter(item=>item.target_name!=='Yecaoyun Cloud2-current' && !/Yecaoyun Cloud2/i.test(item.display_name ?? '')).sort((a,b)=>{
    const ai=order.indexOf(a.target_name),bi=order.indexOf(b.target_name);
    return (ai<0?99:ai)-(bi<0?99:bi);
  });
  const names=state.vpsTargets.map(item=>item.target_name);
  if(!names.includes(state.lastVps))state.lastVps=names.includes('DMIT Premium')?'DMIT Premium':names[0];
  routeState.target=state.lastVps;
  renderVpsPicker();
  // 8 个测试点的在线状态只影响选择器圆点，不阻塞图表首屏。
  void refreshVpsPickerStatus();
}

async function selectVps(target,{loadRouteData=true}={}){
  if(!state.vpsTargets.some(item=>item.target_name===target))return false;
  ++state.targetRequest;state.target=target;state.lastVps=target;routeState.target=target;state.liveKey=null;
  try{localStorage.setItem('network-monitor-selected-vps',target)}catch{}
  renderVpsPicker();
  if(routeState.targets.some(item=>item.target_name===target))$('#routeTarget').value=target;
  clearPreviousSelection();
  const requests=[loadChart(),loadLive(false),loadVpsStatus(target)];
  if(loadRouteData)requests.push(loadRoute());
  await Promise.all(requests);
  return true;
}

function setLegendValue(wan,row,animate=false){
  const label=$(`#legend${wan[0].toUpperCase()+wan.slice(1)}`);
  const button=label.closest('button');
  const value=!row?tr().noData:row.success && row.avg_ms!=null ? `${Number(row.avg_ms).toFixed(1)} ms` : tr().noResponse;
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
    label.textContent=tr().reading;button.classList.remove('latest-failed','value-change');
  }
  state.samples=[];state.chartSignature=null;
  if(state.chart)drawChart([]);
  $('#chartTooltip').classList.remove('show');clearHover();
}

async function loadLive(refreshChartOnChange=true){
  const requestedType=state.type,requestedTarget=state.target,requestId=++state.liveRequest;
  try{
    const data=await getJSON(`/api/live?type=${requestedType}&target=${encodeURIComponent(requestedTarget)}`);
    if(requestId!==state.liveRequest || requestedType!==state.type || requestedTarget!==state.target)return;
    state.liveItems=data.items;
    const nextKey=`${requestedType}|${requestedTarget}|${data.latest_timestamp ?? 'none'}`;
    const changed=state.liveKey!==null && state.liveKey!==nextKey;
    for(const wan of Object.keys(WAN_META))setLegendValue(wan,data.items.find(item=>item.wan===wan),changed);
    $('#liveStatus').classList.remove('stale');
    renderLiveStatus();
    state.liveKey=nextKey;
    if(changed && refreshChartOnChange){
      if(!state.refreshPromise){
        state.refreshPromise=Promise.all([loadOverview(),loadChart()]).finally(()=>{state.refreshPromise=null});
      }
      await state.refreshPromise;
    }
  }catch(error){
    if(requestId!==state.liveRequest)return;
    console.error(error);$('#liveStatus').classList.add('stale');renderLiveStatus();
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
  tooltip.innerHTML=`<time>${formatShanghai(rows[0].timestamp)}</time>${rows.map(row=>`<div class="tip-line ${row.success?'':'fail'} ${row.wan}"><i></i><span>${escapeHtml(wanName(row.wan))}</span><small>${escapeHtml(row.success?tr().loss(fmt(row.loss_percent,0,'%')):tr().failedSample)}</small><b>${row.success?fmt(row.avg_ms,2,' ms'):escapeHtml(tr().noResponse)}</b></div>`).join('')}`;
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
    // 每分钟的刷新经常命中 20 秒边缘缓存，拿到与上次相同的数据时不重绘整张画布。
    const signature=chartSignature(data);
    if(signature!==state.chartSignature||!state.chart){
      state.samples=data.samples;state.chartSignature=signature;
      drawChart(state.samples);updateLegend(state.samples);
    }
    state.chartMeta={count:data.count,bucketSeconds:data.bucket_seconds};
    renderChartMeta();
    $('#chartLoading').classList.add('hidden');
    return true;
  }catch(error){
    if(error.name==='AbortError')return false;
    throw error;
  }finally{
    if(requestId===state.chartRequest){
      $('#chartLoading').classList.add('hidden');
    }
    if(state.chartController===controller)state.chartController=null;
  }
}

function chartSignature(data){
  const samples=Array.isArray(data.samples)?data.samples:[];
  const first=samples[0],last=samples.at(-1);
  return [data.type,data.target,data.range,data.count,samples.length,first?.timestamp,last?.timestamp,last?.wan,last?.avg_ms,last?.success].join('|');
}

function renderChartMeta(){
  if(state.chartMeta)$('#chartCount').textContent=tr().chartCount(Number(state.chartMeta.count).toLocaleString(tr().dateLocale),state.chartMeta.bucketSeconds/60);
  $('#chartRangeLabel').textContent=`${tr().ranges[state.range]||state.range} · Asia/Shanghai`;
}

function renderLiveStatus(){
  const node=$('#liveStatus');
  node.innerHTML=`<i></i>${escapeHtml(node.classList.contains('stale')?tr().liveFailed:tr().liveOk)}`;
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
  $('#routeToggle').innerHTML=routeState.expanded?`${escapeHtml(tr().collapse)} <span>⌃</span>`:`${escapeHtml(tr().expand)} <span>⌄</span>`;
  $('#routeMore').innerHTML=routeState.expanded
    ? `${escapeHtml(tr().routeMoreCollapse(routeState.hops.length))} <span>⌃</span>`
    : `${escapeHtml(tr().routeMoreExpand(routeState.hops.length))} <span>⌄</span>`;
}

function renderRouteTargets(targets){
  routeState.targets=targets;
  const select=$('#routeTarget');
  const names=targets.map(item=>item.target_name);
  if(!names.includes(routeState.target))routeState.target=names[0]||'';
  select.innerHTML=targets.map(item=>`<option value="${escapeHtml(item.target_name)}">${escapeHtml(targetDisplayName(item.target_name,item.display_name))}</option>`).join('');
  select.value=routeState.target;
  select.disabled=targets.length<2;
  $('#routeTargetWrap').classList.toggle('disabled',select.disabled);
  $('#routeTargetWrap').querySelector('span').textContent=routeState.direction==='return'?tr().returnVps:tr().outboundTarget;
}

function renderRouteEmpty(title,description,status='no_data'){
  $('#routeTableWrap').classList.add('empty-table');
  $('#routeRows').innerHTML=`<tr><td colspan="6"><div class="empty-state"><span class="route-icon">⌁</span><b>${escapeHtml(title)}</b><p>${escapeHtml(description)}<span class="premium-route-note">${escapeHtml(tr().premiumNote)}</span></p></div></td></tr>`;
  routeState.hops=[];setRouteExpanded(false);
  const result=$('#routeResult');result.dataset.status=status;result.querySelector('b').textContent=title;result.querySelector('span').textContent='';
}

function renderRoute(data,{keepExpanded=routeState.expanded}={}){
  state.routeData=data;state.routeError=false;
  renderRouteTargets(data.targets||[]);
  const summary=data.summary||{status:'no_data',label:tr().noRouteData,hop_count:0};
  const label=serverText(summary.label);
  const result=$('#routeResult');result.dataset.status=summary.status;result.querySelector('b').textContent=label;
  const details=[];
  if(summary.hop_count)details.push(tr().hopCount(summary.hop_count));
  if(summary.final_latency_ms!=null)details.push(`${Number(summary.final_latency_ms).toFixed(2)} ms`);
  if(summary.error&&summary.status!=='incomplete')details.push(summary.error);
  result.querySelector('span').textContent=details.join(' · ');
  $('#routeUpdated').textContent=data.item?formatShanghai(data.item.timestamp):'—';
  const hops=Array.isArray(data.hops)?data.hops:[];
  if(!hops.length){
    const descriptions=tr().routeDescriptions;
    const description=summary.status==='failed'&&summary.error
      ? tr().failedReason(summary.error)
      : descriptions[summary.status]||descriptions.other;
    renderRouteEmpty(label,description,summary.status);
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
  setRouteExpanded(keepExpanded);
}

async function loadRoute(){
  const requestId=++routeState.request;
  if(routeState.controller)routeState.controller.abort();
  const controller=new AbortController();routeState.controller=controller;
  const result=$('#routeResult');result.dataset.status='loading';result.querySelector('b').textContent=tr().routeReading;result.querySelector('span').textContent='';
  const params=new URLSearchParams({wan:routeState.wan,direction:routeState.direction,protocol:routeState.protocol,target_name:routeState.target});
  try{
    const data=await getJSON(`/api/routes?${params}`,{signal:controller.signal});
    if(requestId!==routeState.request)return false;
    if(data.query.wan!==routeState.wan||data.query.direction!==routeState.direction||data.query.protocol!==routeState.protocol||data.query.target_name!==routeState.target)return false;

    const availableTargets=(data.targets||[])
      .map(item=>item.target_name)
      .filter(Boolean);

    if(
      availableTargets.length &&
      !availableTargets.includes(routeState.target)
    ){
      const fallback=availableTargets[0];
      routeState.target=fallback;
      if(state.lastVps!==fallback)void selectVps(fallback,{loadRouteData:false});
      return loadRoute();
    }

    renderRoute(data);return true;
  }catch(error){
    if(error.name==='AbortError')return false;
    if(requestId===routeState.request){
      $('#routeUpdated').textContent='—';
      state.routeData=null;state.routeError=true;
      renderRouteEmpty(tr().routeLoadFailedTitle,tr().routeLoadFailedBody,'unavailable');
    }
    console.error(error);return false;
  }finally{
    if(routeState.controller===controller)routeState.controller=null;
  }
}

async function changeRouteFilter(field,value){
  if(field==='target')return selectVps(value);
  routeState[field]=value;

  setRouteSwitch(
    field==='wan'
      ? '#routeWanSwitch'
      : field==='direction'
        ? '#routeDirectionSwitch'
        : '#routeProtocolSwitch',
    value
  );

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
  $$('#langToggle button').forEach(button=>button.addEventListener('click',()=>I18N&&I18N.setLang(button.dataset.lang)));
  let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>drawChart(state.samples),120)});
}


const bandwidthServerMap={
  'dmit-premium':'美国 DMIT Premium',
  'dmit-eyeball':'美国 DMIT Eyeball',
  'netlab-us':'美国 NetLab Global',
  'zillion-us':'美国 Zillion Network',
  'evoxt-my':'马来 Evoxt Premium',
  'alibaba-sg':'新加坡 Sakura Cloud',
  'netlab-hk':'香港 NetLab Global',
  'yecaoyun-hk1':'香港 Yecaoyun Cloud'
};

function bandwidthDisplayName(value){
  const key=String(value||'').trim();
  return bandwidthServerMap[key]||key;
}

function bandwidthMbps(row){
  const value=row?.receiver_mbps ?? row?.sender_mbps;
  const number=Number(value);
  return Number.isFinite(number)?`${number.toFixed(2)} Mbps`:'—';
}

function bandwidthRetr(upload,download){
  const values=[upload?.retransmits,download?.retransmits]
    .map(Number)
    .filter(Number.isFinite);
  if(!values.length)return '—';
  return String(values.reduce((sum,value)=>sum+value,0));
}

function bandwidthRows(payload){
  if(Array.isArray(payload))return payload;
  if(Array.isArray(payload?.items))return payload.items;
  if(Array.isArray(payload?.rows))return payload.rows;
  if(Array.isArray(payload?.data))return payload.data;
  return [];
}

function renderBandwidth(payload){
  state.bandwidthPayload=payload;state.bandwidthFailed=false;
  const rows=bandwidthRows(payload);
  const grouped=new Map();
  const disabledServers=new Set();

  const isSuccess=row=>(
    row &&
    Number(row.completed)===1 &&
    !row.error &&
    Number.isFinite(Number(row.receiver_mbps))
  );

  for(const row of rows){
    const displayName=bandwidthDisplayName(row.server_name);
    if(!displayName)continue;

    if(!grouped.has(displayName)){
      grouped.set(displayName,{upload:null,download:null});
    }

    const group=grouped.get(displayName);

    if(row.direction==='upload'&&!group.upload){
      group.upload=row;
    }

    if(row.direction==='download'&&!group.download){
      group.download=row;
    }
  }

  let successful=0;
  let enabled=0;
  let disabled=0;
  let failed=0;
  let latestTimestamp=null;

  $$('#bandwidthCards .speed-card[data-server]').forEach(card=>{
    const name=card.dataset.server;
    const uploadField=card.querySelector('[data-field="upload_mbps"]');
    const downloadField=card.querySelector('[data-field="download_mbps"]');
    const retrField=card.querySelector('[data-field="retr"]');
    const testedAtField=card.querySelector('[data-field="tested_at"]');

    if(disabledServers.has(name)){
      uploadField.textContent=tr().disabled;
      downloadField.textContent=tr().disabled;
      retrField.textContent='—';
      testedAtField.textContent=tr().paused;
      card.dataset.state='disabled';
      disabled+=1;
      return;
    }

    enabled+=1;

    const group=grouped.get(name);
    const upload=group?.upload||null;
    const download=group?.download||null;

    const uploadSuccess=isSuccess(upload);
    const downloadSuccess=isSuccess(download);

    uploadField.textContent=uploadSuccess
      ? bandwidthMbps(upload)
      : upload
        ? tr().failed
        : '—';

    downloadField.textContent=downloadSuccess
      ? bandwidthMbps(download)
      : download
        ? tr().failed
        : '—';

    retrField.textContent=(uploadSuccess||downloadSuccess)
      ? bandwidthRetr(
          uploadSuccess?upload:null,
          downloadSuccess?download:null
        )
      : '—';

    const timestamps=[
      uploadSuccess?upload?.timestamp:null,
      downloadSuccess?download?.timestamp:null
    ]
      .filter(Boolean)
      .sort()
      .reverse();

    const testedAt=timestamps[0]||null;
    testedAtField.textContent=testedAt
      ? formatShanghai(testedAt)
      : (upload||download ? tr().roundFailed : '—');

    const hasSuccess=uploadSuccess||downloadSuccess;
    const hasFailure=Boolean(
      (upload&&!uploadSuccess)||
      (download&&!downloadSuccess)
    );

    card.dataset.state=hasSuccess
      ? 'ready'
      : hasFailure
        ? 'failed'
        : 'empty';

    if(hasSuccess){
      successful+=1;

      if(!latestTimestamp||testedAt>latestTimestamp){
        latestTimestamp=testedAt;
      }
    }else if(hasFailure){
      failed+=1;
    }
  });

  const status=$('#bandwidthStatus');
  const empty=$('#bandwidthTrendEmpty');

  if(successful||failed){
    status.textContent=latestTimestamp
      ? tr().bandwidthUpdated(formatShanghai(latestTimestamp))
      : tr().bandwidthSuccess(successful,enabled);

    status.classList.remove('waiting-badge');

    empty.innerHTML=
      `<b>${escapeHtml(tr().bandwidthSuccess(successful,enabled))}</b>`+
      `<p>${escapeHtml(tr().bandwidthFailedNote(failed,disabled))}</p>`;
  }else{
    status.textContent=tr().bandwidthWaiting;
    status.classList.add('waiting-badge');

    empty.innerHTML=
      `<b>${escapeHtml(tr().bandwidthNotLive(enabled))}</b>`+
      `<p>${escapeHtml(tr().bandwidthNotLiveNote(disabled))}</p>`;
  }
}

async function loadBandwidth(){
  try{
    const payload=await getJSON('/api/bandwidth?limit=200');
    renderBandwidth(payload);
    return true;
  }catch(error){
    console.error('bandwidth load failed',error);
    state.bandwidthFailed=true;
    $('#bandwidthStatus').textContent=tr().bandwidthFailedLoad;
    return false;
  }
}

/* Theme bridge for website embeds. The monitor has no independent theme toggle. */
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
function approvedParentOrigins(){
  const list=[];
  try{
    const meta=document.querySelector('meta[name="monitor-embed-origin"]');
    const raw=meta&&meta.content?meta.content.trim():'';
    if(raw){for(const item of raw.split(/[\s,]+/)){if(!item)continue;try{list.push(new URL(item).origin);}catch{}}}
  }catch{}
  return list;
}
function isTrustedThemeMessage(event,config){
  if(!event||event.source==null||event.source!==config.parentWindow)return false;
  const data=event.data;
  if(!data||typeof data!=='object'||data.type!==THEME_MESSAGE_TYPE)return false;
  if(data.theme!=='dark'&&data.theme!=='light')return false;
  return isTrustedParentOrigin(event.origin,config);
}
/* 官网切换语言时下发 {type:'nsp-monitor-lang:v1',lang}；来源校验与主题消息完全一致。 */
const LANG_MESSAGE_TYPE='nsp-monitor-lang:v1';
function isTrustedLangMessage(event,config){
  if(!event||event.source==null||event.source!==config.parentWindow)return false;
  const data=event.data;
  if(!data||typeof data!=='object'||data.type!==LANG_MESSAGE_TYPE)return false;
  if(data.lang!=='zh'&&data.lang!=='en')return false;
  return isTrustedParentOrigin(event.origin,config);
}
function isTrustedParentOrigin(origin,config){
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
    if(isTrustedLangMessage(event,config)){
      // 嵌入时语言跟随官网，不写入监控子域自己的 localStorage。
      if(I18N)I18N.setLang(event.data.lang,{persist:false});
      return;
    }
    if(!isTrustedThemeMessage(event,config))return;
    applyTheme(event.data.theme);
    if(state.chart)drawChart(state.samples);
  });
}

/* 切换语言：静态文案由 MonitorI18n.applyStatic 处理，这里用已缓存的数据重绘动态区域，不重新请求。 */
function rerenderForLanguage(){
  const t=tr();
  const overallLabel=$('#overallStatus b');
  overallLabel.textContent=state.overall?serverText(state.overall.label):t.reading;
  renderVpsPicker();
  if(state.vpsStatusData)renderVpsStatus(state.vpsStatusData);
  if(state.liveItems)for(const wan of Object.keys(WAN_META))setLegendValue(wan,state.liveItems.find(item=>item.wan===wan));
  renderLiveStatus();
  renderChartMeta();
  if(state.chart)drawChart(state.samples);
  if(state.routeData)renderRoute(state.routeData);
  else if(state.routeError)renderRouteEmpty(t.routeLoadFailedTitle,t.routeLoadFailedBody,'unavailable');
  else{const result=$('#routeResult');if(result.dataset.status==='loading')result.querySelector('b').textContent=t.routeReading;}
  if(state.bandwidthPayload)renderBandwidth(state.bandwidthPayload);
  else if(state.bandwidthFailed)$('#bandwidthStatus').textContent=t.bandwidthFailedLoad;
  else $('#bandwidthStatus').textContent=t.bandwidthWaiting;
  if($('#chartLoading').dataset.failed==='true')$('#chartLoading').innerHTML=`<span></span>${escapeHtml(t.apiFailed)}`;
  $('#routeTargetWrap').querySelector('span').textContent=routeState.direction==='return'?t.returnVps:t.outboundTarget;
}

async function init(){
  bindInteractions();
  if(I18N){I18N.applyStatic();I18N.onChange(rerenderForLanguage);}
  rerenderForLanguage();
  // 测速卡片独立加载并自行处理失败；图表只依赖 VPS 列表和目标列表，不再等待测速与 8 个测试点状态。
  void loadBandwidth();
  try{
    const overview=loadOverview();
    await loadVpsTargets();
    routeState.target=state.lastVps;
    await Promise.all([
      overview,
      loadTargets().then(()=>Promise.all([loadChart(),loadLive(false)])),
      loadRoute(),
      loadVpsStatus()
    ]);
  }
  catch(error){console.error(error);$('#chartLoading').dataset.failed='true';$('#chartLoading').innerHTML=`<span></span>${escapeHtml(tr().apiFailed)}`;setOverall({status:'stale',label:tr().readFailed});}
  setInterval(()=>{if(!document.hidden){loadLive(true);loadVpsStatus()}},5000);
  setInterval(()=>{if(!document.hidden)refreshVpsPickerStatus()},15000);
  setInterval(()=>{if(!document.hidden)loadBandwidth()},60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){loadLive(true);loadVpsStatus();refreshVpsPickerStatus()}});
}
if(typeof window!=='undefined'&&typeof document!=='undefined'){
  initThemeEmbed();
  init();
}
if(typeof module!=='undefined'&&module.exports){
  module.exports={MonitorI18n,THEME_MESSAGE_TYPE,LANG_MESSAGE_TYPE,normalizeTheme,isLoopbackOrigin,isTrustedThemeMessage,isTrustedLangMessage};
}
