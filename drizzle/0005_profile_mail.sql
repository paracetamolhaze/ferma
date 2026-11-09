CREATE TABLE `mail_settings` (
	`owner` text PRIMARY KEY NOT NULL,
	`baseUrl` text NOT NULL,
	`domain` text NOT NULL,
	`encryptedToken` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `profiles` ADD `emailLocal` text;--> statement-breakpoint
CREATE UNIQUE INDEX `profile_email_unique` ON `profiles` (`owner`,`emailLocal`);