import type { DatabaseConnection } from "../db.js";

export const CONTACT_TYPES = ["wechat", "telegram", "email", "other"] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export const BUSINESS_SCENARIOS = [
  "tiktok_content",
  "live_streaming",
  "social_media",
  "ai_development",
  "cross_border_ecommerce",
  "other",
  "unsure",
] as const;
export type BusinessScenario = (typeof BUSINESS_SCENARIOS)[number];

export const PROBLEM_TYPES = [
  "access_failure",
  "performance_instability",
  "dns_ipv4_ipv6_udp_issue",
  "platform_environment_issue",
  "live_content_account_environment",
  "existing_network_suitability",
  "new_network_plan",
  "other_or_unsure",
] as const;
export type ProblemType = (typeof PROBLEM_TYPES)[number];

export const CURRENT_NETWORK_TYPES = [
  "home_broadband",
  "enterprise_network",
  "vps_server",
  "proxy_network",
  "unknown",
  "other",
] as const;
export type CurrentNetworkType = (typeof CURRENT_NETWORK_TYPES)[number];

export const PROBLEM_FREQUENCIES = [
  "one_time",
  "intermittent",
  "frequent",
  "continuous",
  "unknown",
] as const;
export type ProblemFrequency = (typeof PROBLEM_FREQUENCIES)[number];

export const DIAGNOSIS_STATUSES = ["new", "handled"] as const;
export type DiagnosisStatus = (typeof DIAGNOSIS_STATUSES)[number];

export const DIAGNOSIS_CLASSIFICATIONS = [
  "continue_as_is",
  "local_optimization",
  "need_more_info",
  "formal_diagnosis",
  "network_plan",
  "out_of_scope",
] as const;
export type DiagnosisClassification = (typeof DIAGNOSIS_CLASSIFICATIONS)[number];

const SUBMISSION_KEYS = new Set([
  "contactType",
  "contactValue",
  "businessScenario",
  "targetRegion",
  "problemTypes",
  "problemDescription",
  "safetyAcknowledged",
  "currentRegion",
  "currentIsp",
  "currentNetworkType",
  "problemFrequency",
  "isExistingCustomer",
  "preferredContactWindow",
  "extraNotes",
]);
const CLASSIFICATION_KEYS = new Set(["classification", "adminNote"]);

const CONTACT_TYPE_SET = new Set<string>(CONTACT_TYPES);
const BUSINESS_SCENARIO_SET = new Set<string>(BUSINESS_SCENARIOS);
const PROBLEM_TYPE_SET = new Set<string>(PROBLEM_TYPES);
const CURRENT_NETWORK_TYPE_SET = new Set<string>(CURRENT_NETWORK_TYPES);
const PROBLEM_FREQUENCY_SET = new Set<string>(PROBLEM_FREQUENCIES);
const DIAGNOSIS_STATUS_SET = new Set<string>(DIAGNOSIS_STATUSES);
const DIAGNOSIS_CLASSIFICATION_SET = new Set<string>(
  DIAGNOSIS_CLASSIFICATIONS,
);

export interface DiagnosisSubmission {
  readonly contactType: ContactType;
  readonly contactValue: string;
  readonly businessScenario: BusinessScenario;
  readonly targetRegion: string;
  readonly problemTypes: readonly ProblemType[];
  readonly problemDescription: string;
  readonly currentRegion: string | null;
  readonly currentIsp: string | null;
  readonly currentNetworkType: CurrentNetworkType | null;
  readonly problemFrequency: ProblemFrequency | null;
  readonly isExistingCustomer: boolean | null;
  readonly preferredContactWindow: string | null;
  readonly extraNotes: string | null;
}

export interface DiagnosisClassificationInput {
  readonly classification: DiagnosisClassification;
  readonly adminNote: string | null;
}

export interface AdminDiagnosisItem extends DiagnosisSubmission {
  readonly id: number;
  readonly status: DiagnosisStatus;
  readonly classification: DiagnosisClassification | null;
  readonly adminNote: string | null;
  readonly createdAt: string;
  readonly handledAt: string | null;
}

