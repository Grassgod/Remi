import { createRoot } from "react-dom/client";
import { BoardApp } from "./BoardApp";
import "../styles/index.css";

// Light theme for public board
document.documentElement.classList.remove("dark");

createRoot(document.getElementById("root")!).render(<BoardApp />);
