CREATE TABLE `profile_integrations` (
	`profileId` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`encryptedKey` text NOT NULL,
	`fingerprint` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`profileId`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_key_unique` ON `profile_integrations` (`owner`,`fingerprint`);