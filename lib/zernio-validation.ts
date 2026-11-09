export async function validateZernioKey(token: string, request: typeof fetch = fetch) {
  let response: Response;
  try {
    response = await request('https://zernio.com/api/v1/profiles', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000), redirect: 'manual',
    });
  } catch {
    throw new Error('Не удалось связаться с Zernio. Попробуйте ещё раз.');
  }
  if (response.status === 401 || response.status === 403) throw new Error('Zernio не принял ключ. Проверьте ключ и его права доступа.');
  if (response.status === 429) throw new Error('Слишком много запросов к Zernio. Попробуйте немного позже.');
  if (!response.ok) throw new Error('Zernio временно недоступен. Ключ не изменён.');
  const data = await response.json().catch(() => null) as { profiles?: { _id?: unknown }[] } | null;
  if (!Array.isArray(data?.profiles) || data.profiles.some(profile => !profile || typeof profile._id !== 'string')) throw new Error('Неожиданный ответ Zernio. Ключ не изменён.');
  return data.profiles.map(profile => profile._id as string);
}
