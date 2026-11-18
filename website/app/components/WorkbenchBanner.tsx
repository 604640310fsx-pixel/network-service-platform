import { useT } from "../lib/i18n";
import "./workbench-banner.css";

type WorkbenchBannerProps = {
  kicker: string;
  title: string;
  description: string;
  statusLabel: string;
  badge: string;
  className?: string;
};

export const workbenchBannerLayoutClass = "cc-workbench-layout";

/**
 * Shared information band taken from the existing subscription configurator.
 * Keep the content page-specific while preserving one visual implementation.
 */
export function WorkbenchBanner({
  kicker,
  title,
  description,
  statusLabel,
  badge,
  className,
}: WorkbenchBannerProps) {
  const t = useT();
  return (
    <header className={["cc-workbench", className].filter(Boolean).join(" ")}>
      <div>
        <span className="cc-workbench-kicker">{kicker}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="cc-workbench-status" aria-label={t.workbench.statusLabel}>
        <span><i aria-hidden="true" />{statusLabel}</span>
        <small>{badge}</small>
      </div>
    </header>
  );
}
