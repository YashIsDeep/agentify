CREATE TABLE `action_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`stage_id` text NOT NULL,
	`phase_id` text,
	`after_binding_id` text,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`trigger` text NOT NULL,
	`action_type` text NOT NULL,
	`config` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`ask_feedback` integer DEFAULT false NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stage_id`) REFERENCES `stages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`phase_id`) REFERENCES `phases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`after_binding_id`) REFERENCES `action_bindings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bindings_workflow_key_idx` ON `action_bindings` (`workflow_id`,`key`);--> statement-breakpoint
CREATE INDEX `bindings_stage_trigger_idx` ON `action_bindings` (`stage_id`,`trigger`);--> statement-breakpoint
CREATE INDEX `bindings_after_idx` ON `action_bindings` (`after_binding_id`);--> statement-breakpoint
CREATE TABLE `action_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`visit_id` text NOT NULL,
	`phase_state_id` text,
	`binding_id` text,
	`binding_key` text NOT NULL,
	`label` text NOT NULL,
	`action_type` text NOT NULL,
	`trigger` text NOT NULL,
	`config` text NOT NULL,
	`overrides` text,
	`batch_id` text NOT NULL,
	`batch_position` integer NOT NULL,
	`status` text NOT NULL,
	`retry_of_run_id` integer,
	`parent_run_id` integer,
	`outputs` text,
	`error` text,
	`session_id` text,
	`usage` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`visit_id`) REFERENCES `stage_visits`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`phase_state_id`) REFERENCES `phase_states`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `action_runs` (`status`);--> statement-breakpoint
CREATE INDEX `runs_task_idx` ON `action_runs` (`task_id`,`binding_key`);--> statement-breakpoint
CREATE INDEX `runs_visit_idx` ON `action_runs` (`visit_id`);--> statement-breakpoint
CREATE INDEX `runs_batch_idx` ON `action_runs` (`batch_id`,`batch_position`);--> statement-breakpoint
CREATE INDEX `runs_phase_state_idx` ON `action_runs` (`phase_state_id`);--> statement-breakpoint
CREATE TABLE `phase_states` (
	`id` text PRIMARY KEY NOT NULL,
	`visit_id` text NOT NULL,
	`phase_id` text,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`completion` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`completed_by` text,
	FOREIGN KEY (`visit_id`) REFERENCES `stage_visits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `phase_states_visit_idx` ON `phase_states` (`visit_id`,`position`);--> statement-breakpoint
CREATE TABLE `phases` (
	`id` text PRIMARY KEY NOT NULL,
	`stage_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`completion` text NOT NULL,
	FOREIGN KEY (`stage_id`) REFERENCES `stages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `phases_stage_idx` ON `phases` (`stage_id`,`position`);--> statement-breakpoint
CREATE TABLE `stage_visits` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`stage_id` text NOT NULL,
	`stage_name` text NOT NULL,
	`attempt` integer NOT NULL,
	`entered_at` integer NOT NULL,
	`completed_at` integer,
	`exited_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `visits_task_idx` ON `stage_visits` (`task_id`,`stage_id`);--> statement-breakpoint
CREATE TABLE `stages` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`wip_limit` integer,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stages_workflow_idx` ON `stages` (`workflow_id`,`position`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`repo_path` text,
	`base_branch` text,
	`branch` text,
	`worktree_path` text,
	`links` text NOT NULL,
	`tags` text NOT NULL,
	`agent_override` text,
	`model_override` text,
	`last_feedback` text,
	`status` text DEFAULT 'active' NOT NULL,
	`current_stage_id` text,
	`current_visit_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tasks_workflow_status_idx` ON `tasks` (`workflow_id`,`status`);--> statement-breakpoint
CREATE TABLE `timeline_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`visit_id` text,
	`run_id` integer,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `timeline_task_idx` ON `timeline_events` (`task_id`,`id`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
