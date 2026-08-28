export const sectionKeys = [
  "dashboard",
  "services",
  "monitor",
  "orders",
  "subscribe",
] as const;

export type SectionKey = (typeof sectionKeys)[number];
