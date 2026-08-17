export const sectionKeys = [
  "dashboard",
  "services",
  "reports",
  "monitor",
  "orders",
  "tickets",
  "docs",
  "status",
  "profile",
  "security",
] as const;

export type SectionKey = (typeof sectionKeys)[number];
