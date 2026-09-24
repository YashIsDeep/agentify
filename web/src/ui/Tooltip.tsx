import { Info } from "lucide-react";
import { Tooltip as Primitive, Slot } from "radix-ui";
import { type ComponentProps, type ReactElement, type ReactNode, useState } from "react";
import "./tooltip.css";

/** Mount once at the root: tooltips share one open delay, and moving between them skips it. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <Primitive.Provider delayDuration={400}>{children}</Primitive.Provider>;
}

/**
 * A short label on hover or keyboard focus. The child must be one element that takes a ref (a
 * native element or a kit component). For icon-only buttons use IconButton, which does this itself.
 *
 * Any other props (a ref, handlers) pass through to the child, so a Tooltip can itself be the
 * trigger of a Menu or Popover.
 */
export function Tooltip({
  content,
  side = "top",
  children,
  ...passThrough
}: {
  content: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactElement;
} & ComponentProps<typeof Primitive.Trigger>) {
  if (!content) return <Slot.Root {...passThrough}>{children}</Slot.Root>;
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild {...passThrough}>
        {children}
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content className="ui-tooltip" side={side} sideOffset={6} collisionPadding={8}>
          {content}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

/**
 * An info icon beside a label or heading, holding detail that helps but isn't needed up front. Opens
 * on hover, focus, or a tap (touch has no hover).
 *
 * A span, not a button: it usually sits inside a <label>, and a button there would become the
 * label's control and take the input's name. Its click is cancelled so a checkbox label doesn't
 * toggle.
 */
export function InfoTip({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Primitive.Root open={open} onOpenChange={setOpen}>
      <Primitive.Trigger asChild>
        <span
          className="ui-info-tip"
          role="img"
          aria-label="More information"
          tabIndex={0}
          onClick={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          <Info size={13} aria-hidden="true" />
        </span>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content className="ui-tooltip ui-tooltip--rich" side="top" sideOffset={6} collisionPadding={8}>
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
