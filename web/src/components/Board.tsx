import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useQuery } from "@tanstack/react-query";
import type { StageDef, TaskSummary, WorkflowDef } from "@wm/shared";
import { useMemo, useState } from "react";
import { api } from "../api";
import { useNow } from "../hooks";
import { cls } from "../lib/format";
import { MoveDialog } from "./MoveDialog";
import { TaskCardView } from "./TaskCard";

export function Board({
  workflow,
  selectedTaskId,
  onOpenTask,
}: {
  workflow: WorkflowDef;
  selectedTaskId: string | null;
  onOpenTask: (id: string) => void;
}) {
  const now = useNow(30_000);
  const tasks = useQuery({
    queryKey: ["tasks", workflow.id, "active"],
    queryFn: () => api.tasks({ workflowId: workflow.id, status: "active" }),
  });
  const [dragging, setDragging] = useState<TaskSummary | null>(null);
  const [pendingMove, setPendingMove] = useState<{ task: TaskSummary; to: StageDef } | null>(null);

  const sensors = useSensors(
    // A small distance keeps plain clicks opening the task instead of starting a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] } }),
  );

  const byStage = useMemo(() => {
    const groups = new Map<string, TaskSummary[]>();
    for (const task of tasks.data ?? []) {
      const list = groups.get(task.currentStageId ?? "") ?? [];
      list.push(task);
      groups.set(task.currentStageId ?? "", list);
    }
    // Oldest arrival first, like a queue.
    for (const list of groups.values()) list.sort((a, b) => (a.enteredStageAt ?? 0) - (b.enteredStageAt ?? 0));
    return groups;
  }, [tasks.data]);

  const onDragStart = ({ active }: DragStartEvent) => {
    setDragging((active.data.current?.task as TaskSummary | undefined) ?? null);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    const task = active.data.current?.task as TaskSummary | undefined;
    const to = workflow.stages.find((stage) => stage.id === over?.id);
    if (task && to && to.id !== task.currentStageId) setPendingMove({ task, to });
  };

  if (tasks.error) return <div className="board-message error">Could not load tasks: {tasks.error.message}</div>;

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="board">
        {workflow.stages.map((stage) => (
          <Column
            key={stage.id}
            stage={stage}
            tasks={byStage.get(stage.id) ?? []}
            loading={tasks.isLoading}
            now={now}
            selectedTaskId={selectedTaskId}
            onOpenTask={onOpenTask}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>{dragging && <TaskCardView task={dragging} now={now} overlay />}</DragOverlay>
      {pendingMove && (
        <MoveDialog
          task={pendingMove.task}
          from={workflow.stages.find((stage) => stage.id === pendingMove.task.currentStageId)}
          to={pendingMove.to}
          onClose={() => setPendingMove(null)}
        />
      )}
    </DndContext>
  );
}

function Column({
  stage,
  tasks,
  loading,
  now,
  selectedTaskId,
  onOpenTask,
}: {
  stage: StageDef;
  tasks: TaskSummary[];
  loading: boolean;
  now: number;
  selectedTaskId: string | null;
  onOpenTask: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const overLimit = stage.wipLimit !== null && tasks.length > stage.wipLimit;

  return (
    <section ref={setNodeRef} className={cls("column", isOver && "column-over")} aria-label={stage.name}>
      <header className="column-header">
        <h3>{stage.name}</h3>
        <span className={cls("count", overLimit && "count-over")} title={overLimit ? "Over the WIP limit" : undefined}>
          {tasks.length}
          {stage.wipLimit !== null && `/${stage.wipLimit}`}
        </span>
      </header>
      <div className="column-phases">{stage.phases.map((phase) => phase.name).join(" → ")}</div>
      <div className="column-body">
        {tasks.map((task) => (
          <DraggableCard
            key={task.id}
            task={task}
            now={now}
            selected={task.id === selectedTaskId}
            onOpen={() => onOpenTask(task.id)}
          />
        ))}
        {!loading && tasks.length === 0 && <div className="column-empty">No tasks</div>}
      </div>
    </section>
  );
}

function DraggableCard({
  task,
  now,
  selected,
  onOpen,
}: {
  task: TaskSummary;
  now: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id, data: { task } });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      aria-label={`${task.title}. Press Enter to open, Space to move.`}
      className={cls("card-slot", isDragging && "card-slot-dragging")}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
        else listeners?.onKeyDown?.(event);
      }}
    >
      <TaskCardView task={task} now={now} selected={selected} />
    </div>
  );
}
