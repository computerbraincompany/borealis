const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/**
 * Body-free readiness probe shared by health, status, and Settings surfaces.
 * It performs one GET against the given URL, cancels the body immediately, and
 * reduces the outcome to a boolean. Provider responses are never read, so no
 * endpoint content can reach logs or clients.
 */
export async function probeEndpointOk(
  url: string,
  options: { apiKey?: string; timeoutMs?: number } = {}
): Promise<boolean> {
  const headers: Record<string, string> = { Accept: "application/json", "Cache-Control": "no-store" };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}
