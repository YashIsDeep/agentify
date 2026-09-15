import type { TaskLink } from "@wm/shared";

export interface LinkDraft {
  type: string;
  value: string;
}

/**
 * The link type a pasted URL obviously belongs to, or null when it can't be told — a bare
 * `PROJ-123` could be Jira or Linear, so the user picks.
 */
export function detectLinkType(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const onHost = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (onHost("atlassian.net") || host.startsWith("jira.") || /\/browse\/[A-Za-z][A-Za-z0-9_]*-\d+/.test(url.pathname)) return "jira";
  if (onHost("linear.app")) return "linear";
  if (onHost("notion.so") || onHost("notion.site")) return "notion";
  if (onHost("github.com")) return "github";
  if (onHost("gitlab.com") || host.startsWith("gitlab.")) return "gitlab";
  return "url";
}

/** Whether a value holds an issue key like PROJ-123, bare or inside a URL — so it's worth looking up. */
export const hasIssueKey = (value: string): boolean => /[A-Za-z][A-Za-z0-9_]*-\d+/.test(value);

/** Editing a value fills in its type when the user hasn't picked a specific one. */
export function withValue(link: LinkDraft, value: string): LinkDraft {
  const detected = detectLinkType(value);
  return { value, type: detected && (link.type === "" || link.type === "url") ? detected : link.type };
}

/** Drops rows left blank; the form refuses to submit a filled row without a type. */
export function cleanLinks(links: LinkDraft[]): TaskLink[] {
  return links
    .map((link) => ({ type: link.type.trim(), value: link.value.trim() }))
    .filter((link) => link.type && link.value);
}

/**
 * Proper name for display. The stored type stays lower-case — `{{task.links.jira}}` and the
 * integration actions match it exactly — so only the label is cased.
 */
const LINK_LABELS: Record<string, string> = {
  jira: "Jira",
  linear: "Linear",
  notion: "Notion",
  github: "GitHub",
  gitlab: "GitLab",
  url: "URL",
};

export const linkTypeLabel = (type: string): string => LINK_LABELS[type] ?? (type && type[0]!.toUpperCase() + type.slice(1));
