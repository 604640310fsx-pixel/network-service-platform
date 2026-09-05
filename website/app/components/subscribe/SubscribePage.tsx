import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { networkTypes } from "../../lib/subscribeCatalog";
import { parseSelectionParams, selectionToQuery, type CatalogSelection } from "../../lib/resolveSelection";
import { usePlanAvailability } from "../../lib/planAvailability";
import { WorkbenchBanner } from "../WorkbenchBanner";
import { useCustomerDrawer } from "../customer/CustomerCenterShell";
import { MobileOrderBar } from "./MobileOrderBar";
import { OptionCard } from "./OptionCard";
import { OrderSummary } from "./OrderSummary";
import { StepProgress } from "./StepProgress";
import { useSubscriptionSelection } from "./useSubscriptionSelection";
import "./subscribe.css";

const stepsWithSpec = [
  ["网络类型", "选择网络类型"],
  ["国家/地区", "选择目标国家"],
  ["运营商", "选择运营商"],
  ["规格", "选择套餐规格"],
  ["有效期", "选择购买时长"],
  ["确认并提交", "核对方案并填写需求"],
] as const;

const stepsWithoutSpec = [
  ["网络类型", "选择网络类型"],
  ["国家/地区", "选择目标国家"],
  ["运营商", "选择运营商"],
  ["有效期", "选择购买时长"],
  ["确认并提交", "核对方案并填写需求"],
] as const;

const solutionPresentation: Record<string, { code: string; label: string; highlights: string[] }> = {
  "us-local-carrier": {
    code: "US LOCAL CARRIER",
    label: "美国本地运营商",
    highlights: ["NTT", "GTT", "Cogent", "Charter"],
  },
  "local-isp": {
    code: "LOCAL PREMIUM",
    label: "覆盖地区",
    highlights: ["美国", "台湾", "日本", "马来西亚"],
  },
  residential: {
    code: "RESIDENTIAL ISP",
    label: "直连高级路线",
    highlights: ["CN2 GIA", "9929", "CMIN2"],
  },
};

/* 真住宅宽带的能力概览把线路名称（电信 CN2 GIA / 联通 9929 / 移动 CMIN2）与住宅环境属性
   （UDP / IPv4·IPv6 / DNS 等）混在同一份列表里。线路名称改为在上方以"直连高级路线"标题
   呈现，这里从 catalog 的 features 里把线路字符串过滤掉，只保留住宅环境事实，避免同一张
   卡片里出现两次线路信息。不改写 catalog 数据本身。 */
const RESIDENTIAL_ROUTE_FEATURES = ["电信 CN2 GIA", "联通 9929", "移动 CMIN2"];
const RESIDENTIAL_FEATURE_LABELS: Record<string, string> = { UDP: "支持完整UDP" };

function residentialEnvironmentFeatures(features: string[]) {
  const environment = features
    .filter((feature) => !RESIDENTIAL_ROUTE_FEATURES.includes(feature))
    .map((feature) => RESIDENTIAL_FEATURE_LABELS[feature] ?? feature);
  // "真实住宅 ISP" 并非 catalog features 里的字符串，但对应 ispsByTypeAndRegion.residential
  // 里真实命名的住宅 ISP——是同一份 catalog 数据里已有的真实事实，只是换成客户能懂的话。
  return ["真实住宅 ISP", ...environment];
}

/* 地区场景标签：本地展示层覆盖，不写入 subscribeCatalog 的 badge 字段（仅一个短语）。
   只在真住宅宽带的地区选择卡片上显示，其余网络类型的地区不受影响。 */
const RESIDENTIAL_REGION_TAGS: Record<string, string[]> = {
  sg: ["AI 首选", "社媒", "低延迟", "高速", "稳定"],
  jp: ["AI 推荐", "社媒", "低延迟", "高速", "稳定"],
  vn: ["AI 推荐", "社媒", "低延迟", "性价比高"],
  my: ["AI 推荐", "社媒", "低延迟", "稳定"],
  kr: ["AI 推荐", "社媒", "低延迟", "稳定"],
  tw: ["AI 推荐", "社媒", "低延迟", "稳定"],
  us: ["AI 推荐", "社媒", "稳定"],
};

