import { useMemo } from "react";
import { encode } from "uqr";

/** A QR code for `value`, one SVG path of dark modules on a light tile, the same in both themes. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { path, size } = useMemo(() => {
    const { data, size } = encode(value, { ecc: "M", border: 2 });
    let path = "";
    data.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }));
    return { path, size };
  }, [value]);
  return (
    <svg className="qr-code" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <path d={path} />
    </svg>
  );
}
