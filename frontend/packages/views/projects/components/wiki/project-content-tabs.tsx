"use client";

import { useState, type ReactNode } from "react";
import { BookText, ListTodo } from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@multiremi/ui/components/ui/tabs";
import { ProjectWikiSection } from "./project-wiki-section";
import { useT } from "../../../i18n";

type ProjectContentTab = "issues" | "wiki";

/**
 * Issues | Wiki switch for the project detail content panel.
 *
 * The issues surface arrives as a slot rather than being rendered here, so the
 * board doesn't have to know it lives behind a tab. Both branches are real
 * `TabsContent` panels: Base UI derives each tab's `aria-controls` from the
 * panel registered under the matching value, so rendering the content as a
 * sibling of the tab list would leave a tablist whose tabs control nothing and
 * a content region with no `tabpanel` role. The panels re-create the flex
 * column the panel column used to provide directly (`text-base` pins the
 * inherited font size the surfaces were built against — `TabsContent` ships
 * `text-sm`). Deliberately local state: the switch is view-only chrome, not a
 * route (Phase 1 keeps `/projects/:id` pointing at the same page whichever tab
 * is showing).
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
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as ProjectContentTab)}
      className="min-h-0 flex-1 gap-0"
    >
      <TabsList variant="line" className="mx-3 mt-2 shrink-0">
        <TabsTrigger value="issues">
          <ListTodo className="h-4 w-4" />
          {t(($) => $.wiki.tab_issues)}
        </TabsTrigger>
        <TabsTrigger value="wiki">
          <BookText className="h-4 w-4" />
          {t(($) => $.wiki.tab_wiki)}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="issues" className="flex min-h-0 flex-col text-base">
        {issues}
      </TabsContent>
      <TabsContent value="wiki" className="flex min-h-0 flex-col text-base">
        <ProjectWikiSection projectId={projectId} />
      </TabsContent>
    </Tabs>
  );
}
