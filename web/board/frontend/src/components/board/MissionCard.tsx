import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Mission } from "../../api";

const STEP_LABELS: Record<string, string> = {
  intake: "Intake",
  rfc: "RFC",
  decompose: "Tasks",
  execute: "Execute",
  eval: "Eval",
  summary: "Summary",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `Updated ${months[d.getMonth()]} ${d.getDate()}`;
}

interface Props {
  mission: Mission;
  onClick?: () => void;
}

export function MissionCard({ mission, onClick }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: mission.id, data: { mission } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    height: 100,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className={`cursor-default flex flex-col w-full px-4 py-3 mb-2 bg-white rounded focus:outline-none ${
        isDragging ? "shadow-[rgb(0_0_0/9%)_0px_3px_12px]" : ""
      }`}
    >
      {/* Title */}
      <div className="text-sm font-medium text-gray-700 line-clamp-2 leading-snug">
        {mission.title}
      </div>

      {/* Bottom row */}
      <div className="mt-auto flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Step badge */}
          <span className="inline-block rounded-sm border border-gray-100 px-1 py-0.5 text-xs text-gray-400">
            {STEP_LABELS[mission.currentStep] ?? mission.currentStep}
          </span>
          {/* MR link */}
          {mission.mrUrl && (
            <a
              href={mission.mrUrl}
              target="_blank"
              rel="noopener"
              className="text-xs text-blue-500 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              MR
            </a>
          )}
        </div>

        {/* Avatar / created by */}
        {mission.createdByName && (
          <div className="w-5 h-5 rounded-full bg-gray-300 flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0">
            {mission.createdByName.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      {/* Updated date */}
      <div className="text-xs text-gray-400 mt-1">
        {formatDate(mission.updatedAt)}
      </div>
    </div>
  );
}
