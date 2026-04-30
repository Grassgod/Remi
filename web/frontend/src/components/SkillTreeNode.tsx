import { useState } from "react";
import { ChevronDown, ChevronRight, File } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SkillFileNode } from "../api/types";

interface SkillTreeNodeProps {
  node: SkillFileNode;
  skillName: string;
  selectedFile: string;
  onSelect: (skillName: string, filePath: string) => void;
  depth: number;
}

export function SkillTreeNode({ node, skillName, selectedFile, onSelect, depth }: SkillTreeNodeProps) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isDir = node.type === "directory";
  const isSelected = !isDir && selectedFile === node.path;

  return (
    <div>
      <div
        className={cn(
          "flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors",
          isSelected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        )}
        style={{ paddingLeft: `${depth * 10 + 8}px` }}
        onClick={() => {
          if (isDir) setExpanded(!expanded);
          else onSelect(skillName, node.path);
        }}
      >
        {isDir ? (
          expanded ? <ChevronDown className="h-2.5 w-2.5 shrink-0" /> : <ChevronRight className="h-2.5 w-2.5 shrink-0" />
        ) : (
          <File className="h-2.5 w-2.5 shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
      </div>
      {isDir && expanded && node.children?.map(child => (
        <SkillTreeNode
          key={child.path}
          node={child}
          skillName={skillName}
          selectedFile={selectedFile}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}
