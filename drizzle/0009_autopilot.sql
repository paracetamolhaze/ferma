CREATE TABLE `autopilot_items` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`profileId` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`dueAt` text NOT NULL,
	`text` text,
	`imagePrompt` text,
	`imageKey` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retryAt` text,
	`zernioPostId` text,
	`error` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`profileId`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `autopilot_state` (
	`owner` text PRIMARY KEY NOT NULL,
	`heartbeatAt` text NOT NULL,
	`bridgeOk` integer DEFAULT 0 NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE TABLE `personas` (
	`profileId` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`persona` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`profileId`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
