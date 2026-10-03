import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaskDetail } from "@wm/shared";
import { useEffect, useState } from "react";
import { useApi } from "./api-context";
import { useToast } from "./ui";

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Runs an API call that returns fresh task detail, updates caches, and toasts failures. */
export function useTaskAction() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation<TaskDetail, Error, () => Promise<TaskDetail>>({
    mutationFn: (call) => call(),
    onSuccess: (detail) => {
      queryClient.setQueryData(["task", detail.task.id], detail);
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => toast(error.message, "error"),
  });
}

/**
 * An action type's name as the workflow editor shows it ("Ensure worktree"), for anywhere that
 * would otherwise print its id ("ensure-worktree"). Falls back to the id until the list has loaded.
 */
export function useActionTypeLabel(): (type: string) => string {
  const api = useApi();
  const types = useQuery({ queryKey: ["action-types"], queryFn: api.actionTypes, staleTime: Infinity });
  return (type) => types.data?.find((info) => info.type === type)?.label ?? type;
}
