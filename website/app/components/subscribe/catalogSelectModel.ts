/* Pure helpers for the subscribe page country/carrier listbox (CatalogSelect).
   Presentation only: option lists, availability and selection come from the real
   catalogue, the server availability index and the existing selection callbacks. */

import type { PlanAvailabilityIndex } from "../../lib/planAvailability";

export type CatalogSelectOption = {
  id: string;
  label: string;
  flagClass?: string;
  // Extra text the search box matches (other-language name, catalogue id).
  search?: string;
  // Informational tag only; it does not make the option unselectable.
  note?: string | null;
  disabled?: boolean;
};

/** Keyboard movement inside an open listbox. Clamps at both ends and skips disabled options. */
export function moveActiveIndex(
  current: number,
  key: string,
  disabled: readonly boolean[],
  pageSize = 5,
): number | null {
  const enabled: number[] = [];
  disabled.forEach((isDisabled, index) => { if (!isDisabled) enabled.push(index); });
  if (enabled.length === 0) return null;
  const first = enabled[0]!;
  const last = enabled[enabled.length - 1]!;
  const reversed = [...enabled].reverse();
  switch (key) {
    case "ArrowDown": return current < 0 ? first : (enabled.find((index) => index > current) ?? last);
    case "ArrowUp": return current < 0 ? last : (reversed.find((index) => index < current) ?? first);
    case "Home": return first;
    case "End": return last;
    case "PageDown": return reversed.find((index) => index <= Math.max(current, 0) + pageSize) ?? first;
    case "PageUp": return enabled.find((index) => index >= Math.max(current, 0) - pageSize) ?? last;
    default: return null;
  }
}

/** Type-to-jump: next enabled label starting with the typed prefix. A single letter cycles through matches. */
export function typeaheadIndex(
  labels: readonly string[],
  disabled: readonly boolean[],
  prefix: string,
  current: number,
): number {
  const needle = prefix.toLowerCase();
  if (!needle || labels.length === 0) return -1;
  const start = needle.length === 1 ? current + 1 : Math.max(current, 0);
  for (let step = 0; step < labels.length; step += 1) {
    const index = (((start + step) % labels.length) + labels.length) % labels.length;
    if (!disabled[index] && labels[index]!.toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

/** Options whose label or search text contains the query (case-insensitive, trimmed). */
export function filterOptions<T extends CatalogSelectOption>(options: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter((option) => `${option.label} ${option.search ?? ""}`.toLowerCase().includes(needle));
}

/** Tab / Shift+Tab out of an open select: given the document's tab stops in order, flagged when they belong
    to the select (trigger and popover), return the first stop after it, or the last stop before it.
    -1 when there is none. Mirrors a native select, whose popup is not part of the tab order. */
export function adjacentTabStop(insideSelect: readonly boolean[], backward: boolean): number {
  const first = insideSelect.indexOf(true);
  const last = insideSelect.lastIndexOf(true);
  if (first < 0) return -1;
  if (backward) {
    for (let index = first - 1; index >= 0; index -= 1) if (!insideSelect[index]) return index;
    return -1;
  }
  for (let index = last + 1; index < insideSelect.length; index += 1) if (!insideSelect[index]) return index;
  return -1;
}

/** Active option on open or after filtering: the selected one when visible and enabled, else the first enabled. */
export function initialActiveId(options: readonly CatalogSelectOption[], selectedId: string | null): string | null {
  const selected = options.find((option) => option.id === selectedId && !option.disabled);
  return (selected ?? options.find((option) => !option.disabled))?.id ?? null;
}

export type PopoverPlacement = { placement: "down" | "up"; maxHeight: number };

/** Fit the scrolling list between the trigger and the visible obstacles (sticky top bar, mobile order bar,
    viewport). Opens downward unless below cannot show a comfortable amount and above has more room. */
export function placePopover(input: {
  triggerTop: number;
  triggerBottom: number;
  topLimit: number;
  bottomLimit: number;
  gap: number;
  chromeHeight: number;
  wantedHeight: number;
  comfortHeight: number;
  minHeight: number;
}): PopoverPlacement {
  const below = input.bottomLimit - input.triggerBottom - input.gap - input.chromeHeight;
  const above = input.triggerTop - input.topLimit - input.gap - input.chromeHeight;
  const upward = below < Math.min(input.wantedHeight, input.comfortHeight) && above > below;
  const room = upward ? above : below;
  return {
    placement: upward ? "up" : "down",
    maxHeight: Math.round(Math.max(input.minHeight, Math.min(input.wantedHeight, room))),
  };
}

/** Whether the loaded server availability index has any purchasable plan for this type/region(/carrier).
    A null index (loading or failed) returns null: unknown, so no tag is shown. */
export function hasPurchasablePlan(
  index: PlanAvailabilityIndex | null,
  typeId: string | null,
  regionId: string,
  ispId?: string,
): boolean | null {
  if (index === null || typeId === null) return null;
  return Object.values(index).some((item) =>
    item.isActive && !item.soldOut && item.typeId === typeId && item.regionId === regionId &&
    (ispId === undefined || item.ispId === ispId));
}
