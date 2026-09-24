import type { LucideIcon } from "lucide-react";
import { type ComponentProps, isValidElement, type ReactElement, type ReactNode } from "react";
import { cls } from "../lib/format";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";
import "./button.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md";

const ICON_SIZE: Record<ButtonSize, number> = { sm: 13, md: 15 };

/** A lucide icon, drawn at the button's size, or an element (a brand mark) drawn as given. */
export type IconProp = LucideIcon | ReactElement;

export function renderIcon(icon: IconProp | undefined, size: number): ReactNode {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  const Icon = icon;
  return <Icon size={size} aria-hidden="true" />;
}

export interface ButtonProps extends ComponentProps<"button"> {
  /**
   * `primary` for the one main action in a view, `danger` for destructive ones, `link` for a
   * small inline action in running text ("Show output").
   */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon. */
  icon?: IconProp;
  /** Disables the button and shows a spinner, with `loadingText` in place of the label if given. */
  loading?: boolean;
  loadingText?: ReactNode;
}

/**
 * The button. Defaults to `type="button"`, so a button inside a form never submits it by accident:
 * pass `type="submit"` for the one that should.
 */
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  loading = false,
  loadingText,
  type = "button",
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cls("ui-button", `ui-button--${variant}`, `ui-button--${size}`, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={ICON_SIZE[size]} /> : renderIcon(icon, ICON_SIZE[size])}
      {loading && loadingText ? loadingText : children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ComponentProps<"button">, "children"> {
  /** What the button does. Required: it is the accessible name and the tooltip. */
  label: string;
  icon: LucideIcon;
  variant?: "ghost" | "danger";
  size?: ButtonSize;
  /** Shown as the tooltip while the button is disabled, to say why ("Tasks are still in this stage"). */
  disabledReason?: string;
}

/** A square, icon-only button. Its label shows as a tooltip, so it never needs a `title`. */
export function IconButton({
  label,
  icon: Icon,
  variant = "ghost",
  size = "md",
  disabledReason,
  type = "button",
  className,
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      type={type}
      aria-label={label}
      className={cls("ui-icon-button", `ui-icon-button--${variant}`, `ui-icon-button--${size}`, className)}
      {...rest}
    >
      <Icon size={ICON_SIZE[size]} aria-hidden="true" />
    </button>
  );
  // A disabled button gets no pointer or focus events, so the reason hangs off a focusable wrapper.
  if (rest.disabled && disabledReason) {
    return (
      <Tooltip content={disabledReason}>
        <span className="ui-disabled-reason" tabIndex={0} aria-label={`${label}: ${disabledReason}`}>
          {button}
        </span>
      </Tooltip>
    );
  }
  return <Tooltip content={label}>{button}</Tooltip>;
}
