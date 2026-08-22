"use client";

import { FlaskConical } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@multiremi/ui/components/ui/empty";
import { useT } from "../../i18n";

// Commit attribution now lives in the provider-neutral Source Control tab.
// Labs stays as a container for future experimental flags.
export function LabsTab() {
  const { t } = useT("settings");
  return (
    <div className="space-y-4">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FlaskConical className="h-4 w-4" />
          </EmptyMedia>
          <EmptyTitle>{t(($) => $.labs.section_placeholder_title)}</EmptyTitle>
          <EmptyDescription>
            {t(($) => $.labs.section_placeholder_description)}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
