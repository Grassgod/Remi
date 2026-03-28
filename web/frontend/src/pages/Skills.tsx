import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { Zap, FileText, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownFileViewer } from "../components/MarkdownFileViewer";
import * as api from "../api/client";
import type { SkillInfo } from "../api/types";

type Tab = "skill" | "reports";

export function Skills() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("skill");
  const [skillContent, setSkillContent] = useState("");
  const [reportDates, setReportDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [reportContent, setReportContent] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getSkills().then(data => {
      setSkills(data);
      if (data.length > 0) setSelected(data[0].name);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setTab("skill");
    api.getSkillFile(selected).then(d => setSkillContent(d.content)).catch(() => setSkillContent(""));
    const skill = skills.find(s => s.name === selected);
    if (skill?.hasSchedule) {
      api.getSkillReports(selected).then(setReportDates).catch(() => setReportDates([]));
    } else {
      setReportDates([]);
    }
    setSelectedDate(null);
    setReportContent("");
  }, [selected]);

  useEffect(() => {
    if (!selected || !selectedDate) return;
    api.getSkillReport(selected, selectedDate).then(d => setReportContent(d.content)).catch(() => setReportContent(""));
  }, [selectedDate]);

  const handleSaveSkill = async (content: string) => {
    if (!selected) return;
    await api.putSkillFile(selected, content);
    setSkillContent(content);
  };

  const currentSkill = skills.find(s => s.name === selected);

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
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[220px_1fr]">
          {/* Skill List */}
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
                {skills.map(skill => (
                  <div
                    key={skill.name}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs transition-colors",
                      selected === skill.name
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    )}
                    onClick={() => setSelected(skill.name)}
                  >
                    <FileText className="h-3 w-3 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                    {skill.hasSchedule && (
                      <Clock className="h-3 w-3 shrink-0 text-green-500" />
                    )}
                  </div>
                ))}
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
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                      Skills / <span className="text-foreground font-medium">{currentSkill.name}</span>
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
                    variant={tab === "skill" ? "default" : "outline"}
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setTab("skill")}
                  >
                    SKILL.md
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

                {/* SKILL.md Tab */}
                {tab === "skill" && (
                  <Card>
                    <CardContent className="pt-4">
                      <MarkdownFileViewer content={skillContent} onSave={handleSaveSkill} />
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
