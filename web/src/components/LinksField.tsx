import { LINK_TYPES } from "@wm/shared";
import { Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { type LinkDraft, linkTypeLabel, withValue } from "../lib/links";
import { Button, Field, IconButton } from "../ui";

export function LinksField({
  links,
  onChange,
  optional = false,
  tip,
}: {
  links: LinkDraft[];
  onChange: (links: LinkDraft[]) => void;
  optional?: boolean;
  tip?: ReactNode;
}) {
  const replace = (index: number, link: LinkDraft) => onChange(links.map((current, i) => (i === index ? link : current)));

  return (
    <Field label="Links" optional={optional} tip={tip} group>
      {links.map((link, index) => (
        <div key={index} className="link-row">
          {/* A dropdown because `{{task.links.jira}}` matches the type exactly: a link typed
              "Jira" would render empty and its integration action would quietly skip. */}
          <select
            className="link-type"
            aria-label="Link type"
            value={link.type}
            // A filled-in row needs a type, or saving would silently drop it.
            required={link.value.trim() !== ""}
            onChange={(e) => replace(index, { ...link, type: e.target.value })}
          >
            {link.type === "" && <option value="">Type…</option>}
            {LINK_TYPES.map((type) => (
              <option key={type} value={type}>
                {linkTypeLabel(type)}
              </option>
            ))}
            {link.type !== "" && !LINK_TYPES.includes(link.type as (typeof LINK_TYPES)[number]) && (
              <option value={link.type}>{linkTypeLabel(link.type)}</option>
            )}
          </select>
          <input
            aria-label="Link"
            value={link.value}
            placeholder="PROJ-123 or paste a Jira / Linear URL"
            onChange={(e) => replace(index, withValue(link, e.target.value))}
          />
          {/* A lone blank row is just the place to paste; there is nothing to remove yet. */}
          {(links.length > 1 || link.value !== "" || link.type !== "") && (
            <IconButton label="Remove link" icon={Trash2} onClick={() => onChange(links.filter((_, i) => i !== index))} />
          )}
        </div>
      ))}
      <div>
        <Button variant="link" icon={Plus} onClick={() => onChange([...links, { type: "", value: "" }])}>
          Add link
        </Button>
      </div>
    </Field>
  );
}
