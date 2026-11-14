/**
 * Threads through the owner's own Meta app (Threads API, graph.threads.com).
 * Docs (checked 2026-11-14): developers.facebook.com/docs/threads/posts, /get-started/long-lived-tokens, /troubleshooting.
 */
import { expiresAt, graphClient, readInsights, sameText, str, tokenDue, type Fetch } from './meta';
import { PublishError, type Capabilities, type ContainerState, type MetaApp, type Prepared, type PublisherAdapter, type PublishRequest, type Token } from './types';

export const THREADS_GRAPH = 'https://graph.threads.com';
const API = `${THREADS_GRAPH}/v1.0`;
// threads_manage_replies: answering replies from «Активность» (only after the owner approves each answer).
export const THREADS_SCOPES = ['threads_basic', 'threads_content_publish', 'threads_manage_insights', 'threads_read_replies', 'threads_manage_replies'];
// Threads asks to wait about 30 seconds after creating a container before publishing it.
const PROCESSING_MS = 30_000;

/** Threads counts emoji by their UTF-8 length; everything else by characters. */
export function threadsLength(text: string) {
  let length = 0;
  for (const char of text) length += /\p{Extended_Pictographic}/u.test(char) ? new TextEncoder().encode(char).length : 1;
  return length;
}

export const threadsCapabilities: Capabilities = {
  formats: ['text', 'image', 'carousel'], maxText: 500, minCarousel: 2, maxCarousel: 20,
  imageTypes: ['image/jpeg', 'image/png'], maxImageBytes: 8 * 1024 * 1024, nativeScheduling: false, insights: true, dailyLimit: 250,
};

