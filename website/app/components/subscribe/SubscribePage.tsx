import { useEffect, useState, type KeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useCatalogText, useT, type Messages } from "../../lib/i18n";
import { networkTypes, trafficOptions } from "../../lib/subscribeCatalog";
import { parseSelectionParams, selectionToQuery, type CatalogSelection } from "../../lib/resolveSelection";
import { usePlanAvailability } from "../../lib/planAvailability";
import { formatCardYuan, specMonthlyPriceFen, typeFromPriceFen } from "../../lib/cardPrices";
import { WorkbenchBanner } from "../WorkbenchBanner";
import { useCustomerDrawer } from "../customer/CustomerCenterShell";
import { MobileOrderBar } from "./MobileOrderBar";
import { getNextEnabledRadioIndex, getRovingRadioTabIndex, OptionCard } from "./OptionCard";
import { OrderSummary } from "./OrderSummary";
import { StepProgress } from "./StepProgress";
import { useSubscriptionSelection } from "./useSubscriptionSelection";
import "./subscribe.css";

const STEP_KEYS_WITH_SPEC = ["type", "region", "isp", "spec", "duration", "confirm"] as const;
const STEP_KEYS_WITHOUT_SPEC = ["type", "region", "isp", "duration", "confirm"] as const;

const solutionCodes: Record<string, string> = {
  "us-local-carrier": "US LOCAL CARRIER",
  "local-isp": "LOCAL PREMIUM",
  residential: "RESIDENTIAL ISP",
  "pure-native-ip": "PURE NATIVE IP",
};

/* 真住宅宽带的能力概览把线路名称（电信 CN2 GIA / 联通 9929 / 移动 CMIN2）与住宅环境属性
   （UDP / IPv4·IPv6 / DNS 等）混在同一份列表里。线路名称改为在上方以"直连高级路线"标题
   呈现，这里从 catalog 的 features 里把线路字符串过滤掉，只保留住宅环境事实，避免同一张
   卡片里出现两次线路信息。不改写 catalog 数据本身。 */
const RESIDENTIAL_ROUTE_FEATURES = ["电信 CN2 GIA", "联通 9929", "移动 CMIN2"];

