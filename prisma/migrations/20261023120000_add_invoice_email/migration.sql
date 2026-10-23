-- AlterTable: stored line items and invoice email workflow state (additive, all nullable)
ALTER TABLE `Invoice` ADD COLUMN `lineItems` JSON NULL,
    ADD COLUMN `emailState` ENUM('SENDING', 'UNKNOWN', 'ACCEPTED') NULL,
    ADD COLUMN `emailStateAt` DATETIME(3) NULL;
