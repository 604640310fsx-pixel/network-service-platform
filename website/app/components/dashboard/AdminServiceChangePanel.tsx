import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { confirmAdminServiceChange, getAdminManualFacts, getAdminServiceChanges, saveAdminManualFacts,
  type AdminManualFacts, type AdminServiceChangeListing } from "../../lib/admin-services-api";
import { PaymentApiError } from "../../lib/payment-api";
import { resolveSelection } from "../../lib/resolveSelection";
import { packageSpecsByTypeAndRegion } from "../../lib/subscribeCatalog";

type Reminder={listing:AdminServiceChangeListing|null;error:string;refresh:()=>Promise<void>};
const ReminderContext=createContext<Reminder|null>(null);
function message(error:unknown):string {
  const code=error instanceof PaymentApiError?error.code:"";
  const copy:Record<string,string>={unauthorized:"管理员登录已失效，请重新登录。",forbidden:"没有管理员配置权限。",
    csrf_invalid:"安全校验已失效，请刷新页面。",stale_change:"资料或变更版本已变化，待办保留，请刷新核对。",
    change_not_due:"尚未到服务器确认的到期时间。",change_not_paid:"尚无权威已付款记录，不能确认。",
    admin_service_facts_required:"需管理员补齐套餐资料。",service_not_quotable:"服务已到期或资料不完整，不能直接应用升级。",
    change_already_pending:"已有待处理变更，不能改写套餐资料。",invalid_change_target:"目标组合不可用，请核对套餐。"};
  return copy[code]??"操作未完成，待办不会因查看或失败而清除。请刷新核对。";
}
export function AdminServiceChangesProvider({children}:{children:ReactNode}) {
  const {principal}=useAuth();const location=useLocation();
  const [listing,setListing]=useState<AdminServiceChangeListing|null>(null),[error,setError]=useState("");
  const request=useRef(0),controller=useRef<AbortController|null>(null);
  const refresh=useCallback(async()=>{
    const seq=++request.current;controller.current?.abort();
    if(principal?.role!=="admin"){setListing(null);setError("");return;}
    const c=new AbortController();controller.current=c;
    try{const next=await getAdminServiceChanges(c.signal);if(seq===request.current&&!c.signal.aborted){setListing(next);setError("");}}
    catch(cause){if(seq===request.current&&!c.signal.aborted)setError(message(cause));}
  },[principal?.role,principal?.email]);
  useEffect(()=>{void refresh();return()=>{request.current++;controller.current?.abort();};},[refresh,location.pathname]);
  return <ReminderContext.Provider value={{listing,error,refresh}}>{children}</ReminderContext.Provider>;
}
export function AdminServiceChangeBadge(){const r=useContext(ReminderContext);const {principal}=useAuth();
  if(principal?.role!=="admin")return null;
  return <strong className="dash-tag is-warn" aria-label="待配置套餐变更数量">{r?.listing?.counts.total??"…"}</strong>;
}
function packageLabel(item:{typeId:string;regionId:string;ispId:string},specId:string|null){
  const {summary}=resolveSelection({...item,specId,durationId:"month-1"});
  return [summary.type,summary.region,summary.isp,summary.spec].filter(x=>x&&x!=="—").join(" · ");
}
export function AdminServiceChangePanel({csrfToken}:{csrfToken:string|null}) {
  const reminder=useContext(ReminderContext);const [selected,setSelected]=useState<number|null>(null);
  const [checked,setChecked]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const locked=useRef(false);const listing=reminder?.listing;
  async function confirm(){
    const item=listing?.items.find(i=>i.id===selected);
    if(!item||!csrfToken||!checked||locked.current||item.category==="scheduled"||item.reason)return;
    locked.current=true;setBusy(true);setError("");
    try{await confirmAdminServiceChange(item,csrfToken);setSelected(null);setChecked(false);await reminder?.refresh();}
    catch(cause){setError(message(cause));await reminder?.refresh();}
    finally{locked.current=false;setBusy(false);}
  }
  return <section className="dash-panel" id="admin-service-changes" aria-labelledby="manual-changes-title">
    <h2 id="manual-changes-title"><em>ADMIN TODO</em>套餐变更待配置 <AdminServiceChangeBadge/></h2>
    <p className="dash-usvc-meta">已付款待配置 {listing?.counts.paidPending??"—"} · 到期待处理降档 {listing?.counts.dueDowngrade??"—"}。查看不会清除提醒；需您在3X-UI手动配置后确认。</p>
    <button type="button" className="dash-usvc-ghost" onClick={()=>void reminder?.refresh()} disabled={busy}>刷新待办</button>
    {reminder?.error&&<p role="alert" className="dash-inline-error">{reminder.error}</p>}
    {listing?.items.length===0&&<p role="status">暂无待处理套餐变更。</p>}
    <ul className="dash-usvc-list">{listing?.items.map(item=><li className="dash-usvc-item" key={item.id} id={`manual-change-${item.id}`}>
      <div className="dash-usvc-head"><strong>{item.customer} · 变更#{item.id}</strong><span className={`dash-tag ${item.category==="scheduled"?"":"is-warn"}`}>
        {item.category==="scheduled"?"未来预约（未计入待办）":item.category==="due_downgrade"?"到期待处理降档":"已付款待配置"}</span></div>
      <p>{packageLabel(item,item.currentSpecId)} → <strong>{packageLabel(item,item.targetSpecId)}</strong></p>
      <button type="button" className="dash-primary-link" onClick={()=>{setSelected(item.id);setChecked(false);setError("");}}>查看配置详情</button>
      {selected===item.id&&<div className="dash-usvc-open" aria-label={`变更${item.id}配置详情`}>
        <p>服务 #{item.serviceId} · 订单 {item.orderRef??"无收费订单（预约降档）"} · 变更状态 {item.status}</p>
        <p>补差 ¥{(item.amountFen/100).toFixed(2)} · 付款时间 {item.paidAt??"不收费"} · 预约到期 {item.effectiveAt??"付款后待人工配置"}</p>
        <p>保持到期 {item.periodEnd??"资料缺失"}；本月已用 {item.usageUsedGb??"未知"}G / {item.usageQuotaGb??"未知"}G。不退差价、不清零、不自动扣款、不免费延期。</p>
        {item.reason&&<p role="alert" className="dash-inline-error">不能直接确认：{item.reason}。已付款订单/待办保留，请先核对服务资料及冲突。</p>}
        {item.category==="scheduled"?<p>服务器尚未判定到期，不可提前确认。到期后将显示待处理提醒。</p>:<>
          <label><input type="checkbox" checked={checked} disabled={busy||!!item.reason} onChange={e=>setChecked(e.target.checked)}/>我已手动配置目标线路和流量，并核对到期及已用未变</label>
          <p className="dash-usvc-meta">记录为“管理员确认”，不是系统或服务商自动验证。</p>
          <button type="button" className="dash-primary-link" disabled={!checked||busy||csrfToken===null||!!item.reason} onClick={()=>void confirm()}>{busy?"确认中…":"确认已配置"}</button>
        </>}
      </div>}
    </li>)}</ul>
    {error&&<p role="alert" className="dash-inline-error">{error}</p>}
  </section>;
}

