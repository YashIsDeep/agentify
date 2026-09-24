import { type ComponentProps, type ReactNode } from "react";
import { cls } from "../lib/format";
import { type IconProp, renderIcon } from "./Button";
import "./badge.css";

export type Tone = "neutral" | "accent" | "success" | "warn" | "danger" | "info";

/**
 * A status: what state something is in ("Ready", "Failed", "Needs you"). Filled and bold, with a
 * leading icon, or a dot when there's none. For plain labels (a tag, a branch) use Tag.
 */
export function Badge({
  tone = "neutral",
  icon,
  title,
  children,
}: {
  tone?: Tone;
  icon?: IconProp;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={cls("ui-badge", `ui-tone-${tone}`)} title={title}>
      {icon ? renderIcon(icon, 11) : <span className="ui-badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/**
 * A small label: a tag, a branch, a link, a count. Quiet by default; `tone` tints it. With `href`
 * it is a link (external links open in a new tab).
 */
export function Tag({
  tone = "neutral",
  icon,
  href,
  title,
  className,
  children,
}: {
  tone?: Tone;
  icon?: IconProp;
  href?: string;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const props: ComponentProps<"span"> = { className: cls("ui-tag", `ui-tone-${tone}`, className), title };
  const content = (
    <>
      {renderIcon(icon, 11)}
      <span className="ui-tag__text">{children}</span>
    </>
  );
  return href ? (
    <a {...(props as ComponentProps<"a">)} href={href} target="_blank" rel="noreferrer">
      {content}
    </a>
  ) : (
    <span {...props}>{content}</span>
  );
}

/** Tags in a wrapping row. */
export function TagList({ children }: { children: ReactNode }) {
  return <div className="ui-tag-list">{children}</div>;
}