function SolutionIcon({ typeId }: { typeId: string }) {
  if (typeId === "us-local-carrier") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M4.5 9h15M4.5 15h15M12 4c2.2 2.2 3.3 4.9 3.3 8S14.2 17.8 12 20c-2.2-2.2-3.3-4.9-3.3-8S9.8 6.2 12 4Z" /></svg>;
  }
  if (typeId === "local-isp") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 17.5h14M7 14l3-3 2.5 2.5L17 9" /><circle cx="7" cy="14" r="1.3" /><circle cx="10" cy="11" r="1.3" /><circle cx="12.5" cy="13.5" r="1.3" /><circle cx="17" cy="9" r="1.3" /></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 11.5 12 5l7.5 6.5V20h-15Z" /><path d="M9 20v-5h6v5M8 9.3V5.5h3" /></svg>;
}

export function SubscribePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // 仅在挂载时读取一次 query 作为初始选择；hook 只有在其解析为完整方案时才采纳，
  // 不完整 / 非法参数不会污染 hook（回退默认选择）。
  const [initialSelection] = useState(() => parseSelectionParams(searchParams));
  const availability = usePlanAvailability();
  const selection = useSubscriptionSelection(initialSelection, availability.index ?? undefined);
  const priceStatus = availability.loading
    ? "价格加载中…"
    : availability.error
      ? "价格暂不可用，请稍后重试"
      : null;
  const canRequest =
    !availability.loading &&
    !availability.error &&
    selection.summary.complete &&
    selection.summary.total !== null &&
    selection.summary.availability === "available";
  const { activeDrawer, openDrawer, closeDrawer } = useCustomerDrawer();
  const orderOpen = activeDrawer === "order";
  const steps = selection.requiresSpec ? stepsWithSpec : stepsWithoutSpec;
  // 选择步骤对应的 DOM 区块；最后一步"确认并提交"不再对应区块（跳转独立页）。
  const sectionIds = selection.requiresSpec
    ? ["sub-section-type", "sub-section-region", "sub-section-isp", "sub-section-spec", "sub-section-duration"]
    : ["sub-section-type", "sub-section-region", "sub-section-isp", "sub-section-duration"];

  const currentSelection: CatalogSelection = {
    typeId: selection.typeId,
    regionId: selection.regionId,
    ispId: selection.ispId,
    specId: selection.specId,
    durationId: selection.durationId,
  };

  // 把当前选择镜像回 /subscribe 的 query（replace，避免堆积浏览历史）；
  // 正常跳转前历史记录即带有同一组 ID，浏览器后退 / 刷新可据此恢复。
  useEffect(() => {
    setSearchParams(new URLSearchParams(selectionToQuery(currentSelection)), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.typeId, selection.regionId, selection.ispId, selection.specId, selection.durationId]);

  // 携带当前选择跳转到独立提交页（只放公开 catalog ID）。
  function goToRequest() {
    if (!canRequest) return;
    navigate(`/subscribe/request?${selectionToQuery(currentSelection)}`);
  }

  function goToStep(step: number) {
    // 最后一步"确认并提交"不对应区块：方案完整则跳转独立页，不完整则不跳转。
    if (step > sectionIds.length) {
      if (canRequest) goToRequest();
      return;
    }
    selection.setCurrentStep(step);
    document.getElementById(sectionIds[step - 1])?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <main className="sub-page">
      <div className="sub-layout">
        <div className="sub-content">
          <WorkbenchBanner
            kicker="NETWORK SOLUTION CONFIGURATOR"
            title="配置适合业务场景的网络方案"
            description="按网络架构、服务地区与所需选项逐步确认方案。目录价格已接入，未提供的周期价格保持待确认。"
            statusLabel="方案配置台"
            badge="CATALOG V1"
          />

          <StepProgress steps={steps} currentStep={selection.currentStep} onStep={goToStep} />

          <section className="sub-section sub-solution-section" id="sub-section-type">
            <div className="sub-section-heading">
              <div><span>STEP 01 · NETWORK TYPE</span><h2>选择网络方案架构</h2><p>先确定接入网络的技术方向，再继续配置地区与运营商。</p></div>
              <small>三类方案</small>
            </div>
            <div className="sub-grid sub-solution-grid" role="radiogroup" aria-label="网络类型">
              {networkTypes.map((option) => {
                const presentation = solutionPresentation[option.id];
                const selected = selection.typeId === option.id;
                return (
                  <OptionCard key={option.id} selected={selected} onSelect={() => selection.selectType(option.id)} label={option.name} className="sub-type-option">
                    <span className="sub-solution-top">
                      <span className="sub-solution-icon"><SolutionIcon typeId={option.id} /></span>
                      <span className="sub-solution-title"><small>{presentation.code}</small><strong>{option.name}</strong></span>
                      {option.badge && <i className="sub-tag is-accent">{option.badge}</i>}
                    </span>
                    <span className="sub-description">{option.description}</span>
                    <span className="sub-route-group">
                      <small>{presentation.label}</small>
                      <span>{presentation.highlights.map((item) => <i key={item}>{item}</i>)}</span>
                    </span>
                    {option.id === "residential" ? (
                      <>
                        <span className="sub-capability-label">住宅环境</span>
                        <span className="sub-features">{residentialEnvironmentFeatures(option.features).map((feature) => <span key={feature}>{feature}</span>)}</span>
                      </>
                    ) : (
                      <>
                        <span className="sub-capability-label">能力概览</span>
                        <span className="sub-features">{option.features.map((feature) => <span key={feature}>{feature}</span>)}</span>
                      </>
                    )}
                    <span className="sub-solution-footer">
                      <span><small>正式价格</small><b>价格待确认</b></span>
                      <strong>{selected ? "当前方案" : "选择方案"}<i aria-hidden="true">→</i></strong>
                    </span>
                  </OptionCard>
                );
              })}
            </div>
          </section>

          <section className="sub-section" id="sub-section-region">
            <div className="sub-section-heading">
              <div><span>STEP 02 · LOCATION</span><h2>选择国家/地区</h2><p>确认网络服务的目标接入区域。</p></div>
              <small>{selection.availableRegions.length} 个可用区域</small>
            </div>
            <div
              className={`sub-grid sub-grid-region${selection.typeId === "residential" ? " has-tags" : ""}`}
              role="radiogroup"
              aria-label="国家或地区"
            >
              {selection.availableRegions.map((option) => (
                <OptionCard key={option.id} selected={selection.regionId === option.id} onSelect={() => selection.selectRegion(option.id)} label={option.name} className="sub-region-option">
                  <span className="sub-region-main">
                    <span className="sub-option-head"><i className={`sub-flag is-${option.flagClass}`} aria-hidden="true" /><strong>{option.name}</strong></span>
                    <span className="sub-region-meta">
                      <small>价格待确认</small>
                      {option.badge && <i className={`sub-tag ${option.configured ? "is-accent" : ""}`}>{option.badge}</i>}
                    </span>
                  </span>
                  {selection.typeId === "residential" && RESIDENTIAL_REGION_TAGS[option.id] && (
                    <span className="sub-region-tags">
                      {RESIDENTIAL_REGION_TAGS[option.id]!.map((tag) => <i key={tag} className="sub-tag">{tag}</i>)}
                    </span>
                  )}
                </OptionCard>
              ))}
            </div>
          </section>

          <section className="sub-section" id="sub-section-isp">
            <div className="sub-section-heading">
              <div><span>STEP 03 · NETWORK OPERATOR</span><h2>选择运营商{selection.regionId && <em>· {selection.summary.region}</em>}</h2><p>查看当前地区已经配置的 ISP 接入方案。</p></div>
              <small>{selection.availableIsps.length ? `${selection.availableIsps.length} 个可用项` : "待配置"}</small>
            </div>
            {selection.availableIsps.length ? (
              <div className="sub-grid sub-isp-grid" role="radiogroup" aria-label="运营商">
                {selection.availableIsps.map((option) => (
                  <OptionCard key={option.id} selected={selection.ispId === option.id} onSelect={() => selection.selectIsp(option.id)} label={option.name} className="sub-isp-option">
                    <span><strong>{option.name}</strong><small>{option.routeInfo ?? option.description}</small></span>
                  </OptionCard>
                ))}
              </div>
            ) : <div className="sub-pending" role="status">该地区方案待配置</div>}
          </section>

          {selection.requiresSpec && <section className="sub-section" id="sub-section-spec">
            <div className="sub-section-heading">
              <div><span>STEP 04 · SERVICE PROFILE</span><h2>选择使用规格</h2><p>按共享方式、流量与使用场景确认接入规格。</p></div>
              <small>{selection.availableSpecs.length ? `${selection.availableSpecs.length} 个规格` : "请先选择 ISP"}</small>
            </div>
            {selection.availableSpecs.length ? (
              <div className="sub-grid sub-grid-three" role="radiogroup" aria-label="套餐规格">
                {selection.availableSpecs.map((option) => (
                  <OptionCard key={option.id} selected={selection.specId === option.id} onSelect={() => selection.selectSpec(option.id)} label={option.name} className="sub-spec-option">
                    <span className="sub-option-head"><strong>{option.name}</strong>{option.badge && <i className="sub-tag is-accent">{option.badge}</i>}<i className="sub-tag">价格待确认</i></span>
                    <span className="sub-features">{option.features.map((feature) => <span key={feature}>{feature}</span>)}</span>
                    <span className="sub-option-cta">{option.description}</span>
                  </OptionCard>
                ))}
              </div>
            ) : <div className="sub-pending">请先选择可用的运营商方案</div>}
          </section>}

          <section className="sub-section" id="sub-section-duration">
            <div className="sub-section-heading">
              <div>
                <span>{selection.requiresSpec ? "STEP 05" : "STEP 04"} · SERVICE TERM</span>
                <h2>选择有效期</h2>
                <p>价格由服务器实时核定；未提供价格或已停售/售罄的周期保持待确认。</p>
                {priceStatus && <p className={`sub-price-status${availability.error ? " is-error" : ""}`} role={availability.error ? "alert" : "status"}>{priceStatus}</p>}
              </div>
              <small>{selection.availableDurations.length} 个期限</small>
            </div>
            {selection.canSelectDuration ? (
              <div className="sub-grid sub-grid-four" role="radiogroup" aria-label="购买有效期">
                {selection.availableDurations.map((option) => {
                  const total = selection.durationPrices[option.id] ?? null;
                  const status = selection.durationAvailability[option.id] ?? "unknown";
                  const statusLabel = status === "sold_out" ? "售罄" : status === "unavailable" ? "暂不可选" : null;
                  return (
                    <OptionCard key={option.id} selected={selection.durationId === option.id} onSelect={() => selection.selectDuration(option.id)} label={option.name} className="sub-duration-option">
                      <span className="sub-option-head">
                        <strong>{option.name}</strong>
                        {statusLabel ? <i className="sub-tag">{statusLabel}</i> : option.badge && <i className="sub-tag is-accent">{option.badge}</i>}
                      </span>
                      <span className="sub-duration-total">{total === null ? "—" : `¥${total}`}</span>
                      <span className="sub-duration-meta"><span>{total === null ? (statusLabel ?? "价格待确认") : `约 ¥${Math.floor(total / option.months)} / 月`}</span><b /></span>
                    </OptionCard>
                  );
                })}
              </div>
            ) : <div className="sub-pending">{selection.requiresSpec ? "请先选择套餐规格" : "请先选择运营商"}</div>}
          </section>
        </div>

        <aside className="sub-desktop-summary" aria-label="方案摘要"><OrderSummary summary={selection.summary} canRequest={canRequest} onRequest={goToRequest} /></aside>
      </div>

      <aside
        className={`sub-order-drawer ${orderOpen ? "is-open" : ""}`}
        data-cc-drawer="order"
        role={orderOpen ? "dialog" : undefined}
        aria-modal={orderOpen ? true : undefined}
        aria-label="方案摘要抽屉"
      >
        <button type="button" className="sub-drawer-close" onClick={closeDrawer} aria-label="关闭方案摘要">×</button>
        <OrderSummary summary={selection.summary} canRequest={canRequest} drawer onRequest={goToRequest} />
      </aside>
      <MobileOrderBar summary={selection.summary} canRequest={canRequest} open={orderOpen} onOpen={(trigger) => openDrawer("order", trigger)} onRequest={goToRequest} />
    </main>
  );
}
