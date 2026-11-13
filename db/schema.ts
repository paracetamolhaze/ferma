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
