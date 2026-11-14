CREATE TABLE `recommendations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`profileId` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`reason` text NOT NULL,
	`basis` text DEFAULT '{}' NOT NULL,
	`change` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`createdAt` text NOT NULL,
	`decidedAt` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recommendation_kind` ON `recommendations` (`owner`,`kind`,`profileId`);--> statement-breakpoint
CREATE TABLE `topic_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`keywords` text DEFAULT '[]' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `topic_category_name` ON `topic_categories` (`owner`,`name`);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `categories` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `content_settings` ADD `qualityThreshold` integer DEFAULT 80 NOT NULL;--> statement-breakpoint
ALTER TABLE `content_settings` ADD `maxAgeHours` integer DEFAULT 48 NOT NULL;--> statement-breakpoint
ALTER TABLE `content_settings` ADD `retentionDays` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `content_settings` ADD `reviewEnabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `content_variants` ADD `score` integer;--> statement-breakpoint
ALTER TABLE `content_variants` ADD `review` text;--> statement-breakpoint
ALTER TABLE `engagement_tasks` ADD `platform` text;--> statement-breakpoint
ALTER TABLE `engagement_tasks` ADD `remotePostId` text;--> statement-breakpoint
ALTER TABLE `engagement_tasks` ADD `suggestion` text;--> statement-breakpoint
ALTER TABLE `engagement_tasks` ADD `reply` text;--> statement-breakpoint
ALTER TABLE `engagement_tasks` ADD `repliedAt` text;--> statement-breakpoint
ALTER TABLE `engagement_tasks` ADD `error` text;--> statement-breakpoint
ALTER TABLE `engagement_tasks` ADD `updatedAt` text;--> statement-breakpoint
ALTER TABLE `engagement_tasks` ADD `replyContainerId` text;--> statement-breakpoint
ALTER TABLE `engagement_tasks` ADD `replyRemoteId` text;--> statement-breakpoint
ALTER TABLE `publications` ADD `priority` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `publications` ADD `repliesAt` text;--> statement-breakpoint
ALTER TABLE `social_accounts` ADD `pausedUntil` text;--> statement-breakpoint
ALTER TABLE `social_accounts` ADD `diagnostics` text;--> statement-breakpoint
ALTER TABLE `source_assets` ADD `dhash` text;--> statement-breakpoint
ALTER TABLE `source_items` ADD `categories` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `source_items` ADD `urgent` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `source_items` ADD `classifiedAt` text;--> statement-breakpoint
ALTER TABLE `source_items` ADD `relatedTo` text;