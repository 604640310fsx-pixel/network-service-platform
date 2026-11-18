import {
  Component,
  useId,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { QRCodeSVG } from "qrcode.react";
import type { ServiceDeliveryItem } from "../../lib/payment-api";
import {
  SUBSCRIPTION_PLATFORMS,
  clientsForPlatform,
  safeSubscriptionHref,
  safeVerifiedDeepLinkHref,
  type SubscriptionClientId,
  type SubscriptionPlatform,
} from "./subscriptionImportModel";
import "./subscription-import.css";
import { useT } from "../../lib/i18n";

export type SubscriptionImportDelivery = Pick<
  ServiceDeliveryItem,
  "position" | "label" | "subscriptionUrl"
>;

export type VerifiedDeepLinkRequest = {
  readonly platform: SubscriptionPlatform;
  readonly clientId: SubscriptionClientId;
  readonly subscriptionUrl: string;
};

export type SubscriptionImportModuleProps = {
  /** Items must come from the existing authorized delivery response. */
  readonly deliveryItems: readonly SubscriptionImportDelivery[];
  /** Place the existing controls directly inside an owned service card. */
  readonly compact?: boolean;
  readonly initialPlatform?: SubscriptionPlatform;
  /**
   * Optional integration hook for a separately confirmed exact deep-link contract.
   * Returning null keeps that client on the manual-import path.
   */
  readonly getVerifiedDeepLink?: (request: VerifiedDeepLinkRequest) => string | null;
};

class LocalQrBoundary extends Component<
  { readonly children: ReactNode; readonly failedMessage: string },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // 订阅地址属于敏感交付数据；异常对象和组件栈均不写入日志。
  }

  render() {
    if (this.state.failed) {
      return <p className="cc-si-inline-error" role="alert">{this.props.failedMessage}</p>;
    }
    return this.props.children;
  }
}

function resolvedVerifiedDeepLink(
  getVerifiedDeepLink: SubscriptionImportModuleProps["getVerifiedDeepLink"],
  request: VerifiedDeepLinkRequest,
): string | null {
  if (getVerifiedDeepLink === undefined) return null;
  try {
    return safeVerifiedDeepLinkHref(getVerifiedDeepLink(request));
  } catch {
    // 不记录包含订阅地址的 request 或外部 builder 异常。
    return null;
  }
}

