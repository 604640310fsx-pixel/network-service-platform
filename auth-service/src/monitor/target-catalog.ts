export const MONITOR_TARGET_KEY_MAX_LENGTH = 128;
export const MONITOR_TARGET_LABEL_MAX_LENGTH = 200;
export const MONITOR_TARGET_STATES = ["active", "disabled", "retired"] as const;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export type MonitorTargetState = (typeof MONITOR_TARGET_STATES)[number];

export interface MonitorTargetOption {
  readonly key: string;
  readonly label: string;
  readonly state: MonitorTargetState;
}

export interface MonitorTargetCatalog {
  list(signal?: AbortSignal): Promise<readonly MonitorTargetOption[]>;
}

function normalizedBoundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.trim() !== value) return null;
  if (
    value.length < 1 ||
    value.length > maxLength ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

export function normalizeMonitorTargetKey(value: unknown): string | null {
  return normalizedBoundedText(value, MONITOR_TARGET_KEY_MAX_LENGTH);
}

export function normalizeMonitorTargetLabel(value: unknown): string | null {
  return normalizedBoundedText(value, MONITOR_TARGET_LABEL_MAX_LENGTH);
}

export function normalizeMonitorTargetState(value: unknown): MonitorTargetState | null {
  return typeof value === "string" &&
    MONITOR_TARGET_STATES.includes(value as MonitorTargetState)
    ? (value as MonitorTargetState)
    : null;
}
