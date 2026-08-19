import { durations, networkTypes, regions } from "../../lib/subscribeCatalog";
import { useCustomerDrawer } from "../customer/CustomerCenterShell";
import { MobileOrderBar } from "./MobileOrderBar";
import { OptionCard } from "./OptionCard";
import { OrderSummary } from "./OrderSummary";
import { StepProgress } from "./StepProgress";
import { useSubscriptionSelection } from "./useSubscriptionSelection";
import "./subscribe.css";

const sectionIds = ["sub-section-type", "sub-section-region", "sub-section-isp", "sub-section-spec", "sub-section-duration", "sub-section-duration"];

const solutionPresentation: Record<string, { code: string; label: string; highlights: string[] }> = {
  "ai-network": {
    code: "GLOBAL TRANSIT",
    label: "国际骨干线路",
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
  if (typeId === "ai-network") {
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
              <p>按网络架构、服务地区与使用规格逐步确认方案。页面内容与价格当前仅作 prototype 展示。</p>
            </div>
            <div className="sub-workbench-status" aria-label="页面状态">
              <span><i aria-hidden="true" />方案配置台</span>
              <small>PROTOTYPE</small>
            </div>
          </header>

          <StepProgress currentStep={selection.currentStep} onStep={goToStep} />

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
                      <span><small>PROTOTYPE 起价</small><b>¥{option.startingPrice}<em>/月</em></b></span>
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
              <small>{regions.length} 个演示区域</small>
            </div>
            <div className="sub-grid sub-grid-four" role="radiogroup" aria-label="国家或地区">
              {regions.map((option) => (
                <OptionCard key={option.id} selected={selection.regionId === option.id} onSelect={() => selection.selectRegion(option.id)} label={option.name} className="sub-region-option">
                  <span className="sub-option-head"><i className={`sub-flag is-${option.flagClass}`} aria-hidden="true" /><strong>{option.name}</strong></span>
                  <span className="sub-region-meta">
                    {option.startingPrice ? <b>¥{option.startingPrice}<small> 起</small></b> : <small>支持更多地区</small>}
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
                    <span className="sub-isp-logo">{option.name}</span><span><strong>{option.name}</strong><small>{option.description}</small></span>
                  </OptionCard>
                ))}
              </div>
            ) : <div className="sub-pending" role="status">该地区方案待配置</div>}
          </section>

          <section className="sub-section" id="sub-section-spec">
            <div className="sub-section-heading">
              <div><span>STEP 04 · SERVICE PROFILE</span><h2>选择使用规格</h2><p>按共享方式、流量与使用场景确认接入规格。</p></div>
              <small>{selection.availableSpecs.length ? `${selection.availableSpecs.length} 个规格` : "请先选择 ISP"}</small>
            </div>
            {selection.availableSpecs.length ? (
              <div className="sub-grid sub-grid-three" role="radiogroup" aria-label="套餐规格">
                {selection.availableSpecs.map((option) => (
                  <OptionCard key={option.id} selected={selection.specId === option.id} onSelect={() => selection.selectSpec(option.id)} label={option.name} className="sub-spec-option">
                    <span className="sub-option-head"><strong>{option.name}</strong>{option.badge && <i className="sub-tag is-accent">{option.badge}</i>}<i className="sub-tag">¥{option.monthlyPrice} / 月</i></span>
                    <span className="sub-features">{option.features.map((feature) => <span key={feature}>{feature}</span>)}</span>
                    <span className="sub-option-cta">{option.description}</span>
                  </OptionCard>
                ))}
              </div>
            ) : <div className="sub-pending">请先选择可用的运营商方案</div>}
          </section>

          <section className="sub-section" id="sub-section-duration">
            <div className="sub-section-heading">
              <div><span>STEP 05 · SERVICE TERM</span><h2>选择有效期</h2><p>演示价格会根据当前规格与有效期同步更新。</p></div>
              <small>{durations.length} 个期限</small>
            </div>
            {selection.selectedSpec ? (
              <div className="sub-grid sub-grid-four" role="radiogroup" aria-label="购买有效期">
                {durations.map((option) => {
                  const total = Math.round(selection.selectedSpec!.monthlyPrice * option.months * option.rate);
                  const listPrice = selection.selectedSpec!.monthlyPrice * option.months;
                  return (
                    <OptionCard key={option.id} selected={selection.durationId === option.id} onSelect={() => selection.selectDuration(option.id)} label={option.name} className="sub-duration-option">
                      <span className="sub-option-head"><strong>{option.name}</strong>{option.badge && <i className="sub-tag is-accent">{option.badge}</i>}</span>
                      <span className="sub-duration-total">¥{total}</span>
                      <span className="sub-duration-meta"><span>¥{Math.floor(total / option.months)} / 月</span><b>{listPrice > total ? `省 ¥${listPrice - total}` : ""}</b></span>
                    </OptionCard>
                  );
                })}
              </div>
            ) : <div className="sub-pending">请先选择套餐规格</div>}
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
