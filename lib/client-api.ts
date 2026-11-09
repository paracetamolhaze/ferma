export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, init); }
  catch (error) {
    if (init?.signal?.aborted) throw error;
    throw new Error('Нет связи с сервером. Проверьте подключение и повторите попытку.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? data.error : null;
    throw new Error(typeof message === 'string' ? message : response.status === 401
      ? 'Сессия завершилась. Обновите страницу и войдите снова.'
      : 'Сервер временно недоступен. Повторите попытку.');
  }
  if (!data || typeof data !== 'object') throw new Error('Не удалось прочитать ответ сервера. Обновите страницу.');
  return data as T;
}
