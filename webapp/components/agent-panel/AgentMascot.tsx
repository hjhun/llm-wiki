"use client";

import { useEffect, useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";

// Loaded lazily on the client only, so lottie-web never enters the SSR path
// of the server-rendered protected layout.
const Lottie = dynamic(() => import("lottie-react"), { ssr: false });

const MASCOT_URL = "/mascot.lottie.json";

/**
 * The animated agent character shown inside the edge panel. Plays a Lottie
 * animation from `public/mascot.lottie.json` when that file is present;
 * otherwise it renders a self-contained CSS/SVG voxel mascot so the panel
 * always has a character to show. `running` toggles the energetic vs. calm
 * motion.
 */
export default function AgentMascot({ running }: { running: boolean }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(MASCOT_URL, { cache: "force-cache" });
        if (!res.ok) return;
        const json = (await res.json()) as Record<string, unknown>;
        // A genuine Lottie document always carries a `layers` array.
        if (!cancelled && Array.isArray(json.layers)) {
          setData(json);
        }
      } catch {
        // Missing or malformed file: keep the CSS fallback.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (data) {
    return (
      <div className="agent-mascot-stage" aria-hidden>
        <Lottie
          // Remounting on the run/idle change re-applies loop + autoplay.
          key={running ? "run" : "idle"}
          animationData={data}
          loop={running}
          autoplay={running}
          className="h-[150px] w-[150px]"
        />
      </div>
    );
  }

  return <RingMascot running={running} />;
}

/**
 * Concentric ring layout for the mascot. Each entry is one ring drawn as a
 * single SVG circle whose stroke is intentionally left slightly open (a gap in
 * the dash pattern), so the rings read as hand-drawn loops rather than closed
 * outlines. `pathLength` normalizes every circumference to 100 units, so `gap`
 * is just a percentage of the loop regardless of radius. `spin` is the
 * clockwise rotation period (seconds) used while an agent is running — the
 * values are deliberately non-harmonic so the rings never line up, mirroring
 * how concurrently running agents each tick at their own pace.
 */
const RINGS = [
  { r: 52, width: 7, gap: 7, spin: 3.1 },
  { r: 41, width: 5.5, gap: 8, spin: 4.7 },
  { r: 30, width: 4.5, gap: 9, spin: 2.3 },
  { r: 20, width: 3.5, gap: 11, spin: 5.9 },
  { r: 11, width: 3, gap: 13, spin: 3.7 },
] as const;

/**
 * Dependency-free mascot: several concentric, slightly open rings of differing
 * thickness and color drawn as inline SVG. CSS keyframes in globals.css spin
 * each ring clockwise while `data-running="true"`; because every ring carries
 * its own period (via the `--spin` custom property) they rotate at different
 * speeds and stay out of sync. Idle keeps them still with a soft breathing
 * pulse so the panel still feels alive.
 */
function RingMascot({ running }: { running: boolean }) {
  return (
    <div className="agent-mascot-stage" aria-hidden>
      <svg
        className="agent-rings"
        data-running={running ? "true" : "false"}
        viewBox="0 0 120 120"
        width="150"
        height="150"
        role="img"
      >
        {RINGS.map((ring, i) => (
          <circle
            key={ring.r}
            className="agent-ring"
            // Stroke color is set per ring in globals.css and switches with the
            // theme (gold on dark, ink-navy on light to match the active tab).
            data-ring={i}
            cx="60"
            cy="60"
            r={ring.r}
            pathLength={100}
            // The ring is open: one dash covers the loop minus its gap.
            strokeDasharray={`${100 - ring.gap} ${ring.gap}`}
            // Offset each opening so the gaps fan around the figure.
            strokeDashoffset={i * 7}
            style={
              {
                strokeWidth: ring.width,
                "--spin": `${ring.spin}s`,
              } as CSSProperties
            }
          />
        ))}
      </svg>
    </div>
  );
}
