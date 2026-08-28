export type ContactType = "wechat" | "telegram" | "email" | "other";

export type BusinessScenario =
  | "tiktok_content"
  | "live_streaming"
  | "social_media"
  | "ai_development"
  | "cross_border_ecommerce"
  | "other"
  | "unsure";

export type ProblemType =
  | "access_failure"
  | "performance_instability"
  | "dns_ipv4_ipv6_udp_issue"
  | "platform_environment_issue"
  | "live_content_account_environment"
  | "existing_network_suitability"
  | "new_network_plan"
  | "other_or_unsure";

export type CurrentNetworkType =
  | "home_broadband"
  | "enterprise_network"
  | "vps_server"
  | "proxy_network"
  | "unknown"
  | "other";

export type ProblemFrequency =
  | "one_time"
  | "intermittent"
  | "frequent"
  | "continuous"
  | "unknown";

export type DiagnosisStatus = "new" | "handled";

export type DiagnosisClassification =
  | "continue_as_is"
  | "local_optimization"
  | "need_more_info"
  | "formal_diagnosis"
  | "network_plan"
  | "out_of_scope";

export type DiagnosisSubmission = {
  readonly contactType: ContactType;
  readonly contactValue: string;
  readonly businessScenario: BusinessScenario;
  readonly targetRegion: string;
  readonly problemTypes: readonly ProblemType[];
  readonly problemDescription: string;
  readonly safetyAcknowledged: true;
  readonly currentRegion?: string;
  readonly currentIsp?: string;
  readonly currentNetworkType?: CurrentNetworkType;
  readonly problemFrequency?: ProblemFrequency;
  readonly isExistingCustomer?: boolean;
  readonly preferredContactWindow?: string;
  readonly extraNotes?: string;
};

export type AdminDiagnosisItem = Omit<
  DiagnosisSubmission,
  | "safetyAcknowledged"
  | "currentRegion"
  | "currentIsp"
  | "currentNetworkType"
  | "problemFrequency"
  | "isExistingCustomer"
  | "preferredContactWindow"
  | "extraNotes"
> & {
  readonly id: number;
  readonly currentRegion: string | null;
  readonly currentIsp: string | null;
  readonly currentNetworkType: CurrentNetworkType | null;
  readonly problemFrequency: ProblemFrequency | null;
  readonly isExistingCustomer: boolean | null;
  readonly preferredContactWindow: string | null;
  readonly extraNotes: string | null;
  readonly status: DiagnosisStatus;
  readonly classification: DiagnosisClassification | null;
  readonly adminNote: string | null;
  readonly createdAt: string;
  readonly handledAt: string | null;
};

const CONTACT_TYPES: readonly ContactType[] = ["wechat", "telegram", "email", "other"];
const BUSINESS_SCENARIOS: readonly BusinessScenario[] = [
  "tiktok_content",
  "live_streaming",
  "social_media",
  "ai_development",
  "cross_border_ecommerce",
  "other",
  "unsure",
];
const PROBLEM_TYPES: readonly ProblemType[] = [
  "access_failure",
  "performance_instability",
  "dns_ipv4_ipv6_udp_issue",
  "platform_environment_issue",
  "live_content_account_environment",
  "existing_network_suitability",
  "new_network_plan",
  "other_or_unsure",
];
const CURRENT_NETWORK_TYPES: readonly CurrentNetworkType[] = [
  "home_broadband",
  "enterprise_network",
  "vps_server",
  "proxy_network",
  "unknown",
  "other",
];
const PROBLEM_FREQUENCIES: readonly ProblemFrequency[] = [
  "one_time",
  "intermittent",
  "frequent",
  "continuous",
  "unknown",
];
const DIAGNOSIS_STATUSES: readonly DiagnosisStatus[] = ["new", "handled"];
const DIAGNOSIS_CLASSIFICATIONS: readonly DiagnosisClassification[] = [
  "continue_as_is",
  "local_optimization",
  "need_more_info",
  "formal_diagnosis",
  "network_plan",
  "out_of_scope",
];

type JsonRecord = Record<string, unknown>;

export class DiagnosisApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
  ) {
    super(code);
    this.name = "DiagnosisApiError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== "string") {
    return null;
  }
  return value.error.code;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new DiagnosisApiError("invalid_response", response.status);
  }
}

async function requestJson(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "same-origin", signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new DiagnosisApiError("network_error");
  }

  const body = await readJson(response);
  if (!response.ok) {
    throw new DiagnosisApiError(errorCode(body) ?? "request_failed", response.status);
  }
  return body;
}

function isOneOf<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): value is Value {
  return typeof value === "string" && allowed.some((item) => item === value);
}

function isStringWithin(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    Array.from(value).length >= minimum &&
    Array.from(value).length <= maximum
  );
}

