-- AlterTable
ALTER TABLE `Invoice` ADD COLUMN `paymentToken` VARCHAR(64) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `Invoice_paymentToken_key` ON `Invoice`(`paymentToken`);
