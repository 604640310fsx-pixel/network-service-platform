export function buyerStatusHref(): "/status" {
  return "/status";
}

/* The plain entry stays target-free: Auth selects the first owned bound target
   server-side after validating the web session. */
export function resolveBuyerStatusHref(): "/status" {
  return "/status";
}

export type BuyerLineRef =
  | { readonly kind: "service"; readonly ref: string; readonly position: number }
  | { readonly kind: "grant"; readonly ref: number; readonly position: number };

export function lineSelector(line: BuyerLineRef): string {
  return `${line.kind}:${line.ref}:${line.position}`;
}

/* A delivered line's own status page (NSP-LINE-STATUS-08). The selector names only the
   buyer's line, never a monitor target; Auth checks ownership and resolves the bound server. */
export function buyerLineStatusHref(line: BuyerLineRef): string {
  return `/status?line=${encodeURIComponent(lineSelector(line))}`;
}

const LINE_SELECTOR = /^(?:service:DL[A-Za-z0-9]{8,64}|grant:[1-9][0-9]{0,8}):[1-9][0-9]{0,8}$/;

/** The `line` query value when it is a well-formed selector; null when absent; "invalid" otherwise. */
export function readStatusLineParam(search: string): string | "invalid" | null {
  const value = new URLSearchParams(search).get("line");
  if (value === null) return null;
  return LINE_SELECTOR.test(value) ? value : "invalid";
}
