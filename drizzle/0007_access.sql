CREATE TABLE `activations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`profileId` text NOT NULL,
	`product` text NOT NULL,
	`phone` text NOT NULL,
	`country` text NOT NULL,
	`price` text NOT NULL,
	`status` text NOT NULL,
	`code` text,
	`expiresAt` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`profileId`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `fivesim_settings` (
	`owner` text PRIMARY KEY NOT NULL,
	`encryptedToken` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `profile_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`profileId` text NOT NULL,
	`platform` text NOT NULL,
	`encryptedTotp` text,
	`encryptedBackup` text,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`profileId`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_secret_platform` ON `profile_secrets` (`profileId`,`platform`);