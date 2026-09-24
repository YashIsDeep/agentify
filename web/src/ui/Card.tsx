import type { HTMLAttributes, ReactNode } from "react";
import { cls } from "../lib/format";
import { InfoTip } from "./Tooltip";
import "./card.css";

/** A bordered panel: a settings card, or a group of related content on a page. */
export function Card({
  as: Tag = "section",
  label,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & {
  as?: "section" | "div" | "article";
  /** Accessible name, when the card has no heading of its own. */
  label?: string;
  children?: ReactNode;
}) {
  return (
    <Tag className={cls("ui-card", className)} aria-label={label} {...rest}>
      {children}
    </Tag>
  );
}

/**
 * A card's heading row: a tinted icon tile, the title, and something on the right (a status badge).
 * `brand` tints the tile in that brand's colour (see [data-brand] in tokens.css).
 */
export function CardHeader({
  icon,
  brand,
  title,
  tip,
  aside,
}: {
  icon?: ReactNode;
  brand?: string;
  title: ReactNode;
  tip?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="ui-card__header">
      {icon && (
        <span className="ui-card__icon" data-brand={brand}>
          {icon}
        </span>
      )}
      <h3 className="ui-card__title">
        {title}
        {tip && <InfoTip>{tip}</InfoTip>}
      </h3>
      {aside}
    </header>
  );
}

/** Cards in a grid: two to a row, one on narrow screens. */
export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="ui-card-grid">{children}</div>;
}
