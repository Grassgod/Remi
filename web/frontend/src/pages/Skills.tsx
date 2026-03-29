import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { Zap, FileText, Clock, ChevronRight, ChevronDown, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownFileViewer } from "../components/MarkdownFileViewer";
import { SkillTreeNode } from "../components/SkillTreeNode";
import * as api from "../api/client";
import type { SkillInfo, SkillFileNode } from "../api/types";

type Tab = "file" | "reports";

export function Skills() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [basePath, setBasePath] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState("SKILL.md");
  const [skillTree, setSkillTree] = useState<SkillFileNode[]>([]);
  const [tab, setTab] = useState<Tab>("file");
  const [fileContent, setFileContent] = useState("");
  const [reportDates, setReportDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [reportContent, setReportContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());

  useEffect(() => {
    Promise.all([
      api.getSkills(),
      api.getSkillsBasePath(),
    ]).then(([skillsData, baseData]) => {
      setSkills(skillsData);
      setBasePath(baseData.basePath);
      if (skillsData.length > 0) {
        const first = skillsData[0].name;
        setSelected(first);
        setExpandedSkills(new Set([first]));
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  // Load tree + file when skill selected
  useEffect(() => {
    if (!selected) return;
    setTab("file");
    setSelectedFile("SKILL.md");
    api.getSkillTree(selected).then(setSkillTree).catch(() => setSkillTree([]));
    api.getSkillFile(selected).then(d => setFileContent(d.content)).catch(() => setFileContent(""));
    const skill = skills.find(s => s.name === selected);
    if (skill?.hasSchedule) {
      api.getSkillReports(selected).then(setReportDates).catch(() => setReportDates([]));
    } else {
      setReportDates([]);
    }
    setSelectedDate(null);
    setReportContent("");
  }, [selected]);

  // Load file content when file path changes
  useEffect(() => {
    if (!selected || !selectedFile) return;
    setTab("file");
    api.getSkillFile(selected, selectedFile).then(d => setFileContent(d.content)).catch(() => setFileContent(""));
  }, [selectedFile]);

  useEffect(() => {
    if (!selected || !selectedDate) return;
    api.getSkillReport(selected, selectedDate).then(d => setReportContent(d.content)).catch(() => setReportContent(""));
  }, [selectedDate]);

  const handleSaveFile = async (content: string) => {
    if (!selected) return;
    await api.putSkillFile(selected, content, selectedFile);
    setFileContent(content);
  };

  const toggleSkillExpand = (name: string) => {
    setExpandedSkills(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectSkillFile = (skillName: string, filePath: string) => {
    if (selected !== skillName) {
      setSelected(skillName);
      setExpandedSkills(prev => new Set(prev).add(skillName));
    }
    setSelectedFile(filePath);
  };

  const currentSkill = skills.find(s => s.name === selected);
  const fullPath = selected && basePath ? `${basePath}/${selected}/${selectedFile}` : "";
  // Shorten for display: replace /home/hehuajie with ~
  const displayPath = fullPath.replace(/^\/home\/[^/]+/, "~");

  return (
    <Layout title="Skills" subtitle="Skill Definitions & Reports">
      {loading ? (
        <div className="p-10 text-center text-xs text-muted-foreground">Loading...</div>
      ) : skills.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center">
            <Zap className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <div className="text-sm text-muted-foreground">No skills found</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Skills are loaded from ~/.remi/.claude/skills/
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[240px_1fr]">
          {/* Skill Tree Sidebar */}
          <Card className="lg:sticky lg:top-0">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Zap className="h-4 w-4 text-muted-foreground" />
                Skills
                <Badge variant="secondary" className="ml-auto text-[10px]">{skills.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="max-h-[600px] px-2 pb-2">
                {skills.map(skill => {
                  const isExpanded = expandedSkills.has(skill.name);
                  const isSelected = selected === skill.name;
                  return (
                    <div key={skill.name}>
                      {/* Skill root */}
                      <div
                        className={cn(
                          "flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors",
                          isSelected && !isExpanded
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                          isSelected && isExpanded && "text-foreground"
                        )}
                        onClick={() => {
                          toggleSkillExpand(skill.name);
                          if (selected !== skill.name) {
                            setSelected(skill.name);
                          }
                        }}
                      >
                        {isExpanded
                          ? <ChevronDown className="h-3 w-3 shrink-0" />
                          : <ChevronRight className="h-3 w-3 shrink-0" />}
                        <FolderOpen className="h-3 w-3 shrink-0" />
                        <span className="min-w-0 flex-1 truncate font-medium">{skill.name}</span>
                        {skill.hasSchedule && (
                          <Clock className="h-3 w-3 shrink-0 text-green-500" />
                        )}
                      </div>
                      {/* File tree */}
                      {isExpanded && isSelected && skillTree.length > 0 && (
                        <div className="ml-3 border-l border-border pl-1">
                          {skillTree.map(node => (
                            <SkillTreeNode
                              key={node.path}
                              node={node}
                              skillName={skill.name}
                              selectedFile={selectedFile}
                              onSelect={selectSkillFile}
                              depth={0}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Content */}
          <div className="flex flex-col gap-3">
            {currentSkill && (
              <>
                {/* Header */}
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1 font-mono">
                      {displayPath}
                    </div>
                    <div className="flex items-center gap-3">
                      <CardTitle className="text-base">{currentSkill.name}</CardTitle>
                      {currentSkill.hasSchedule && (
                        <>
                          <Badge variant="outline" className="border-green-500/30 text-green-500 bg-green-500/5 text-[10px]">
                            Scheduled
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">{currentSkill.cron}</span>
                        </>
                      )}
                    </div>
                    {currentSkill.description && (
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{currentSkill.description}</p>
                    )}
                  </CardHeader>
                </Card>

                {/* Tabs */}
                <div className="flex gap-1">
                  <Button
                    variant={tab === "file" ? "default" : "outline"}
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setTab("file")}
                  >
                    {selectedFile}
                  </Button>
                  {reportDates.length > 0 && (
                    <Button
                      variant={tab === "reports" ? "default" : "outline"}
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => {
                        setTab("reports");
                        if (!selectedDate && reportDates.length > 0) setSelectedDate(reportDates[0]);
                      }}
                    >
                      Reports ({reportDates.length})
                    </Button>
                  )}
                </div>

                {/* File Tab */}
                {tab === "file" && (
                  <Card>
                    <CardContent className="pt-4">
                      <MarkdownFileViewer
                        content={fileContent}
                        onSave={selectedFile.endsWith(".md") ? handleSaveFile : undefined}
                        readOnly={!selectedFile.endsWith(".md")}
                      />
                    </CardContent>
                  </Card>
                )}

                {/* Reports Tab */}
                {tab === "reports" && (
                  <Card>
                    <CardContent className="pt-4">
                      <div className="mb-3 flex flex-wrap gap-1.5">
                        {reportDates.slice(0, 14).map(date => (
                          <Button
                            key={date}
                            variant={selectedDate === date ? "default" : "outline"}
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setSelectedDate(date)}
                          >
                            {date.slice(5)}
                          </Button>
                        ))}
                      </div>
                      {selectedDate && reportContent && (
                        <MarkdownFileViewer content={reportContent} readOnly />
                      )}
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
}

