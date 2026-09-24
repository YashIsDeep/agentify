import { Fragment, type ReactNode } from "react";
import "./detail-list.css";

/** Read-only facts as label/value rows: a task's git details, an agent's version and path. */
export function DetailList({ items, mono = false }: { items: [label: string, value: ReactNode][]; mono?: boolean }) {
  return (
    <dl className={mono ? "ui-details ui-details--mono" : "ui-details"}>
      {items.map(([label, value]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value ?? "—"}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
