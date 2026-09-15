import { Check, type LucideIcon } from "lucide-react";
import { Fragment, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { cls } from "../lib/format";

export interface MenuItem {
  key: string;
  label: string;
  icon?: LucideIcon;
  /** A quieter second line under the label. */
  hint?: string;
  /** Leave undefined for plain actions; true/false marks a choice in a `checkActive` menu. */
  active?: boolean;
  /** Draws a divider above this item. */
  divided?: boolean;
  onSelect: () => void;
}

/** A trigger button and a dropdown list. Closes on pick, outside click, Tab or Escape. */
export function Menu({
  label,
  trigger,
  triggerLabel,
  triggerClassName,
  title,
  items,
  align = "right",
  checkActive = false,
}: {
  /** Accessible name of the list. */
  label: string;
  trigger: ReactNode;
  /** Accessible name of the trigger, for icon-only triggers. */
  triggerLabel?: string;
  triggerClassName?: string;
  title?: string;
  items: MenuItem[];
  align?: "left" | "right";
  /** Tick the active item, for menus that pick one of several. */
  checkActive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.active),
  );

  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, activeIndex]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return;
    const buttons = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      // Stop here so an open task drawer doesn't close along with the menu.
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className="menu-root" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-label={triggerLabel}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
      </button>
      {open && (
        <div className={cls("menu", align === "left" && "menu-left")} role="menu" aria-label={label}>
          {items.map((item, index) => {
            const choice = checkActive && item.active !== undefined;
            return (
              <Fragment key={item.key}>
                {item.divided && <div className="menu-divider" role="separator" />}
                <button
                  ref={(element) => {
                    itemRefs.current[index] = element;
                  }}
                  type="button"
                  role={choice ? "menuitemradio" : "menuitem"}
                  aria-checked={choice ? item.active : undefined}
                  className={cls("menu-item", item.active && "menu-item-active")}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  {item.icon && <item.icon size={15} />}
                  <span className="menu-item-text">
                    <span>{item.label}</span>
                    {item.hint && <span className="menu-item-hint">{item.hint}</span>}
                  </span>
                  {choice && item.active && <Check size={15} className="menu-item-check" />}
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
