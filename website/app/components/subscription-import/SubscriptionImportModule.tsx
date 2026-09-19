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
  { readonly children: ReactNode },
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
      return <p className="cc-si-inline-error" role="alert">二维码生成失败，请改用复制地址。</p>;
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
  const [platform, setPlatform] = useState<SubscriptionPlatform>(initialPlatform);
  const initialClients = clientsForPlatform(initialPlatform);
  const [clientId, setClientId] = useState<SubscriptionClientId>(initialClients[0].id);
  const [selectedPosition, setSelectedPosition] = useState<number | null>(
    deliveryItems[0]?.position ?? null,
  );
  const [qrOpen, setQrOpen] = useState(compact);
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
  const verifiedDeepLink = subscriptionUrl === null
    ? null
    : resolvedVerifiedDeepLink(getVerifiedDeepLink, {
        platform,
        clientId: selectedClient.id,
        subscriptionUrl,
      });

  function selectPlatform(nextPlatform: SubscriptionPlatform) {
    const nextClients = clientsForPlatform(nextPlatform);
    setPlatform(nextPlatform);
    setClientId(nextClients[0].id);
    setActionMessage(null);
    setSafeOpenVisible(false);
  }

  function selectDelivery(position: number) {
    setSelectedPosition(position);
    setQrOpen(compact);
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
      setActionMessage("订阅地址已复制。");
    } catch {
      inputRef.current?.focus();
      inputRef.current?.select();
      setActionMessage("自动复制失败，已选中地址，请手动复制。");
    }
  }

  if (activeItem === null) {
    return (
      <section className={pageClassName} aria-labelledby={`${instanceId}-empty-title`}>
        <section className="cc-si-panel cc-si-empty" role="status">
          <span>SUBSCRIPTION</span>
          <h2 id={`${instanceId}-empty-title`}>订阅信息待接入</h2>
          <p>只有授权接口返回已开通服务的真实交付数据后，才会在这里显示导入工具。</p>
        </section>
      </section>
    );
  }

  if (subscriptionUrl === null) {
    return (
      <section className={pageClassName} aria-labelledby={`${instanceId}-invalid-title`}>
        <section className="cc-si-panel cc-si-empty" role="alert">
          <span>SUBSCRIPTION</span>
          <h2 id={`${instanceId}-invalid-title`}>订阅地址暂不可用</h2>
          <p>交付数据未通过安全校验，本页不会复制、打开或生成二维码。</p>
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
              <h2 id={`${instanceId}-title`}>导入订阅</h2>
              <p>选择当前设备和已安装客户端，再使用真实交付地址导入。</p>
            </div>
            <small>线路 {activeItem.position}</small>
          </header>

          <aside className="cc-si-location-note" aria-label="Chrome 位置权限提醒">
            <strong>建议关闭或按次询问位置权限</strong>
            <ul>
              <li>桌面 Chrome：在地址栏手动输入 <code>chrome://settings/content/location</code>，检查并清理已允许查看位置的网站名单；建议关闭网站位置权限，或在每次询问时按需拒绝。</li>
              <li>Android：同时检查 Chrome 的网站位置权限与系统中的 Chrome 位置权限，建议设为每次询问或拒绝。</li>
              <li>iPhone / iPad：在系统设置的定位服务中检查 Chrome 位置权限，建议设为永不或下次询问，并按需拒绝。</li>
            </ul>
            <p>非必要时建议关闭；需要时改为每次询问。上面的桌面设置地址仅供复制或选中，本页不会尝试打开、修改或声称权限已变更。</p>
          </aside>

          {deliveryItems.length > 1 && (
            <label className="cc-si-field">
              <span>选择线路</span>
              <select
                value={activeItem.position}
                onChange={(event) => selectDelivery(Number(event.currentTarget.value))}
              >
                {deliveryItems.map((item) => (
                  <option key={item.position} value={item.position}>
                    线路 {item.position} · {item.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="cc-si-field">
            <span>当前订阅地址</span>
            <input
              ref={inputRef}
              type="url"
              value={subscriptionUrl}
              readOnly
              spellCheck={false}
              autoComplete="off"
              aria-label={`${activeItem.label}订阅地址`}
            />
          </label>

          <div className="cc-si-actions">
            <button type="button" className="cc-si-primary" onClick={() => void copySubscriptionUrl()}>
              复制地址
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
              安全打开
            </button>
            <button
              type="button"
              className="cc-si-secondary"
              aria-expanded={qrOpen}
              aria-controls={qrPanelId}
              onClick={() => setQrOpen((open) => !open)}
            >
              {qrOpen ? "收起二维码" : "显示二维码"}
            </button>
          </div>

          {actionMessage !== null && <p className="cc-si-status" role="status">{actionMessage}</p>}

          {safeOpenVisible && (
            <aside className="cc-si-browser-notice" aria-label="浏览器地址权限提醒">
              <strong>打开前请确认浏览器地址权限</strong>
              <p>订阅地址属于私密交付信息。请只在受信任设备中打开，不要截图、转发或粘贴到第三方网站。</p>
              <a
                href={subscriptionUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                referrerPolicy="no-referrer"
                onClick={() => setActionMessage("已请求浏览器在新标签页打开，请以浏览器实际结果为准。")}
              >
                确认并在新标签页打开
              </a>
            </aside>
          )}

        </section>

        <section className="cc-si-panel">
          <header className="cc-si-heading cc-si-heading-compact">
            <div>
              <span>CLIENT</span>
              <h2>选择客户端</h2>
              <p>未提供逐项确认的一键导入动作时，本页始终使用手动导入。</p>
            </div>
          </header>

          <div className="cc-si-platform-tabs" role="tablist" aria-label="设备系统">
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
              客户端清单仅按批准矩阵展示；一键导入和兼容性仍需逐项确认。
            </p>
            <div className="cc-si-client-grid" aria-label={`${platformLabel} 可选客户端`}>
              {clients.map((client) => (
                <button
                  key={client.id}
                  type="button"
                  aria-pressed={client.id === selectedClient.id}
                  className={client.id === selectedClient.id ? "is-active" : undefined}
                  onClick={() => {
                    setClientId(client.id);
                    setActionMessage(null);
                  }}
                >
                  <span>{client.name}</span>
                  {client.recommended && <small>推荐</small>}
                </button>
              ))}
            </div>

            {qrOpen && (
              <div id={qrPanelId} className="cc-si-qr" aria-label="本地订阅二维码">
                <LocalQrBoundary key={subscriptionUrl}>
                  <QRCodeSVG value={subscriptionUrl} size={184} level="M" marginSize={2} />
                </LocalQrBoundary>
                <p>二维码仅在当前浏览器本地生成，不调用第三方二维码服务。</p>
              </div>
            )}

            <div className="cc-si-manual">
              <h3>{selectedClient.name} · 手动导入</h3>
              <ol>
                <li>复制本页当前线路的订阅地址。</li>
                <li>打开 {selectedClient.name}，进入它的订阅或配置导入入口。</li>
                <li>粘贴地址并提交；是否导入成功以客户端实际显示为准。</li>
              </ol>
              {verifiedDeepLink === null ? (
                <button type="button" className="cc-si-secondary" onClick={() => void copySubscriptionUrl()}>
                  复制后手动导入
                </button>
              ) : (
                <a
                  className="cc-si-primary"
                  href={verifiedDeepLink}
                  onClick={() => setActionMessage(
                    `已请求浏览器打开 ${selectedClient.name}；若未唤起，请改用手动导入。`,
                  )}
                >
                  尝试打开 {selectedClient.name}
                </a>
              )}
            </div>
          </div>

          <details className="cc-si-help">
            <summary>导入不了？</summary>
            <ul>
              <li>重新复制当前线路地址，避免缺少字符或带入空格。</li>
              <li>浏览器没有唤起客户端时，直接使用上面的手动导入步骤。</li>
              <li>确认所选设备系统与当前客户端一致。</li>
            </ul>
            <p>仍无法导入时，只向现有支持渠道提供线路名称、设备系统和客户端名称；不要发送完整订阅地址。</p>
          </details>

        </section>
      </div>
    </section>
  );
}
