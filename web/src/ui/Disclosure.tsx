import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cls } from "../lib/format";
import "./disclosure.css";

/**
 * A section that folds open in place, for settings most people never need. Native <details>, so it
 * works from the keyboard and needs no state; `defaultOpen` opens it when something inside needs
 * attention (an error, a value that isn't the default).
 */
export function Disclosure({
  summary,
  icon,
  defaultOpen = false,
  className,
  children,
}: {
  summary: ReactNode;
  icon?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <details className={cls("ui-disclosure", className)} open={defaultOpen || undefined}>
      <summary>
        {icon}
        <span>{summary}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className="ui-disclosure__body">{children}</div>
    </details>
  );
}
