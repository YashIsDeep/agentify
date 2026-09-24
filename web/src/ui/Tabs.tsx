import type { LucideIcon } from "lucide-react";
import { Tabs as Primitive } from "radix-ui";
import { type ReactNode, useState } from "react";
import "./tabs.css";

export interface Tab<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  content: ReactNode;
  /**
   * Keep the panel mounted (hidden) once it has been shown, so a form in it keeps its edits while
   * you look at another tab. Other panels mount only while they're showing.
   */
  keepMounted?: boolean;
}

/**
 * A row of tabs over their panels; arrow keys move between tabs. Uncontrolled by default (starting
 * on the first tab); pass `value` and `onChange` to drive it from outside.
 */
export function Tabs<T extends string>({
  label,
  tabs,
  value: controlled,
  onChange,
}: {
  label: string;
  tabs: Tab<T>[];
  value?: T;
  onChange?: (value: T) => void;
}) {
  const [uncontrolled, setUncontrolled] = useState<T | undefined>(tabs[0]?.value);
  const value = controlled ?? uncontrolled;
  const [visited, setVisited] = useState<ReadonlySet<T>>(() => new Set(value ? [value] : []));
  // Derived during render, the React way to track "shown at least once" without an effect.
  if (value && !visited.has(value)) setVisited(new Set([...visited, value]));

  return (
    <Primitive.Root
      className="ui-tabs"
      value={value}
      onValueChange={(next) => {
        setUncontrolled(next as T);
        onChange?.(next as T);
      }}
    >
      <Primitive.List className="ui-tabs__list" aria-label={label}>
        {tabs.map(({ value: tab, label: text, icon: Icon }) => (
          <Primitive.Trigger key={tab} value={tab} className="ui-tabs__tab">
            {Icon && <Icon size={14} aria-hidden="true" />}
            {text}
          </Primitive.Trigger>
        ))}
      </Primitive.List>
      {tabs.map((tab) => (
        <Primitive.Content
          key={tab.value}
          value={tab.value}
          forceMount={tab.keepMounted && visited.has(tab.value) ? true : undefined}
          hidden={tab.value !== value}
        >
          {tab.content}
        </Primitive.Content>
      ))}
    </Primitive.Root>
  );
}
