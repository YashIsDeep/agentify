import { Search, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EMOJI_GROUPS, type EmojiEntry, searchEmoji } from "../lib/emoji";
import { cls } from "../lib/format";
import { WorkflowIcon } from "./WorkflowIcon";

/** Emoji per row; the grid's CSS uses the same number, and arrow keys step by it. */
const COLUMNS = 8;
/** Kept clear of the viewport edges when the panel is nudged back on screen. */
const MARGIN = 8;

/**
 * Picks the emoji for a workflow. The trigger shows the current icon, so the button doubles as the
 * icon everywhere the picker appears.
 */
export function EmojiPicker({
  value,
  onChange,
  triggerClassName,
  triggerSize = 20,
  label = "Change icon",
}: {
  value: string;
  onChange: (icon: string) => void;
  triggerClassName?: string;
  triggerSize?: number;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  /** null while the search box is empty, which is when the groups are shown instead. */
  const results = useMemo(() => (query.trim() ? searchEmoji(query) : null), [query]);

  /**
   * The panel is fixed rather than absolute, so a dialog or a drawer with its own overflow can't clip
   * it. That means placing it by hand: under the trigger when it fits, above it when it doesn't, and
   * nudged back inside the viewport horizontally.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    // offsetWidth/Height, not the client rect: the open animation scales the panel, and a measurement
    // taken mid-animation would put it a few pixels off.
    const { offsetWidth: width, offsetHeight: height } = panel;
    const below = trigger.bottom + MARGIN;
    const fitsBelow = below + height <= window.innerHeight - MARGIN;
    const clamp = (value: number, limit: number) => Math.max(MARGIN, Math.min(value, limit - MARGIN));
    setPosition({
      // Clamped as well as flipped, so a panel taller than the space either side still lands on screen.
      top: clamp(fitsBelow ? below : trigger.top - MARGIN - height, window.innerHeight - height),
      left: clamp(trigger.left, window.innerWidth - width),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    // A fixed panel would drift away from its trigger, so anything that moves the trigger closes it.
    const dismiss = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  };

  const pick = (icon: string) => {
    onChange(icon);
    close();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return;
    if (event.key === "Escape") {
      // Stop here so the dialog or drawer behind the picker stays open.
      event.stopPropagation();
      close();
      return;
    }
    const cells = cellRefs.current.filter((cell): cell is HTMLButtonElement => cell !== null);
    const index = cells.indexOf(document.activeElement as HTMLButtonElement);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[event.key];
    if (step === undefined || cells.length === 0) return;
    event.preventDefault();
    // From the search box, any arrow key enters the grid at the first emoji.
    if (index === -1) {
      cells[0]?.focus();
      return;
    }
    cells[index + step]?.focus();
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
    <div className="emoji-picker" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={cls("emoji-trigger", triggerClassName)}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((isOpen) => !isOpen)}
      >
        <WorkflowIcon icon={value} size={triggerSize} />
      </button>
      {open && (
        <div className="emoji-panel" ref={panelRef} role="dialog" aria-label="Pick an icon" style={position}>
          <div className="emoji-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search icons"
              aria-label="Search icons"
              autoFocus
            />
            {value && (
              <button type="button" className="link-button" onClick={() => pick("")}>
                <X size={13} />
                Remove
              </button>
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
      )}
    </div>
  );
}
