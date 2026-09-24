import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isTicketLinkType, type TicketDraft, type WorkflowDef } from "@wm/shared";
import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useApi } from "../api-context";
import { cleanLinks, hasIssueKey, type LinkDraft } from "../lib/links";
import { Button, Callout, Dialog, DialogBody, DialogFooter, Field, FieldRow, FormStack, useToast } from "../ui";
import { LinksField } from "./LinksField";
import { RepoFields, WorktreeCheck } from "./RepoFields";

export function NewTaskDialog({
  workflows,
  defaultWorkflowId,
  onClose,
  onCreated,
}: {
  workflows: WorkflowDef[];
  defaultWorkflowId: string;
  onClose: () => void;
  onCreated: (task: { id: string; workflowId: string }) => void;
}) {
  const api = useApi();
  const [form, setForm] = useState({
    workflowId: defaultWorkflowId,
    stageId: "",
    title: "",
    description: "",
    repoPath: "",
    baseBranch: "",
    useWorktree: true,
  });
  // One empty row up front, so there's somewhere to paste the ticket straight away.
  const [links, setLinks] = useState<LinkDraft[]>([{ type: "", value: "" }]);

  // The first Jira or Linear link is the ticket the title and description can be drafted from.
  const ticket = links.find((link) => isTicketLinkType(link.type) && hasIssueKey(link.value));
  const ticketKey = ticket ? `${ticket.type}:${ticket.value.trim()}` : null;
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState<{ tone: "success" | "warn" | "danger"; text: string } | null>(null);
  /** The ticket last drafted from, so the same one isn't drafted again on its own. */
  const draftedFrom = useRef<string | null>(null);
  /** Only the newest request may fill the form. */
  const latestDraft = useRef(0);

  const fillFromTicket = (link: LinkDraft, onlyBlank: boolean) => {
    const request = ++latestDraft.current;
    draftedFrom.current = `${link.type}:${link.value.trim()}`;
    setDrafting(true);
    setDraftNote(null);
    api
      .draftFromTicket({ type: link.type, value: link.value.trim() })
      .then(
        (draft) => {
          if (request !== latestDraft.current) return;
          // Typing while the draft was on its way wins over the draft.
          setForm((current) => ({
            ...current,
            title: onlyBlank && current.title.trim() ? current.title : draft.title,
            description: onlyBlank && current.description.trim() ? current.description : draft.description,
          }));
          setDraftNote(draftNoteFor(draft));
        },
        (error: Error) => {
          if (request === latestDraft.current) setDraftNote({ tone: "danger", text: error.message });
        },
      )
      .finally(() => {
        if (request === latestDraft.current) setDrafting(false);
      });
  };

  // A ticket added to a blank form fills it in, once the link has stopped changing.
  const blank = !form.title.trim() && !form.description.trim();
  useEffect(() => {
    if (!ticket || !blank || ticketKey === draftedFrom.current) return;
    const timer = setTimeout(() => fillFromTicket(ticket, true), 700);
    return () => clearTimeout(timer);
  }, [ticketKey, blank]);
  const set = (key: "workflowId" | "stageId" | "title" | "description") => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value, ...(key === "workflowId" ? { stageId: "" } : {}) }));
  const workflow = workflows.find((w) => w.id === form.workflowId);

  const queryClient = useQueryClient();
  const toast = useToast();
  const create = useMutation({
    mutationFn: () =>
      api.createTask({
        workflowId: form.workflowId,
        stageId: form.stageId || undefined,
        title: form.title,
        description: form.description,
        repoPath: form.repoPath.trim() || null,
        baseBranch: form.baseBranch.trim() || null,
        useWorktree: form.useWorktree,
        links: cleanLinks(links),
      }),
    onSuccess: (detail) => {
      queryClient.setQueryData(["task", detail.task.id], detail);
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast(`Created “${detail.task.title}”`);
      onCreated(detail.task);
    },
    onError: (error) => toast(error.message, "error"),
  });

  const submit = () => {
    if (form.title.trim()) create.mutate();
  };

  // A link row needs a value to become a link, and useWorktree only matters with a repo path.
  const dirty =
    form.title.trim() !== "" ||
    form.description.trim() !== "" ||
    form.repoPath.trim() !== "" ||
    form.baseBranch.trim() !== "" ||
    form.stageId !== "" ||
    form.workflowId !== defaultWorkflowId ||
    links.some((link) => link.value.trim() !== "");

  // Escape, the backdrop, the X and Cancel all close through here, so a form with something in it
  // is never thrown away by a stray keypress or a misplaced click.
  const requestClose = () => {
    if (!dirty || window.confirm("Discard this task? What you've entered will be lost.")) onClose();
  };

  return (
    <Dialog title="New task" size="md" onClose={requestClose} onSubmit={submit}>
      <DialogBody>
        {/* The only required field, and the one the manual path starts at, so it takes focus. */}
        <Field label="Title">
          <input
            value={form.title}
            onChange={set("title")}
            placeholder={drafting ? "Drafting from the ticket…" : "Add login page"}
            autoFocus
            required
          />
        </Field>
        <Field label="Description" optional>
          <textarea
            value={form.description}
            onChange={set("description")}
            rows={4}
            placeholder={drafting ? "Drafting from the ticket…" : "Markdown supported"}
          />
        </Field>
        {/* The other way in: right below the fields it fills, so it needs no extra click. */}
        <FormStack>
          <LinksField
            links={links}
            onChange={setLinks}
            optional
            tip="Paste a Jira or Linear link and the title and description fill in from the ticket."
          />
          {ticket && (
            <div>
              <Button
                size="sm"
                icon={Sparkles}
                loading={drafting}
                loadingText="Reading the ticket…"
                onClick={() => {
                  if (blank || window.confirm("Replace the title and description with a draft from the ticket?")) {
                    fillFromTicket(ticket, false);
                  }
                }}
              >
                Fill in from ticket
              </Button>
            </div>
          )}
          {ticket && draftNote && <Callout tone={draftNote.tone}>{draftNote.text}</Callout>}
        </FormStack>
        <FieldRow>
          <Field label="Workflow">
            <select value={form.workflowId} onChange={set("workflowId")}>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Start in">
            <select value={form.stageId} onChange={set("stageId")}>
              {workflow?.stages.map((stage, index) => (
                <option key={stage.id} value={index === 0 ? "" : stage.id}>
                  {stage.name}
                </option>
              ))}
            </select>
          </Field>
        </FieldRow>
        <RepoFields
          repoPath={form.repoPath}
          baseBranch={form.baseBranch}
          optional
          onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
        />
        {form.repoPath.trim() !== "" && (
          <WorktreeCheck
            checked={form.useWorktree}
            onChange={(useWorktree) => setForm((current) => ({ ...current, useWorktree }))}
          />
        )}
      </DialogBody>
      <DialogFooter onCancel={requestClose} busy={create.isPending}>
        <Button type="submit" variant="primary" disabled={!form.title.trim()} loading={create.isPending} loadingText="Creating…">
          Create task
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function draftNoteFor(draft: TicketDraft): { tone: "success" | "warn"; text: string } {
  if (draft.warning) return { tone: "warn", text: draft.warning };
  if (!draft.drafter) return { tone: "success", text: `Copied from ${draft.issueKey}.` };
  return { tone: "success", text: `Drafted from ${draft.issueKey} by ${draft.drafter.model ?? draft.drafter.agent}.` };
}
