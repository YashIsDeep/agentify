import { Check, type LucideIcon } from "lucide-react";
import { DropdownMenu, Popover as PopoverPrimitive } from "radix-ui";
import { Fragment, type ReactElement, type ReactNode } from "react";
import { cls } from "../lib/format";
import "./menu.css";

export interface MenuItem {
  key: string;
  label: string;
  icon?: LucideIcon;
  /** A quieter second line under the label. */
  hint?: string;
  /** Marks the current choice in a menu that picks one of several; it gets a tick. */
  active?: boolean;
  /** Draws a divider above this item. */
  divided?: boolean;
  /** A destructive item, drawn in red. */
  danger?: boolean;
  onSelect: () => void;
}

type Side = "top" | "bottom";
type Align = "start" | "end";

/**
 * A list of actions or choices opened from a trigger. The trigger is one element that takes a ref
 * (a kit Button or IconButton); the menu places itself, flips when there's no room, and handles the
 * arrow keys, typeahead and Escape.
 */
export function Menu({
  label,
  trigger,
  items,
  side = "bottom",
  align = "end",
  width,
}: {
  /** Accessible name of the list. */
  label: string;
  trigger: ReactElement;
  items: MenuItem[];
  side?: Side;
  align?: Align;
  /** A fixed width, for menus whose hints would otherwise make it jump around. */
  width?: number;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="ui-menu"
          aria-label={label}
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          style={width ? { width } : undefined}
        >
          {items.map((item) => (
            <Fragment key={item.key}>
              {item.divided && <DropdownMenu.Separator className="ui-menu__divider" />}
              <DropdownMenu.Item
                className={cls("ui-menu__item", item.active && "ui-menu__item--active", item.danger && "ui-menu__item--danger")}
                onSelect={item.onSelect}
              >
                {item.icon && <item.icon size={15} aria-hidden="true" />}
                <span className="ui-menu__text">
                  <span>{item.label}</span>
                  {item.hint && <span className="ui-menu__hint">{item.hint}</span>}
                </span>
                {item.active && <Check size={15} className="ui-menu__check" aria-label="Current" />}
              </DropdownMenu.Item>
            </Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * A floating panel of anything (a list, a picker) opened from a trigger. Like Menu, the trigger is
 * one element that takes a ref, and the panel places and flips itself.
 */
export function Popover({
  label,
  trigger,
  side = "bottom",
  align = "start",
  width,
  open,
  onOpenChange,
  className,
  children,
}: {
  /** Accessible name of the panel. */
  label: string;
  trigger: ReactElement;
  side?: Side;
  align?: Align;
  width?: number;
  /** Controlled open state, for panels that close themselves (a picker after a pick). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className={cls("ui-popover", className)}
          aria-label={label}
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          style={width ? { width: `min(${width}px, calc(100vw - 16px))` } : undefined}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
