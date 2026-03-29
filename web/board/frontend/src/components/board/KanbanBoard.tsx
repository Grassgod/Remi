import { DndContext, DragOverlay, closestCorners, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { useState } from "react";
import type { Mission } from "../../api";
import { useBoardStore } from "../../stores/board";
import { KanbanColumn } from "./KanbanColumn";
import { MissionCard } from "./MissionCard";

const COLUMNS = [
  { status: "inbox", label: "Inbox" },
  { status: "in_progress", label: "In Progress" },
  { status: "in_review", label: "In Review" },
  { status: "done", label: "Done" },
] as const;

interface Props {
  onCardClick?: (mission: Mission) => void;
}

export function KanbanBoard({ onCardClick }: Props) {
  const { missions, moveMission } = useBoardStore();
  const [activeId, setActiveId] = useState<string | null>(null);

  const activeMission = activeId ? missions.find((m) => m.id === activeId) : null;

  // Require 8px movement before starting drag — allows clicks to work
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const missionId = active.id as string;
    const newStatus = over.id as string;

    const validStatuses = COLUMNS.map((c) => c.status as string);
    if (!validStatuses.includes(newStatus)) return;

    const mission = missions.find((m) => m.id === missionId);
    if (mission && mission.status !== newStatus) {
      moveMission(missionId, newStatus);
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={(e) => setActiveId(e.active.id as string)}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-full border-t border-border">
        {COLUMNS.map((col) => (
          <KanbanColumn
            key={col.status}
            status={col.status}
            label={col.label}
            missions={missions.filter((m) => m.status === col.status)}
            onCardClick={onCardClick}
          />
        ))}
      </div>

      <DragOverlay>
        {activeMission ? (
          <div className="opacity-90 rotate-1 shadow-card-lg bg-white rounded-lg border border-border max-w-[280px]">
            <MissionCard mission={activeMission} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
