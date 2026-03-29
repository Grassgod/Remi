import type { Project } from "../../api";

interface Props {
  projects: Project[];
  currentSlug: string | null;
  onSelect: (slug: string) => void;
}

export function ProjectSelector({ projects, currentSlug, onSelect }: Props) {
  if (projects.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5">
      {projects.map((p) => (
        <button
          key={p.slug}
          onClick={() => onSelect(p.slug)}
          className={`rounded-md px-2.5 py-1 text-[0.82rem] font-medium transition-colors ${
            currentSlug === p.slug
              ? "bg-[#f0f0f3] text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-[#f7f7f8]"
          }`}
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}
