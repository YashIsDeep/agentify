ALTER TABLE `stages` ADD `stay_when_done` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Stages used to keep a task once their actions finished unless the last one moved it. Workflows
-- that already exist keep doing so: a stage whose last enabled action neither moves nor archives
-- the task is set to stay.
UPDATE `stages` SET `stay_when_done` = 1 WHERE (
  SELECT `action_type` FROM `action_bindings`
  WHERE `action_bindings`.`stage_id` = `stages`.`id` AND `action_bindings`.`enabled` = 1
  ORDER BY `position` DESC LIMIT 1
) NOT IN ('move-stage', 'archive-task');
