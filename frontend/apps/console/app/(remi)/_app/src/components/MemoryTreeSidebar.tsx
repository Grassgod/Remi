import { cn } from "~remiadmin/lib/utils";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./ui/collapsible";
import { Brain, FileText, Calendar, ChevronRight, Search, FolderOpen, User, Box, Building, Lightbulb, Monitor, Cpu, MessageSquare, StickyNote, Archive } from "lucide-react";
import type { EntitySummary, ProjectMemory } from "../api/types";

interface MemoryTreeSidebarProps {
  entities: EntitySummary[];
  projectMemories: ProjectMemory[];
  activeView: string;
  onNavigate: (view: string) => void;
}

const TYPE_CONFIG: Record<string, { label: string; icon: React.ComponentType<any> }> = {
  person: { label: "People", icon: User },
  software: { label: "Software", icon: Box },
  decision: { label: "Decisions", icon: Lightbulb },
  device: { label: "Devices", icon: Monitor },
  service: { label: "Services", icon: Cpu },
  project: { label: "Projects", icon: FolderOpen },
  platform: { label: "Platforms", icon: Building },
  organization: { label: "Organizations", icon: Building },
  feedback: { label: "Feedback", icon: MessageSquare },
  note: { label: "Notes", icon: StickyNote },
  archive: { label: "Archives", icon: Archive },
};

function groupEntities(entities: EntitySummary[]) {
  const groups: Record<string, EntitySummary[]> = {};
  for (const e of entities) {
    const key = e.type || "other";
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  }
  return groups;
}

export function MemoryTreeSidebar({ entities, projectMemories, activeView, onNavigate }: MemoryTreeSidebarProps) {
  const groups = groupEntities(entities);

  // All entity types in one flat list
  const allTypes = Object.entries(groups).filter(([type]) => TYPE_CONFIG[type]);
  const otherTypes = Object.entries(groups).filter(([type]) => !TYPE_CONFIG[type]);

  return (
    <div className="sticky top-4 h-fit">
      <ScrollArea className="max-h-[calc(100vh-8rem)]">
        <div className="space-y-1 pr-2">
          {/* Soul — MEMORY.md at the top */}
          <button
            onClick={() => onNavigate("global")}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors hover:bg-accent/50",
              activeView === "global" && "bg-accent text-accent-foreground"
            )}
          >
            <FileText className="h-3.5 w-3.5 text-amber-500" />
            Soul.md
          </button>

          <div className="my-1.5 border-t border-border" />

          {/* Entities — all entity types unified */}
          <Collapsible defaultOpen>
            <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent/50">
              <ChevronRight className="h-3 w-3 transition-transform [[data-state=open]_&]:rotate-90" />
              Entities
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="ml-2 space-y-0.5 border-l border-border pl-2">
                {[...allTypes, ...otherTypes].map(([type, items]) => {
                  const config = TYPE_CONFIG[type];
                  const Icon = config?.icon || Brain;
                  const isActive = activeView === `type:${type}`;
                  return (
                    <button
                      key={type}
                      onClick={() => onNavigate(`type:${type}`)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent/50",
                        isActive && "bg-accent text-accent-foreground"
                      )}
                    >
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="flex-1 text-left">{config?.label || type}</span>
                      <Badge variant="secondary" className="h-4 min-w-[18px] justify-center px-1 text-[9px]">
                        {items.length}
                      </Badge>
                    </button>
                  );
                })}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Project Memories — 项目目录下的 memory 文件 */}
          {projectMemories.length > 0 && (
            <Collapsible defaultOpen>
              <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent/50">
                <ChevronRight className="h-3 w-3 transition-transform [[data-state=open]_&]:rotate-90" />
                Project Memories
                <Badge variant="secondary" className="ml-auto h-4 min-w-[18px] justify-center px-1 text-[9px]">
                  {projectMemories.length}
                </Badge>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="ml-2 space-y-0.5 border-l border-border pl-2">
                  {projectMemories.map(pm => (
                    <div key={pm.projectId}>
                      <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                        <FolderOpen className="h-3.5 w-3.5 text-cyan-500" />
                        <span className="flex-1 truncate">{pm.projectName}</span>
                        <Badge variant="outline" className="h-4 px-1 text-[8px] text-cyan-500 border-cyan-500/30">
                          {pm.files.length}
                        </Badge>
                      </div>
                      <div className="ml-4 space-y-0.5 border-l border-cyan-500/20 pl-2">
                        {pm.files.map(f => (
                          <button
                            key={f.path}
                            onClick={() => onNavigate(`project-file:${pm.projectId}:${f.path}`)}
                            className={cn(
                              "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[10px] transition-colors hover:bg-accent/50",
                              activeView === `project-file:${pm.projectId}:${f.path}` && "bg-accent text-accent-foreground"
                            )}
                          >
                            <FileText className="h-3 w-3 text-cyan-500/50" />
                            <span className="truncate">{f.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}


          {/* Separator */}
          <div className="my-2 border-t border-border" />

          {/* Tools */}
          <button
            onClick={() => onNavigate("daily")}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent/50",
              activeView === "daily" && "bg-accent text-accent-foreground"
            )}
          >
            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
            Daily Logs
          </button>

          <button
            onClick={() => onNavigate("recall")}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent/50",
              activeView === "recall" && "bg-accent text-accent-foreground"
            )}
          >
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            Recall Debug
          </button>
        </div>
      </ScrollArea>
    </div>
  );
}
