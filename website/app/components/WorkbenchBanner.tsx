import "./workbench-banner.css";

type WorkbenchBannerProps = {
  kicker: string;
  title: string;
  description: string;
  statusLabel: string;
  badge: string;
  className?: string;
};

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
  return (
    <header className={["cc-workbench", className].filter(Boolean).join(" ")}>
      <div>
        <span className="cc-workbench-kicker">{kicker}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="cc-workbench-status" aria-label="页面状态">
        <span><i aria-hidden="true" />{statusLabel}</span>
        <small>{badge}</small>
      </div>
    </header>
  );
}
