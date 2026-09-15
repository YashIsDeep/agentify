import { LINK_TYPES } from "@wm/shared";
import { Plus, Trash2 } from "lucide-react";
import { type LinkDraft, linkTypeLabel, withValue } from "../lib/links";

export function LinksField({
  links,
  onChange,
  autoFocus = false,
}: {
  links: LinkDraft[];
  onChange: (links: LinkDraft[]) => void;
  /** Focus the first link's value. */
  autoFocus?: boolean;
}) {
  const replace = (index: number, link: LinkDraft) => onChange(links.map((current, i) => (i === index ? link : current)));

  return (
    <div className="field">
      <span>Links</span>
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
            autoFocus={autoFocus && index === 0}
            value={link.value}
            placeholder="PROJ-123 or paste a Jira / Linear URL"
            onChange={(e) => replace(index, withValue(link, e.target.value))}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Remove link"
            onClick={() => onChange(links.filter((_, i) => i !== index))}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button type="button" className="link-button" onClick={() => onChange([...links, { type: "", value: "" }])}>
        <Plus size={13} /> Add link
      </button>
    </div>
  );
}
