import { useEffect } from "react";
import { useBoardStore } from "../stores/board";
import { KanbanBoard } from "../components/board/KanbanBoard";
import { ProjectSelector } from "../components/board/ProjectSelector";
import type { Mission } from "../api";

interface Props {
  slug?: string;
  onNavigate?: (path: string) => void;
}

export function Board({ slug, onNavigate }: Props) {
  const {
    projects,
    currentSlug,
    stats,
    loading,
    fetchProjects,
    selectProject,
    refreshMissions,
  } = useBoardStore();

  useEffect(() => { fetchProjects(); }, []);

  useEffect(() => {
    if (slug && slug !== currentSlug) selectProject(slug);
  }, [slug]);

  useEffect(() => {
    const interval = setInterval(refreshMissions, 5000);
    return () => clearInterval(interval);
  }, []);

  const isPersonal = !slug;

  const handleCardClick = (mission: Mission) => {
    onNavigate?.(`/issue/${mission.id}`);
  };

  return (
    <div className="flex h-dvh flex-col">
      {/* Top bar — Linearlite style */}
      <header className="flex items-center justify-between px-6 border-b border-gray-200 h-14 flex-shrink-0">
        <div className="flex items-center gap-3 text-sm">
          <span className="font-semibold text-gray-800">
            {currentSlug ? projects.find(p => p.slug === currentSlug)?.name ?? currentSlug : "Mission Board"}
          </span>

          {isPersonal && (
            <>
              <span className="text-gray-300">|</span>
              <ProjectSelector
                projects={projects}
                currentSlug={currentSlug}
                onSelect={selectProject}
              />
            </>
          )}
        </div>

        <div className="flex items-center gap-4 text-sm text-gray-400">
          {stats && <span>Board {stats.total}</span>}
        </div>
      </header>

      {/* Board area */}
      <div className="flex-1 overflow-auto bg-gray-100 pt-6 pl-8">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-sm text-gray-400 animate-pulse">Loading...</div>
          </div>
        ) : (
          <KanbanBoard onCardClick={handleCardClick} />
        )}
      </div>
    </div>
  );
}
