/* 监控面板界面语言：中文（默认）/ English，零依赖。
   语言来源优先级：URL ?lang=（官网 iframe 嵌入时传入）→ 本站 localStorage `nsp.lang`
   （与官网同名同取值；监控是独立子域，浏览器不会与官网共享存储）→ 浏览器语言（zh* → 中文，
   其余 → English）。官网嵌入后切换语言经已校验 origin 的 postMessage 下发。
   只翻译界面文案；服务端返回的少量状态文案按原文查表翻译，查不到时原样显示。 */
(function(root){
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
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
