export const sectionKeys = [
  "status",
  "dashboard",
  "services",
  "network",
  "monitor",
  "orders",
  "subscribe",
] as const;

export type SectionKey = (typeof sectionKeys)[number];
