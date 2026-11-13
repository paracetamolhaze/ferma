CREATE TABLE `comment_replies` (
	`commentId` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`profileId` text NOT NULL,
	`postId` text NOT NULL,
	`status` text NOT NULL,
	`reply` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`profileId`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `profile_sources` (
	`profileId` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`tgChannel` text,
	`tgLastId` integer,
	`replies` integer DEFAULT 0 NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`profileId`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
