CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`profileId` text NOT NULL,
	`slot` integer NOT NULL,
	`platform` text NOT NULL,
	`accountId` text,
	`username` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`profileId`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "two_slots" CHECK("channels"."slot" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_slot` ON `channels` (`profileId`,`slot`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_platform` ON `channels` (`profileId`,`platform`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`type` text NOT NULL,
	`size` integer NOT NULL,
	`remoteUrl` text,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`profileId` text NOT NULL,
	`title` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`mediaId` text,
	`platforms` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`scheduledFor` text,
	`zernioId` text,
	`error` text,
	`payload` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`profileId`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mediaId`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`color` text DEFAULT '#d7e7c4' NOT NULL,
	`zernioId` text,
	`createdAt` text NOT NULL
);