export function AdminManualServiceFacts({serviceId,csrfToken}:{serviceId:number;csrfToken:string|null}) {
  const [facts,setFacts]=useState<AdminManualFacts|null>(null),[error,setError]=useState("");
  const [spec,setSpec]=useState(""),[price,setPrice]=useState(""),[start,setStart]=useState(""),[usage,setUsage]=useState(""),[used,setUsed]=useState("");
  const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[saved,setSaved]=useState(false);
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  async function load(){setBusy(true);setError("");try{const f=await getAdminManualFacts(serviceId);if(!mounted.current)return;
    setFacts(f);setSpec(f.specId??"");setPrice(f.monthlyPriceFen===null?"":String(f.monthlyPriceFen));
    setStart(f.periodStart??f.openedAt??"");setUsage(f.usageStart??"");setUsed(f.usageUsedGb===null?"":String(f.usageUsedGb));
    setConfirmed(false);setSaved(false);
  }catch(cause){if(mounted.current)setError(message(cause));}finally{if(mounted.current)setBusy(false);}}
  async function save(){if(!facts||!csrfToken||!confirmed||busy)return;setBusy(true);setError("");try{
    await saveAdminManualFacts(serviceId,{expectedVersion:facts.version,specId:spec||null,monthlyPriceFen:Number(price),
      periodStart:start,usageStart:usage,usageUsedGb:Number(used)},csrfToken);
    await load();setSaved(true);
  }catch(cause){setError(message(cause));}finally{setBusy(false);}}
  return <div className="dash-usvc-open"><button type="button" className="dash-usvc-ghost" disabled={busy} onClick={()=>void load()}>补齐 / 人工核实套餐资料</button>
    {facts&&<div><p>原订单 {facts.orderRef} · {facts.durationId} · 到期 {facts.endsAt??"未填写（请先在服务管理保存准确到期时间）"}</p>
      <p>{facts.source}。已知订单、归属、付费周期及周期折扣由服务器复用；请核对实际套餐和本月已用，不默认零。</p>
      <div className="dash-usvc-grid">
        <label>当前实际套餐<select value={spec} onChange={e=>setSpec(e.target.value)} disabled={busy}>
          {facts.typeId==="local-isp"&&<option value="">普通线路200G</option>}
          {(packageSpecsByTypeAndRegion[facts.typeId]?.[facts.regionId]??[]).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
        </select></label>
        <label>原付费期月费（分）<input type="number" min="1" required value={price} onChange={e=>setPrice(e.target.value)}/></label>
        <label>原付费期开始（UTC ISO）<input value={start} onChange={e=>setStart(e.target.value)}/></label>
        <label>当前月窗口开始（UTC ISO）<input value={usage} onChange={e=>setUsage(e.target.value)}/></label>
        <label>当前月已用（G）<input type="number" min="0" required value={used} onChange={e=>setUsed(e.target.value)}/></label>
      </div>
      <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy}/>我已人工核实以上资料，记录为管理员确认（非服务商验证）</label>
      <button type="button" className="dash-primary-link" disabled={!confirmed||busy||!csrfToken||!facts.endsAt||price.trim()===""||used.trim()===""||usage.trim()===""} onClick={()=>void save()}>确认套餐资料</button>
      {saved&&<p role="status">套餐资料已人工确认。</p>}
    </div>}{error&&<p role="alert" className="dash-inline-error">{error}</p>}
  </div>;
}
