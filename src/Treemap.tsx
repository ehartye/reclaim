import { useState, useEffect, useRef, useId } from "react";
import { bytes, basename } from "./types";
type Item = {
  path: string;
  bytes: number;
  color?: string;
  opportunity?: boolean;
  label?: string;
};
type Rect = Item & { x: number; y: number; w: number; h: number };
const palette = [
  "#4678de",
  "#279b94",
  "#8b78bc",
  "#d8a155",
  "#739bea",
  "#607e9d",
  "#69b8b2",
  "#b9a0d7",
];
function textColor(hex: string) {
  const channels = hex
    .replace("#", "")
    .match(/../g)!
    .map((c) => parseInt(c, 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const luminance =
    channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return 1.05 / (luminance + 0.05) >= 4.5 ? "#ffffff" : "#07101c";
}
function tile(
  items: Item[],
  x: number,
  y: number,
  w: number,
  h: number,
): Rect[] {
  if (!items.length) return [];
  if (items.length === 1) return [{ ...items[0], x, y, w, h }];
  const total = items.reduce((n, i) => n + i.bytes, 0);
  let sum = 0,
    split = 0;
  while (split < items.length - 1 && sum < total / 2) {
    sum += items[split].bytes;
    split++;
  }
  const ratio = sum / total;
  return w > h
    ? [
        ...tile(items.slice(0, split), x, y, w * ratio, h),
        ...tile(items.slice(split), x + w * ratio, y, w * (1 - ratio), h),
      ]
    : [
        ...tile(items.slice(0, split), x, y, w, h * ratio),
        ...tile(items.slice(split), x, y + h * ratio, w, h * (1 - ratio)),
      ];
}
export function Treemap({
  items,
  onChoose,
  compact = false,
}: {
  items: Item[];
  onChoose?: (p: string) => void;
  compact?: boolean;
}) {
  const patternId = useId();
  const [hover, setHover] = useState<Item | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(280, Math.min(800, entries[0].contentRect.width))),
    );
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const height = compact ? (width < 500 ? 190 : 230) : width < 500 ? 300 : 390;
  const all = items
    .filter((i) => i.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 32);
  const rects = tile(all, 0, 0, width, height);
  return (
    <div className={"treemap " + (compact ? "compact" : "")}>
      <div className="map-surface" ref={container}>
        <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          <defs>
            <pattern
              id={patternId}
              width="7"
              height="7"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(35)"
            >
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="7"
                stroke="#ffffff"
                strokeOpacity="0.16"
                strokeWidth="1.5"
              />
            </pattern>
          </defs>
          {rects.map((r, i) => (
            <g key={r.path}>
              <rect
                x={r.x + 3}
                y={r.y + 3}
                width={Math.max(0, r.w - 6)}
                height={Math.max(0, r.h - 6)}
                rx="7"
                fill={r.color || palette[i % palette.length]}
              />
              {r.opportunity && (
                <rect
                  x={r.x + 3}
                  y={r.y + 3}
                  width={Math.max(0, r.w - 6)}
                  height={Math.max(0, r.h - 6)}
                  rx="7"
                  fill={`url(#${patternId})`}
                />
              )}
              {r.w > 100 && r.h > 55 && (
                <>
                  <text
                    aria-hidden="true"
                    x={r.x + 17}
                    y={r.y + 29}
                    fill={textColor(r.color || palette[i % palette.length])}
                    fontSize="15"
                    fontWeight="600"
                  >
                    {(r.label || basename(r.path)).slice(
                      0,
                      Math.max(5, Math.floor(r.w / 9) - 3),
                    )}
                  </text>
                  <text
                    aria-hidden="true"
                    x={r.x + 17}
                    y={r.y + 51}
                    fill={textColor(r.color || palette[i % palette.length])}
                    fontSize="13"
                  >
                    {bytes(r.bytes)}
                  </text>
                </>
              )}
            </g>
          ))}
        </svg>
        {onChoose &&
          rects.map((r) => (
            <button
              key={r.path}
              className="map-hit"
              aria-label={`${r.label || basename(r.path)}, ${bytes(r.bytes)}`}
              style={{
                left: `${(r.x / width) * 100}%`,
                top: `${(r.y / height) * 100}%`,
                width: `${(r.w / width) * 100}%`,
                height: `${(r.h / height) * 100}%`,
              }}
              onClick={() => onChoose(r.path)}
              onFocus={() => setHover(r)}
              onBlur={() => setHover(null)}
              onMouseEnter={() => setHover(r)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
      </div>
      {hover && (
        <div className="map-tooltip">
          {hover.label || basename(hover.path)} <b>{bytes(hover.bytes)}</b>
        </div>
      )}
    </div>
  );
}
