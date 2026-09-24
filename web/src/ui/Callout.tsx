import { CircleCheck, Info, type LucideIcon, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cls } from "../lib/format";
import "./callout.css";

type CalloutTone = "info" | "success" | "warn" | "danger";

const ICONS: Record<CalloutTone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warn: TriangleAlert,
  danger: TriangleAlert,
};

/**
 * A message in a tinted box: the outcome of something you did, or a warning worth reading before
 * you go on. Errors get role="alert" so screen readers announce them.
 */
export function Callout({ tone = "info", className, children }: { tone?: CalloutTone; className?: string; children: ReactNode }) {
  const Icon = ICONS[tone];
  return (
    <div className={cls("ui-callout", `ui-tone-${tone}`, className)} role={tone === "danger" ? "alert" : undefined}>
      <Icon size={14} aria-hidden="true" />
      <div className="ui-callout__body">{children}</div>
    </div>
  );
}