function residentialEnvironmentFeatures(features: string[], copy: Messages["subscribe"], ct: (text: string) => string) {
  const environment = features
    .filter((feature) => !RESIDENTIAL_ROUTE_FEATURES.includes(feature))
    .map((feature) => (feature === "UDP" ? copy.fullUdp : ct(feature)));
  // "真实住宅 ISP" 并非 catalog features 里的字符串，但对应 ispsByTypeAndRegion.residential
  // 里真实命名的住宅 ISP——是同一份 catalog 数据里已有的真实事实，只是换成客户能懂的话。
  return [copy.realResidentialIsp, ...environment];
}

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
  const t = useT();
  const copy = t.subscribe;
  const ct = useCatalogText();
  const [searchParams, setSearchParams] = useSearchParams();
  // 仅在挂载时读取一次 query 作为初始选择；hook 只有在其解析为完整方案时才采纳，
  // 不完整 / 非法参数不会污染 hook（回退默认选择）。
  const [initialSelection] = useState(() => parseSelectionParams(searchParams));
  const availability = usePlanAvailability();
  const selection = useSubscriptionSelection(initialSelection, availability.index ?? undefined);
  const priceStatus = availability.loading
    ? copy.priceLoading
    : availability.error
      ? copy.priceUnavailable
      : null;
  const canRequest =
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
    selection.setCurrentStep(selection.summary.ispImplied && step >= 3 ? step + 1 : step);
    document.getElementById(sectionIds[step - 1])?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <main className="sub-page">
      <div className="sub-layout">
        <div className="sub-content">
          <WorkbenchBanner
            kicker="NETWORK SOLUTION CONFIGURATOR"
            title={copy.banner.title}
            description={copy.banner.description}
            statusLabel={copy.banner.statusLabel}
            badge="CATALOG V1"
          />

          <StepProgress steps={steps} currentStep={displayedStep} onStep={goToStep} />

          <section className="sub-section sub-solution-section" id="sub-section-type">
            <div className="sub-section-heading">
              <div><span>STEP 01 · NETWORK TYPE</span><h2>{copy.typeSection.title}</h2><p>{copy.typeSection.lead}</p></div>
              <small>{copy.typeSection.count}</small>
            </div>
            <div className="sub-grid sub-solution-grid" role="radiogroup" aria-label={copy.typeSection.groupLabel} onKeyDown={handleRadioGroupKeyDown}>
              {networkTypes.map((option) => {
                const presentation = copy.solutions[option.id];
                const typeFromFen = typeFromPriceFen(availability.index, option.id);
                const selected = selection.typeId === option.id;
                return (
                  <OptionCard key={option.id} selected={selected} onSelect={() => selection.selectType(option.id)} label={ct(option.name)} className="sub-type-option" tabIndex={optionTabIndex(networkTypes, selection.typeId, option.id)}>
                    <span className="sub-solution-top">
                      <span className="sub-solution-icon"><SolutionIcon typeId={option.id} /></span>
                      <span className="sub-solution-title"><small>{solutionCodes[option.id]}</small><strong>{ct(option.name)}</strong></span>
                      {option.badge && <i className="sub-tag is-accent">{ct(option.badge)}</i>}
                    </span>
                    <span className="sub-description">{ct(option.description)}</span>
                    {presentation && (
                      <span className="sub-route-group">
                        <small>{presentation.label}</small>
                        <span>{presentation.highlights.map((item) => <i key={item}>{item}</i>)}</span>
                      </span>
                    )}
                    {option.id === "residential" ? (
                      <>
                        <span className="sub-capability-label">{copy.typeSection.residentialEnvironment}</span>
                        <span className="sub-features">{residentialEnvironmentFeatures(option.features, copy, ct).map((feature) => <span key={feature}>{feature}</span>)}</span>
                      </>
                    ) : (
                      <>
                        <span className="sub-capability-label">{copy.typeSection.capabilities}</span>
                        <span className="sub-features">{option.features.map((feature) => <span key={feature}>{ct(feature)}</span>)}</span>
                      </>
                    )}
                    <span className="sub-solution-footer">
                      <b>{typeFromFen === null ? copy.pricePending : copy.from(formatCardYuan(typeFromFen))}</b>
                      <strong>{selected ? copy.typeSection.current : copy.typeSection.choose}<i aria-hidden="true">→</i></strong>
                    </span>
                  </OptionCard>
                );
              })}
            </div>
          </section>

          <section className="sub-section" id="sub-section-region">
            <div className="sub-section-heading">
              <div><span>STEP 02 · LOCATION</span><h2>{copy.regionSection.title}</h2><p>{copy.regionSection.lead}</p></div>
              <small>{copy.regionSection.count(selection.availableRegions.length)}</small>
            </div>
            <div
              className="sub-grid sub-grid-region"
              role="radiogroup"
              aria-label={copy.regionSection.groupLabel}
              onKeyDown={handleRadioGroupKeyDown}
            >
              {selection.availableRegions.map((option) => {
                return (
                <OptionCard key={option.id} selected={selection.regionId === option.id} onSelect={() => selection.selectRegion(option.id)} label={ct(option.cardName ?? option.name)} className="sub-region-option" tabIndex={optionTabIndex(selection.availableRegions, selection.regionId, option.id)}>
                  <span className="sub-region-main">
                    <span className="sub-option-head"><i className={`sub-flag is-${option.flagClass}`} aria-hidden="true" /><strong>{ct(option.cardName ?? option.name)}</strong></span>
                  </span>
                </OptionCard>
                );
              })}
            </div>
          </section>

          {showIspStep && <section className="sub-section" id="sub-section-isp">
            <div className="sub-section-heading">
              <div><span>STEP 03 · NETWORK OPERATOR</span><h2>{copy.ispSection.title}{selection.regionId && <em>· {ct(selection.summary.region)}</em>}</h2><p>{copy.ispSection.lead}</p></div>
              <small>{selection.availableIsps.length ? copy.ispSection.count(selection.availableIsps.length) : copy.ispSection.pendingConfig}</small>
            </div>
            {selection.availableIsps.length ? (
              <div className="sub-grid sub-isp-grid" role="radiogroup" aria-label={copy.ispSection.groupLabel} onKeyDown={handleRadioGroupKeyDown}>
                {selection.availableIsps.map((option) => (
                  <OptionCard key={option.id} selected={selection.ispId === option.id} onSelect={() => selection.selectIsp(option.id)} label={option.name} className="sub-isp-option" tabIndex={optionTabIndex(selection.availableIsps, selection.ispId, option.id)}>
                    <span><strong>{option.name}</strong><small>{ct(option.routeInfo ?? option.description)}</small></span>
                  </OptionCard>
                ))}
              </div>
            ) : <div className="sub-pending" role="status">{copy.ispSection.regionPending}</div>}
          </section>}

          {selection.hasSpecStep && <section className="sub-section" id="sub-section-spec">
            <div className="sub-section-heading">
              <div><span>STEP 04 · SERVICE PROFILE</span><h2>{copy.specSection.title}</h2><p>{copy.specSection.lead}</p></div>
              <small>{selection.availableSpecs.length ? copy.specSection.count(selection.availableSpecs.length) : copy.specSection.chooseIspFirst}</small>
            </div>
            {selection.availableLines.length > 0 ? (
              <div className="sub-package-choice">
                <div><h3>{copy.specSection.lineTitle}</h3><div className="sub-grid sub-package-lines" role="radiogroup" aria-label={copy.specSection.lineTitle} onKeyDown={handleRadioGroupKeyDown}>
                  {selection.availableLines.map((line) => <OptionCard key={line.id} selected={selection.selectedLine?.id === line.id}
                    onSelect={() => selection.selectLine(line.id)} label={ct(line.name)} className="sub-package-option"
                    tabIndex={optionTabIndex(selection.availableLines, selection.selectedLine?.id ?? null, line.id)}>
                    <strong>{ct(line.name)}</strong>{line.notice && <small>{ct(line.notice)}</small>}
                  </OptionCard>)}
                </div></div>
                <div><h3>{copy.specSection.trafficTitle}</h3><div className="sub-grid sub-package-traffic" role="radiogroup" aria-label={copy.specSection.trafficGroupLabel} onKeyDown={handleRadioGroupKeyDown}>
                  {trafficOptions.filter((traffic) => selection.selectedLine &&
                    selection.packageSpecId(selection.selectedLine.id, traffic.id) !== undefined).map((traffic) =>
                    <OptionCard key={traffic.id} selected={selection.selectedTrafficId === traffic.id}
                      onSelect={() => selection.selectTraffic(traffic.id)} label={traffic.name} className="sub-package-option"
                      tabIndex={optionTabIndex(trafficOptions, selection.selectedTrafficId, traffic.id)}>
                      <strong>{traffic.name}</strong>
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
                <span>{selection.summary.ispImplied ? "STEP 04" : selection.hasSpecStep ? "STEP 05" : "STEP 04"} · SERVICE TERM</span>
                <h2>{copy.durationSection.title}</h2>
                <p>{copy.durationSection.lead}</p>
                {priceStatus && <p className={`sub-price-status${availability.error ? " is-error" : ""}`} role={availability.error ? "alert" : "status"}>{priceStatus}</p>}
              </div>
              <small>{copy.durationSection.count(selection.availableDurations.length)}</small>
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

        <aside className="sub-desktop-summary" aria-label={copy.summaryLabel}><OrderSummary summary={selection.summary} canRequest={canRequest} onRequest={goToRequest} /></aside>
      </div>

      <aside
        className={`sub-order-drawer ${orderOpen ? "is-open" : ""}`}
        data-cc-drawer="order"
        role={orderOpen ? "dialog" : undefined}
        aria-modal={orderOpen ? true : undefined}
        aria-label={copy.summaryDrawerLabel}
      >
        <button type="button" className="sub-drawer-close" onClick={closeDrawer} aria-label={copy.closeSummary}>×</button>
        <OrderSummary summary={selection.summary} canRequest={canRequest} drawer onRequest={goToRequest} />
      </aside>
      <MobileOrderBar summary={selection.summary} canRequest={canRequest} open={orderOpen} onOpen={(trigger) => openDrawer("order", trigger)} onRequest={goToRequest} />
    </main>
  );
}
