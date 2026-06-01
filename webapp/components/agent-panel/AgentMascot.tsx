"use client";

import { useEffect, useState } from "react";
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

  return <FallbackVoxelCatMascot running={running} />;
}

/**
 * Dependency-free fallback mascot: a blocky voxel-style cat drawn as inline
 * SVG and animated entirely through CSS keyframes in globals.css. Body parts
 * carry `agent-voxel-*` classes; the `data-running` attribute switches the
 * whole character between a calm idle pose and an energetic working pose.
 */
function FallbackVoxelCatMascot({ running }: { running: boolean }) {
  return (
    <div className="agent-mascot-stage" aria-hidden>
      <svg
        className="agent-voxel"
        data-running={running ? "true" : "false"}
        viewBox="0 0 136 140"
        width="128"
        height="150"
        role="img"
      >
        <path
          className="agent-voxel-spark"
          d="M18 25 H26 V33 H18 Z M12 35 H18 V41 H12 Z"
        />
        <path
          className="agent-voxel-spark agent-voxel-spark-late"
          d="M96 21 H104 V29 H96 Z M105 31 H111 V37 H105 Z"
        />
        <ellipse
          className="agent-voxel-shadow"
          cx="60"
          cy="132"
          rx="33"
          ry="5"
        />
        <g className="agent-voxel-bob">
          <g className="agent-voxel-tail">
            <g transform="translate(72 58) rotate(-3 12 42)">
              <path
                className="agent-voxel-tail-base"
                d="M2 35 H15 V25 H31 V10 H48 V25 H37 V40 H21 V52 H2 Z"
              />
              <path
                className="agent-voxel-tail-shade"
                d="M15 25 H31 V10 H39 V19 H26 V34 H15 Z"
              />
              <path
                className="agent-voxel-tail-tip"
                d="M31 10 H48 V25 H37 V40 H29 V31 H39 V19 H31 Z"
              />
            </g>
          </g>
          <rect
            className="agent-voxel-body"
            x="37"
            y="77"
            width="42"
            height="41"
            rx="5"
          />
          <rect
            className="agent-voxel-body-shade"
            x="68"
            y="77"
            width="18"
            height="41"
            rx="5"
          />
          <rect
            className="agent-voxel-belly"
            x="47"
            y="86"
            width="18"
            height="22"
            rx="2"
          />
          <rect
            className="agent-voxel-paw agent-voxel-paw-l"
            x="36"
            y="112"
            width="22"
            height="12"
            rx="2"
          />
          <rect
            className="agent-voxel-paw agent-voxel-paw-r agent-voxel-rear-paw"
            x="66"
            y="111"
            width="20"
            height="13"
            rx="2"
          />
          <rect
            className="agent-voxel-collar"
            x="37"
            y="74"
            width="49"
            height="7"
            rx="1"
          />
          <rect
            className="agent-voxel-tag"
            x="56"
            y="78"
            width="8"
            height="8"
            rx="1"
          />
          <g className="agent-voxel-head">
            <path
              className="agent-voxel-ear agent-voxel-ear-l"
              d="M33 28 L41 8 L49 28 Z"
            />
            <path
              className="agent-voxel-ear agent-voxel-ear-r"
              d="M63 28 L71 8 L79 28 Z"
            />
            <path
              className="agent-voxel-inner-ear"
              d="M36 26 L41 17 L46 26 Z M66 26 L71 17 L76 26 Z"
            />
            <path
              className="agent-voxel-head-top"
              d="M33 27 H79 L91 38 H27 Z"
            />
            <path
              className="agent-voxel-head-side"
              d="M79 38 L91 38 V76 L79 84 Z"
            />
            <rect
              className="agent-voxel-face"
              x="27"
              y="38"
              width="52"
              height="46"
              rx="4"
            />
            <rect
              className="agent-voxel-face-patch"
              x="30"
              y="41"
              width="15"
              height="12"
              rx="1"
            />
            <g className="agent-voxel-eyes">
              <rect
                className="agent-voxel-eye"
                x="41"
                y="54"
                width="6"
                height="7"
              />
              <rect
                className="agent-voxel-eye"
                x="62"
                y="54"
                width="6"
                height="7"
              />
            </g>
            <rect
              className="agent-voxel-muzzle"
              x="46"
              y="63"
              width="18"
              height="10"
              rx="2"
            />
            <rect
              className="agent-voxel-nose"
              x="53"
              y="62"
              width="5"
              height="4"
              rx="1"
            />
            <path
              className="agent-voxel-whisker"
              d="M45 67 H34 M45 71 H32 M65 67 H76 M65 71 H78"
            />
            <rect
              className="agent-voxel-mouth"
              x="53"
              y="69"
              width="5"
              height="3"
              rx="1"
            />
          </g>
        </g>
      </svg>
    </div>
  );
}
