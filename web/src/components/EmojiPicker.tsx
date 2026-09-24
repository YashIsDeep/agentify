import { Search, X } from "lucide-react";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { EMOJI_GROUPS, type EmojiEntry, searchEmoji } from "../lib/emoji";
import { cls } from "../lib/format";
import { Button, Popover, Tooltip } from "../ui";
import { WorkflowIcon } from "./WorkflowIcon";

/** Emoji per row; the grid's CSS uses the same number, and arrow keys step by it. */
const COLUMNS = 8;

const TRIGGER_ICON = { md: 18, lg: 22 } as const;

/**
 * Picks the emoji for a workflow. The trigger shows the current icon, so the button doubles as the
 * icon everywhere the picker appears.
 */
export function EmojiPicker({
  value,
  onChange,
  size = "md",
  label = "Change icon",
}: {
  value: string;
  onChange: (icon: string) => void;
  size?: keyof typeof TRIGGER_ICON;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const cellRefs = useRef<(HTMLButtonElement | null)[]>([]);

  /** null while the search box is empty, which is when the groups are shown instead. */
  const results = useMemo(() => (query.trim() ? searchEmoji(query) : null), [query]);

  const setOpenAndReset = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const pick = (icon: string) => {
    onChange(icon);
    setOpenAndReset(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const cells = cellRefs.current.filter((cell): cell is HTMLButtonElement => cell !== null);
    const index = cells.indexOf(document.activeElement as HTMLButtonElement);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[event.key];
    if (step === undefined || cells.length === 0) return;
    event.preventDefault();
    // From the search box, any arrow key enters the grid at the first emoji.
    if (index === -1) cells[0]?.focus();
    else cells[index + step]?.focus();
  };

  cellRefs.current = [];
  let cellIndex = 0;
  const cell = (entry: EmojiEntry) => {
    const position = cellIndex++;
    return (
      <button
        key={entry.char}
        ref={(element) => {
          cellRefs.current[position] = element;
        }}
        type="button"
        className={cls("emoji-cell", entry.char === value && "emoji-cell-active")}
        title={entry.name}
        aria-label={entry.name}
        aria-pressed={entry.char === value}
        onClick={() => pick(entry.char)}
      >
        {entry.char}
      </button>
    );
  };

  return (
    <Popover
      label="Pick an icon"
      width={340}
      open={open}
      onOpenChange={setOpenAndReset}
      className="emoji-panel"
      trigger={
        <Tooltip content={label}>
          <button type="button" className={cls("emoji-trigger", `emoji-trigger--${size}`)} aria-label={label}>
            <WorkflowIcon icon={value} size={TRIGGER_ICON[size]} />
          </button>
        </Tooltip>
      }
    >
      <div onKeyDown={onKeyDown}>
        <div className="emoji-search">
          <Search size={14} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search icons" aria-label="Search icons" autoFocus />
          {value && (
            <Button variant="link" icon={X} onClick={() => pick("")}>
              Remove
            </Button>
          )}
        </div>
        <div className="emoji-scroll">
          {results ? (
            results.length > 0 ? (
              <div className="emoji-grid">{results.map(cell)}</div>
            ) : (
              <p className="muted small emoji-empty">No icon matches “{query.trim()}”.</p>
            )
          ) : (
            EMOJI_GROUPS.map((group) => (
              <section key={group.name}>
                <h4 className="emoji-group-name">{group.name}</h4>
                <div className="emoji-grid">{group.emoji.map(cell)}</div>
              </section>
            ))
          )}
        </div>
      </div>
    </Popover>
  );
}
