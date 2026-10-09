import { useQuery } from "@tanstack/react-query";
import type { ArtifactInfo } from "@wm/shared";
import { FileText } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useApi } from "../api-context";
import { cls, fileSize, relativeTime } from "../lib/format";
import { Dialog, DialogBody, EmptyState } from "../ui";
import { artifactLabel, sortedArtifacts } from "../lib/artifacts";

export function ArtifactsPanel({ taskId }: { taskId: string }) {
  const api = useApi();
  const list = useQuery({ queryKey: ["artifacts", taskId], queryFn: () => api.artifacts(taskId) });
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const files = sortedArtifacts(list.data ?? []);
  const selected = files.find((file) => file.name === selectedName) ?? files[0];

  if (list.isLoading) return <p className="muted small panel-pad">Loading artifacts…</p>;
  if (list.error) return <p className="error small panel-pad">{list.error.message}</p>;
  if (files.length === 0) {
    return (
      <EmptyState icon={FileText} title="No artifacts yet">
        Actions write files like requirements.md here. Artifacts are kept after the task is archived.
      </EmptyState>
    );
  }

  return (
    <div className="artifacts">
      <ul className="artifact-list">
        {files.map((file) => (
          <li key={file.name}>
            <button
              type="button"
              className={cls("artifact-item", file.name === selected?.name && "artifact-item-active")}
              onClick={() => setSelectedName(file.name)}
              title={file.name}
            >
              <FileText size={14} />
              <span className="artifact-name">{artifactLabel(file)}</span>
              <span className="muted small">{fileSize(file.size)}</span>
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <div className="artifact-preview">
          <div className="artifact-preview-header">
            <strong title={selected.name}>{artifactLabel(selected)}</strong>
            <span className="muted small">updated {relativeTime(selected.modifiedAt)}</span>
          </div>
          <ArtifactContent taskId={taskId} file={selected} />
        </div>
      )}
    </div>
  );
}

/**
 * The task's artifacts beside a review's diff, so the plan or requirements being signed off can be
 * read without leaving the chat. Hidden until an action has written one.
 */
export function ReviewArtifacts({ taskId }: { taskId: string }) {
  const api = useApi();
  const list = useQuery({ queryKey: ["artifacts", taskId], queryFn: () => api.artifacts(taskId) });
  const [openName, setOpenName] = useState<string | null>(null);
  const files = sortedArtifacts(list.data ?? []);
  const open = files.find((file) => file.name === openName);
  if (files.length === 0) return null;

  return (
    <div className="diff-panel">
      <div className="diff-head">
        <FileText size={14} />
        <strong>Artifacts</strong>
        <span className="muted small">
          {files.length} file{files.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="diff-files">
        {files.map((file) => (
          <li key={file.name}>
            <button type="button" className="diff-file" aria-haspopup="dialog" onClick={() => setOpenName(file.name)}>
              <FileText size={13} />
              <span className="diff-path" title={file.name}>{artifactLabel(file)}</span>
              <span className="muted small">{relativeTime(file.modifiedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <Dialog title={artifactLabel(open)} size="xl" onClose={() => setOpenName(null)}>
          <DialogBody>
            <ArtifactContent taskId={taskId} file={open} />
          </DialogBody>
        </Dialog>
      )}
    </div>
  );
}

/** One artifact's text: Markdown rendered, anything else as it is. */
function ArtifactContent({ taskId, file }: { taskId: string; file: ArtifactInfo }) {
  const api = useApi();
  const content = useQuery({
    // modifiedAt in the key refetches when an action rewrites the file.
    queryKey: ["artifact", taskId, file.name, file.modifiedAt],
    queryFn: () => api.artifact(taskId, file.name),
  });

  if (content.isLoading) return <p className="muted small">Loading…</p>;
  if (content.error) return <p className="error small">{content.error.message}</p>;
  if (!/\.(md|markdown)$/i.test(file.name)) return <pre className="log artifact-text">{content.data}</pre>;
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}>
        {content.data ?? ""}
      </Markdown>
    </div>
  );
}
