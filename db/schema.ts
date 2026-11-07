import { sqliteTable, text, integer, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
export const profiles = sqliteTable("profiles", {
  id: text().primaryKey(), owner: text().notNull(), name: text().notNull(),
  description: text().notNull().default(""), color: text().notNull().default("#d7e7c4"),
  zernioId: text(), createdAt: text().notNull(),
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
