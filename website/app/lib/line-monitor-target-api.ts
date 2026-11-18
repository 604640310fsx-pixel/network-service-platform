/* 买家线路 → 公开监控页预选服务器名（GET /api/me/monitor-target?line=…）。
   只返回 Auth 按所有权解析出的公开服务器名；任何失败都返回 null，监控页按默认服务器打开。 */
export async function getLineMonitorTarget(line: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(`/api/me/monitor-target?line=${encodeURIComponent(line)}`, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "manual",
      signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    return Object.keys(record).length === 1 && typeof record.target === "string" ? record.target : null;
  } catch {
    return null;
  }
}
