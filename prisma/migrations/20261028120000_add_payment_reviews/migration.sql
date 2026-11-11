-- CreateTable
CREATE TABLE `PaymentReview` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `status` ENUM('OPEN', 'REVIEWED') NOT NULL DEFAULT 'OPEN',
    `code` VARCHAR(40) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `recommendedAction` VARCHAR(500) NOT NULL,
    `invoiceId` INTEGER NULL,
    `invoiceNumber` VARCHAR(191) NULL,
    `paypalOrderId` VARCHAR(64) NULL,
    `paypalCaptureId` VARCHAR(64) NULL,
    `webhookEventId` VARCHAR(64) NULL,
    `expected` VARCHAR(64) NULL,
    `observed` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reviewedAt` DATETIME(3) NULL,

    UNIQUE INDEX `PaymentReview_dedupeKey_key`(`dedupeKey`),
    INDEX `PaymentReview_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `PaymentReview_invoiceId_idx`(`invoiceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PaymentReview` ADD CONSTRAINT `PaymentReview_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `Invoice`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

