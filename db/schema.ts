import { sqliteTable, text, integer, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
export const integrations = sqliteTable("integrations", {
  owner: text().primaryKey(), encryptedKey: text().notNull(), updatedAt: text().notNull(),
});
export const profileIntegrations = sqliteTable("profile_integrations", {
  profileId: text().primaryKey().references(() => profiles.id),
  owner: text().notNull(), encryptedKey: text().notNull(), fingerprint: text().notNull(), updatedAt: text().notNull(),
}, t => [uniqueIndex('profile_key_unique').on(t.owner, t.fingerprint)]);
export const profiles = sqliteTable("profiles", {
  id: text().primaryKey(), owner: text().notNull(), name: text().notNull(),
  description: text().notNull().default(""), color: text().notNull().default("#d7e7c4"),
  zernioId: text(), accountSelection: text(), emailLocal: text(), phone: text(), smsLine: text(), avatarKey: text(), createdAt: text().notNull(),
}, t => [uniqueIndex('profile_remote_unique').on(t.owner, t.zernioId), uniqueIndex('profile_email_unique').on(t.owner, t.emailLocal), uniqueIndex('profile_phone_unique').on(t.owner, t.phone), uniqueIndex('profile_sms_line_unique').on(t.owner, t.smsLine)]);
export const personas = sqliteTable("personas", {
  profileId: text().primaryKey().references(() => profiles.id), owner: text().notNull(),
  persona: text().notNull(), enabled: integer().notNull().default(0), updatedAt: text().notNull(),
});
export const autopilotItems = sqliteTable("autopilot_items", {
  id: text().primaryKey(), owner: text().notNull(), profileId: text().notNull().references(() => profiles.id),
  kind: text().notNull(), status: text().notNull(), dueAt: text().notNull(),
  text: text(), imagePrompt: text(), imageKey: text(), extraImages: integer().notNull().default(0), attempts: integer().notNull().default(0), retryAt: text(),
  zernioPostId: text(), error: text(), createdAt: text().notNull(), updatedAt: text().notNull(),
});
export const autopilotState = sqliteTable("autopilot_state", {
  owner: text().primaryKey(), heartbeatAt: text().notNull(), bridgeOk: integer().notNull().default(0), note: text(),
});
export const profileSources = sqliteTable("profile_sources", {
  profileId: text().primaryKey().references(() => profiles.id), owner: text().notNull(),
  tgChannel: text(), tgLastId: integer(), replies: integer().notNull().default(0), updatedAt: text().notNull(),
});
export const commentReplies = sqliteTable("comment_replies", {
  commentId: text().primaryKey(), owner: text().notNull(), profileId: text().notNull().references(() => profiles.id),
  postId: text().notNull(), status: text().notNull(), reply: text(), createdAt: text().notNull(),
});
export const fivesimSettings = sqliteTable("fivesim_settings", {
  owner: text().primaryKey(), encryptedToken: text().notNull(), updatedAt: text().notNull(),
});
export const activations = sqliteTable("activations", {
  id: text().primaryKey(), owner: text().notNull(), profileId: text().notNull().references(() => profiles.id),
  product: text().notNull(), phone: text().notNull(), country: text().notNull(), price: text().notNull(),
  status: text().notNull(), code: text(), expiresAt: text().notNull(), createdAt: text().notNull(),
});
export const profileSecrets = sqliteTable("profile_secrets", {
  id: text().primaryKey(), owner: text().notNull(), profileId: text().notNull().references(() => profiles.id),
  platform: text().notNull(), encryptedTotp: text(), encryptedBackup: text(), updatedAt: text().notNull(),
}, t => [uniqueIndex('profile_secret_platform').on(t.profileId, t.platform)]);
export const smsSettings = sqliteTable("sms_settings", {
  owner: text().primaryKey(), baseUrl: text().notNull(), encryptedToken: text().notNull(), encryptedSigningKey: text().notNull(), updatedAt: text().notNull(),
});
export const mailSettings = sqliteTable("mail_settings", {
  owner: text().primaryKey(), baseUrl: text().notNull(), domain: text().notNull(), encryptedToken: text().notNull(), updatedAt: text().notNull(),
});
export const channels = sqliteTable("channels", {
  id: text().primaryKey(), profileId: text().notNull().references(() => profiles.id),
  slot: integer().notNull(), platform: text().notNull(), accountId: text(),
  username: text(), state: text().notNull().default("pending"), createdAt: text().notNull(),
}, t => [uniqueIndex("channel_slot").on(t.profileId, t.slot), uniqueIndex("channel_platform").on(t.profileId, t.platform), check("two_slots", sql`${t.slot} IN (0, 1)`)]);
export const media = sqliteTable("media", {
  id: text().primaryKey(), owner: text().notNull(), name: text().notNull(),
  key: text().notNull(), type: text().notNull(), size: integer().notNull(),
  remoteUrl: text(), createdAt: text().notNull(),
});
export const posts = sqliteTable("posts", {
  id: text().primaryKey(), owner: text().notNull(), profileId: text().notNull().references(() => profiles.id),
  title: text().notNull(), content: text().notNull().default(""), mediaId: text().references(() => media.id),
  platforms: text().notNull().default("[]"), status: text().notNull().default("draft"),
  scheduledFor: text(), zernioId: text(), error: text(), payload: text(), createdAt: text().notNull(),
});

// ---- FERMA 2.0: materials from sources (Gudini), editorial variants, own social accounts, campaigns,
// and one publication queue for every provider.
/** A connected content source. One Gudini per owner in this version. The token is encrypted. */
export const contentSources = sqliteTable("content_sources", {
  id: text().primaryKey(), owner: text().notNull(), kind: text().notNull(), name: text().notNull(),
  baseUrl: text().notNull(), encryptedToken: text().notNull(), enabled: integer().notNull().default(1),
  cursor: text(), status: text().notNull().default("idle"), lastSyncAt: text(), lastSuccessAt: text(), lastError: text(),
  failures: integer().notNull().default(0), nextSyncAt: text(), syncRequested: integer().notNull().default(0),
  createdAt: text().notNull(), updatedAt: text().notNull(),
}, t => [uniqueIndex("content_source_kind").on(t.owner, t.kind)]);
/** A material as the source sent it: the original contract JSON is kept unchanged in payload. */
export const sourceItems = sqliteTable("source_items", {
  id: text().primaryKey(), owner: text().notNull(), sourceId: text().notNull().references(() => contentSources.id),
  externalId: text().notNull(), kind: text().notNull(), revision: text().notNull(), title: text().notNull(),
  category: text(), topic: text(), language: text().notNull().default("ru"), payload: text().notNull(),
  simhash: text().notNull(), duplicateOf: text(), status: text().notNull(),
  assetsTotal: integer().notNull().default(0), assetsStored: integer().notNull().default(0),
  attempts: integer().notNull().default(0), nextAttemptAt: text(), error: text(),
  sourceCreatedAt: text(), sourceReadyAt: text(), importedAt: text().notNull(), updatedAt: text().notNull(),
  /** Topic categories (names from topic_categories) set by the classifier; urgent = goes to the priority queue. */
  categories: text().notNull().default("[]"), urgent: integer().notNull().default(0), classifiedAt: text(),
  /** Another material that tells the same story (not a copy): one account does not get both. */
  relatedTo: text(),
}, t => [uniqueIndex("source_item_external").on(t.sourceId, t.externalId)]);
/** Original files byte for byte, stored once per revision under their SHA-256. */
export const sourceAssets = sqliteTable("source_assets", {
  id: text().primaryKey(), owner: text().notNull(), itemId: text().notNull().references(() => sourceItems.id),
  revision: text().notNull(), assetId: text().notNull(), role: text().notNull(), card: integer(),
  contentType: text().notNull(), size: integer().notNull(), sha256: text(), storageKey: text(),
  status: text().notNull(), attempts: integer().notNull().default(0), error: text(),
  createdAt: text().notNull(), updatedAt: text().notNull(),
  /** Perceptual hash of a picture (ferma-media-worker), to find the same image in other materials. */
  dhash: text(),
}, t => [uniqueIndex("source_asset_unique").on(t.itemId, t.revision, t.assetId)]);
/**
 * An editorial version of a material: its own angle (style), its own text, and for carousels its own cards.
 * text — up to 500 characters (Threads), caption — the longer Instagram caption. A version is bound to one
 * profile and platform before its cards are drawn in that profile's design.
 */
export const contentVariants = sqliteTable("content_variants", {
  id: text().primaryKey(), owner: text().notNull(), itemId: text().notNull().references(() => sourceItems.id),
  revision: text().notNull(), slot: integer().notNull(), style: text().notNull(), format: text().notNull(), layout: text().notNull().default("auto"),
  status: text().notNull(), headline: text(), text: text(), caption: text(), cards: text(), quality: text(),
  profileId: text(), platform: text(), aiImagery: integer().notNull().default(0),
  assetsCount: integer().notNull().default(0), attempts: integer().notNull().default(0), error: text(),
  createdAt: text().notNull(), updatedAt: text().notNull(),
  /** The editor's 0-100 rating and its reasons (claims checked against the sources, issues). A help, not a proof. */
  score: integer(), review: text(),
}, t => [uniqueIndex("variant_slot").on(t.itemId, t.revision, t.slot)]);
export const variantAssets = sqliteTable("variant_assets", {
  id: text().primaryKey(), owner: text().notNull(), variantId: text().notNull().references(() => contentVariants.id),
  index: integer().notNull(), storageKey: text().notNull(), contentType: text().notNull(), size: integer().notNull(),
  width: integer(), height: integer(), sha256: text(), dhash: text(), createdAt: text().notNull(),
}, t => [uniqueIndex("variant_asset_index").on(t.variantId, t.index)]);
/** Work for ferma-media-worker. The status change is the lock; a lease that ran out is taken again. */
export const mediaJobs = sqliteTable("media_jobs", {
  id: text().primaryKey(), owner: text().notNull(), kind: text().notNull(), subjectId: text().notNull(),
  status: text().notNull(), attempts: integer().notNull().default(0), leaseUntil: text(), nextAttemptAt: text(),
  error: text(), elapsedMs: integer(), cpuMs: integer(), createdAt: text().notNull(), updatedAt: text().notNull(),
}, t => [uniqueIndex("media_job_subject").on(t.kind, t.subjectId)]);
/** The owner's own Meta app per provider (Threads, Instagram). The secret is encrypted. */
export const providerApps = sqliteTable("provider_apps", {
  id: text().primaryKey(), owner: text().notNull(), provider: text().notNull(), appId: text().notNull(),
  encryptedSecret: text().notNull(), redirectUri: text().notNull(), updatedAt: text().notNull(),
}, t => [uniqueIndex("provider_app_owner").on(t.owner, t.provider)]);
export const oauthStates = sqliteTable("oauth_states", {
  state: text().primaryKey(), owner: text().notNull(), profileId: text().notNull(), provider: text().notNull(),
  createdAt: text().notNull(), expiresAt: text().notNull(),
});
/**
 * A social account connected with its own token through the owner's app. Separate from Zernio's `channels`
 * (which keep their two-slot rule): a profile may hold one account per provider here.
 */
export const socialAccounts = sqliteTable("social_accounts", {
  id: text().primaryKey(), owner: text().notNull(), profileId: text().notNull().references(() => profiles.id),
  platform: text().notNull(), provider: text().notNull(), remoteId: text().notNull(), username: text(), name: text(),
  accountType: text(), followers: integer(), encryptedToken: text().notNull(), tokenExpiresAt: text(), tokenObtainedAt: text().notNull(),
  status: text().notNull(), lastCheckedAt: text(), error: text(), quotaUsed: integer(), quotaTotal: integer(),
  createdAt: text().notNull(), updatedAt: text().notNull(),
  /** The network asked to wait (rate limit): nothing is sent from this account before this time. */
  pausedUntil: text(),
  /** The last diagnostics of the account (JSON): token, permissions, quota, insights. */
  diagnostics: text(),
}, t => [uniqueIndex("social_account_remote").on(t.owner, t.provider, t.remoteId), uniqueIndex("social_account_profile").on(t.profileId, t.provider)]);
/** What a profile writes about and how: topics, voice, formats, how often and when, and how much is automatic. */
export const profileEditorial = sqliteTable("profile_editorial", {
  profileId: text().primaryKey().references(() => profiles.id), owner: text().notNull(),
  topics: text().notNull().default("[]"), style: text().notNull().default("neutral"), language: text().notNull().default("ru"),
  formats: text().notNull().default('["text","image","carousel"]'), perDay: text().notNull().default('{"threads":2,"instagram":1}'),
  windows: text().notNull().default("[[9,22]]"), timezoneOffsetMinutes: integer().notNull().default(300),
  minGapMinutes: integer().notNull().default(90), mode: text().notNull().default("manual"), design: text(),
  updatedAt: text().notNull(),
});
export const campaigns = sqliteTable("campaigns", {
  id: text().primaryKey(), owner: text().notNull(), name: text().notNull(), status: text().notNull().default("paused"),
  mode: text().notNull().default("manual"), kinds: text().notNull().default('["news","carousel"]'), keywords: text().notNull().default("[]"),
  profileIds: text().notNull().default("[]"), platforms: text().notNull().default('["threads","instagram"]'),
  maxAccountsPerItem: integer().notNull().default(5), spreadMinutes: integer().notNull().default(120), since: text(),
  createdAt: text().notNull(), updatedAt: text().notNull(),
  /** Topic categories this campaign takes (empty = all). */
  categories: text().notNull().default("[]"),
});
/** Topic categories set by the owner (crypto, finance…). Materials are sorted into them, profiles choose them. */
export const topicCategories = sqliteTable("topic_categories", {
  id: text().primaryKey(), owner: text().notNull(), name: text().notNull(), keywords: text().notNull().default("[]"),
  sort: integer().notNull().default(0), createdAt: text().notNull(), updatedAt: text().notNull(),
}, t => [uniqueIndex("topic_category_name").on(t.owner, t.name)]);
/** Settings of the whole content pipeline. Automatic publishing is off until the owner switches it on. */
export const contentSettings = sqliteTable("content_settings", {
  owner: text().primaryKey(), variantsPerItem: integer().notNull().default(5), autopublish: integer().notNull().default(0),
  dailyWriterCalls: integer().notNull().default(60), fetchVideo: integer().notNull().default(0),
  /** HTTPS address where Meta fetches pictures of a post (FERMA's public media port behind Caddy). */
  publicBaseUrl: text(), updatedAt: text().notNull(),
  /** Below this rating a version waits for the owner even in automatic mode. */
  qualityThreshold: integer().notNull().default(80),
  /** Materials older than this are not published as fresh news. */
  maxAgeHours: integer().notNull().default(48),
  /** Drawn cards of finished or dropped versions are removed after this many days; Gudini's originals never. */
  retentionDays: integer().notNull().default(30),
  /** The AI editor reviews every version before it can be used. */
  reviewEnabled: integer().notNull().default(1),
});
/** One queue for every provider. A material goes to an account once: (itemId, accountId) is unique. */
export const publications = sqliteTable("publications", {
  id: text().primaryKey(), owner: text().notNull(), profileId: text().notNull().references(() => profiles.id),
  accountId: text().notNull().references(() => socialAccounts.id), provider: text().notNull(), platform: text().notNull(),
  campaignId: text(), itemId: text().notNull(), variantId: text().notNull(), format: text().notNull(), status: text().notNull(),
  text: text().notNull().default(""), mediaCount: integer().notNull().default(0), scheduledFor: text().notNull(),
  attempts: integer().notNull().default(0), nextAttemptAt: text(), lockedUntil: text(),
  containerIds: text(), parentContainerId: text(), containerReadyAt: text(), mediaKeys: text(),
  remoteId: text(), permalink: text(), publishedAt: text(), idempotencyKey: text().notNull(),
  error: text(), errorKind: text(), stats: text(), statsAt: text(), approvedAt: text(),
  createdAt: text().notNull(), updatedAt: text().notNull(),
  /** 1 = urgent news: goes before everything else in its account's queue. */
  priority: integer().notNull().default(0),
  /** When replies and comments under the post were last read for «Активность». */
  repliesAt: text(),
}, t => [uniqueIndex("publication_key").on(t.idempotencyKey), uniqueIndex("publication_item_account").on(t.itemId, t.accountId)]);
export const publicationEvents = sqliteTable("publication_events", {
  id: text().primaryKey(), owner: text().notNull(), publicationId: text().notNull(), at: text().notNull(),
  level: text().notNull(), message: text().notNull(),
});
/**
 * Comments under the accounts' own posts. A reply is suggested by the AI, edited and sent only by the owner.
 * status: new → suggested → sent | ignored | failed.
 */
export const engagementTasks = sqliteTable("engagement_tasks", {
  id: text().primaryKey(), owner: text().notNull(), profileId: text().notNull().references(() => profiles.id),
  accountId: text().notNull(), publicationId: text(), kind: text().notNull(), remoteId: text().notNull(),
  author: text(), text: text(), status: text().notNull(), receivedAt: text().notNull(), createdAt: text().notNull(),
  platform: text(), remotePostId: text(), suggestion: text(), reply: text(), repliedAt: text(), error: text(), updatedAt: text(),
  /** Threads answers in two steps: the container made at «Отправить», then its publication half a minute later. */
  replyContainerId: text(), replyRemoteId: text(),
}, t => [uniqueIndex("engagement_remote").on(t.accountId, t.remoteId)]);
/**
 * Recommendations from the analytics: what to change, why (the numbers behind it) and the change itself.
 * Nothing is applied until the owner accepts it. status: proposed → accepted | dismissed.
 */
export const recommendations = sqliteTable("recommendations", {
  id: text().primaryKey(), owner: text().notNull(), profileId: text(), kind: text().notNull(), title: text().notNull(),
  reason: text().notNull(), basis: text().notNull().default("{}"), change: text().notNull().default("{}"),
  status: text().notNull().default("proposed"), createdAt: text().notNull(), decidedAt: text(),
}, t => [uniqueIndex("recommendation_kind").on(t.owner, t.kind, t.profileId)]);
/** Heartbeats of the background processes (content engine, media worker) for the interface. */
export const engineStatus = sqliteTable("engine_status", {
  id: text().primaryKey(), owner: text().notNull(), name: text().notNull(), heartbeatAt: text().notNull(),
  ok: integer().notNull().default(1), note: text(), details: text(),
}, t => [uniqueIndex("engine_status_name").on(t.owner, t.name)]);
