import { useState } from "react";
import { Board } from "./pages/Board";
import { MissionDetail } from "./pages/MissionDetail";

export function App() {
  const [route, setRoute] = useState(window.location.hash || "#/board");

  // Simple hash router
  const navigate = (path: string) => {
    window.location.hash = path;
    setRoute("#" + path);
  };

  // Listen to hash changes (back/forward)
  window.onhashchange = () => setRoute(window.location.hash);

  // Parse route
  const hashPath = route.replace("#", "") || "/board";

  // /issue/:id — Mission detail page
  const issueMatch = hashPath.match(/^\/issue\/(.+)$/);
  if (issueMatch) {
    return (
      <MissionDetail
        id={issueMatch[1]}
        onBack={() => navigate("/board")}
      />
    );
  }

  // /board/:slug — Project board
  const boardSlugMatch = hashPath.match(/^\/board\/(.+)$/);
  if (boardSlugMatch) {
    return <Board slug={boardSlugMatch[1]} onNavigate={navigate} />;
  }

  // /board or / — Personal board
  return <Board onNavigate={navigate} />;
}
