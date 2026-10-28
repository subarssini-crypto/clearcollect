-- AlterTable
ALTER TABLE `Client` ADD COLUMN `archivedAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `FollowUpReminder` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `invoiceId` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'SENDING', 'UNKNOWN', 'SENT', 'FAILED') NOT NULL DEFAULT 'DRAFT',
    `subject` VARCHAR(200) NOT NULL,
    `message` TEXT NOT NULL,
    `recipient` VARCHAR(191) NULL,
    `sendStartedAt` DATETIME(3) NULL,
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `FollowUpReminder_invoiceId_status_idx`(`invoiceId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `FollowUpReminder` ADD CONSTRAINT `FollowUpReminder_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `Invoice`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

