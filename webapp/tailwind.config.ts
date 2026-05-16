import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0b0d10",
          subtle: "#13161a",
          panel: "#181c22",
        },
        line: "#262b33",
        ink: {
          DEFAULT: "#e7ebf0",
          dim: "#8a93a0",
          faint: "#5b6470",
        },
        accent: {
          DEFAULT: "#7aa2ff",
          soft: "#3b4a7a",
        },
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "Pretendard", "sans-serif"],
        mono: ["ui-monospace", "JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [typography],
};

export default config;