export class DiagnosisDomainError extends Error {
  constructor(
    readonly statusCode: 404 | 409,
    readonly code: "not_found" | "invalid_transition",
  ) {
    super(code);
    this.name = "DiagnosisDomainError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function enumValue<Value extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
): Value | null {
  return typeof value === "string" && allowed.has(value) ? (value as Value) : null;
}

function stringLength(value: string): number {
  return Array.from(value).length;
}

function trimmedString(value: unknown, minimum: number, maximum: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  const length = stringLength(trimmed);
  return length >= minimum && length <= maximum ? trimmed : null;
}

function optionalTrimmedString(
  value: unknown,
  minimum: number,
  maximum: number,
): string | null | undefined {
  return value === undefined ? null : trimmedString(value, minimum, maximum) ?? undefined;
}

function optionalEnum<Value extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
): Value | null | undefined {
  return value === undefined ? null : enumValue<Value>(value, allowed) ?? undefined;
}

function storedOptionalEnum<Value extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
): Value | null {
  if (value === null) {
    return null;
  }
  const parsed = enumValue<Value>(value, allowed);
  if (parsed === null) {
    throw new Error("Diagnosis database invariant failed");
  }
  return parsed;
}

export function parseProblemTypes(value: string): readonly ProblemType[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Diagnosis database invariant failed");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) {
    throw new Error("Diagnosis database invariant failed");
  }
  const result: ProblemType[] = [];
  const unique = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== "string" || !PROBLEM_TYPE_SET.has(item) || unique.has(item)) {
      throw new Error("Diagnosis database invariant failed");
    }
    unique.add(item);
    result.push(item as ProblemType);
  }
  return result;
}

export function serializeProblemTypes(problemTypes: readonly ProblemType[]): string {
  const serialized = JSON.stringify(problemTypes);
  const parsed = parseProblemTypes(serialized);
  if (
    parsed.length !== problemTypes.length ||
    parsed.some((item, index) => item !== problemTypes[index])
  ) {
    throw new Error("Diagnosis problem types serialization failed");
  }
  return serialized;
}

function normalizeProblemTypes(value: unknown): readonly ProblemType[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    return null;
  }
  const unique = new Set<string>();
  const result: ProblemType[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !PROBLEM_TYPE_SET.has(item) || unique.has(item)) {
      return null;
    }
    unique.add(item);
    result.push(item as ProblemType);
  }
  return result;
}

export function normalizeDiagnosisSubmission(value: unknown): DiagnosisSubmission | null {
  if (!isRecord(value) || !hasOnlyKeys(value, SUBMISSION_KEYS)) {
    return null;
  }
  const contactType = enumValue<ContactType>(value.contactType, CONTACT_TYPE_SET);
  const contactValue = trimmedString(value.contactValue, 1, 200);
  const businessScenario = enumValue<BusinessScenario>(
    value.businessScenario,
    BUSINESS_SCENARIO_SET,
  );
  const targetRegion = trimmedString(value.targetRegion, 1, 80);
  const problemTypes = normalizeProblemTypes(value.problemTypes);
  const problemDescription = trimmedString(value.problemDescription, 10, 2000);
  const currentRegion = optionalTrimmedString(value.currentRegion, 1, 80);
  const currentIsp = optionalTrimmedString(value.currentIsp, 1, 120);
  const currentNetworkType = optionalEnum<CurrentNetworkType>(
    value.currentNetworkType,
    CURRENT_NETWORK_TYPE_SET,
  );
  const problemFrequency = optionalEnum<ProblemFrequency>(
    value.problemFrequency,
    PROBLEM_FREQUENCY_SET,
  );
  const preferredContactWindow = optionalTrimmedString(
    value.preferredContactWindow,
    1,
    80,
  );
  const extraNotes = optionalTrimmedString(value.extraNotes, 1, 1000);
  const isExistingCustomer =
    value.isExistingCustomer === undefined
      ? null
      : typeof value.isExistingCustomer === "boolean"
        ? value.isExistingCustomer
        : undefined;

  if (
    contactType === null ||
    contactValue === null ||
    businessScenario === null ||
    targetRegion === null ||
    problemTypes === null ||
    problemDescription === null ||
    value.safetyAcknowledged !== true ||
    currentRegion === undefined ||
    currentIsp === undefined ||
    currentNetworkType === undefined ||
    problemFrequency === undefined ||
    isExistingCustomer === undefined ||
    preferredContactWindow === undefined ||
    extraNotes === undefined
  ) {
    return null;
  }

  return {
    contactType,
    contactValue,
    businessScenario,
    targetRegion,
    problemTypes,
    problemDescription,
    currentRegion,
    currentIsp,
    currentNetworkType,
    problemFrequency,
    isExistingCustomer,
    preferredContactWindow,
    extraNotes,
  };
}

