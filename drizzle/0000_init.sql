CREATE TABLE `application_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`doc_code` text NOT NULL,
	`required` integer DEFAULT true NOT NULL,
	`min_files` integer DEFAULT 1 NOT NULL,
	`state` text DEFAULT 'missing' NOT NULL,
	`current_version_id` text,
	`reviewer_id` text,
	`reviewer_reason_code` text,
	`reviewer_note` text,
	`reviewed_at` text,
	`updated_at` text,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_docs_app_code_uq` ON `application_documents` (`application_id`,`doc_code`);--> statement-breakpoint
CREATE INDEX `app_docs_app_state_idx` ON `application_documents` (`application_id`,`state`);--> statement-breakpoint
CREATE INDEX `app_docs_state_idx` ON `application_documents` (`state`,`doc_code`);--> statement-breakpoint
CREATE TABLE `application_events` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`actor_id` text,
	`visible_to_student` integer DEFAULT true NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `app_events_app_at_idx` ON `application_events` (`application_id`,`at`);--> statement-breakpoint
CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`ref` text,
	`student_id` text NOT NULL,
	`rule_set_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_expiry` text,
	`no_pass` integer DEFAULT false NOT NULL,
	`requested_months` integer,
	`notes` text,
	`fee_status` text DEFAULT 'unpaid' NOT NULL,
	`submitted_at` text,
	`claimed_by` text,
	`claimed_until` text,
	`approved_at` text,
	`approved_by` text,
	`sent_at` text,
	`sent_method` text,
	`pass_issued_at` text,
	`new_expiry` text,
	`closed_at` text,
	`withdrawn_at` text,
	`corrections_round` integer DEFAULT 0 NOT NULL,
	`last_activity_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text,
	FOREIGN KEY (`student_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rule_set_id`) REFERENCES `rule_sets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_ref_uq` ON `applications` (`ref`);--> statement-breakpoint
CREATE INDEX `applications_status_expiry_idx` ON `applications` (`status`,`current_expiry`);--> statement-breakpoint
CREATE INDEX `applications_student_idx` ON `applications` (`student_id`);--> statement-breakpoint
CREATE INDEX `applications_expiry_idx` ON `applications` (`current_expiry`);--> statement-breakpoint
CREATE INDEX `applications_fee_idx` ON `applications` (`fee_status`);--> statement-breakpoint
CREATE INDEX `applications_activity_idx` ON `applications` (`last_activity_at`);--> statement-breakpoint
CREATE INDEX `applications_submitted_idx` ON `applications` (`submitted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `applications_one_active_uq` ON `applications` (`student_id`) WHERE status NOT IN ('pass_issued','closed','withdrawn');--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`meta` text DEFAULT '{}' NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_prev_hash_uq` ON `audit_log` (`prev_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_hash_uq` ON `audit_log` (`hash`);--> statement-breakpoint
CREATE INDEX `audit_log_target_idx` ON `audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_idx` ON `audit_log` (`actor_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_action_idx` ON `audit_log` (`action`,`at`);--> statement-breakpoint
CREATE TABLE `document_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`application_document_id` text NOT NULL,
	`application_id` text NOT NULL,
	`seq` integer NOT NULL,
	`page` integer DEFAULT 1 NOT NULL,
	`storage_key` text NOT NULL,
	`thumb_key` text,
	`content_type` text DEFAULT 'image/jpeg' NOT NULL,
	`sha256` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`bytes` integer NOT NULL,
	`quality` text,
	`uploaded_by` text NOT NULL,
	`uploaded_at` text NOT NULL,
	`superseded_at` text,
	`deleted_at` text,
	FOREIGN KEY (`application_document_id`) REFERENCES `application_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `doc_versions_doc_seq_uq` ON `document_versions` (`application_document_id`,`seq`);--> statement-breakpoint
CREATE INDEX `doc_versions_app_sha_idx` ON `document_versions` (`application_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`body` text NOT NULL,
	`internal` integer DEFAULT false NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_app_at_idx` ON `messages` (`application_id`,`at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text,
	`recipient_id` text,
	`kind` text NOT NULL,
	`channel` text DEFAULT 'email' NOT NULL,
	`dedupe_key` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`provider_id` text,
	`created_at` text NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe_uq` ON `notifications` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notifications_status_idx` ON `notifications` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_app_idx` ON `notifications` (`application_id`);--> statement-breakpoint
CREATE INDEX `notifications_recipient_idx` ON `notifications` (`recipient_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `otp_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`consumed_at` text,
	`ip` text
);
--> statement-breakpoint
CREATE INDEX `otp_codes_email_idx` ON `otp_codes` (`email`,`created_at`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`to` text NOT NULL,
	`subject` text NOT NULL,
	`text` text NOT NULL,
	`html` text,
	`kind` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_created_idx` ON `outbox` (`created_at`);--> statement-breakpoint
