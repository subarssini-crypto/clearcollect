/*
  Warnings:

  - A unique constraint covering the columns `[paypalOrderId]` on the table `Invoice` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[paypalCaptureId]` on the table `Invoice` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `invoice` ADD COLUMN `paypalCaptureId` VARCHAR(191) NULL,
    ADD COLUMN `paypalOrderId` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `Invoice_paypalOrderId_key` ON `Invoice`(`paypalOrderId`);

-- CreateIndex
CREATE UNIQUE INDEX `Invoice_paypalCaptureId_key` ON `Invoice`(`paypalCaptureId`);
