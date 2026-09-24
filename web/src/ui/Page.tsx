import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cls } from "../lib/format";
import { InfoTip } from "./Tooltip";
import "./page.css";

/**
 * A full page in the main area: a header with the title, an optional tip and actions on the right,
 * then the content, scrolling as one. `narrow` keeps settings pages to a readable width.
 */
export function Page({
  title,
  tip,
  actions,
  narrow = false,
  className,
  children,
}: {
  title: ReactNode;
  tip?: ReactNode;
  actions?: ReactNode;
  narrow?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cls("ui-page", narrow && "ui-page--narrow", className)}>
      <header className="ui-page__header">
        <h1 className="ui-page__title">
          {title}
          {tip && <InfoTip>{tip}</InfoTip>}
        </h1>
        {actions && <div className="ui-page__actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

/** A whole-screen message: loading, a failure with its way out, a missing workspace. */
export function Splash({ title, action, children }: { title: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className="ui-splash" role="status">
      <strong>{title}</strong>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

/** What a list or panel shows when it has nothing in it yet, with the way to add the first thing. */
export function EmptyState({
  icon: Icon,
  title,
  action,
  children,
}: {
  icon: LucideIcon;
  title: string;
  action?: ReactNode;
  /** One sentence on what will appear here. */
  children?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      <span className="ui-empty__icon">
        <Icon size={22} aria-hidden="true" />
      </span>
      <strong>{title}</strong>
      {children && <p className="ui-empty__text">{children}</p>}
      {action && <div className="ui-empty__action">{action}</div>}
    </div>
  );
}
