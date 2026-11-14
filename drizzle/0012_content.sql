CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'paused' NOT NULL,
	`mode` text DEFAULT 'manual' NOT NULL,
	`kinds` text DEFAULT '["news","carousel"]' NOT NULL,
	`keywords` text DEFAULT '[]' NOT NULL,
	`profileIds` text DEFAULT '[]' NOT NULL,
	`platforms` text DEFAULT '["threads","instagram"]' NOT NULL,
	`maxAccountsPerItem` integer DEFAULT 5 NOT NULL,
	`spreadMinutes` integer DEFAULT 120 NOT NULL,
	`since` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `content_settings` (
	`owner` text PRIMARY KEY NOT NULL,
	`variantsPerItem` integer DEFAULT 5 NOT NULL,
	`autopublish` integer DEFAULT 0 NOT NULL,
	`dailyWriterCalls` integer DEFAULT 60 NOT NULL,
	`fetchVideo` integer DEFAULT 0 NOT NULL,
	`publicBaseUrl` text,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `content_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`baseUrl` text NOT NULL,
	`encryptedToken` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`cursor` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`lastSyncAt` text,
	`lastSuccessAt` text,
	`lastError` text,
	`failures` integer DEFAULT 0 NOT NULL,
	`nextSyncAt` text,
	`syncRequested` integer DEFAULT 0 NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_source_kind` ON `content_sources` (`owner`,`kind`);--> statement-breakpoint
CREATE TABLE `content_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`itemId` text NOT NULL,
	`revision` text NOT NULL,
	`slot` integer NOT NULL,
	`style` text NOT NULL,
	`format` text NOT NULL,
	`layout` text DEFAULT 'auto' NOT NULL,
	`status` text NOT NULL,
	`headline` text,
	`text` text,
	`caption` text,
	`cards` text,
	`quality` text,
	`profileId` text,
	`platform` text,
	`aiImagery` integer DEFAULT 0 NOT NULL,
	`assetsCount` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`itemId`) REFERENCES `source_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variant_slot` ON `content_variants` (`itemId`,`revision`,`slot`);--> statement-breakpoint
CREATE TABLE `engagement_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`profileId` text NOT NULL,
	`accountId` text NOT NULL,
	`publicationId` text,
	`kind` text NOT NULL,
	`remoteId` text NOT NULL,
	`author` text,
	`text` text,
	`status` text NOT NULL,
	`receivedAt` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`profileId`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `engagement_remote` ON `engagement_tasks` (`accountId`,`remoteId`);--> statement-breakpoint
CREATE TABLE `engine_status` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`heartbeatAt` text NOT NULL,
	`ok` integer DEFAULT 1 NOT NULL,
	`note` text,
	`details` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `engine_status_name` ON `engine_status` (`owner`,`name`);--> statement-breakpoint
CREATE TABLE `media_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`kind` text NOT NULL,
	`subjectId` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`leaseUntil` text,
	`nextAttemptAt` text,
	`error` text,
	`elapsedMs` integer,
	`cpuMs` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_job_subject` ON `media_jobs` (`kind`,`subjectId`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`profileId` text NOT NULL,
	`provider` text NOT NULL,
	`createdAt` text NOT NULL,
	`expiresAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `profile_editorial` (
	`profileId` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`topics` text DEFAULT '[]' NOT NULL,
	`style` text DEFAULT 'neutral' NOT NULL,
	`language` text DEFAULT 'ru' NOT NULL,
	`formats` text DEFAULT '["text","image","carousel"]' NOT NULL,
	`perDay` text DEFAULT '{"threads":2,"instagram":1}' NOT NULL,
	`windows` text DEFAULT '[[9,22]]' NOT NULL,
	`timezoneOffsetMinutes` integer DEFAULT 300 NOT NULL,
	`minGapMinutes` integer DEFAULT 90 NOT NULL,
	`mode` text DEFAULT 'manual' NOT NULL,
	`design` text,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`profileId`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `provider_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`provider` text NOT NULL,
	`appId` text NOT NULL,
	`encryptedSecret` text NOT NULL,
	`redirectUri` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_app_owner` ON `provider_apps` (`owner`,`provider`);--> statement-breakpoint
CREATE TABLE `publication_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`publicationId` text NOT NULL,
	`at` text NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `publications` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`profileId` text NOT NULL,
	`accountId` text NOT NULL,
	`provider` text NOT NULL,
	`platform` text NOT NULL,
	`campaignId` text,
	`itemId` text NOT NULL,
	`variantId` text NOT NULL,
	`format` text NOT NULL,
	`status` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`mediaCount` integer DEFAULT 0 NOT NULL,
	`scheduledFor` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`nextAttemptAt` text,
	`lockedUntil` text,
	`containerIds` text,
	`parentContainerId` text,
	`containerReadyAt` text,
	`mediaKeys` text,
	`remoteId` text,
	`permalink` text,
	`publishedAt` text,
	`idempotencyKey` text NOT NULL,
	`error` text,
	`errorKind` text,
	`stats` text,
	`statsAt` text,
	`approvedAt` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`profileId`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accountId`) REFERENCES `social_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_key` ON `publications` (`idempotencyKey`);--> statement-breakpoint
CREATE UNIQUE INDEX `publication_item_account` ON `publications` (`itemId`,`accountId`);--> statement-breakpoint
CREATE TABLE `social_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`profileId` text NOT NULL,
	`platform` text NOT NULL,
	`provider` text NOT NULL,
	`remoteId` text NOT NULL,
	`username` text,
	`name` text,
	`accountType` text,
	`followers` integer,
	`encryptedToken` text NOT NULL,
	`tokenExpiresAt` text,
	`tokenObtainedAt` text NOT NULL,
	`status` text NOT NULL,
	`lastCheckedAt` text,
	`error` text,
	`quotaUsed` integer,
	`quotaTotal` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`profileId`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `social_account_remote` ON `social_accounts` (`owner`,`provider`,`remoteId`);--> statement-breakpoint
CREATE UNIQUE INDEX `social_account_profile` ON `social_accounts` (`profileId`,`provider`);--> statement-breakpoint
CREATE TABLE `source_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`itemId` text NOT NULL,
	`revision` text NOT NULL,
	`assetId` text NOT NULL,
	`role` text NOT NULL,
	`card` integer,
	`contentType` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text,
	`storageKey` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`itemId`) REFERENCES `source_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_asset_unique` ON `source_assets` (`itemId`,`revision`,`assetId`);--> statement-breakpoint
CREATE TABLE `source_items` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`sourceId` text NOT NULL,
	`externalId` text NOT NULL,
	`kind` text NOT NULL,
	`revision` text NOT NULL,
	`title` text NOT NULL,
	`category` text,
	`topic` text,
	`language` text DEFAULT 'ru' NOT NULL,
	`payload` text NOT NULL,
	`simhash` text NOT NULL,
	`duplicateOf` text,
	`status` text NOT NULL,
	`assetsTotal` integer DEFAULT 0 NOT NULL,
	`assetsStored` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`nextAttemptAt` text,
	`error` text,
	`sourceCreatedAt` text,
	`sourceReadyAt` text,
	`importedAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`sourceId`) REFERENCES `content_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_item_external` ON `source_items` (`sourceId`,`externalId`);--> statement-breakpoint
CREATE TABLE `variant_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`variantId` text NOT NULL,
	`index` integer NOT NULL,
	`storageKey` text NOT NULL,
	`contentType` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`sha256` text,
	`dhash` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`variantId`) REFERENCES `content_variants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variant_asset_index` ON `variant_assets` (`variantId`,`index`);