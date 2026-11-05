import { useEffect, useState, type KeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useCatalogText, useT } from "../../lib/i18n";
import { networkTypes, trafficOptions, residentialTrafficOptions } from "../../lib/subscribeCatalog";
import { normalizeResidentialNewPurchase, parseSelectionParams, selectionToQuery, type CatalogSelection } from "../../lib/resolveSelection";
import { monthlyPresentation } from "./subscriptionPresentation";
import { usePlanAvailability } from "../../lib/planAvailability";
import { formatCardYuan, specMonthlyPriceFen, typeFromPriceFen } from "../../lib/cardPrices";
import { PendingOrderNotice } from "./PendingOrderNotice";
import { useCustomerDrawer } from "../customer/CustomerCenterShell";
import { MobileOrderBar } from "./MobileOrderBar";
import { getNextEnabledRadioIndex, getRovingRadioTabIndex, OptionCard } from "./OptionCard";
import { OrderSummary } from "./OrderSummary";
import { StepProgress } from "./StepProgress";
import { useSubscriptionSelection } from "./useSubscriptionSelection";
import "./subscribe.css";
import "./subscribe-configurator.css";

const STEP_KEYS_WITH_SPEC = ["type", "region", "isp", "spec", "duration", "confirm"] as const;
const STEP_KEYS_WITHOUT_SPEC = ["type", "region", "isp", "duration", "confirm"] as const;

// Presentation only: keep catalog IDs, default selection, prices and order identity.
const productCardOrder = ["pure-native-ip", "residential", "us-local-carrier", "local-isp"];
const displayNetworkTypes = [...networkTypes].sort((a, b) => productCardOrder.indexOf(a.id) - productCardOrder.indexOf(b.id));

function optionTabIndex<T extends { id: string }>(
  options: readonly T[],
  selectedId: string | null,
  optionId: string,
  isDisabled?: (option: T) => boolean,
): 0 | -1 {
  const disabled = options.map((option) => isDisabled?.(option) ?? false);
  return getRovingRadioTabIndex(
    options.findIndex((option) => option.id === selectedId),
    options.findIndex((option) => option.id === optionId),
    disabled,
  );
}

function handleRadioGroupKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || target.getAttribute("role") !== "radio") return;

  const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
  const nextIndex = getNextEnabledRadioIndex(
    radios.indexOf(target),
    event.key,
    radios.map((radio) => radio.disabled),
  );
  if (nextIndex === null) return;

  const nextRadio = radios[nextIndex];
  if (!nextRadio) return;
  event.preventDefault();
  nextRadio.click();
  nextRadio.focus();
}

function SolutionIcon({ typeId }: { typeId: string }) {
  // Exact as-used r30 SVG alpha masks, including the original dual-ISP composite.
  // Decorative only; no runtime HTML injection or icon dependency installation.
  return <span className={`sub-product-glyph is-${typeId}`} aria-hidden="true" />;
}

