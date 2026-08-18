import { durations, networkTypes, regions } from "../../lib/subscribeCatalog";
import { useCustomerDrawer } from "../customer/CustomerCenterShell";
import { MobileOrderBar } from "./MobileOrderBar";
import { OptionCard } from "./OptionCard";
import { OrderSummary } from "./OrderSummary";
import { StepProgress } from "./StepProgress";
import { useSubscriptionSelection } from "./useSubscriptionSelection";
import "./subscribe.css";

const sectionIds = ["sub-section-type", "sub-section-region", "sub-section-isp", "sub-section-spec", "sub-section-duration", "sub-section-duration"];

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
          <StepProgress currentStep={selection.currentStep} onStep={goToStep} />

          <section className="sub-section" id="sub-section-type">
            <h2><em>STEP 01</em>选择网络类型</h2>
            <div className="sub-grid sub-grid-three" role="radiogroup" aria-label="网络类型">
              {networkTypes.map((option) => (
                <OptionCard key={option.id} selected={selection.typeId === option.id} onSelect={() => selection.selectType(option.id)} label={option.name} className="sub-type-option">
                  <span className="sub-option-head"><strong>{option.name}</strong>{option.badge && <i className="sub-tag is-accent">{option.badge}</i>}</span>
                  <span className="sub-price"><b>¥{option.startingPrice}</b><small>/月 起</small></span>
                  <span className="sub-description">{option.description}</span>
                  <span className="sub-features">{option.features.map((feature) => <span key={feature}>{feature}</span>)}</span>
                  <span className="sub-option-cta">{selection.typeId === option.id ? "已选择此类型" : "选择此类型"}</span>
                </OptionCard>
              ))}
            </div>
          </section>

          <section className="sub-section" id="sub-section-region">
            <h2><em>STEP 02</em>选择国家/地区</h2>
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
            <h2><em>STEP 03</em>选择运营商{selection.regionId && <span>（{selection.summary.region}）</span>}</h2>
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
            <h2><em>STEP 04</em>选择规格</h2>
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
            <h2><em>STEP 05</em>选择有效期</h2>
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

        <aside className="sub-desktop-summary" aria-label="订单摘要"><OrderSummary summary={selection.summary} /></aside>
      </div>

      <aside
        className={`sub-order-drawer ${orderOpen ? "is-open" : ""}`}
        data-cc-drawer="order"
        role={orderOpen ? "dialog" : undefined}
        aria-modal={orderOpen ? true : undefined}
        aria-label="订单摘要抽屉"
      >
        <button type="button" className="sub-drawer-close" onClick={closeDrawer} aria-label="关闭订单摘要">×</button>
        <OrderSummary summary={selection.summary} drawer />
      </aside>
      <MobileOrderBar summary={selection.summary} open={orderOpen} onOpen={(trigger) => openDrawer("order", trigger)} />
    </main>
  );
}
