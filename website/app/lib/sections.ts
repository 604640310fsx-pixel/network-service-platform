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
] as const;

export type SectionKey = (typeof sectionKeys)[number];
