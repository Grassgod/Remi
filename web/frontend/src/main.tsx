import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/index.css";

// Initialize theme from localStorage (default: dark)
const stored = localStorage.getItem("remi-theme");
if (stored === "light") {
  document.documentElement.classList.remove("dark");
} else {
  document.documentElement.classList.add("dark");
}

createRoot(document.getElementById("root")!).render(<App />);
