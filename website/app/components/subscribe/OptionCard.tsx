import type { ReactNode } from "react";

type OptionCardProps = {
  selected: boolean;
  onSelect: () => void;
  label: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  tabIndex?: 0 | -1;
};

export function getNextEnabledRadioIndex(
  currentIndex: number,
  key: string,
  disabled: readonly boolean[],
): number | null {
  if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(key)) {
    return null;
  }
  const enabled = disabled.flatMap((isDisabled, index) => (isDisabled ? [] : [index]));
  if (enabled.length === 0) return null;
  if (key === "Home") return enabled[0]!;
  if (key === "End") return enabled[enabled.length - 1]!;

  const currentEnabledIndex = enabled.indexOf(currentIndex);
  const direction = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
  if (currentEnabledIndex < 0) return direction > 0 ? enabled[0]! : enabled[enabled.length - 1]!;
  return enabled[(currentEnabledIndex + direction + enabled.length) % enabled.length]!;
}

export function getRovingRadioTabIndex(
  selectedIndex: number,
  optionIndex: number,
  disabled: readonly boolean[],
): 0 | -1 {
  if (disabled[optionIndex]) return -1;
  const selectedIsEnabled = selectedIndex >= 0 && disabled[selectedIndex] === false;
  const tabStop = selectedIsEnabled ? selectedIndex : disabled.findIndex((isDisabled) => !isDisabled);
  return optionIndex === tabStop ? 0 : -1;
}

export function OptionCard({
  selected,
  onSelect,
  label,
  children,
  className = "",
  disabled = false,
  tabIndex = selected && !disabled ? 0 : -1,
}: OptionCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      disabled={disabled}
      tabIndex={tabIndex}
      className={`sub-option ${selected ? "is-selected" : ""} ${className}`.trim()}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}
