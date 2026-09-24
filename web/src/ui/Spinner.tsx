import { LoaderCircle } from "lucide-react";

/** Something is in progress. Decorative: pair it with text or an aria-busy/role="status" parent. */
export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <LoaderCircle size={size} aria-hidden="true" className={className ? `spin ${className}` : "spin"} />;
}
