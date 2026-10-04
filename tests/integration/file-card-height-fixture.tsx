/** Local SSR → hydration fixture for MUL-518; no API/database is involved. */
import { hydrateRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { EntryHtml } from "../../frontend/packages/views/common/session-log/entry-html";
import type { Attachment } from "@multiremi/core/types";
import enChat from "../../frontend/packages/views/locales/en/chat.json";
import enEditor from "../../frontend/packages/views/locales/en/editor.json";
import enUI from "../../frontend/packages/views/locales/en/ui.json";
import "../../frontend/packages/views/editor/styles/index.css";

export interface FixtureRow { name: string; html: string; markdown: string; attachments?: Attachment[] }
export function Surface({ rows }: { rows: FixtureRow[] }) {
  return <QueryClientProvider client={new QueryClient()}>
    <I18nProvider locale="en" resources={{ en: { chat: enChat, editor: enEditor, ui: enUI } }}>
      <main>{[false, true].map(compact => <section key={String(compact)}>
        {rows.map(row => <div key={row.name} data-height-row={`${compact ? "compact" : "normal"}:${row.name}`}>
          <EntryHtml html={row.html} markdown={row.markdown} attachments={row.attachments}
            className={compact ? "rich-text-editor--compact" : ""} />
        </div>)}
      </section>)}</main>
    </I18nProvider>
  </QueryClientProvider>;
}

if (typeof window !== "undefined") {
  Object.assign(window, { hydrateFileCards: () => {
    const rows = (window as unknown as { fileCardRows: FixtureRow[] }).fileCardRows;
    hydrateRoot(document.getElementById("root")!, <Surface rows={rows} />);
  } });
}