export function SubscribePage() {
  const navigate = useNavigate();
  const t = useT();
  const copy = t.subscribe;
  const ct = useCatalogText();
  const [searchParams, setSearchParams] = useSearchParams();
  // 仅在挂载时读取一次 query 作为初始选择；hook 只有在其解析为完整方案时才采纳，
  // 不完整 / 非法参数不会污染 hook（回退默认选择）。
  const [initialEntry] = useState(() => {
    const entry = normalizeResidentialNewPurchase(parseSelectionParams(searchParams));
    return { ...entry, reconfirm: entry.selection.typeId === "residential" &&
      (entry.reconfirm || searchParams.get("reconfirm") === "residential-v2") };
  });
  const [legacyConfirmed, setLegacyConfirmed] = useState(false);
  const availability = usePlanAvailability();
  const selection = useSubscriptionSelection(initialEntry.selection, availability.index ?? undefined);
  const needsResidentialReconfirm = selection.typeId === "residential" && initialEntry.reconfirm && !legacyConfirmed;
  const shownTrafficOptions = selection.typeId==='residential'?residentialTrafficOptions:trafficOptions;
  const priceStatus = availability.loading
    ? copy.priceLoading
    : availability.error
      ? copy.priceUnavailable
      : null;
  const canRequest =
    !needsResidentialReconfirm &&
    !availability.loading &&
    !availability.error &&
    selection.summary.complete &&
    selection.summary.total !== null &&
    selection.summary.availability === "available";
  const { activeDrawer, openDrawer, closeDrawer } = useCustomerDrawer();
  const orderOpen = activeDrawer === "order";
  const showIspStep = !selection.summary.ispImplied;
  const stepKeys = (selection.hasSpecStep ? STEP_KEYS_WITH_SPEC : STEP_KEYS_WITHOUT_SPEC)
    .filter((key) => showIspStep || key !== "isp");
  const steps = stepKeys.map(
    (key) => [copy.steps[key].name, copy.steps[key].tip] as const,
  );
  // 选择步骤对应的 DOM 区块；最后一步"确认并提交"不再对应区块（跳转独立页）。
  const allSectionIds = selection.hasSpecStep
    ? ["sub-section-type", "sub-section-region", "sub-section-isp", "sub-section-spec", "sub-section-duration"]
    : ["sub-section-type", "sub-section-region", "sub-section-isp", "sub-section-duration"];
  const sectionIds = showIspStep ? allSectionIds : allSectionIds.filter((id) => id !== "sub-section-isp");
  const displayedStep = selection.summary.ispImplied && selection.currentStep >= 4
    ? selection.currentStep - 1 : selection.currentStep;

  const currentSelection: CatalogSelection = {
    typeId: selection.typeId,
    regionId: selection.regionId,
    ispId: selection.ispId,
    specId: selection.specId,
    durationId: selection.durationId,
  };
  const monthly = monthlyPresentation(availability.index, currentSelection);
  const summaryPresentation = {
    monthly,
    line: selection.selectedLine ? ct(selection.selectedLine.name) : null,
    months: selection.availableDurations.find(option => option.id === selection.durationId)?.months ?? null,
  };
  function optionAddon(specId: string | null | undefined) {
    if (specId === undefined) return null;
    return monthlyPresentation(availability.index, { ...currentSelection, specId })?.addonMonthlyFen ?? null;
  }

  // 把当前选择镜像回 /subscribe 的 query（replace，避免堆积浏览历史）；
  // 正常跳转前历史记录即带有同一组 ID，浏览器后退 / 刷新可据此恢复。
  useEffect(() => {
    const query = new URLSearchParams(selectionToQuery(currentSelection));
    if (needsResidentialReconfirm) query.set("reconfirm", "residential-v2");
    setSearchParams(query, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.typeId, selection.regionId, selection.ispId, selection.specId, selection.durationId, needsResidentialReconfirm]);

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
    selection.setCurrentStep(selection.summary.ispImplied && step >= 3 ? step + 1 : step);
    document.getElementById(sectionIds[step - 1])?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <main className="sub-page sub-configurator-v11">
      <div className="sub-layout">
        <div className="sub-content">
          <StepProgress steps={steps} currentStep={displayedStep} onStep={goToStep} />
          <PendingOrderNotice />
          {needsResidentialReconfirm && <div className="sub-pending" role="alert"><p>{copy.residentialReconfirm}</p><button type="button" className="sub-order-button" onClick={() => setLegacyConfirmed(true)}>{copy.residentialConfirm}</button></div>}

          <section className="sub-section sub-solution-section" id="sub-section-type">
            <div className="sub-section-heading">
              <div><h2>{copy.configurator.typeTitle}</h2></div>
              <p>{copy.configurator.fromNote}</p>
            </div>
            <div className="sub-grid sub-solution-grid" role="radiogroup" aria-label={copy.typeSection.groupLabel} onKeyDown={handleRadioGroupKeyDown}>
              {displayNetworkTypes.map((option) => {
                const product = copy.productCards[option.id];
                const typeFromFen = typeFromPriceFen(availability.index, option.id);
                const selected = selection.typeId === option.id;
                return (
                  <OptionCard key={option.id} selected={selected} onSelect={() => selection.selectType(option.id)} label={ct(option.name)} className="sub-type-option" tabIndex={optionTabIndex(displayNetworkTypes, selection.typeId, option.id)}>
                    <span className="sub-solution-top">
                      <span className="sub-solution-icon"><SolutionIcon typeId={option.id} /></span>
                      <span className="sub-solution-title"><strong>{ct(option.name)}</strong></span>
                    </span>
                    <span className="sub-product-audience">{product.audience.replace(/^适合人群：|^For: /, "")}</span>
                    <span className="sub-type-price">{typeFromFen === null ? copy.pricePending : <><b>{formatCardYuan(typeFromFen)}</b><small>{copy.configurator.monthlyFrom}</small></>}</span>
                    <span className="sub-solution-footer">
                      <span className="sub-type-specs"><span className="sub-type-spec-label">{product.tag}</span><span>{product.bandwidth}</span></span>
                      <strong>{selected ? copy.configurator.selected : copy.configurator.choose}</strong>
                    </span>
                  </OptionCard>
                );
              })}
            </div>
          </section>

          <div className="sub-configuration">
          <section className="sub-section" id="sub-section-region">
            <div className="sub-section-heading">
              <div><h2>{copy.configurator.location}</h2></div>
            </div>
            <label className="sub-location-select"><span>{copy.regionSection.groupLabel}</span>
              {selection.regionId && <i className={`sub-flag is-${selection.availableRegions.find(option => option.id === selection.regionId)?.flagClass}`} aria-hidden="true" />}
              <select aria-label={copy.regionSection.groupLabel} value={selection.regionId ?? ""} onChange={event => selection.selectRegion(event.target.value)}>
                <option value="" disabled>{copy.regionSection.title}</option>
                {selection.availableRegions.map(option => <option key={option.id} value={option.id}>{ct(option.cardName ?? option.name)}</option>)}
              </select>
            </label>
          </section>

          {showIspStep && <section className="sub-section" id="sub-section-isp">
            <div className="sub-section-heading">
              <div><h2>{copy.ispSection.title}</h2></div>
            </div>
            {selection.availableIsps.length ? (
              <label className="sub-location-select"><span>{copy.ispSection.groupLabel}</span>
                <select aria-label={copy.ispSection.groupLabel} value={selection.ispId ?? ""} onChange={event => selection.selectIsp(event.target.value)}>
                  <option value="" disabled>{copy.ispSection.title}</option>
                  {selection.availableIsps.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
                </select>
              </label>
            ) : <div className="sub-pending" role="status">{copy.ispSection.regionPending}</div>}
          </section>}

          {selection.hasSpecStep && <section className="sub-section" id="sub-section-spec">
            <div className="sub-section-heading">
              <div><h2>{copy.configurator.profile}</h2></div>
            </div>
            {selection.availableLines.length > 0 ? (
              <div className="sub-package-choice">
                <div><h3>{copy.specSection.lineTitle}</h3><div className="sub-grid sub-package-lines" role="radiogroup" aria-label={copy.specSection.lineTitle} onKeyDown={handleRadioGroupKeyDown}>
                  {selection.availableLines.map((line) => <OptionCard key={line.id} selected={selection.selectedLine?.id === line.id}
                    onSelect={() => selection.selectLine(line.id)} label={ct(line.name)} className="sub-package-option"
                    tabIndex={optionTabIndex(selection.availableLines, selection.selectedLine?.id ?? null, line.id)}>
                    <strong>{ct(line.name)}</strong>{line.notice && <small>{ct(line.notice)}</small>}
                    {optionAddon(selection.packageSpecId(line.id, selection.selectedTrafficId ?? "")) !== null && <b className="sub-addon">+{formatCardYuan(optionAddon(selection.packageSpecId(line.id, selection.selectedTrafficId ?? ""))!)}{copy.configurator.perMonth}</b>}
                  </OptionCard>)}
                </div></div>
                <div><h3>{copy.specSection.trafficTitle}</h3><div className="sub-grid sub-package-traffic" role="radiogroup" aria-label={copy.specSection.trafficGroupLabel} onKeyDown={handleRadioGroupKeyDown}>
                  {shownTrafficOptions.filter((traffic) => selection.selectedLine &&
                    selection.packageSpecId(selection.selectedLine.id, traffic.id) !== undefined).map((traffic) =>
                    <OptionCard key={traffic.id} selected={selection.selectedTrafficId === traffic.id}
                      onSelect={() => selection.selectTraffic(traffic.id)} label={traffic.name} className="sub-package-option"
                      tabIndex={optionTabIndex(shownTrafficOptions, selection.selectedTrafficId, traffic.id)}>
                      <strong>{traffic.name}</strong>
                      {selection.typeId === "residential" && <small>{copy.residentialTrafficDevices(selection.availableSpecs.find(option => option.lineId === selection.selectedLine?.id && option.trafficId === traffic.id)?.deviceAllowance ?? null)}</small>}
                      {optionAddon(selection.packageSpecId(selection.selectedLine!.id, traffic.id)) !== null && <b className="sub-addon">+{formatCardYuan(optionAddon(selection.packageSpecId(selection.selectedLine!.id, traffic.id))!)}{copy.configurator.perMonth}</b>}
                    </OptionCard>)}
                </div></div>
              </div>
            ) : selection.availableSpecs.length ? (
              <div className="sub-grid sub-grid-three" role="radiogroup" aria-label={copy.specSection.groupLabel} onKeyDown={handleRadioGroupKeyDown}>
                {selection.availableSpecs.map((option) => {
                  const monthlyFen = selection.typeId === null ? null : specMonthlyPriceFen(availability.index, selection.typeId, selection.regionId, selection.ispId, option.id);
                  return (
                  <OptionCard key={option.id} selected={selection.specId === option.id} onSelect={() => selection.selectSpec(option.id)} label={ct(option.name)} className="sub-spec-option" tabIndex={optionTabIndex(selection.availableSpecs, selection.specId, option.id)}>
                    <span className="sub-option-head"><strong>{ct(option.name)}</strong>{option.badge && <i className="sub-tag is-accent">{ct(option.badge)}</i>}<i className="sub-tag">{monthlyFen === null ? copy.pricePending : copy.perMonth(formatCardYuan(monthlyFen))}</i></span>
                    <span className="sub-features">{option.features.map((feature) => <span key={feature}>{ct(feature)}</span>)}</span>
                    {option.description && <span className="sub-option-cta">{ct(option.description)}</span>}
                  </OptionCard>
                  );
                })}
              </div>
            ) : <div className="sub-pending">{copy.specSection.chooseIspPlanFirst}</div>}
          </section>}

          <section className="sub-section" id="sub-section-duration">
            <div className="sub-section-heading">
              <div>
                <h2>{copy.configurator.term}</h2>
                {priceStatus && <p className={`sub-price-status${availability.error ? " is-error" : ""}`} role={availability.error ? "alert" : "status"}>{priceStatus}</p>}
              </div>
            </div>
            {selection.canSelectDuration ? (
              <div className="sub-grid sub-grid-four" role="radiogroup" aria-label={copy.durationSection.groupLabel} onKeyDown={handleRadioGroupKeyDown}>
                {selection.availableDurations.map((option) => {
                  const total = selection.durationPrices[option.id] ?? null;
                  const status = selection.durationAvailability[option.id] ?? "unknown";
                  const statusLabel = status === "sold_out" ? copy.durationSection.soldOut : status === "unavailable" ? copy.durationSection.unavailable : null;
                  const durationDisabled = status === "sold_out" || status === "unavailable";
                  return (
                    <OptionCard
                      key={option.id}
                      selected={selection.durationId === option.id}
                      onSelect={() => selection.selectDuration(option.id)}
                      label={ct(option.name)}
                      className="sub-duration-option"
                      disabled={durationDisabled}
                      tabIndex={optionTabIndex(
                        selection.availableDurations,
                        selection.durationId,
                        option.id,
                        (duration) => {
                          const durationStatus = selection.durationAvailability[duration.id] ?? "unknown";
                          return durationStatus === "sold_out" || durationStatus === "unavailable";
                        },
                      )}
                    >
                      <span className="sub-option-head">
                        <strong>{ct(option.name)}</strong>
                        {statusLabel ? <i className="sub-tag">{statusLabel}</i> : option.badge && <i className="sub-tag is-accent">{ct(option.badge)}</i>}
                      </span>
                      <span className="sub-duration-total">{total === null ? "—" : `¥${total}`}</span>
                      <span className="sub-duration-meta"><span>{total === null ? (statusLabel ?? copy.pricePending) : copy.durationSection.approxPerMonth(Math.floor(total / option.months))}</span><b /></span>
                    </OptionCard>
                  );
                })}
              </div>
            ) : <div className="sub-pending">{selection.hasSpecStep ? copy.durationSection.chooseSpecFirst : copy.durationSection.chooseIspFirst}</div>}
          </section>
          </div>
        </div>

        <aside className="sub-desktop-summary" aria-label={copy.summaryLabel}><OrderSummary summary={selection.summary} presentation={summaryPresentation} canRequest={canRequest} onRequest={goToRequest} /></aside>
      </div>

      <aside
        className={`sub-order-drawer ${orderOpen ? "is-open" : ""}`}
        data-cc-drawer="order"
        role={orderOpen ? "dialog" : undefined}
        aria-modal={orderOpen ? true : undefined}
        aria-label={copy.summaryDrawerLabel}
      >
        <button type="button" className="sub-drawer-close" onClick={closeDrawer} aria-label={copy.closeSummary}>×</button>
        <OrderSummary summary={selection.summary} presentation={summaryPresentation} canRequest={canRequest} drawer onRequest={goToRequest} />
      </aside>
      <MobileOrderBar summary={selection.summary} months={summaryPresentation.months} canRequest={canRequest} open={orderOpen} onOpen={(trigger) => openDrawer("order", trigger)} onRequest={goToRequest} />
    </main>
  );
}
