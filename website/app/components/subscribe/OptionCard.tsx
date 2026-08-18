import type { ReactNode } from "react";

type OptionCardProps = {
  selected: boolean;
  onSelect: () => void;
  label: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
};

export function OptionCard({ selected, onSelect, label, children, className = "", disabled = false }: OptionCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      disabled={disabled}
      className={`sub-option ${selected ? "is-selected" : ""} ${className}`.trim()}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}
