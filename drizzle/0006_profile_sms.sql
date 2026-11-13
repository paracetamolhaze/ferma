CREATE TABLE `sms_settings` (
	`owner` text PRIMARY KEY NOT NULL,
	`baseUrl` text NOT NULL,
	`encryptedToken` text NOT NULL,
	`encryptedSigningKey` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `profiles` ADD `phone` text;--> statement-breakpoint
ALTER TABLE `profiles` ADD `smsLine` text;--> statement-breakpoint
CREATE UNIQUE INDEX `profile_phone_unique` ON `profiles` (`owner`,`phone`);--> statement-breakpoint
CREATE UNIQUE INDEX `profile_sms_line_unique` ON `profiles` (`owner`,`smsLine`);