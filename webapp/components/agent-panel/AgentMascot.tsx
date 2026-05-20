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
 * otherwise it renders a self-contained CSS/SVG chibi so the panel always
 * has a character to show. `running` toggles the energetic vs. calm motion.
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

  return <FallbackChibi running={running} />;
}

/**
 * Dependency-free fallback mascot: a chibi character drawn as inline SVG and
 * animated entirely through CSS keyframes in globals.css. Body parts carry
 * `agent-chibi-*` classes; the `data-running` attribute switches the whole
 * character between a calm idle pose and an energetic working pose.
 */
function FallbackChibi({ running }: { running: boolean }) {
  return (
    <div className="agent-mascot-stage" aria-hidden>
      <svg
        className="agent-chibi"
        data-running={running ? "true" : "false"}
        viewBox="0 0 120 140"
        width="128"
        height="150"
        role="img"
      >
        <path
          className="agent-chibi-spark"
          d="M19 23 L21.5 29.5 L28 32 L21.5 34.5 L19 41 L16.5 34.5 L10 32 L16.5 29.5 Z"
        />
        <path
          className="agent-chibi-spark agent-chibi-spark-late"
          d="M101 19 L103 24 L108 26 L103 28 L101 33 L99 28 L94 26 L99 24 Z"
        />
        <g className="agent-chibi-bob">
          <rect
            className="agent-chibi-leg agent-chibi-leg-l"
            x="49"
            y="111"
            width="11"
            height="22"
            rx="5.5"
          />
          <rect
            className="agent-chibi-leg agent-chibi-leg-r"
            x="60"
            y="111"
            width="11"
            height="22"
            rx="5.5"
          />
          <rect
            className="agent-chibi-arm agent-chibi-arm-l"
            x="23"
            y="79"
            width="11"
            height="27"
            rx="5.5"
          />
          <rect
            className="agent-chibi-arm agent-chibi-arm-r"
            x="86"
            y="79"
            width="11"
            height="27"
            rx="5.5"
          />
          <rect
            className="agent-chibi-body"
            x="38"
            y="73"
            width="44"
            height="42"
            rx="18"
          />
          <g className="agent-chibi-head">
            <path
              className="agent-chibi-ahoge"
              d="M58 15 C55 7 64 3 68 7 C71 10 68 14 63 13"
            />
            <circle className="agent-chibi-face" cx="60" cy="46" r="33" />
            <path
              className="agent-chibi-hair"
              d="M27 50 C26 14 42 7 60 7 C78 7 94 14 93 50 C82 33 72 28 60 28 C48 28 38 33 27 50 Z"
            />
            <g className="agent-chibi-eyes">
              <ellipse
                className="agent-chibi-eye"
                cx="49"
                cy="52"
                rx="4.6"
                ry="6.2"
              />
              <ellipse
                className="agent-chibi-eye"
                cx="71"
                cy="52"
                rx="4.6"
                ry="6.2"
              />
            </g>
            <ellipse
              className="agent-chibi-blush"
              cx="41"
              cy="60"
              rx="5.4"
              ry="3.4"
            />
            <ellipse
              className="agent-chibi-blush"
              cx="79"
              cy="60"
              rx="5.4"
              ry="3.4"
            />
            <path className="agent-chibi-mouth" d="M54 62 Q60 69 66 62" />
          </g>
        </g>
      </svg>
    </div>
  );
}
