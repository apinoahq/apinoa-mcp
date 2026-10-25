/**
 * The few HTTP calls the tools make. Plain fetch, not the SDK: the server describes its tools from the
 * live catalog, so it reaches every operation by its URL, including ones published after this package.
 */

export interface ApiOptions {
  apiKey?: string;
  baseUrl: string;
  fetch: typeof fetch;
  /** Per-call timeout. Image translation under load can take minutes. */
  timeoutMs: number;
}

export interface CatalogEntry {
  id: string;
  kind: "marketplace" | "sns";
  operations: string[];
  regions?: string[];
  cost?: Record<string, { base: number; max: number }>;
  params: Record<string, { properties?: Record<string, { description?: string; type?: string; enum?: string[] }>; required?: string[] }>;
}

/** A refusal from the API, with its stable code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(`${code}: ${message}`);
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Flatten params into a query string the way the API reads it: lists comma-joined, nothing nested. */
export function toQuery(params: Record<string, unknown>): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return q;
}

const hasObject = (params: Record<string, unknown>) => Object.values(params).some((v) => v !== null && typeof v === "object" && !Array.isArray(v));

async function send(o: ApiOptions, path: string, init: RequestInit, attempts = 3): Promise<Response> {
  for (let i = 0; ; i++) {
    const res = await o.fetch(o.baseUrl + path, {
      ...init,
      headers: { ...(o.apiKey ? { "x-api-key": o.apiKey } : {}), "user-agent": "apinoa-mcp", ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    if (!RETRYABLE.has(res.status) || i >= attempts - 1) return res;
    const header = res.headers.get("retry-after");
    const wait = header === null ? NaN : Number(header);
    await new Promise((r) => setTimeout(r, Math.min(30_000, (Number.isFinite(wait) && wait >= 0 ? wait : 2 ** i) * 1000)));
  }
}

async function unwrap(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(res.status, `HTTP_${res.status}`, text.slice(0, 300) || res.statusText);
  }
  if (!res.ok || body?.success === false) {
    throw new ApiError(res.status, body?.error?.code ?? `HTTP_${res.status}`, body?.error?.message ?? res.statusText, body?.requestId);
  }
  return body.data;
}

/** One operation: GET with a query string, or POST with a JSON body when an input is an object (an image). */
export async function callOperation(o: ApiOptions, platform: string, operation: string, params: Record<string, unknown>): Promise<unknown> {
  const path = `/v1/${encodeURIComponent(platform)}/${encodeURIComponent(operation)}`;
  if (hasObject(params)) {
    return unwrap(await send(o, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) }));
  }
  const q = toQuery(params).toString();
  return unwrap(await send(o, q ? `${path}?${q}` : path, { method: "GET" }));
}

export async function fetchCatalog(o: ApiOptions): Promise<CatalogEntry[]> {
  const data = (await unwrap(await send({ ...o, timeoutMs: Math.min(o.timeoutMs, 10_000) }, "/v1/marketplaces", { method: "GET" }, 1))) as {
    marketplaces: CatalogEntry[];
  };
  return data.marketplaces;
}

/** Image translation: raw bytes in, a JPEG (or, with render=false, JSON) out. */
export async function translateImage(
  o: ApiOptions,
  image: Uint8Array,
  contentType: string,
  query: Record<string, string | boolean | undefined>,
): Promise<{ contentType: string; bytes: Uint8Array; regions?: number }> {
  const q = toQuery(query as Record<string, unknown>).toString();
  const res = await send(o, `/v1/image-translate/translate?${q}`, { method: "POST", headers: { "content-type": contentType }, body: image as BodyInit });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || type.includes("json")) {
    const data = await unwrap(res);
    return { contentType: "application/json", bytes: new TextEncoder().encode(JSON.stringify(data)) };
  }
  const regions = Number(res.headers.get("x-apinoa-regions-count"));
  return { contentType: type || "image/jpeg", bytes: new Uint8Array(await res.arrayBuffer()), ...(Number.isFinite(regions) ? { regions } : {}) };
}

/** Download an image a tool was pointed at. */
export async function download(o: ApiOptions, url: string, maxBytes = 20 * 1024 * 1024): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!/^https?:\/\//i.test(url)) throw new ApiError(400, "INVALID_IMAGE_URL", "image_url must be an http(s) URL");
  const res = await o.fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new ApiError(400, "IMAGE_DOWNLOAD_FAILED", `the image URL answered ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new ApiError(413, "IMAGE_TOO_LARGE", `the image is over ${maxBytes / 1024 / 1024} MB`);
  return { bytes, contentType: (res.headers.get("content-type") ?? "image/jpeg").split(";")[0]!.trim() };
}
