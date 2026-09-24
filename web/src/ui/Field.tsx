import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { cls } from "../lib/format";
import { InfoTip } from "./Tooltip";
import "./field.css";

interface LabelProps {
  label: ReactNode;
  /** Marks a field you can leave blank. Required is the default and isn't marked. */
  optional?: boolean;
  /** Detail behind an info icon beside the label. */
  tip?: ReactNode;
}

function LabelText({ label, optional, tip }: LabelProps) {
  return (
    <span className="ui-field__label">
      {label}
      {optional && <span className="ui-field__optional">Optional</span>}
      {tip && <InfoTip>{tip}</InfoTip>}
    </span>
  );
}

/**
 * A labelled form control: put one native input, select or textarea (or a kit select such as
 * ModelSelect) inside. `error` shows under it in red; `note` is for the rare line that must be read
 * before submitting — everything else belongs in `tip`.
 *
 * Renders a <label>, so clicking the label focuses the control. For a field made of several controls
 * (a list of links, key/value rows) pass `group`: it becomes a <fieldset> with a <legend>.
 */
export function Field({
  label,
  optional,
  tip,
  error,
  note,
  group = false,
  grow = false,
  className,
  children,
}: LabelProps & {
  error?: ReactNode;
  note?: ReactNode;
  group?: boolean;
  /** Takes twice the share of the room in a FieldRow. */
  grow?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const classes = cls("ui-field", grow && "ui-field--grow", className);
  const extra = (
    <>
      {error && <FieldError>{error}</FieldError>}
      {note && <span className="ui-field__note">{note}</span>}
    </>
  );
  if (group) {
    return (
      <fieldset className={classes}>
        <legend>
          <LabelText label={label} optional={optional} tip={tip} />
        </legend>
        {children}
        {extra}
      </fieldset>
    );
  }
  return (
    <label className={classes}>
      <LabelText label={label} optional={optional} tip={tip} />
      {children}
      {extra}
    </label>
  );
}

/** An error under a control that checks its own value (ModelSelect); inside a Field, use its `error`. */
export function FieldError({ children }: { children: ReactNode }) {
  return (
    <span className="ui-field__error" role="alert">
      {children}
    </span>
  );
}

/** Fields side by side, stacking on narrow screens. */
export function FieldRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cls("ui-field-row", className)}>{children}</div>;
}

/** A vertical stack of fields with the standard gap: the body of any form. */
export function FormStack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cls("ui-form-stack", className)}>{children}</div>;
}

/** A search box with its magnifier. `label` is the accessible name; the placeholder says what it searches. */
export function SearchInput({
  value,
  onChange,
  label,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={cls("ui-search", className)}>
      <Search size={14} aria-hidden="true" />
      <input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label} />
    </label>
  );
}

/** A checkbox with its label to the right. `onChange` gets the new checked state. */
export function Checkbox({
  checked,
  onChange,
  label,
  tip,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  tip?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label className={cls("ui-checkbox", disabled && "ui-checkbox--disabled", className)}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>
        {label}
        {tip && <InfoTip>{tip}</InfoTip>}
      </span>
    </label>
  );
}