function isNullableStringWithin(value: unknown, maximum: number): value is string | null {
  return value === null || isStringWithin(value, 1, maximum);
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function parseAdminDiagnosisItem(raw: unknown): AdminDiagnosisItem {
  if (!isRecord(raw)) {
    throw new DiagnosisApiError("invalid_response");
  }

  const problemTypes = raw.problemTypes;
  const uniqueProblems = Array.isArray(problemTypes)
    ? new Set(problemTypes.filter((item): item is string => typeof item === "string"))
    : null;
  const handledAtValid = raw.handledAt === null || isCanonicalInstant(raw.handledAt);

  if (
    typeof raw.id !== "number" ||
    !Number.isSafeInteger(raw.id) ||
    raw.id < 1 ||
    !isOneOf(raw.contactType, CONTACT_TYPES) ||
    !isStringWithin(raw.contactValue, 1, 200) ||
    !isOneOf(raw.businessScenario, BUSINESS_SCENARIOS) ||
    !isStringWithin(raw.targetRegion, 1, 80) ||
    !Array.isArray(problemTypes) ||
    problemTypes.length < 1 ||
    problemTypes.length > 8 ||
    uniqueProblems?.size !== problemTypes.length ||
    !problemTypes.every((item) => isOneOf(item, PROBLEM_TYPES)) ||
    !isStringWithin(raw.problemDescription, 10, 2000) ||
    !isNullableStringWithin(raw.currentRegion, 80) ||
    !isNullableStringWithin(raw.currentIsp, 120) ||
    !(raw.currentNetworkType === null || isOneOf(raw.currentNetworkType, CURRENT_NETWORK_TYPES)) ||
    !(raw.problemFrequency === null || isOneOf(raw.problemFrequency, PROBLEM_FREQUENCIES)) ||
    !(raw.isExistingCustomer === null || typeof raw.isExistingCustomer === "boolean") ||
    !isNullableStringWithin(raw.preferredContactWindow, 80) ||
    !isNullableStringWithin(raw.extraNotes, 1000) ||
    !isOneOf(raw.status, DIAGNOSIS_STATUSES) ||
    !(raw.classification === null || isOneOf(raw.classification, DIAGNOSIS_CLASSIFICATIONS)) ||
    !(raw.adminNote === null || (typeof raw.adminNote === "string" && Array.from(raw.adminNote).length <= 500)) ||
    !isCanonicalInstant(raw.createdAt) ||
    !handledAtValid ||
    (raw.status === "new" && (raw.classification !== null || raw.handledAt !== null)) ||
    (raw.status === "handled" && (raw.classification === null || raw.handledAt === null))
  ) {
    throw new DiagnosisApiError("invalid_response");
  }

  return {
    id: raw.id,
    contactType: raw.contactType,
    contactValue: raw.contactValue,
    businessScenario: raw.businessScenario,
    targetRegion: raw.targetRegion,
    problemTypes,
    problemDescription: raw.problemDescription,
    currentRegion: raw.currentRegion,
    currentIsp: raw.currentIsp,
    currentNetworkType: raw.currentNetworkType,
    problemFrequency: raw.problemFrequency,
    isExistingCustomer: raw.isExistingCustomer,
    preferredContactWindow: raw.preferredContactWindow,
    extraNotes: raw.extraNotes,
    status: raw.status,
    classification: raw.classification,
    adminNote: raw.adminNote,
    createdAt: raw.createdAt,
    handledAt: raw.handledAt as string | null,
  };
}

export async function submitDiagnosisRequest(
  submission: DiagnosisSubmission,
): Promise<void> {
  const body = await requestJson("/api/diagnosis/requests", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify(submission),
  });
  if (!isRecord(body) || body.status !== "ok" || Object.keys(body).length !== 1) {
    throw new DiagnosisApiError("invalid_response");
  }
}

export async function getAdminDiagnosisRequests(
  status: DiagnosisStatus,
  signal?: AbortSignal,
): Promise<AdminDiagnosisItem[]> {
  const body = await requestJson(
    `/api/admin/diagnosis/requests?status=${status}`,
    { method: "GET", headers: { Accept: "application/json" } },
    signal,
  );
  if (!isRecord(body) || !Array.isArray(body.items) || Object.keys(body).length !== 1) {
    throw new DiagnosisApiError("invalid_response");
  }
  return body.items.map(parseAdminDiagnosisItem);
}

export async function classifyAdminDiagnosisRequest(
  requestId: number,
  csrfToken: string,
  classification: DiagnosisClassification,
  adminNote: string | null,
): Promise<void> {
  const requestBody = adminNote === null ? { classification } : { classification, adminNote };
  const body = await requestJson(`/api/admin/diagnosis/requests/${requestId}`, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(requestBody),
  });
  if (!isRecord(body) || body.status !== "ok" || Object.keys(body).length !== 1) {
    throw new DiagnosisApiError("invalid_response");
  }
}