CREATE TABLE `packets` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`status` text DEFAULT 'generating' NOT NULL,
	`generated_by` text NOT NULL,
	`storage_key` text,
	`sha256` text,
	`bytes` integer,
	`manifest` text,
	`error` text,
	`created_at` text NOT NULL,
	`ready_at` text,
	`sent_at` text,
	`sent_method` text,
	`sent_by` text,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `packets_app_idx` ON `packets` (`application_id`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`amount_ugx` integer NOT NULL,
	`paid_on` text NOT NULL,
	`reference` text,
	`receipt_key` text,
	`recorded_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `payments_app_idx` ON `payments` (`application_id`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`full_name` text,
	`role` text DEFAULT 'student' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`email_status` text DEFAULT 'ok' NOT NULL,
	`invited_by` text,
	`last_login_at` text,
	`created_at` text NOT NULL,
	`updated_at` text,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_email_uq` ON `profiles` (`email`);--> statement-breakpoint
CREATE INDEX `profiles_role_idx` ON `profiles` (`role`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`key`, `window_start`)
);
--> statement-breakpoint
CREATE TABLE `reason_templates` (
	`code` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ref_counters` (
	`year` integer PRIMARY KEY NOT NULL,
	`last` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rule_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_set_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`help_text` text DEFAULT '' NOT NULL,
	`where_to_get` text DEFAULT '' NOT NULL,
	`example_path` text,
	`applies_to_types` text,
	`min_files` integer DEFAULT 1 NOT NULL,
	`source` text DEFAULT 'notice' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`rule_set_id`) REFERENCES `rule_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_documents_set_code_uq` ON `rule_documents` (`rule_set_id`,`code`);--> statement-breakpoint
CREATE TABLE `rule_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`fee_usd` integer NOT NULL,
	`fee_note` text,
	`penalty_usd_per_day` integer NOT NULL,
	`apply_before_days` integer NOT NULL,
	`max_pass_months` integer NOT NULL,
	`exempt_countries` text NOT NULL,
	`reminder_days` text NOT NULL,
	`notice_date` text,
	`submission_email` text,
	`published_at` text,
	`published_by` text,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_sets_version_uq` ON `rule_sets` (`version`);--> statement-breakpoint
CREATE INDEX `rule_sets_status_idx` ON `rule_sets` (`status`);--> statement-breakpoint
CREATE TABLE `runway_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`expiry` text NOT NULL,
	`day` integer NOT NULL,
	`band` text NOT NULL,
	`flagged_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`student_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runway_flags_uq` ON `runway_flags` (`student_id`,`expiry`,`day`);--> statement-breakpoint
CREATE INDEX `runway_flags_open_idx` ON `runway_flags` (`resolved_at`,`band`);--> statement-breakpoint
CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`filters` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saved_views_owner_idx` ON `saved_views` (`owner_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`profile_id` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`ip` text,
	`user_agent` text,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_uq` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_profile_idx` ON `sessions` (`profile_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `students` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`student_no` text,
	`nationality` text,
	`student_type` text,
	`programme` text,
	`phone` text,
	`pass_expiry` text,
	`no_pass` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `students_student_no_uq` ON `students` (`student_no`);--> statement-breakpoint
CREATE INDEX `students_pass_expiry_idx` ON `students` (`pass_expiry`);