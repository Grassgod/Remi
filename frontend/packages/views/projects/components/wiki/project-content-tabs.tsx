"use client";

import { useState, type ReactNode } from "react";
import { BookText, ListTodo } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@multiremi/ui/components/ui/tabs";
import { ProjectWikiSection } from "./project-wiki-section";
import { useT } from "../../../i18n";

type ProjectContentTab = "issues" | "wiki";

/**
 * Issues | Wiki switch for the project detail content panel.
 *
 * The issues surface arrives as a slot rather than being rendered here so the
 * two branches stay direct flex children of the panel column — wrapping the
 * issues board in a tab panel would re-layout it. Deliberately local state:
 * the switch is view-only chrome, not a route (Phase 1 keeps `/projects/:id`
 * pointing at the same page whichever tab is showing).
 */
export function ProjectContentTabs({
  projectId,
  issues,
}: {
  projectId: string;
  issues: ReactNode;
}) {
  const { t } = useT("projects");
  const [tab, setTab] = useState<ProjectContentTab>("issues");

  return (
    <>
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as ProjectContentTab)}
        className="shrink-0 px-3 pt-2"
      >
        <TabsList variant="line">
          <TabsTrigger value="issues">
            <ListTodo className="h-4 w-4" />
            {t(($) => $.wiki.tab_issues)}
          </TabsTrigger>
          <TabsTrigger value="wiki">
            <BookText className="h-4 w-4" />
            {t(($) => $.wiki.tab_wiki)}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "issues" ? issues : <ProjectWikiSection projectId={projectId} />}
    </>
  );
}
