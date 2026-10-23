-- AlterTable: verified payment metadata (additive, nullable; existing rows stay NULL = "Unavailable")
ALTER TABLE `Invoice` ADD COLUMN `paidAt` DATETIME(3) NULL,
    ADD COLUMN `paypalEnvironment` ENUM('SANDBOX', 'LIVE') NULL;