export function SubscriptionImportModule({
  deliveryItems,
  compact = false,
  initialPlatform = "ios",
  getVerifiedDeepLink,
}: SubscriptionImportModuleProps) {
  const instanceId = useId();
  const copy = useT().subscriptionImport;
  const [platform, setPlatform] = useState<SubscriptionPlatform>(initialPlatform);
  const initialClients = clientsForPlatform(initialPlatform);
  const [clientId, setClientId] = useState<SubscriptionClientId>(initialClients[0].id);
  const [selectedPosition, setSelectedPosition] = useState<number | null>(
    deliveryItems[0]?.position ?? null,
  );
  const [qrOpen, setQrOpen] = useState(false);
  const [safeOpenVisible, setSafeOpenVisible] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pageClassName = compact ? "cc-si-page is-compact" : "cc-si-page";

  const clients = clientsForPlatform(platform);
  const platformLabel =
    SUBSCRIPTION_PLATFORMS.find((candidate) => candidate.id === platform)?.label ?? platform;
  const selectedClient = clients.find((client) => client.id === clientId) ?? clients[0];
  const activeItem =
    deliveryItems.find((item) => item.position === selectedPosition) ?? deliveryItems[0] ?? null;
  const subscriptionUrl = activeItem === null
    ? null
    : safeSubscriptionHref(activeItem.subscriptionUrl);
  function selectPlatform(nextPlatform: SubscriptionPlatform) {
    const nextClients = clientsForPlatform(nextPlatform);
    setPlatform(nextPlatform);
    setClientId(nextClients[0].id);
    setActionMessage(null);
    setSafeOpenVisible(false);
  }

  function selectDelivery(position: number) {
    setSelectedPosition(position);
    setQrOpen(false);
    setSafeOpenVisible(false);
    setActionMessage(null);
  }

  function movePlatformFocus(currentIndex: number, key: string) {
    let nextIndex: number | null = null;
    if (key === "ArrowRight" || key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % SUBSCRIPTION_PLATFORMS.length;
    } else if (key === "ArrowLeft" || key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + SUBSCRIPTION_PLATFORMS.length) % SUBSCRIPTION_PLATFORMS.length;
    } else if (key === "Home") {
      nextIndex = 0;
    } else if (key === "End") {
      nextIndex = SUBSCRIPTION_PLATFORMS.length - 1;
    }
    if (nextIndex === null) return false;

    const nextPlatform = SUBSCRIPTION_PLATFORMS[nextIndex].id;
    selectPlatform(nextPlatform);
    requestAnimationFrame(() => {
      document.getElementById(`${instanceId}-platform-${nextPlatform}`)?.focus();
    });
    return true;
  }

  async function copySubscriptionUrl() {
    if (subscriptionUrl === null) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(subscriptionUrl);
      setActionMessage(copy.copied);
    } catch {
      inputRef.current?.focus();
      inputRef.current?.select();
      setActionMessage(copy.copyFailed);
    }
  }

  if (activeItem === null) {
    return (
      <section className={pageClassName} aria-labelledby={`${instanceId}-empty-title`}>
        <section className="cc-si-panel cc-si-empty" role="status">
          <span>SUBSCRIPTION</span>
          <h2 id={`${instanceId}-empty-title`}>{copy.pendingTitle}</h2>
          <p>{copy.pendingBody}</p>
        </section>
      </section>
    );
  }

  if (subscriptionUrl === null) {
    return (
      <section className={pageClassName} aria-labelledby={`${instanceId}-invalid-title`}>
        <section className="cc-si-panel cc-si-empty" role="alert">
          <span>SUBSCRIPTION</span>
          <h2 id={`${instanceId}-invalid-title`}>{copy.invalidTitle}</h2>
          <p>{copy.invalidBody}</p>
        </section>
      </section>
    );
  }

  const platformTabId = `${instanceId}-platform-${platform}`;
  const platformPanelId = `${instanceId}-client-panel`;
  const qrPanelId = `${instanceId}-local-qr`;

  return (
    <section className={pageClassName} aria-labelledby={`${instanceId}-title`}>
      <div className="cc-si-layout">
        <section className="cc-si-panel">
          <header className="cc-si-heading">
            <div>
              <span>SUBSCRIPTION</span>
              <h2 id={`${instanceId}-title`}>{copy.title}</h2>
              <p>{copy.lead}</p>
            </div>
            <small>{copy.line(activeItem.position)}</small>
          </header>

          <aside className="cc-si-location-note" aria-label={copy.locationLabel}>
            <strong>{copy.locationTitle}</strong>
            <ul>
              <li>{copy.locationDesktopBefore}<code>chrome://settings/content/location</code>{copy.locationDesktopAfter}</li>
              <li>{copy.locationAndroid}</li>
              <li>{copy.locationIos}</li>
            </ul>
            <p>{copy.locationFoot}</p>
          </aside>

          {deliveryItems.length > 1 && (
            <label className="cc-si-field">
              <span>{copy.chooseLine}</span>
              <select
                value={activeItem.position}
                onChange={(event) => selectDelivery(Number(event.currentTarget.value))}
              >
                {deliveryItems.map((item) => (
                  <option key={item.position} value={item.position}>
                    {copy.lineOption(item.position, item.label)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="cc-si-field">
            <span>{copy.currentUrl}</span>
            <input
              ref={inputRef}
              type="url"
              value={subscriptionUrl}
              readOnly
              spellCheck={false}
              autoComplete="off"
              aria-label={copy.urlLabel(activeItem.label)}
            />
          </label>

          <div className="cc-si-actions">
            <button type="button" className="cc-si-primary" onClick={() => void copySubscriptionUrl()}>
              {copy.copy}
            </button>
            <button
              type="button"
              className="cc-si-secondary"
              aria-expanded={safeOpenVisible}
              onClick={() => {
                setSafeOpenVisible((visible) => !visible);
                setActionMessage(null);
              }}
            >
              {copy.safeOpen}
            </button>
            <button
              type="button"
              className="cc-si-secondary"
              aria-expanded={qrOpen}
              aria-controls={qrPanelId}
              onClick={() => setQrOpen((open) => !open)}
            >
              {qrOpen ? copy.hideQr : copy.showQr}
            </button>
          </div>

          {qrOpen && (
            <div id={qrPanelId} className="cc-si-qr" aria-label={copy.qrLabel}>
              <div className="cc-si-qr-code">
                <LocalQrBoundary key={subscriptionUrl} failedMessage={copy.qrFailed}>
                  <QRCodeSVG value={subscriptionUrl} size={184} level="M" marginSize={2} />
                </LocalQrBoundary>
              </div>
              <p>{copy.qrHint}</p>
            </div>
          )}

          {actionMessage !== null && <p className="cc-si-status" role="status">{actionMessage}</p>}

          {safeOpenVisible && (
            <aside className="cc-si-browser-notice" aria-label={copy.browserLabel}>
              <strong>{copy.browserTitle}</strong>
              <p>{copy.browserBody}</p>
              <a
                href={subscriptionUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                referrerPolicy="no-referrer"
                onClick={() => setActionMessage(copy.openRequested)}
              >
                {copy.confirmOpen}
              </a>
            </aside>
          )}

        </section>

        <section className="cc-si-panel">
          <header className="cc-si-heading cc-si-heading-compact">
            <div>
              <span>CLIENT</span>
              <h2>{copy.clientTitle}</h2>
              <p>{copy.clientLead}</p>
            </div>
          </header>

          <div className="cc-si-platform-tabs" role="tablist" aria-label={copy.platformLabel}>
            {SUBSCRIPTION_PLATFORMS.map((item, index) => {
              const selected = item.id === platform;
              return (
                <button
                  key={item.id}
                  id={`${instanceId}-platform-${item.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={platformPanelId}
                  tabIndex={selected ? 0 : -1}
                  className={selected ? "is-active" : undefined}
                  onClick={() => selectPlatform(item.id)}
                  onKeyDown={(event) => {
                    if (movePlatformFocus(index, event.key)) event.preventDefault();
                  }}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          <div
            id={platformPanelId}
            role="tabpanel"
            aria-labelledby={platformTabId}
            className="cc-si-client-panel"
          >
            <p className="cc-si-client-caveat" role="note">
              {copy.clientCaveat}
            </p>
            <div className="cc-si-client-grid" aria-label={copy.clientGridLabel(platformLabel)}>
              {clients.map((client) => {
                const deepLink = resolvedVerifiedDeepLink(getVerifiedDeepLink, {
                  platform,
                  clientId: client.id,
                  subscriptionUrl,
                });
                return (
                  <div key={client.id} className="cc-si-client-option">
                    <button
                      type="button"
                      aria-pressed={client.id === selectedClient.id}
                      className={client.id === selectedClient.id ? "is-active" : undefined}
                      onClick={() => {
                        setClientId(client.id);
                        setActionMessage(null);
                      }}
                    >
                      <span>{client.name}</span>
                      {client.recommended && <small>{copy.recommended}</small>}
                    </button>
                    {deepLink !== null && (
                      <a
                        className="cc-si-client-import"
                        href={deepLink}
                        aria-label={client.id === "clash"
                          ? copy.importClashLabel
                          : copy.importClientLabel(client.name)}
                        onClick={() => setActionMessage(
                          client.id === "clash"
                            ? copy.importClashRequested
                            : copy.importClientRequested(client.name),
                        )}
                      >
                        {copy.import}
                      </a>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="cc-si-manual">
              <h3>{copy.manualTitle(selectedClient.name)}</h3>
              <ol>
                <li>{copy.manualStep1}</li>
                <li>{copy.manualStep2(selectedClient.name)}</li>
                <li>{copy.manualStep3}</li>
              </ol>
              <p className="cc-si-manual-reason">{copy.manualReasons[selectedClient.id]}</p>
              <button type="button" className="cc-si-secondary" onClick={() => void copySubscriptionUrl()}>
                {copy.copyThenManual}
              </button>
            </div>
          </div>

          <details className="cc-si-help">
            <summary>{copy.helpTitle}</summary>
            <ul>
              {copy.help.map((item) => <li key={item}>{item}</li>)}
            </ul>
            <p>{copy.helpFoot}</p>
          </details>

        </section>
      </div>
    </section>
  );
}
