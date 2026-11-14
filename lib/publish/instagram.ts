/**
 * Instagram through the owner's own Meta app: Instagram API with Instagram Login (graph.instagram.com).
 * Needs an Instagram professional account (Business or Creator).
 * Docs (checked 2026-11-14): developers.facebook.com/docs/instagram-platform/content-publishing, /business-login.
 */
import { expiresAt, graphClient, readInsights, sameText, str, tokenDue, type Fetch } from './meta';
import { PublishError, type Capabilities, type ContainerState, type MetaApp, type Prepared, type PublisherAdapter, type PublishRequest, type Token } from './types';

export const INSTAGRAM_GRAPH = 'https://graph.instagram.com';
const API = `${INSTAGRAM_GRAPH}/v27.0`;
// instagram_business_manage_comments: reading comments and answering them from «Активность» after the owner approves.
export const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_insights', 'instagram_business_manage_comments'];
// Images are usually processed within seconds; the status is still checked before publishing.
const PROCESSING_MS = 10_000;

export const instagramCapabilities: Capabilities = {
  formats: ['image', 'carousel'], maxText: 2200, minCarousel: 2, maxCarousel: 20,
  // The API accepts JPEG only for pictures.
  imageTypes: ['image/jpeg'], maxImageBytes: 8 * 1024 * 1024, nativeScheduling: false, insights: true,
  // Meta's pages name both 100 and 50 posts per day; the real figure is read from content_publishing_limit.
  dailyLimit: 50,
};

