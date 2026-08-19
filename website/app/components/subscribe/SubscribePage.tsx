import { networkTypes } from "../../lib/subscribeCatalog";
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
  ["确认方案", "核对方案摘要"],
] as const;

const stepsWithoutSpec = [
  ["网络类型", "选择网络类型"],
  ["国家/地区", "选择目标国家"],
  ["运营商", "选择运营商"],
  ["有效期", "选择购买时长"],
  ["确认方案", "核对方案摘要"],
] as const;

const solutionPresentation: Record<string, { code: string; label: string; highlights: string[] }> = {
  "us-local-carrier": {
    code: "US LOCAL CARRIER",
    label: "美国本地运营商",
    highlights: ["NTT", "GTT", "Cogent", "Charter"],
  },
  "local-isp": {
    code: "LOCAL PREMIUM",
    label: "本地优化线路",
    highlights: ["CN2 GIA", "AS9929", "CMI"],
  },
  residential: {
    code: "RESIDENTIAL ISP",
    label: "住宅接入维度",
    highlights: ["国家", "ISP", "共享", "独享"],
  },
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
  const selection = useSubscriptionSelection();
  const { activeDrawer, openDrawer, closeDrawer } = useCustomerDrawer();
  const orderOpen = activeDrawer === "order";
  const steps = selection.requiresSpec ? stepsWithSpec : stepsWithoutSpec;
  const sectionIds = selection.requiresSpec
    ? ["sub-section-type", "sub-section-region", "sub-section-isp", "sub-section-spec", "sub-section-duration", "sub-section-duration"]
    : ["sub-section-type", "sub-section-region", "sub-section-isp", "sub-section-duration", "sub-section-duration"];

  function goToStep(step: number) {
    selection.setCurrentStep(step);
    document.getElementById(sectionIds[step - 1])?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <main className="sub-page">
      <div className="sub-layout">
        <div className="sub-content">
          <header className="sub-workbench">
            <div>
              <span className="sub-workbench-kicker">NETWORK SOLUTION CONFIGURATOR</span>
              <h1>配置适合业务场景的网络方案</h1>
              <p>按网络架构、服务地区与所需选项逐步确认方案。目录价格已接入，未提供的周期价格保持待确认。</p>
            </div>
            <div className="sub-workbench-status" aria-label="页面状态">
              <span><i aria-hidden="true" />方案配置台</span>
              <small>CATALOG V1</small>
            </div>
          </header>

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
                    <span className="sub-capability-label">能力概览</span>
                    <span className="sub-features">{option.features.map((feature) => <span key={feature}>{feature}</span>)}</span>
                    <span className="sub-solution-footer">
                      <span><small>正式价格</small><b>{option.startingPrice === null ? "—" : `¥${option.startingPrice}`}<em>{option.startingPrice === null ? "待确认" : "/月"}</em></b></span>
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
            <div className="sub-grid sub-grid-four" role="radiogroup" aria-label="国家或地区">
              {selection.availableRegions.map((option) => (
                <OptionCard key={option.id} selected={selection.regionId === option.id} onSelect={() => selection.selectRegion(option.id)} label={option.name} className="sub-region-option">
                  <span className="sub-option-head"><i className={`sub-flag is-${option.flagClass}`} aria-hidden="true" /><strong>{option.name}</strong></span>
                  <span className="sub-region-meta">
                    {option.startingPrice !== undefined && option.startingPrice !== null ? <b>¥{option.startingPrice}<small> 起</small></b> : <small>价格待确认</small>}
                    {option.badge && <i className={`sub-tag ${option.configured ? "is-accent" : ""}`}>{option.badge}</i>}
                  </span>
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
                    <span className="sub-isp-logo">{option.name}</span><span><strong>{option.name}</strong><small>{option.routeInfo ?? option.description}</small></span>
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
                    <span className="sub-option-head"><strong>{option.name}</strong>{option.badge && <i className="sub-tag is-accent">{option.badge}</i>}<i className="sub-tag">{option.monthlyPrice === null ? "价格待确认" : `¥${option.monthlyPrice} / 月`}</i></span>
                    <span className="sub-features">{option.features.map((feature) => <span key={feature}>{feature}</span>)}</span>
                    <span className="sub-option-cta">{option.description}</span>
                  </OptionCard>
                ))}
              </div>
            ) : <div className="sub-pending">请先选择可用的运营商方案</div>}
          </section>}

          <section className="sub-section" id="sub-section-duration">
            <div className="sub-section-heading">
              <div><span>{selection.requiresSpec ? "STEP 05" : "STEP 04"} · SERVICE TERM</span><h2>选择有效期</h2><p>价格按当前目录展示；未提供价格的周期保持待确认。</p></div>
              <small>{selection.availableDurations.length} 个期限</small>
            </div>
            {selection.canSelectDuration ? (
              <div className="sub-grid sub-grid-four" role="radiogroup" aria-label="购买有效期">
                {selection.availableDurations.map((option) => {
                  const total = selection.durationPrices[option.id] ?? null;
                  return (
                    <OptionCard key={option.id} selected={selection.durationId === option.id} onSelect={() => selection.selectDuration(option.id)} label={option.name} className="sub-duration-option">
                      <span className="sub-option-head"><strong>{option.name}</strong>{option.badge && <i className="sub-tag is-accent">{option.badge}</i>}</span>
                      <span className="sub-duration-total">{total === null ? "—" : `¥${total}`}</span>
                      <span className="sub-duration-meta"><span>{total === null ? "价格待确认" : `约 ¥${Math.floor(total / option.months)} / 月`}</span><b /></span>
                    </OptionCard>
                  );
                })}
              </div>
            ) : <div className="sub-pending">{selection.requiresSpec ? "请先选择套餐规格" : "请先选择运营商"}</div>}
          </section>
        </div>

        <aside className="sub-desktop-summary" aria-label="方案摘要"><OrderSummary summary={selection.summary} /></aside>
      </div>

      <aside
        className={`sub-order-drawer ${orderOpen ? "is-open" : ""}`}
        data-cc-drawer="order"
        role={orderOpen ? "dialog" : undefined}
        aria-modal={orderOpen ? true : undefined}
        aria-label="方案摘要抽屉"
      >
        <button type="button" className="sub-drawer-close" onClick={closeDrawer} aria-label="关闭方案摘要">×</button>
        <OrderSummary summary={selection.summary} drawer />
      </aside>
      <MobileOrderBar summary={selection.summary} open={orderOpen} onOpen={(trigger) => openDrawer("order", trigger)} />
    </main>
  );
}
