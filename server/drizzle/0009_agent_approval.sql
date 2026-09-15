ALTER TABLE `action_runs` ADD `follow_up` text;
--> statement-breakpoint
-- Approvals used to sit in 'running' while they waited; they have their own status now.
UPDATE `action_runs` SET `status` = 'awaiting-approval' WHERE `status` = 'running' AND `action_type` = 'approval';
