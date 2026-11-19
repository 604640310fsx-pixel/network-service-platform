import { useI18n, useT } from "../../lib/i18n";
import { subscriptionLineDisplay } from "./lineDisplay";
import type { ResidentialOptions } from "../../lib/residential-options";
export function ResidentialOptionDetails({ options }: { options: ResidentialOptions }) {
  const t = useT(), copy = t.residentialOptions;
  const { lang } = useI18n();
  const money = (fen: number) => `¥${(fen / 100).toFixed(2).replace(/\.00$/, "")}`;
  return <div className="sub-residential-details" data-residential-version={options.version}>
    <dl>
      <div><dt>{copy.line}</dt><dd>{subscriptionLineDisplay(copy.lines[options.lineId] ?? "", lang, (text) => text)}</dd></div>
      <div><dt>{copy.traffic}</dt><dd>{options.trafficGb === 1000 ? "1T" : `${options.trafficGb}G`}</dd></div>
      <div><dt>{copy.device}</dt><dd>{t.subscribe.residentialDevices(options.deviceAllowance)}</dd></div>
      <div><dt>{copy.base}</dt><dd>{money(options.baseMonthlyFen)}</dd></div>
      <div><dt>{copy.addon}</dt><dd>+{money(options.addonMonthlyFen)}</dd></div>
      <div><dt>{copy.final}</dt><dd>{money(options.finalMonthlyFen)}</dd></div>
      {options.basePeriodFen !== undefined && <><div><dt>{copy.basePeriod}</dt><dd>{money(options.basePeriodFen)}</dd></div>
        <div><dt>{copy.addonPeriod}</dt><dd>+{money(options.addonPeriodFen!)}</dd></div>
        <div><dt>{copy.finalPeriod}</dt><dd>{money(options.finalPeriodFen!)}</dd></div></>}
    </dl><small>{copy.manual}</small>
  </div>;
}
