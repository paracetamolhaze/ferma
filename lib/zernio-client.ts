export class ProviderError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
// Each client captures exactly one profile's key for the entire operation.
export function zernioClient(token: string, request: typeof fetch = fetch) {
  if (!token) throw new ProviderError('Добавьте API-ключ Zernio в этом профиле.', 503);
  return async (path: string, init: RequestInit = {}, key?: string) => {
    let res: Response;
    try { res = await request(`https://zernio.com/api/v1${path}`, {
      ...init, headers: { ...init.headers, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      signal: AbortSignal.timeout(25000), redirect: 'manual',
    }); } catch { throw new ProviderError('Не удалось связаться с Zernio. Повторите попытку.', 503); }
    const raw = await res.json().catch(() => null);
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!res.ok) {
      const fallback = res.status === 401 || res.status === 403 ? 'Zernio не принял ключ. Проверьте его в настройках профиля.'
        : res.status === 429 ? 'Слишком много запросов к Zernio. Повторите немного позже.' : `Zernio временно недоступен (ошибка ${res.status}).`;
      const message = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : fallback;
      throw new ProviderError(message.replaceAll(token, '[ключ скрыт]'), res.status);
    }
    if (!data || typeof data !== 'object') throw new ProviderError('Zernio вернул некорректный ответ. Повторите попытку.', 503);
    return data;
  };
}
