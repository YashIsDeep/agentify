import { X } from "lucide-react";
import { Dialog as Primitive, VisuallyHidden } from "radix-ui";
import type { FormEvent, ReactNode } from "react";
import { cls } from "../lib/format";
import { Button, IconButton } from "./Button";
import "./dialog.css";

const WIDTH = { sm: 440, md: 540, lg: 660, xl: 860 } as const;

/**
 * A modal dialog, open for as long as it is mounted: render it conditionally and close it through
 * `onClose`, which Escape, the backdrop and the ✕ all call. With `onSubmit` the body and footer are
 * one form, so Enter submits and the footer's `type="submit"` button is the default.
 *
 * On open, focus goes to an `autoFocus` child if there is one, else the first field, else the main
 * button, rather than to the ✕. Nested dialogs stack; Escape closes only the top one.
 */
export function Dialog({
  title,
  onClose,
  onSubmit,
  size = "sm",
  bare = false,
  className,
  children,
}: {
  title: string;
  onClose: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  size?: keyof typeof WIDTH;
  /** No header or padding: the content draws its own (the agent chat). The title stays for screen readers. */
  bare?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const content = onSubmit ? (
    <form
      className="ui-dialog__form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(event);
      }}
    >
      {children}
    </form>
  ) : (
    children
  );

  return (
    <Primitive.Root open onOpenChange={(open) => !open && onClose()}>
      <Primitive.Portal>
        <Primitive.Overlay className="ui-dialog-overlay" />
        <Primitive.Content
          className={cls("ui-dialog", bare && "ui-dialog--bare", className)}
          style={bare ? undefined : { width: WIDTH[size] }}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            const dialog = event.currentTarget as HTMLElement;
            // An autoFocus child has already taken focus by the time this runs.
            if (dialog.contains(document.activeElement)) return event.preventDefault();
            const target = dialog.querySelector<HTMLElement>(
              "input:not([type=hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled), .ui-dialog__footer .ui-button--primary:not(:disabled)",
            );
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          {bare ? (
            <VisuallyHidden.Root>
              <Primitive.Title>{title}</Primitive.Title>
            </VisuallyHidden.Root>
          ) : (
            <header className="ui-dialog__header">
              <Primitive.Title className="ui-dialog__title">{title}</Primitive.Title>
              <IconButton label="Close" icon={X} onClick={onClose} />
            </header>
          )}
          {content}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

/**
 * The dialog's scrolling middle. `lead` names the thing the dialog acts on ("Delete workflow" →
 * the workflow's name), in bold above the rest. A plain <ul> inside lists consequences.
 */
export function DialogBody({ lead, children, className }: { lead?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cls("ui-dialog__body", className)}>
      {lead && <p className="ui-dialog__lead">{lead}</p>}
      {children}
    </div>
  );
}

/**
 * The button row: anything in `start` on the left (a destructive extra), then Cancel, then the
 * dialog's own buttons. Cancel is disabled with `busy`, so a request in flight can't be abandoned.
 */
export function DialogFooter({
  onCancel,
  cancelLabel = "Cancel",
  busy = false,
  start,
  children,
}: {
  /** Omit when the dialog's own button is the only way out. */
  onCancel?: () => void;
  /** When the main action is itself a cancel ("Cancel action"), say what backing out keeps instead. */
  cancelLabel?: string;
  busy?: boolean;
  start?: ReactNode;
  children: ReactNode;
}) {
  return (
    <footer className="ui-dialog__footer">
      {start}
      <span className="spacer" />
      {onCancel && (
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </Button>
      )}
      {children}
    </footer>
  );
}

/** Whether a dialog is open, for page-level shortcuts that must stand aside while one is. */
export const isDialogOpen = () => document.querySelector(".ui-dialog") !== null;
