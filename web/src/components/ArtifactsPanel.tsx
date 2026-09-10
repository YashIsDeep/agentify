import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import { cls, fileSize, relativeTime } from "../lib/format";

export function ArtifactsPanel({ taskId }: { taskId: string }) {
  const list = useQuery({ queryKey: ["artifacts", taskId], queryFn: () => api.artifacts(taskId) });
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const files = list.data ?? [];
  const selected = files.find((file) => file.name === selectedName) ?? files[0];

  const content = useQuery({
    // modifiedAt in the key refetches when an action rewrites the file.
    queryKey: ["artifact", taskId, selected?.name, selected?.modifiedAt],
    queryFn: () => api.artifact(taskId, selected!.name),
    enabled: !!selected,
  });

  if (list.isLoading) return <p className="muted small panel-pad">Loading artifacts…</p>;
  if (list.error) return <p className="error small panel-pad">{list.error.message}</p>;
  if (files.length === 0) {
    return (
      <div className="empty-state">
        <FileText size={22} />
        <strong>No artifacts yet</strong>
        <span>Actions write files like requirements.md here. Artifacts are kept after the task is archived.</span>
      </div>
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
            >
              <FileText size={14} />
              <span className="artifact-name">{file.name}</span>
              <span className="muted small">{fileSize(file.size)}</span>
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <div className="artifact-preview">
          <div className="artifact-preview-header">
            <strong>{selected.name}</strong>
            <span className="muted small">updated {relativeTime(selected.modifiedAt)}</span>
          </div>
          {content.isLoading ? (
            <p className="muted small">Loading…</p>
          ) : content.error ? (
            <p className="error small">{content.error.message}</p>
          ) : /\.(md|markdown)$/i.test(selected.name) ? (
            <div className="markdown">
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}
              >
                {content.data ?? ""}
              </Markdown>
            </div>
          ) : (
            <pre className="log artifact-text">{content.data}</pre>
          )}
        </div>
      )}
    </div>
  );
}
