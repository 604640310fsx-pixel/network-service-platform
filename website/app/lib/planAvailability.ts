import { useEffect, useState } from "react";

/* 服务端为每个 (typeId, regionId, ispId, specId, durationId) 五元组维护的可售状态与实时价格；
   前端一律以此为准，不信任 subscribeCatalog 的静态价格作为下单依据。 */
export type PlanAvailabilityItem = {
  readonly typeId: string;
  readonly regionId: string;
  readonly ispId: string;
  readonly specId: string | null;
  readonly durationId: string;
  readonly priceFen: number;
  readonly isActive: boolean;
  readonly soldOut: boolean;
};

export type PlanAvailabilityIndex = Readonly<Record<string, PlanAvailabilityItem>>;

export class PlanAvailabilityError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "PlanAvailabilityError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/* 五元组定位键：非规格网络类型的 specId 恒为 null，与 auth-service 的
   spec_id IS NULL 语义对齐——用空字符串占位，不与任何真实 specId 冲突。 */
export function planAvailabilityKey(
  typeId: string,
  regionId: string,
  ispId: string,
  specId: string | null,
  durationId: string,
): string {
  return `${typeId}|${regionId}|${ispId}|${specId ?? ""}|${durationId}`;
}

function parseItem(raw: unknown): PlanAvailabilityItem {
  if (!isRecord(raw)) throw new PlanAvailabilityError("invalid_response");
  const { typeId, regionId, ispId, specId, durationId, priceFen, isActive, soldOut } = raw;
  if (
    !isNonEmptyString(typeId) ||
    !isNonEmptyString(regionId) ||
    !isNonEmptyString(ispId) ||
    !(specId === null || typeof specId === "string") ||
    !isNonEmptyString(durationId) ||
    typeof priceFen !== "number" ||
    !Number.isSafeInteger(priceFen) ||
    priceFen <= 0 ||
    typeof isActive !== "boolean" ||
    typeof soldOut !== "boolean"
  ) {
    throw new PlanAvailabilityError("invalid_response");
  }
  return {
    typeId,
    regionId,
    ispId,
    specId: specId as string | null,
    durationId,
    priceFen,
    isActive,
    soldOut,
  };
}

export async function fetchPlanAvailability(signal?: AbortSignal): Promise<PlanAvailabilityItem[]> {
  let response: Response;
  try {
    response = await fetch("/api/catalog/plans", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new PlanAvailabilityError("network_error");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PlanAvailabilityError("invalid_response");
  }
  if (!response.ok) throw new PlanAvailabilityError("request_failed");
  if (!isRecord(body) || !Array.isArray(body.items)) throw new PlanAvailabilityError("invalid_response");
  return body.items.map(parseItem);
}

export function buildPlanAvailabilityIndex(items: readonly PlanAvailabilityItem[]): PlanAvailabilityIndex {
  const index: Record<string, PlanAvailabilityItem> = {};
  for (const item of items) {
    index[planAvailabilityKey(item.typeId, item.regionId, item.ispId, item.specId, item.durationId)] = item;
  }
  return index;
}

export type PlanAvailabilityState = {
  readonly loading: boolean;
  readonly error: boolean;
  readonly index: PlanAvailabilityIndex | null;
};

/* 每个调用点各自拉取一次、各自持有 state——不使用模块级全局快照，保证 loading/error
   在每个页面都是可观察的 React 状态，而不是一个跨页面共享、不可感知刷新的缓存对象。 */
export function usePlanAvailability(): PlanAvailabilityState {
  const [state, setState] = useState<PlanAvailabilityState>({ loading: true, error: false, index: null });

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState({ loading: true, error: false, index: null });
    fetchPlanAvailability(controller.signal)
      .then((items) => {
        if (!active) return;
        setState({ loading: false, error: false, index: buildPlanAvailabilityIndex(items) });
      })
      .catch((error) => {
        if (!active) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ loading: false, error: true, index: null });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  return state;
}
