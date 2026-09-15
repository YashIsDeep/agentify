-- Phases and triggers become one ordered list of actions per stage. The data was already converted by
-- src/db/flatten-phases.ts, which runs before migrations.
-- Tables are rebuilt before the phase tables are dropped: foreign keys stay on inside the migration's
-- transaction, and dropping `phase_states` would otherwise cascade into `action_runs`.
CREATE TABLE `__new_action_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`visit_id` text NOT NULL,
	`binding_id` text,
	`binding_key` text NOT NULL,
	`label` text NOT NULL,
	`action_type` text NOT NULL,
	`config` text NOT NULL,
	`overrides` text,
	`batch_id` text NOT NULL,
	`batch_position` integer NOT NULL,
	`status` text NOT NULL,
	`continue_on_failure` integer DEFAULT false NOT NULL,
	`retry_of_run_id` integer,
	`outputs` text,
	`error` text,
	`session_id` text,
	`usage` text,
	`question` text,
	`resume_at` integer,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`visit_id`) REFERENCES `stage_visits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_action_runs`(`id`, `task_id`, `visit_id`, `binding_id`, `binding_key`, `label`, `action_type`, `config`, `overrides`, `batch_id`, `batch_position`, `status`, `continue_on_failure`, `retry_of_run_id`, `outputs`, `error`, `session_id`, `usage`, `question`, `resume_at`, `created_at`, `started_at`, `ended_at`) SELECT `id`, `task_id`, `visit_id`, `binding_id`, `binding_key`, `label`, `action_type`, `config`, `overrides`, `batch_id`, `batch_position`, `status`, false, `retry_of_run_id`, `outputs`, `error`, `session_id`, `usage`, `question`, `resume_at`, `created_at`, `started_at`, `ended_at` FROM `action_runs`;--> statement-breakpoint
DROP TABLE `action_runs`;--> statement-breakpoint
ALTER TABLE `__new_action_runs` RENAME TO `action_runs`;--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `action_runs` (`status`);--> statement-breakpoint
CREATE INDEX `runs_task_idx` ON `action_runs` (`task_id`,`binding_key`);--> statement-breakpoint
CREATE INDEX `runs_visit_idx` ON `action_runs` (`visit_id`);--> statement-breakpoint
CREATE INDEX `runs_batch_idx` ON `action_runs` (`batch_id`,`batch_position`);--> statement-breakpoint
CREATE TABLE `__new_action_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`stage_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`action_type` text NOT NULL,
	`config` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`continue_on_failure` integer DEFAULT false NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stage_id`) REFERENCES `stages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_action_bindings`(`id`, `workflow_id`, `stage_id`, `key`, `label`, `action_type`, `config`, `enabled`, `continue_on_failure`, `position`) SELECT `id`, `workflow_id`, `stage_id`, `key`, `label`, `action_type`, `config`, `enabled`, false, `position` FROM `action_bindings`;--> statement-breakpoint
DROP TABLE `action_bindings`;--> statement-breakpoint
ALTER TABLE `__new_action_bindings` RENAME TO `action_bindings`;--> statement-breakpoint
CREATE UNIQUE INDEX `bindings_workflow_key_idx` ON `action_bindings` (`workflow_id`,`key`);--> statement-breakpoint
CREATE INDEX `bindings_stage_idx` ON `action_bindings` (`stage_id`,`position`);--> statement-breakpoint
DROP TABLE `phase_states`;--> statement-breakpoint
DROP TABLE `phases`;
