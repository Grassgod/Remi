import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Mission } from "../../api";
import { MissionCard } from "./MissionCard";

interface Props {
  status: string;
  label: string;
  missions: Mission[];
  onCardClick?: (mission: Mission) => void;
}

// Linearlite-style status icons (SVG circles)
function StatusIcon({ status }: { status: string }) {
  const colors: Record<string, string> = {
    inbox: "#bbb",
    in_progress: "#f2994a",
    in_review: "#eb5757",
    done: "#10a37f",
  };
  const filled = ["in_progress", "in_review", "done"].includes(status);
  const color = colors[status] ?? "#bbb";

  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="flex-shrink-0">
      <circle cx="7" cy="7" r="5" fill={filled ? color : "none"} stroke={color} strokeWidth="1.5" />
      {status === "done" && (
        <path d="M4.5 7 L6.2 8.8 L9.5 5.2" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      )}
    </svg>
  );
}

export function KanbanColumn({ status, label, missions, onCardClick }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col flex-shrink-0 mr-3 select-none`}
      style={{ width: 360 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-3 text-sm">
        <div className="flex items-center gap-2">
          <StatusIcon status={status} />
          <span className="font-medium text-gray-700">{label}</span>
          <span className="text-gray-400">{missions.length}</span>
        </div>
        <button className="text-gray-300 hover:text-gray-500 text-lg leading-none px-1">+</button>
      </div>

      {/* Cards */}
      <SortableContext items={missions.map((m) => m.id)} strategy={verticalListSortingStrategy}>
        <div className={`flex-1 overflow-y-auto transition-colors rounded ${isOver ? "bg-blue-50" : ""}`}>
          {missions.map((m) => (
            <MissionCard
              key={m.id}
              mission={m}
              onClick={() => onCardClick?.(m)}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}
