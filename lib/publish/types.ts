/**
 * One publishing contract for every network. Each adapter speaks its own API (Threads Graph API, Instagram API
 * with Instagram Login, Zernio, YouTube Data API); nothing here is a shared request format.
 */
export type Platform = 'threads' | 'instagram' | 'tiktok' | 'youtube';
export type Provider = 'meta_threads' | 'meta_instagram' | 'zernio' | 'youtube';
export type Format = 'text' | 'image' | 'carousel' | 'video';

export type Capabilities = {
  /** Formats this adapter can publish in this FERMA version. */
  formats: Format[];
  maxText: number;
  minCarousel: number;
  maxCarousel: number;
  imageTypes: string[];
  maxImageBytes: number;
  /** The network itself holds a scheduled post (Zernio) or FERMA must publish at the time (Meta APIs). */
  nativeScheduling: boolean;
  insights: boolean;
  /** Published posts per rolling 24 h the network allows through the API. */
  dailyLimit: number;
  /** Not available in this version: the reason is shown in the interface instead of a button. */
  inactive?: string;
};

/** scopes: the permissions the network listed when it gave the token (Instagram does; Threads answers debug_token). */
export type Token = { accessToken: string; userId: string; expiresAt: string | null; obtainedAt: string; scopes?: string[] | null };
export type RemoteAccount = { id: string; username: string; name?: string | null; accountType?: string | null; followers?: number | null; picture?: string | null };
/** aiImagery: the pictures were made by an image model; Threads gets its «made with AI» mark. */
export type PublishRequest = { format: Format; text: string; mediaUrls: string[]; aiImagery?: boolean };
/** Containers created on the network, waiting until it has fetched and processed the media. */
/** waitMs: how long the network asks to wait before publishing; the queue adds it to its own clock. */
export type Prepared = { containerIds: string[]; parentId: string; waitMs: number };
export type ContainerState = { state: 'ready' } | { state: 'processing' } | { state: 'published' } | { state: 'failed'; error: string } | { state: 'expired' };
export type Published = { remoteId: string; permalink: string | null; publishedAt: string | null };
export type Stats = Record<string, number>;

export type ErrorKind = 'auth' | 'rate_limit' | 'invalid_media' | 'invalid_request' | 'temporary' | 'not_available';
export class PublishError extends Error {
  /** retryAfterMs: how long the network itself asked to wait (Retry-After, Meta usage headers). */
  constructor(message: string, readonly kind: ErrorKind, readonly detail: string | null = null, readonly retryAfterMs: number | null = null) { super(message); }
  /** Worth another attempt later without changing anything. */
  get retryable() { return this.kind === 'temporary' || this.kind === 'rate_limit'; }
}

export interface PublisherAdapter {
  readonly provider: Provider;
  readonly platform: Platform;
  readonly capabilities: Capabilities;
  /** A token is alive and belongs to this account. */
  checkConnection(token: Token): Promise<RemoteAccount>;
  /** Accounts reachable with this token (Meta: exactly the logged-in account). */
  listAccounts(token: Token): Promise<RemoteAccount[]>;
  /** Plain-language reason why this request can not go out, or null. */
  validate(request: PublishRequest): string | null;
  /** Step 1: upload references (containers) for the post; nothing is visible yet. */
  prepare(token: Token, request: PublishRequest): Promise<Prepared>;
  /** Step 2: whether the network has finished processing the containers. */
  checkPrepared(token: Token, prepared: Prepared): Promise<ContainerState>;
  /** Step 3: make the post public. Publishing the same container twice is refused by the network. */
  publish(token: Token, prepared: Prepared): Promise<Published>;
  /** A post that may already be out (lost answer): find it among the latest posts. */
  findRecent(token: Token, text: string, since: string): Promise<Published | null>;
  stats(token: Token, remoteId: string): Promise<Stats | null>;
  /** Used share of the 24 h publishing limit, when the network reports it. */
  quota(token: Token): Promise<{ used: number; total: number } | null>;
  /** A fresh token, or the same one when it is not due yet. */
  refresh(token: Token, nowMs?: number): Promise<Token>;
}

export type MetaApp = { appId: string; appSecret: string; redirectUri: string };
