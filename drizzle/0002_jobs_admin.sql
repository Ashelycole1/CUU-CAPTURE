CREATE TABLE `deletion_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_at` text NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `deletion_requests_status_idx` ON `deletion_requests` (`status`,`requested_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `deletion_requests_one_pending_uq` ON `deletion_requests` (`profile_id`) WHERE status = 'pending';--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job` text NOT NULL,
	`run_key` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`cursor` text,
	`stats` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`last_error` text,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_runs_job_key_uq` ON `job_runs` (`job`,`run_key`);--> statement-breakpoint
CREATE INDEX `job_runs_job_started_idx` ON `job_runs` (`job`,`started_at`);--> statement-breakpoint
ALTER TABLE `applications` ADD `purged_at` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `next_attempt_at` text;