export function threadsAdapter(request: Fetch = fetch): PublisherAdapter {
  const graph = graphClient(request);
  const me = async (token: Token) => {
    const body = await graph('GET', `${API}/me`, { fields: 'id,username,name,threads_profile_picture_url' }, token.accessToken);
    return { id: str(body.id), username: str(body.username), name: str(body.name) || null, picture: str(body.threads_profile_picture_url) || null };
  };
  const permalink = async (token: Token, id: string) => {
    try {
      const body = await graph('GET', `${API}/${id}`, { fields: 'permalink,timestamp' }, token.accessToken);
      return { permalink: str(body.permalink) || null, publishedAt: str(body.timestamp) || null };
    } catch { return { permalink: null, publishedAt: null }; }
  };
  return {
    provider: 'meta_threads', platform: 'threads', capabilities: threadsCapabilities,
    checkConnection: me,
    async listAccounts(token) { return [await me(token)]; },
    validate(input: PublishRequest) {
      if (threadsLength(input.text) > threadsCapabilities.maxText) return `Текст для Threads длиннее ${threadsCapabilities.maxText} символов.`;
      if (input.format === 'text') return input.text.trim() ? null : 'Для текстового поста нужен текст.';
      if (input.format === 'image') return input.mediaUrls.length === 1 ? null : 'Для поста с картинкой нужна одна картинка.';
      if (input.format === 'carousel') return input.mediaUrls.length >= 2 && input.mediaUrls.length <= threadsCapabilities.maxCarousel ? null : `В карусели Threads от 2 до ${threadsCapabilities.maxCarousel} картинок.`;
      return 'Видео в Threads будет на следующем этапе.';
    },
    async prepare(token, input) {
      const problem = this.validate(input);
      if (problem) throw new PublishError(problem, 'invalid_request');
      const owner = `${API}/${token.userId}/threads`;
      // Threads' own disclosure field for pictures made by an image model; it is set on container creation.
      const ai = input.aiImagery ? true : undefined;
      if (input.format === 'text') {
        const body = await graph('POST', owner, { media_type: 'TEXT', text: input.text }, token.accessToken);
        return { containerIds: [], parentId: str(body.id), waitMs: PROCESSING_MS };
      }
      if (input.format === 'image') {
        const body = await graph('POST', owner, { media_type: 'IMAGE', image_url: input.mediaUrls[0], text: input.text || undefined, is_made_with_ai: ai }, token.accessToken);
        return { containerIds: [], parentId: str(body.id), waitMs: PROCESSING_MS };
      }
      const children: string[] = [];
      for (const url of input.mediaUrls) children.push(str((await graph('POST', owner, { media_type: 'IMAGE', image_url: url, is_carousel_item: true }, token.accessToken)).id));
      const parent = await graph('POST', owner, { media_type: 'CAROUSEL', children: children.join(','), text: input.text || undefined, is_made_with_ai: ai }, token.accessToken);
      return { containerIds: children, parentId: str(parent.id), waitMs: PROCESSING_MS };
    },
    async checkPrepared(token, prepared: Prepared): Promise<ContainerState> {
      const body = await graph('GET', `${API}/${prepared.parentId}`, { fields: 'status,error_message' }, token.accessToken);
      const status = str(body.status);
      if (status === 'FINISHED') return { state: 'ready' };
      if (status === 'PUBLISHED') return { state: 'published' };
      if (status === 'EXPIRED') return { state: 'expired' };
      if (status === 'ERROR') return { state: 'failed', error: str(body.error_message) || 'Threads не обработал публикацию.' };
      return { state: 'processing' };
    },
    async publish(token, prepared) {
      const body = await graph('POST', `${API}/${token.userId}/threads_publish`, { creation_id: prepared.parentId }, token.accessToken);
      const remoteId = str(body.id);
      if (!remoteId) throw new PublishError('Threads не вернул номер публикации.', 'temporary');
      return { remoteId, ...await permalink(token, remoteId) };
    },
    async findRecent(token, text, since) {
      const body = await graph('GET', `${API}/${token.userId}/threads`, { fields: 'id,text,permalink,timestamp', limit: 10 }, token.accessToken);
      const posts = Array.isArray(body.data) ? body.data as Record<string, unknown>[] : [];
      const found = posts.find(post => sameText(str(post.text), text) && Date.parse(str(post.timestamp)) >= Date.parse(since) - 60_000);
      return found ? { remoteId: str(found.id), permalink: str(found.permalink) || null, publishedAt: str(found.timestamp) || null } : null;
    },
    async stats(token, remoteId) {
      return readInsights(await graph('GET', `${API}/${remoteId}/insights`, { metric: 'views,likes,replies,reposts,quotes,shares' }, token.accessToken));
    },
    async quota(token) {
      const body = await graph('GET', `${API}/${token.userId}/threads_publishing_limit`, { fields: 'quota_usage,config' }, token.accessToken);
      const row = Array.isArray(body.data) ? body.data[0] as { quota_usage?: number; config?: { quota_total?: number } } : null;
      return row && typeof row.quota_usage === 'number' ? { used: row.quota_usage, total: row.config?.quota_total ?? threadsCapabilities.dailyLimit } : null;
    },
    async refresh(token, nowMs = Date.now()) {
      if (!tokenDue(token, nowMs)) return token;
      const body = await graph('GET', `${THREADS_GRAPH}/refresh_access_token`, { grant_type: 'th_refresh_token' }, token.accessToken);
      const fresh = str(body.access_token);
      if (!fresh) throw new PublishError('Threads не продлил доступ. Подключите аккаунт заново.', 'auth');
      return { ...token, accessToken: fresh, expiresAt: expiresAt(body.expires_in, nowMs), obtainedAt: new Date(nowMs).toISOString() };
    },
  };
}

/** OAuth: the owner logs in on threads.com and comes back with a one-hour code. */
export function threadsAuthorizeUrl(app: MetaApp, state: string) {
  const url = new URL('https://threads.com/oauth/authorize');
  url.search = new URLSearchParams({ client_id: app.appId, redirect_uri: app.redirectUri, scope: THREADS_SCOPES.join(','), response_type: 'code', state }).toString();
  return url.toString();
}
/** Code -> short-lived token -> 60-day token. The app secret is used only here, on the server. */
export async function threadsExchangeCode(app: MetaApp, code: string, request: Fetch = fetch, nowMs = Date.now()): Promise<Token> {
  const graph = graphClient(request);
  const short = await graph('POST', `${THREADS_GRAPH}/oauth/access_token`, { client_id: app.appId, client_secret: app.appSecret, grant_type: 'authorization_code', redirect_uri: app.redirectUri, code: code.replace(/#_$/, '') });
  const shortToken = str(short.access_token);
  if (!shortToken) throw new PublishError('Threads не выдал доступ.', 'auth');
  const long = await graph('GET', `${THREADS_GRAPH}/access_token`, { grant_type: 'th_exchange_token', client_secret: app.appSecret }, shortToken);
  const accessToken = str(long.access_token);
  if (!accessToken) throw new PublishError('Threads не выдал долгий доступ.', 'auth');
  return { accessToken, userId: str(short.user_id), expiresAt: expiresAt(long.expires_in, nowMs), obtainedAt: new Date(nowMs).toISOString() };
}
