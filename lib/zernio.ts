import { env } from "cloudflare:workers";
export function isConfigured() { return Boolean((env as unknown as Record<string,string>).ZERNIO_API_KEY); }
export class ProviderError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function zernio(path: string, init: RequestInit = {}, key?: string) {
  const token = (env as unknown as Record<string,string>).ZERNIO_API_KEY;
  if (!token) throw new ProviderError("Добавьте ZERNIO_API_KEY в серверные настройки, чтобы подключать соцсети и планировать публикации.", 503);
  const res = await fetch(`https://zernio.com/api/v1${path}`, { ...init, headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}), ...init.headers }, signal: AbortSignal.timeout(25000) });
  const data = await res.json() as Record<string, any>;
  if (!res.ok) throw new ProviderError(typeof data.error === "string" ? data.error : data.message || `Zernio: ошибка ${res.status}`, res.status);
  return data;
}
