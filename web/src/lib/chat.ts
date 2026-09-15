import type { RunLogLine } from "@wm/shared";

/**
 * A transcript line, grouped for reading. A tool call and the result that answers it become one
 * item, because on screen they are one thing: "it read this file, and here is what it got".
 */
export type ChatItem =
  | { key: string; kind: "prompt"; at: number; text: string }
  | { key: string; kind: "message"; at: number; text: string }
  | { key: string; kind: "question"; at: number; text: string }
  | { key: string; kind: "answer"; at: number; text: string }
  | { key: string; kind: "notice"; at: number; text: string; error: boolean }
  | { key: string; kind: "output"; at: number; lines: RunLogLine[] }
  | {
      key: string;
      kind: "tool";
      at: number;
      tool: string;
      detail: string;
      /** The CLI's own id for the call, when it gave one. */
      ref: string | undefined;
      result: { at: number; ok: boolean; detail: string } | null;
    };

export function toChatItems(lines: RunLogLine[]): ChatItem[] {
  const items: ChatItem[] = [];
  const key = (line: RunLogLine, index: number) => `${index}-${line.at}`;

  for (const [index, line] of lines.entries()) {
    // The ask tool's call is shown as the question and answer turns; a tool row would repeat it.
    // A failed call is the exception: without it the chat never says the question went unanswered.
    if ((line.kind === "tool" || line.kind === "tool-result") && /(^|[_.])ask_user$/.test(line.tool ?? "")) {
      if (line.kind === "tool-result" && line.ok === false) {
        items.push({
          key: key(line, index),
          kind: "notice",
          at: line.at,
          text: `The question ended without an answer${line.text ? `: ${line.text}` : ""}`,
          error: true,
        });
      }
      continue;
    }
    switch (line.kind) {
      case "prompt":
      case "message":
      case "question":
      case "answer":
        items.push({ key: key(line, index), kind: line.kind, at: line.at, text: line.text });
        break;
      case "tool":
        items.push({
          key: key(line, index),
          kind: "tool",
          at: line.at,
          tool: line.tool ?? "tool",
          detail: line.text,
          ref: line.ref,
          result: null,
        });
        break;
      case "tool-result": {
        const call = openCall(items, line);
        const result = { at: line.at, ok: line.ok !== false, detail: line.text };
        if (call) call.result = result;
        // An orphan result still has to be visible; a lost call is better than a silent gap.
        else {
          items.push({
            key: key(line, index),
            kind: "tool",
            at: line.at,
            tool: line.tool ?? "tool",
            detail: "",
            ref: line.ref,
            result,
          });
        }
        break;
      }
      case "notice":
        items.push({ key: key(line, index), kind: "notice", at: line.at, text: line.text, error: line.stream === "stderr" });
        break;
      default:
        // Unstructured output: plain actions, or anything the agent's CLI printed raw.
        if (line.stream === "info") {
          items.push({ key: key(line, index), kind: "notice", at: line.at, text: line.text, error: false });
        } else {
          const last = items.at(-1);
          if (last?.kind === "output") last.lines.push(line);
          else items.push({ key: key(line, index), kind: "output", at: line.at, lines: [line] });
        }
    }
  }
  return items;
}

/** The call this result answers: the same id, or failing that the last unanswered call of that tool. */
function openCall(items: ChatItem[], line: RunLogLine): Extract<ChatItem, { kind: "tool" }> | undefined {
  const open = items.filter((item): item is Extract<ChatItem, { kind: "tool" }> => item.kind === "tool" && !item.result);
  if (line.ref) {
    const byRef = open.findLast((item) => item.ref === line.ref);
    if (byRef) return byRef;
  }
  return open.findLast((item) => item.tool === line.tool);
}

/** The whole transcript as plain text, for the copy button. */
export function transcriptText(lines: RunLogLine[]): string {
  return lines
    .map((line) => {
      const time = new Date(line.at).toLocaleTimeString();
      const prefix = line.kind === "tool" ? `▸ ${line.tool}` : line.kind === "tool-result" ? `  ↳ ${line.tool}` : line.kind;
      return `[${time}] ${prefix ? `${prefix}: ` : ""}${line.text}`;
    })
    .join("\n");
}