export function normalizeDiagnosisClassification(
  value: unknown,
): DiagnosisClassificationInput | null {
  if (!isRecord(value) || !hasOnlyKeys(value, CLASSIFICATION_KEYS)) {
    return null;
  }
  const classification = enumValue<DiagnosisClassification>(
    value.classification,
    DIAGNOSIS_CLASSIFICATION_SET,
  );
  const adminNote = optionalTrimmedString(value.adminNote, 1, 500);
  if (classification === null || adminNote === undefined) {
    return null;
  }
  return { classification, adminNote };
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Diagnosis time source is invalid");
  }
  return value.toISOString();
}

function requireCanonicalInstant(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Diagnosis database invariant failed");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Diagnosis database invariant failed");
  }
  return value;
}

export function createDiagnosisRequest(
  database: DatabaseConnection,
  submission: DiagnosisSubmission,
  now: () => Date = () => new Date(),
): void {
  const timestamp = canonicalNow(now);
  database
    .prepare(
      `INSERT INTO diagnosis_requests (
         contact_type, contact_value, business_scenario, target_region,
         problem_types, problem_description, safety_ack, current_region,
         current_isp, current_network_type, problem_frequency,
         is_existing_customer, preferred_contact_window, extra_notes,
         status, classification, admin_note, handled_by_admin_id, handled_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?,
                 'new', NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      submission.contactType,
      submission.contactValue,
      submission.businessScenario,
      submission.targetRegion,
      serializeProblemTypes(submission.problemTypes),
      submission.problemDescription,
      submission.currentRegion,
      submission.currentIsp,
      submission.currentNetworkType,
      submission.problemFrequency,
      submission.isExistingCustomer === null ? null : submission.isExistingCustomer ? 1 : 0,
      submission.preferredContactWindow,
      submission.extraNotes,
      timestamp,
      timestamp,
    );
}

interface DiagnosisRow {
  readonly id: unknown;
  readonly contact_type: unknown;
  readonly contact_value: unknown;
  readonly business_scenario: unknown;
  readonly target_region: unknown;
  readonly problem_types: unknown;
  readonly problem_description: unknown;
  readonly current_region: unknown;
  readonly current_isp: unknown;
  readonly current_network_type: unknown;
  readonly problem_frequency: unknown;
  readonly is_existing_customer: unknown;
  readonly extra_notes: unknown;
  readonly preferred_contact_window: unknown;
  readonly status: unknown;
  readonly classification: unknown;
  readonly admin_note: unknown;
  readonly created_at: unknown;
  readonly handled_at: unknown;
}

const ADMIN_LIST_COLUMNS = `
  id, contact_type, contact_value, business_scenario, target_region,
  problem_types, problem_description, current_region, current_isp,
  current_network_type, problem_frequency, is_existing_customer,
  preferred_contact_window, extra_notes, status, classification, admin_note,
  created_at, handled_at
`;

function optionalStoredString(value: unknown, maximum: number): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || stringLength(value) < 1 || stringLength(value) > maximum) {
    throw new Error("Diagnosis database invariant failed");
  }
  return value;
}

function parseDiagnosisRow(value: unknown): AdminDiagnosisItem {
  if (!isRecord(value)) {
    throw new Error("Diagnosis database invariant failed");
  }
  const row = value as unknown as DiagnosisRow;
  const contactType = enumValue<ContactType>(row.contact_type, CONTACT_TYPE_SET);
  const businessScenario = enumValue<BusinessScenario>(
    row.business_scenario,
    BUSINESS_SCENARIO_SET,
  );
  const currentNetworkType = storedOptionalEnum<CurrentNetworkType>(
    row.current_network_type,
    CURRENT_NETWORK_TYPE_SET,
  );
  const problemFrequency = storedOptionalEnum<ProblemFrequency>(
    row.problem_frequency,
    PROBLEM_FREQUENCY_SET,
  );
  const status = enumValue<DiagnosisStatus>(row.status, DIAGNOSIS_STATUS_SET);
  const classification = storedOptionalEnum<DiagnosisClassification>(
    row.classification,
    DIAGNOSIS_CLASSIFICATION_SET,
  );
  if (
    !Number.isSafeInteger(row.id) ||
    (row.id as number) < 1 ||
    contactType === null ||
    businessScenario === null ||
    status === null ||
    typeof row.contact_value !== "string" ||
    stringLength(row.contact_value) < 1 ||
    stringLength(row.contact_value) > 200 ||
    typeof row.target_region !== "string" ||
    stringLength(row.target_region) < 1 ||
    stringLength(row.target_region) > 80 ||
    typeof row.problem_types !== "string" ||
    typeof row.problem_description !== "string" ||
    stringLength(row.problem_description) < 10 ||
    stringLength(row.problem_description) > 2000 ||
    (row.is_existing_customer !== null &&
      row.is_existing_customer !== 0 &&
      row.is_existing_customer !== 1) ||
    (row.admin_note !== null &&
      (typeof row.admin_note !== "string" || stringLength(row.admin_note) > 500)) ||
    (status === "new" && (classification !== null || row.handled_at !== null)) ||
    (status === "handled" && (classification === null || row.handled_at === null))
  ) {
    throw new Error("Diagnosis database invariant failed");
  }

  return {
    id: row.id as number,
    contactType,
    contactValue: row.contact_value,
    businessScenario,
    targetRegion: row.target_region,
    problemTypes: parseProblemTypes(row.problem_types),
    problemDescription: row.problem_description,
    currentRegion: optionalStoredString(row.current_region, 80),
    currentIsp: optionalStoredString(row.current_isp, 120),
    currentNetworkType,
    problemFrequency,
    isExistingCustomer:
      row.is_existing_customer === null ? null : row.is_existing_customer === 1,
    preferredContactWindow: optionalStoredString(row.preferred_contact_window, 80),
    extraNotes: optionalStoredString(row.extra_notes, 1000),
    status,
    classification,
    adminNote: row.admin_note as string | null,
    createdAt: requireCanonicalInstant(row.created_at),
    handledAt:
      row.handled_at === null ? null : requireCanonicalInstant(row.handled_at),
  };
}

export function listDiagnosisRequests(
  database: DatabaseConnection,
  status: DiagnosisStatus,
): readonly AdminDiagnosisItem[] {
  const order =
    status === "new"
      ? "created_at ASC, id ASC"
      : "handled_at DESC, id DESC";
  return database
    .prepare(
      `SELECT ${ADMIN_LIST_COLUMNS}
       FROM diagnosis_requests
       WHERE status = ?
       ORDER BY ${order}
       LIMIT 100`,
    )
    .all(status)
    .map(parseDiagnosisRow);
}

export interface ClassifyDiagnosisRequestInput extends DiagnosisClassificationInput {
  readonly requestId: number;
  readonly adminUserId: number;
  readonly adminEmail: string;
  readonly now?: () => Date;
}

export function classifyDiagnosisRequest(
  database: DatabaseConnection,
  input: ClassifyDiagnosisRequestInput,
): void {
  const timestamp = canonicalNow(input.now ?? (() => new Date()));
  const operation = database.transaction(() => {
    const rows = database
      .prepare("SELECT status FROM diagnosis_requests WHERE id = ?")
      .all(input.requestId) as Array<{ readonly status: unknown }>;
    if (rows.length === 0) {
      throw new DiagnosisDomainError(404, "not_found");
    }
    if (rows.length !== 1 || rows[0]?.status !== "new") {
      throw new DiagnosisDomainError(409, "invalid_transition");
    }
    const updated = database
      .prepare(
        `UPDATE diagnosis_requests
         SET status = 'handled', classification = ?, admin_note = ?,
             handled_by_admin_id = ?, handled_at = ?, updated_at = ?
         WHERE id = ? AND status = 'new'`,
      )
      .run(
        input.classification,
        input.adminNote,
        input.adminUserId,
        timestamp,
        timestamp,
        input.requestId,
      );
    if (updated.changes !== 1) {
      throw new DiagnosisDomainError(409, "invalid_transition");
    }
    database
      .prepare(
        `INSERT INTO audit_log (actor, action, target_ref, created_at)
         VALUES (?, 'diagnosis.classify', ?, ?)`,
      )
      .run(
        input.adminEmail,
        `diagnosis_request:${input.requestId}`,
        timestamp,
      );
  });
  operation.immediate();
}
