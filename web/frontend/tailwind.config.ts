import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: "#030810",
        surface: "rgba(8, 18, 35, 0.85)",
        panel: "rgba(10, 24, 48, 0.6)",
        hover: "rgba(20, 50, 90, 0.4)",
        glow: {
          primary: "#00e5ff",
          secondary: "#4fc3f7",
          accent: "#00bcd4",
          warm: "#ff9100",
          green: "#00e676",
          red: "#ff1744",
          amber: "#ffab00",
          purple: "#b388ff",
        },
        border: {
          glow: "rgba(0, 229, 255, 0.15)",
          bright: "rgba(0, 229, 255, 0.35)",
        },
        txt: {
          bright: "#e0f7fa",
          primary: "#b0bec5",
          muted: "#546e7a",
          dim: "#37474f",
        },
      },
      fontFamily: {
        display: ["Orbitron", "sans-serif"],
        body: ["Rajdhani", "sans-serif"],
        mono: ["Share Tech Mono", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
