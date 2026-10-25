-- FR-AUD-1: audit_log is append-only. Block UPDATE and DELETE at the database.
CREATE TRIGGER IF NOT EXISTS `audit_log_no_update` BEFORE UPDATE ON `audit_log`
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `audit_log_no_delete` BEFORE DELETE ON `audit_log`
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
