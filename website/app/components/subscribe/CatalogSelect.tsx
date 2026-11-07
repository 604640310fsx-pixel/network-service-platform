import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  adjacentTabStop,
  filterOptions,
  initialActiveId,
  moveActiveIndex,
  placePopover,
  typeaheadIndex,
  type CatalogSelectOption,
} from "./catalogSelectModel";

/* Page-local listbox for the subscribe page's country/region and carrier fields (Claude Design r33).
   It renders the options it is given and reports picks through onSelect; it owns no catalogue,
   availability or selection state. */

type CatalogSelectProps = {
  label: string;
  options: readonly CatalogSelectOption[];
  value: string | null;
  placeholder: string;
  onSelect: (id: string) => void;
  search?: { label: string; placeholder: string; noMatch: (query: string) => string };
};

const PHONE_QUERY = "(max-width: 600px)";
const GAP = 6;
const EDGE = 8;
// Original r33 flag-icons SVGs shipped for the subscription catalogue only.
const COUNTRY_FLAG_CODES = new Set(["br", "de", "fr", "gb", "id", "jp", "kr", "my", "sg", "th", "tw", "us", "vn"]);

function ChevronIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function CheckIcon() {
  return <svg width="16" height="16" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.3l2.2 2.2L9.5 3.7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

const TAB_STOPS = "a[href],area[href],button,input,select,textarea,iframe,summary,[contenteditable],[tabindex]";

/** The document tab stop right after (or before) this select, ignoring its own trigger and popover. */
function tabStopPast(root: HTMLElement, backward: boolean): HTMLElement | null {
  const stops = Array.from(document.querySelectorAll<HTMLElement>(TAB_STOPS)).filter((element) =>
    element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[inert],[hidden]") &&
    element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
  return stops[adjacentTabStop(stops.map((element) => root.contains(element)), backward)] ?? null;
}

function visibleObstacles(): { top: number; bottom: number } {
  const viewport = window.visualViewport?.height ?? window.innerHeight;
  const topbar = document.querySelector(".cc-topbar")?.getBoundingClientRect();
  const progressBottom = Math.max(0, ...Array.from(document.querySelectorAll<HTMLElement>(
    ".sub-configurator-v11 > .sub-steps, .sub-configurator-v11 > .sub-mobile-progress",
  ), element => element.getBoundingClientRect().bottom));
  const bar = document.querySelector<HTMLElement>(".sub-mobile-order-bar");
  const barRect = bar && getComputedStyle(bar).display !== "none" ? bar.getBoundingClientRect() : null;
  return {
    top: Math.max(0, topbar && topbar.bottom > 0 ? topbar.bottom : 0, progressBottom) + EDGE,
    bottom: Math.min(viewport, barRect && barRect.height > 0 ? barRect.top : viewport) - EDGE,
  };
}

export function CatalogSelect({ label, options, value, placeholder, onSelect, search }: CatalogSelectProps) {
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef(false);
  const typeahead = useRef({ text: "", at: 0 });
  // Pointer type of the press that opened the menu ("" for keyboard), read once when the menu opens.
  const openPointer = useRef("");
  const [open, setOpen] = useState(false);
  // Opened by touch/pen: focus the list, not the search box, so no soft keyboard appears until search is tapped.
  const [touchOpened, setTouchOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [placement, setPlacement] = useState<{ placement: "down" | "up"; maxHeight: number }>({ placement: "down", maxHeight: 300 });

  const searchable = Boolean(search);
  const selected = options.find((option) => option.id === value) ?? null;
  const visible = search ? filterOptions(options, query) : [...options];
  const listId = `${uid}-list`;
  const optionDomId = (id: string) => `${uid}-opt-${id}`;
  const activeDomId = open && activeId && visible.some((option) => option.id === activeId) ? optionDomId(activeId) : undefined;

  function openMenu() {
    setQuery("");
    setActiveId(initialActiveId(options, value));
    setTouchOpened(openPointer.current === "touch" || openPointer.current === "pen");
    openPointer.current = "";
    setOpen(true);
  }

  function close(withFocus: boolean) {
    returnFocus.current = withFocus;
    setOpen(false);
    setQuery("");
  }

  function choose(option: CatalogSelectOption) {
    if (option.disabled) return;
    close(true);
    // The native select only fired onChange for a different value; keep that contract.
    if (option.id !== value) onSelect(option.id);
  }

  // Measure and fit the popover; re-fit on scroll/resize while open.
  useLayoutEffect(() => {
    if (!open) return;
    const place = (allowScroll: boolean) => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const phone = window.matchMedia(PHONE_QUERY).matches;
      const row = phone ? 48 : 40;
      const chrome = (searchable ? (phone ? 42 : 36) + 6 : 0) + 14;
      const wanted = Math.min(Math.max(options.length, 1) * row, Math.round((phone ? 6.5 : 7.5) * row));
      let rect = trigger.getBoundingClientRect();
      let limits = visibleObstacles();
      const comfort = Math.round(3.5 * row);
      const roomBelow = limits.bottom - rect.bottom - GAP - chrome;
      const roomAbove = rect.top - limits.top - GAP - chrome;
      // Neither side can show a usable list (e.g. a short phone viewport): bring the trigger up first.
      if (allowScroll && Math.max(roomBelow, roomAbove) < Math.min(wanted, comfort)) {
        window.scrollBy({ top: rect.top - limits.top, behavior: "instant" as ScrollBehavior });
        rect = trigger.getBoundingClientRect();
        limits = visibleObstacles();
      }
      const next = placePopover({
        triggerTop: rect.top,
        triggerBottom: rect.bottom,
        topLimit: limits.top,
        bottomLimit: limits.bottom,
        gap: GAP,
        chromeHeight: chrome,
        wantedHeight: wanted,
        comfortHeight: comfort,
        minHeight: Math.round(1.5 * row),
      });
      setPlacement((current) =>
        current.placement === next.placement && current.maxHeight === next.maxHeight ? current : next);
    };
    place(true);
    const refit = () => place(false);
    window.addEventListener("resize", refit);
    window.addEventListener("scroll", refit, { passive: true, capture: true });
    return () => {
      window.removeEventListener("resize", refit);
      window.removeEventListener("scroll", refit, { capture: true });
    };
  }, [open, options.length, searchable]);

  // Move focus into the popover on open; return it to the trigger after a pick or Escape.
  useEffect(() => {
    if (open) {
      (searchable && !touchOpened ? inputRef.current : listRef.current)?.focus({ preventScroll: true });
    } else if (returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, [open, searchable, touchOpened]);

  // Keep the active option inside the scrolled list without scrolling the page.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list || !activeId) return;
    const item = document.getElementById(optionDomId(activeId));
    if (!item) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = Math.max(0, top - 4);
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeId, placement.maxHeight]);

  // Pointer down outside closes without moving focus.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    openPointer.current = "";
    // Enter / Space reach onClick natively; arrows also open, as in a native select.
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      openMenu();
    }
  }

  function onListKeyDown(event: KeyboardEvent<HTMLElement>) {
    const index = visible.findIndex((option) => option.id === activeId);
    const disabled = visible.map((option) => Boolean(option.disabled));
    const key = event.key;
    if (key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (key === "Tab") {
      // Like a native select: close and continue the page tab order from the field itself, so focus never
      // lands inside the closing popover (Chrome makes scrollable lists tabbable) or falls back to <body>.
      event.preventDefault();
      const target = rootRef.current ? tabStopPast(rootRef.current, event.shiftKey) : null;
      close(false);
      (target ?? triggerRef.current)?.focus();
      return;
    }
    // Space selects from the list itself (including a touch-opened list); in the search box it stays a typed space.
    if (key === "Enter" || (key === " " && event.currentTarget !== inputRef.current)) {
      event.preventDefault();
      const option = visible[index];
      if (option) choose(option);
      return;
    }
    const editingText = Boolean(search && query) && (key === "Home" || key === "End");
    const next = editingText ? null : moveActiveIndex(index, key, disabled);
    if (next !== null) {
      event.preventDefault();
      setActiveId(visible[next]?.id ?? null);
      return;
    }
    if (!search && key.length === 1 && /\S/.test(key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const now = Date.now();
      const text = now - typeahead.current.at < 700 && typeahead.current.text !== key ? typeahead.current.text + key : key;
      typeahead.current = { text, at: now };
      const hit = typeaheadIndex(visible.map((option) => option.label), disabled, text, index);
      if (hit >= 0) setActiveId(visible[hit]!.id);
    }
  }

  function onQueryChange(nextQuery: string) {
    setQuery(nextQuery);
    setActiveId(initialActiveId(filterOptions(options, nextQuery), value));
  }

  return (
    <div
      ref={rootRef}
      className={`sub-select${open ? " is-open" : ""}`}
      onBlur={(event) => {
        if (open && event.relatedTarget && !rootRef.current?.contains(event.relatedTarget as Node)) close(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="sub-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={`${uid}-label ${uid}-value`}
        onPointerDown={(event) => { openPointer.current = event.pointerType; }}
        onClick={() => (open ? close(true) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="sub-select-label" id={`${uid}-label`}>{label}</span>
        {selected?.flagClass && (COUNTRY_FLAG_CODES.has(selected.flagClass)
          ? <img className="sub-flag" src={`/subscription-flags/${selected.flagClass}.svg`} width={20} height={15} alt="" />
          : <i className="sub-flag is-globe" aria-hidden="true" />)}
        <span className={`sub-select-value${selected ? "" : " is-placeholder"}`} id={`${uid}-value`}>{selected?.label ?? placeholder}</span>
        <span className="sub-select-chevron"><ChevronIcon /></span>
      </button>
      {open && (
        <div className={`sub-select-pop is-${placement.placement}`}>
          {search && (
            <div className="sub-select-search">
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M10.6 10.6L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-label={search.label}
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={activeDomId}
                autoComplete="off"
                spellCheck={false}
                placeholder={search.placeholder}
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                onKeyDown={onListKeyDown}
              />
            </div>
          )}
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={label}
            // Never a sequential tab stop (scrollable lists otherwise become one); focus stays in the search box,
            // except after a touch open, where the list holds focus until the search box is tapped.
            tabIndex={-1}
            onFocus={search && !touchOpened ? () => inputRef.current?.focus({ preventScroll: true }) : undefined}
            aria-activedescendant={search && !touchOpened ? undefined : activeDomId}
            className="sub-select-list"
            style={{ maxHeight: placement.maxHeight }}
            onKeyDown={search && !touchOpened ? undefined : onListKeyDown}
          >
            {visible.map((option) => (
              <li
                key={option.id}
                id={optionDomId(option.id)}
                role="option"
                aria-selected={option.id === value}
                aria-disabled={option.disabled || undefined}
                className={`sub-select-option${option.flagClass ? "" : " is-plain"}${option.id === activeId ? " is-active" : ""}${option.id === value ? " is-selected" : ""}${option.disabled ? " is-disabled" : ""}`}
                // Keep focus on the search box / list while clicking an option.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
                onMouseMove={() => { if (!option.disabled && activeId !== option.id) setActiveId(option.id); }}
              >
                {option.flagClass && (COUNTRY_FLAG_CODES.has(option.flagClass)
                  ? <img className="sub-flag" src={`/subscription-flags/${option.flagClass}.svg`} width={20} height={15} alt="" />
                  : <i className="sub-flag is-globe" aria-hidden="true" />)}
                <span className="sub-select-name">{option.label}</span>
                {option.note && <span className="sub-select-note">{option.note}</span>}
                {option.id === value && <span className="sub-select-check"><CheckIcon /></span>}
              </li>
            ))}
            {visible.length === 0 && search && <li className="sub-select-empty" role="presentation">{search.noMatch(query.trim())}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
