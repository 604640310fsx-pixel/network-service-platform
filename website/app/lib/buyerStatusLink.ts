export function buyerStatusHref(): "/status" {
  return "/status";
}

/* Every customer entry is intentionally target-free. Auth selects the first
   owned bound target server-side after validating the web session. */
export function resolveBuyerStatusHref(): "/status" {
  return "/status";
}