export function instagramCaptionProblem(text: string) {
  if (text.length > instagramCapabilities.maxText) return `Подпись Instagram длиннее ${instagramCapabilities.maxText} символов.`;
  if ((text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length > 30) return 'В подписи Instagram больше 30 хештегов.';
  if ((text.match(/(^|\s)@[\w.]+/g) || []).length > 20) return 'В подписи Instagram больше 20 упоминаний.';
  return null;
}

export function instagramAdapter(request: Fetch = fetch): PublisherAdapter {
  const graph = graphClient(request);
  const me = async (token: Token) => {
    const body = await graph('GET', `${API}/me`, { fields: 'user_id,username,name,account_type,profile_picture_url,followers_count' }, token.accessToken);
    return { id: str(body.user_id) || str(body.id), username: str(body.username), name: str(body.name) || null, accountType: str(body.account_type) || null, followers: typeof body.followers_count === 'number' ? body.followers_count : null, picture: str(body.profile_picture_url) || null };
  };
  const details = async (token: Token, id: string) => {
    try {
      const body = await graph('GET', `${API}/${id}`, { fields: 'permalink,timestamp' }, token.accessToken);
      return { permalink: str(body.permalink) || null, publishedAt: str(body.timestamp) || null };
    } catch { return { permalink: null, publishedAt: null }; }
  };
  return {
    provider: 'meta_instagram', platform: 'instagram', capabilities: instagramCapabilities,
    checkConnection: me,
    async listAccounts(token) { return [await me(token)]; },
    validate(input: PublishRequest) {
      const caption = instagramCaptionProblem(input.text);
      if (caption) return caption;
      if (input.format === 'image') return input.mediaUrls.length === 1 ? null : 'Для поста нужна одна картинка.';
      if (input.format === 'carousel') return input.mediaUrls.length >= 2 && input.mediaUrls.length <= instagramCapabilities.maxCarousel ? null : `В карусели Instagram от 2 до ${instagramCapabilities.maxCarousel} картинок.`;
      if (input.format === 'text') return 'Instagram не публикует текст без картинки.';
      return 'Видео в Instagram будет на следующем этапе.';
    },
    async prepare(token, input) {
      const problem = this.validate(input);
      if (problem) throw new PublishError(problem, 'invalid_request');
      const owner = `${API}/${token.userId}/media`;
      if (input.format === 'image') {
        const body = await graph('POST', owner, { image_url: input.mediaUrls[0], caption: input.text || undefined }, token.accessToken);
        return { containerIds: [], parentId: str(body.id), waitMs: PROCESSING_MS };
      }
      const children: string[] = [];
      for (const url of input.mediaUrls) children.push(str((await graph('POST', owner, { image_url: url, is_carousel_item: true }, token.accessToken)).id));
      const parent = await graph('POST', owner, { media_type: 'CAROUSEL', children: children.join(','), caption: input.text || undefined }, token.accessToken);
      return { containerIds: children, parentId: str(parent.id), waitMs: PROCESSING_MS };
    },
    async checkPrepared(token, prepared: Prepared): Promise<ContainerState> {
      const body = await graph('GET', `${API}/${prepared.parentId}`, { fields: 'status_code,status' }, token.accessToken);
      const status = str(body.status_code);
      if (status === 'FINISHED') return { state: 'ready' };
      if (status === 'PUBLISHED') return { state: 'published' };
      if (status === 'EXPIRED') return { state: 'expired' };
      if (status === 'ERROR') return { state: 'failed', error: str(body.status) || 'Instagram не обработал публикацию.' };
      return { state: 'processing' };
    },
    async publish(token, prepared) {
      const body = await graph('POST', `${API}/${token.userId}/media_publish`, { creation_id: prepared.parentId }, token.accessToken);
      const remoteId = str(body.id);
      if (!remoteId) throw new PublishError('Instagram не вернул номер публикации.', 'temporary');
      return { remoteId, ...await details(token, remoteId) };
    },
    async findRecent(token, text, since) {
      const body = await graph('GET', `${API}/${token.userId}/media`, { fields: 'id,caption,permalink,timestamp', limit: 10 }, token.accessToken);
      const posts = Array.isArray(body.data) ? body.data as Record<string, unknown>[] : [];
      const found = posts.find(post => sameText(str(post.caption), text) && Date.parse(str(post.timestamp)) >= Date.parse(since) - 60_000);
      return found ? { remoteId: str(found.id), permalink: str(found.permalink) || null, publishedAt: str(found.timestamp) || null } : null;
    },
    async stats(token, remoteId) {
      return readInsights(await graph('GET', `${API}/${remoteId}/insights`, { metric: 'views,reach,likes,comments,saved,shares,total_interactions' }, token.accessToken));
    },
    async quota(token) {
      const body = await graph('GET', `${API}/${token.userId}/content_publishing_limit`, { fields: 'quota_usage,config' }, token.accessToken);
      const row = Array.isArray(body.data) ? body.data[0] as { quota_usage?: number; config?: { quota_total?: number } } : null;
      return row && typeof row.quota_usage === 'number' ? { used: row.quota_usage, total: row.config?.quota_total ?? instagramCapabilities.dailyLimit } : null;
    },
    async refresh(token, nowMs = Date.now()) {
      if (!tokenDue(token, nowMs)) return token;
      const body = await graph('GET', `${INSTAGRAM_GRAPH}/refresh_access_token`, { grant_type: 'ig_refresh_token' }, token.accessToken);
      const fresh = str(body.access_token);
      if (!fresh) throw new PublishError('Instagram не продлил доступ. Подключите аккаунт заново.', 'auth');
      return { ...token, accessToken: fresh, expiresAt: expiresAt(body.expires_in, nowMs), obtainedAt: new Date(nowMs).toISOString() };
    },
  };
}

export function instagramAuthorizeUrl(app: MetaApp, state: string) {
  const url = new URL('https://www.instagram.com/oauth/authorize');
  url.search = new URLSearchParams({ client_id: app.appId, redirect_uri: app.redirectUri, scope: INSTAGRAM_SCOPES.join(','), response_type: 'code', state, enable_fb_login: 'false' }).toString();
  return url.toString();
}
/** Code -> short-lived token -> 60-day token; the account id comes from /me. */
export async function instagramExchangeCode(app: MetaApp, code: string, request: Fetch = fetch, nowMs = Date.now()): Promise<Token> {
  const graph = graphClient(request);
  const short = await graph('POST', 'https://api.instagram.com/oauth/access_token', { client_id: app.appId, client_secret: app.appSecret, grant_type: 'authorization_code', redirect_uri: app.redirectUri, code: code.replace(/#_$/, '') });
  const first = Array.isArray(short.data) ? short.data[0] as Record<string, unknown> : short;
  const shortToken = str(first?.access_token);
  if (!shortToken) throw new PublishError('Instagram не выдал доступ.', 'auth');
  const long = await graph('GET', `${INSTAGRAM_GRAPH}/access_token`, { grant_type: 'ig_exchange_token', client_secret: app.appSecret }, shortToken);
  const accessToken = str(long.access_token);
  if (!accessToken) throw new PublishError('Instagram не выдал долгий доступ.', 'auth');
  const profile = await graph('GET', `${API}/me`, { fields: 'user_id,username' }, accessToken);
  // The short-lived answer lists the permissions the owner granted (comma-separated).
  const scopes = str(first?.permissions).split(',').map(scope => scope.trim()).filter(Boolean);
  return { accessToken, userId: str(profile.user_id) || str(first?.user_id), expiresAt: expiresAt(long.expires_in, nowMs), obtainedAt: new Date(nowMs).toISOString(), scopes: scopes.length ? scopes : null };
}
