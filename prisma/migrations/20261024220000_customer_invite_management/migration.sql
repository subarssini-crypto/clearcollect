-- AlterTable
ALTER TABLE `CustomerInvite` ADD COLUMN `activeForClientId` INTEGER NULL,
    ADD COLUMN `emailRecipient` VARCHAR(191) NULL,
    ADD COLUMN `emailState` ENUM('SENDING', 'ACCEPTED', 'UNKNOWN', 'FAILED') NULL,
    ADD COLUMN `emailStateAt` DATETIME(3) NULL,
    ADD COLUMN `revokedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `CustomerInvite_activeForClientId_key` ON `CustomerInvite`(`activeForClientId`);
