export const sectionKeys = [
  "status",
  "dashboard",
  "services",
  "network",
  "monitor",
  "orders",
  "subscribe",
  "docs",
  "profile",
  "referrals",
  "tickets",
  "invites",
] as const;

export type SectionKey = (typeof sectionKeys)[number];
