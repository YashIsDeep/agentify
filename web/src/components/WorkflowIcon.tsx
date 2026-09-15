import { SquareKanban } from "lucide-react";

/**
 * A workflow's emoji, or the board glyph when it has none. One component so the sidebar, the board
 * heading and the picker's own trigger can never drift apart.
 *
 * The emoji is boxed to exactly the glyph's size so swapping one for the other never shifts the text
 * beside it; emoji draw wider than they are tall, hence the slightly smaller font size.
 */
export function WorkflowIcon({ icon, size = 17 }: { icon: string; size?: number }) {
  if (!icon) return <SquareKanban size={size} aria-hidden="true" />;
  return (
    <span
      className="workflow-emoji"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.92) }}
      aria-hidden="true"
    >
      {icon}
    </span>
  );
}
