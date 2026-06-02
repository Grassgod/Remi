export function renderMulticaDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bun Multica</title>
  <style>
    :root {
      color-scheme: light;
      --background: oklch(1 0 0);
      --foreground: oklch(0.141 0.005 285.823);
      --card: oklch(1 0 0);
      --card-foreground: oklch(0.141 0.005 285.823);
      --primary: oklch(0.21 0.006 285.885);
      --primary-foreground: oklch(0.985 0 0);
      --secondary: oklch(0.967 0.001 286.375);
      --secondary-foreground: oklch(0.21 0.006 285.885);
      --muted: oklch(0.967 0.001 286.375);
      --muted-foreground: oklch(0.552 0.016 285.938);
      --accent: oklch(0.967 0.001 286.375);
      --accent-foreground: oklch(0.21 0.006 285.885);
      --destructive: oklch(0.577 0.245 27.325);
      --border: oklch(0.92 0.004 286.32);
      --input: oklch(0.92 0.004 286.32);
      --ring: oklch(0.705 0.015 286.067);
      --brand: oklch(0.55 0.16 255);
      --brand-foreground: oklch(0.985 0 0);
      --success: oklch(0.55 0.16 145);
      --warning: oklch(0.75 0.16 85);
      --info: oklch(0.55 0.18 250);
      --sidebar: oklch(0.985 0 0);
      --sidebar-foreground: oklch(0.141 0.005 285.823);
      --sidebar-accent: oklch(0.95 0.002 286.375);
      --sidebar-accent-foreground: oklch(0.21 0.006 285.885);
      --sidebar-border: oklch(0.92 0.004 286.32);
      --radius: .625rem;
      --shadow-card: 0 3px 6px -2px rgba(0,0,0,.02), 0 1px 1px rgba(0,0,0,.04);
      --shadow-panel: 0 16px 45px rgba(0,0,0,.12);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      overflow: hidden;
      background: var(--background);
      color: var(--foreground);
    }
    button, input, select, textarea { font: inherit; letter-spacing: 0; }
    button {
      height: 32px;
      border: 1px solid transparent;
      border-radius: calc(var(--radius) * .8);
      background: transparent;
      color: var(--foreground);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 0 10px;
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      cursor: pointer;
      transition: background .15s ease, color .15s ease, border-color .15s ease, transform .08s ease;
    }
    button:hover { background: var(--muted); }
    button:active { transform: translateY(1px); }
    button.primary { background: var(--primary); color: var(--primary-foreground); }
    button.primary:hover { background: color-mix(in oklab, var(--primary) 86%, transparent); }
    button.outline { border-color: var(--border); background: var(--background); }
    button.outline:hover { background: var(--muted); }
    button.destructive { background: color-mix(in oklab, var(--destructive) 10%, transparent); color: var(--destructive); }
    button.icon {
      width: 32px;
      padding: 0;
      flex: 0 0 auto;
      color: var(--muted-foreground);
    }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--input);
      border-radius: calc(var(--radius) * .8);
      background: var(--background);
      color: var(--foreground);
      outline: none;
      font-size: 13px;
      line-height: 1.4;
      padding: 8px 10px;
    }
    textarea { min-height: 112px; resize: vertical; }
    input:focus, select:focus, textarea:focus {
      border-color: var(--ring);
      box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 25%, transparent);
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted-foreground);
      font-size: 12px;
      font-weight: 650;
    }

    @keyframes entrance-spin {
      0% { transform: rotate(0deg); opacity: 0; }
      50% { opacity: 1; }
      100% { transform: rotate(360deg); opacity: 1; }
    }
    @keyframes chat-impulse {
      0%, 100% {
        color: var(--muted-foreground);
        box-shadow: 0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent);
      }
      50% {
        color: var(--brand);
        box-shadow: 0 0 0 1px color-mix(in oklab, var(--brand) 40%, transparent);
      }
    }
    @keyframes chat-text-shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    @keyframes nav-progress-sweep {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }
    @keyframes board-enter {
      from { opacity: 0; transform: translateY(4px); }
    }

    .multica-icon {
      width: 1em;
      height: 1em;
      display: inline-block;
      color: currentColor;
      animation: entrance-spin .6s ease-out both;
    }
    .multica-icon::before {
      content: "";
      display: block;
      width: 100%;
      height: 100%;
      background: currentColor;
      clip-path: polygon(
        45% 62.1%, 45% 100%, 55% 100%, 55% 62.1%,
        81.8% 88.9%, 88.9% 81.8%, 62.1% 55%, 100% 55%,
        100% 45%, 62.1% 45%, 88.9% 18.2%, 81.8% 11.1%,
        55% 37.9%, 55% 0%, 45% 0%, 45% 37.9%,
        18.2% 11.1%, 11.1% 18.2%, 37.9% 45%, 0% 45%,
        0% 55%, 37.9% 55%, 11.1% 81.8%, 18.2% 88.9%
      );
    }
    .brand-button:hover .multica-icon { animation: entrance-spin .6s ease-out both; }

    .app {
      height: 100vh;
      display: grid;
      grid-template-columns: 256px minmax(0, 1fr);
      background: var(--background);
    }
    .sidebar {
      min-width: 0;
      background: var(--sidebar);
      border-right: 1px solid var(--sidebar-border);
      display: grid;
      grid-template-rows: auto auto 1fr auto;
    }
    .sidebar-header {
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .brand-button {
      height: 36px;
      border-radius: calc(var(--radius) * .9);
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 0 8px;
      color: var(--sidebar-foreground);
      font-weight: 650;
    }
    .brand-button .multica-icon {
      width: 20px;
      height: 20px;
      flex: 0 0 auto;
    }
    .workspace-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .search-trigger {
      height: 32px;
      border: 1px solid var(--border);
      border-radius: calc(var(--radius) * .8);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 8px;
      color: var(--muted-foreground);
      background: var(--background);
      font-size: 13px;
      cursor: pointer;
    }
    .kbd {
      min-width: 20px;
      height: 20px;
      border: 1px solid var(--border);
      border-radius: 5px;
      display: inline-grid;
      place-items: center;
      padding: 0 5px;
      font-size: 11px;
      color: var(--muted-foreground);
      background: var(--muted);
    }
    .quick-create {
      margin: 0 10px 8px;
      height: 32px;
      border-radius: calc(var(--radius) * .8);
      background: var(--primary);
      color: var(--primary-foreground);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .nav-scroll {
      min-height: 0;
      overflow-y: auto;
      padding: 0 8px 10px;
      scrollbar-width: thin;
    }
    .nav-group { padding-top: 8px; }
    .nav-label {
      padding: 7px 8px 5px;
      color: var(--muted-foreground);
      font-size: 11px;
      font-weight: 650;
    }
    .nav-item {
      height: 32px;
      border-radius: calc(var(--radius) * .8);
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 0 8px;
      color: var(--muted-foreground);
      font-size: 13px;
      position: relative;
      cursor: pointer;
    }
    .nav-item.active {
      background: var(--sidebar-accent);
      color: var(--sidebar-accent-foreground);
      font-weight: 600;
    }
    .nav-item:hover { background: color-mix(in oklab, var(--sidebar-accent) 70%, transparent); }
    .nav-icon {
      width: 16px;
      height: 16px;
      border-radius: 5px;
      border: 1px solid currentColor;
      opacity: .72;
      flex: 0 0 auto;
      position: relative;
    }
    .nav-icon.issue::before {
      content: "";
      position: absolute;
      left: 3px;
      right: 3px;
      top: 4px;
      height: 1px;
      background: currentColor;
      box-shadow: 0 4px 0 currentColor;
    }
    .nav-icon.bot { border-radius: 999px; }
    .nav-icon.bot::before {
      content: "";
      position: absolute;
      inset: 4px;
      border-radius: inherit;
      background: currentColor;
    }
    .nav-icon.runtime::before {
      content: "";
      position: absolute;
      left: 3px;
      right: 3px;
      bottom: 3px;
      height: 1px;
      background: currentColor;
    }
    .sidebar-footer {
      border-top: 1px solid var(--border);
      padding: 8px;
      display: grid;
      gap: 6px;
    }
    .user-row {
      height: 34px;
      border-radius: calc(var(--radius) * .8);
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 8px;
      color: var(--muted-foreground);
      font-size: 13px;
    }
    .avatar {
      width: 22px;
      height: 22px;
      border-radius: 999px;
      display: inline-grid;
      place-items: center;
      background: var(--muted);
      color: var(--foreground);
      font-size: 11px;
      font-weight: 700;
      flex: 0 0 auto;
    }

    .content {
      min-width: 0;
      min-height: 0;
      position: relative;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .nav-progress {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      overflow: hidden;
      pointer-events: none;
      opacity: 0;
      z-index: 20;
    }
    .nav-progress.active { opacity: 1; }
    .nav-progress::before {
      content: "";
      display: block;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, transparent, var(--brand), transparent);
      animation: nav-progress-sweep 1.4s cubic-bezier(.4,0,.2,1) infinite;
    }
    .page-header {
      height: 48px;
      flex: 0 0 auto;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 0 16px;
      font-size: 14px;
    }
    .workspace-avatar {
      width: 22px;
      height: 22px;
      border-radius: 7px;
      display: inline-grid;
      place-items: center;
      background: var(--muted);
      color: var(--foreground);
      font-size: 12px;
      font-weight: 700;
    }
    .breadcrumb-muted { color: var(--muted-foreground); }
    .chevron {
      width: 12px;
      height: 12px;
      color: var(--muted-foreground);
      position: relative;
      flex: 0 0 auto;
    }
    .chevron::before {
      content: "";
      position: absolute;
      inset: 2px 3px;
      border-top: 1.5px solid currentColor;
      border-right: 1.5px solid currentColor;
      transform: rotate(45deg);
    }
    .toolbar {
      min-height: 48px;
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 0 16px;
      border-bottom: 1px solid color-mix(in oklab, var(--border) 65%, transparent);
    }
    .toolbar-left, .toolbar-right {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .tabs {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .tab {
      height: 32px;
      border-radius: calc(var(--radius) * .8);
      padding: 0 10px;
      display: inline-flex;
      align-items: center;
      color: var(--muted-foreground);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    .tab.active { color: var(--foreground); background: var(--muted); }
    .chip-button {
      height: 32px;
      border-radius: calc(var(--radius) * .8);
      border: 1px solid var(--border);
      background: var(--background);
      color: var(--muted-foreground);
      padding: 0 9px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
    }
    .chip-button.active {
      background: var(--muted);
      color: var(--foreground);
    }
    .view-toggle {
      height: 32px;
      border: 1px solid var(--border);
      border-radius: calc(var(--radius) * .8);
      display: flex;
      overflow: hidden;
      background: var(--background);
    }
    .view-toggle button {
      height: 30px;
      border-radius: 0;
      border: 0;
      color: var(--muted-foreground);
      padding: 0 9px;
    }
    .view-toggle button.active {
      background: var(--muted);
      color: var(--foreground);
    }

    .page {
      flex: 1;
      min-height: 0;
      display: none;
      flex-direction: column;
    }
    .page.active { display: flex; animation: board-enter .25s ease both; }
    .board {
      flex: 1;
      min-height: 0;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 16px;
      display: grid;
      grid-template-columns: repeat(4, minmax(230px, 1fr));
      gap: 16px;
      background: var(--background);
    }
    .column {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .column-head {
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--muted-foreground);
      font-size: 13px;
      font-weight: 650;
      padding: 0 2px;
    }
    .count-pill {
      min-width: 22px;
      height: 20px;
      border-radius: 999px;
      background: var(--muted);
      color: var(--muted-foreground);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 7px;
      font-size: 11px;
      font-weight: 650;
    }
    .cards {
      min-height: 120px;
      display: grid;
      align-content: start;
      gap: 8px;
    }
    .issue-card {
      border: .5px solid var(--border);
      border-radius: calc(var(--radius) * 1.1);
      background: var(--card);
      color: var(--card-foreground);
      box-shadow: var(--shadow-card);
      padding: 12px 10px;
      display: grid;
      gap: 7px;
      transition: border-color .15s ease, background .15s ease, transform .1s ease;
      cursor: pointer;
    }
    .issue-card:hover {
      border-color: var(--accent);
      background: var(--accent);
    }
    .issue-card:active { transform: translateY(1px); }
    .issue-id {
      font-size: 12px;
      color: var(--muted-foreground);
      font-variant-numeric: tabular-nums;
    }
    .issue-title {
      min-width: 0;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
      font-size: 14px;
      line-height: 1.35;
      font-weight: 550;
    }
    .issue-desc {
      min-width: 0;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 1;
      overflow: hidden;
      color: var(--muted-foreground);
      font-size: 12px;
      line-height: 1.35;
    }
    .issue-meta {
      display: flex;
      align-items: center;
      gap: 7px;
      flex-wrap: wrap;
      min-width: 0;
      margin-top: 2px;
    }
    .agent-avatar {
      width: 22px;
      height: 22px;
      border-radius: 999px;
      display: inline-grid;
      place-items: center;
      background: var(--muted);
      color: var(--foreground);
      font-size: 10px;
      font-weight: 750;
      flex: 0 0 auto;
    }
    .status-badge {
      height: 22px;
      border-radius: 5px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 0 6px;
      font-size: 12px;
      font-weight: 650;
      color: var(--muted-foreground);
      background: var(--muted);
      max-width: 100%;
    }
    .status-badge.queued { color: var(--info); background: color-mix(in oklab, var(--info) 11%, transparent); }
    .status-badge.running, .status-badge.dispatched { color: color-mix(in oklab, var(--warning) 70%, black); background: color-mix(in oklab, var(--warning) 18%, transparent); }
    .status-badge.completed { color: var(--success); background: color-mix(in oklab, var(--success) 13%, transparent); }
    .status-badge.failed, .status-badge.cancelled { color: var(--destructive); background: color-mix(in oklab, var(--destructive) 12%, transparent); }
    .empty-column {
      min-height: 90px;
      border: 1px dashed var(--border);
      border-radius: calc(var(--radius) * 1.1);
      display: grid;
      place-items: center;
      color: var(--muted-foreground);
      font-size: 12px;
      padding: 14px;
      text-align: center;
    }

    .list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      display: none;
      padding: 8px 0;
    }
    .list.active { display: block; }
    .list-row {
      height: 36px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 16px;
      font-size: 13px;
      transition: background .15s ease;
      cursor: pointer;
    }
    .list-row:hover { background: color-mix(in oklab, var(--accent) 60%, transparent); }
    .priority-dot {
      width: 15px;
      height: 15px;
      border-radius: 5px;
      border: 1px solid var(--border);
      flex: 0 0 auto;
    }
    .list-id {
      width: 78px;
      color: var(--muted-foreground);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      flex: 0 0 auto;
    }
    .list-title {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .list-right {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted-foreground);
      font-size: 12px;
      flex: 0 0 auto;
    }

    .collection {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 16px;
    }
    .entity-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(270px, 1fr));
      gap: 12px;
    }
    .entity-card {
      border: .5px solid var(--border);
      border-radius: calc(var(--radius) * 1.1);
      background: var(--card);
      box-shadow: var(--shadow-card);
      padding: 13px;
      display: grid;
      gap: 10px;
      min-width: 0;
    }
    .entity-head {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
    }
    .entity-main {
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .entity-title {
      font-size: 14px;
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .entity-subtitle {
      color: var(--muted-foreground);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .entity-body {
      color: var(--muted-foreground);
      font-size: 12px;
      line-height: 1.45;
      min-height: 36px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .metric-row {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
    }
    .metric {
      min-width: 0;
      border: 1px solid var(--border);
      border-radius: calc(var(--radius) * .8);
      padding: 8px;
      display: grid;
      gap: 3px;
    }
    .metric-value {
      font-size: 16px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .metric-label {
      color: var(--muted-foreground);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .placeholder-panel {
      flex: 1;
      min-height: 0;
      display: grid;
      place-items: center;
      padding: 16px;
    }
    .placeholder-card {
      width: min(420px, 100%);
      border: .5px solid var(--border);
      border-radius: calc(var(--radius) * 1.1);
      background: var(--card);
      box-shadow: var(--shadow-card);
      padding: 18px;
      display: grid;
      gap: 8px;
      text-align: center;
    }
    .placeholder-title { font-weight: 650; }
    .placeholder-text { color: var(--muted-foreground); font-size: 13px; line-height: 1.45; }

    .floating-panel {
      position: absolute;
      border: 1px solid var(--border);
      border-radius: calc(var(--radius) * 1.3);
      background: var(--card);
      box-shadow: var(--shadow-panel);
      display: none;
      z-index: 30;
      overflow: hidden;
    }
    .floating-panel.open { display: block; animation: board-enter .25s ease both; }
    .create-sheet {
      right: 16px;
      top: 104px;
      width: min(380px, calc(100vw - 32px));
    }
    .agent-sheet {
      right: 16px;
      top: 104px;
      width: min(420px, calc(100vw - 32px));
    }
    .sheet-head {
      height: 48px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 14px;
      font-size: 14px;
      font-weight: 650;
    }
    .sheet-form {
      display: grid;
      gap: 10px;
      padding: 14px;
    }
    .notice {
      min-height: 34px;
      border: 1px solid var(--border);
      border-radius: calc(var(--radius) * .8);
      display: none;
      align-items: center;
      padding: 8px 10px;
      color: var(--muted-foreground);
      background: var(--muted);
      font-size: 12px;
    }
    .notice.show { display: flex; }

    .drawer {
      position: absolute;
      top: 48px;
      right: 0;
      bottom: 0;
      width: min(520px, 100%);
      border-left: 1px solid var(--border);
      background: var(--card);
      box-shadow: -16px 0 40px rgba(0,0,0,.08);
      z-index: 25;
      display: none;
      grid-template-rows: auto 1fr;
    }
    .drawer.open { display: grid; animation: board-enter .2s ease both; }
    .drawer-head {
      min-height: 56px;
      border-bottom: 1px solid var(--border);
      padding: 10px 12px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .drawer-title {
      min-width: 0;
      flex: 1;
      display: grid;
      gap: 3px;
    }
    .drawer-title strong {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 14px;
    }
    .drawer-title span {
      color: var(--muted-foreground);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .drawer-body {
      min-height: 0;
      overflow: auto;
      padding: 14px;
      display: grid;
      align-content: start;
      gap: 12px;
    }
    .detail-block {
      display: grid;
      gap: 8px;
    }
    .detail-label {
      color: var(--muted-foreground);
      font-size: 11px;
      font-weight: 650;
      text-transform: uppercase;
    }
    .detail-text {
      color: var(--foreground);
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .detail-cell {
      border: 1px solid var(--border);
      border-radius: calc(var(--radius) * .8);
      padding: 8px;
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .detail-cell span {
      color: var(--muted-foreground);
      font-size: 11px;
    }
    .detail-cell strong {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 650;
    }
    .message-list {
      display: grid;
      gap: 8px;
    }
    .message-row {
      border: 1px solid var(--border);
      border-radius: calc(var(--radius) * .8);
      padding: 9px;
      display: grid;
      gap: 6px;
      background: color-mix(in oklab, var(--muted) 30%, transparent);
    }
    .message-head {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--muted-foreground);
      font-size: 11px;
      font-weight: 650;
    }
    .message-content {
      color: var(--foreground);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 220px;
      overflow: auto;
    }

    .command-overlay {
      position: absolute;
      inset: 0;
      z-index: 60;
      background: rgba(255,255,255,.72);
      display: none;
      place-items: start center;
      padding-top: min(16vh, 120px);
    }
    .command-overlay.open { display: grid; }
    .command-panel {
      width: min(640px, calc(100vw - 32px));
      border: 1px solid var(--border);
      border-radius: calc(var(--radius) * 1.3);
      background: var(--card);
      box-shadow: var(--shadow-panel);
      overflow: hidden;
    }
    .command-input {
      height: 48px;
      border: 0;
      border-bottom: 1px solid var(--border);
      border-radius: 0;
      box-shadow: none !important;
      font-size: 14px;
    }
    .command-results {
      max-height: min(420px, 56vh);
      overflow: auto;
      padding: 6px;
    }
    .command-row {
      min-height: 42px;
      border-radius: calc(var(--radius) * .8);
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 7px 8px;
      cursor: pointer;
    }
    .command-row:hover { background: var(--muted); }
    .command-row-main {
      min-width: 0;
      flex: 1;
      display: grid;
      gap: 2px;
    }
    .command-row-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 600;
    }
    .command-row-subtitle {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted-foreground);
      font-size: 12px;
    }

    .runtime-strip {
      position: absolute;
      left: 16px;
      right: 72px;
      bottom: 12px;
      height: 40px;
      display: flex;
      align-items: center;
      gap: 8px;
      pointer-events: none;
    }
    .runtime-pill {
      height: 30px;
      max-width: 260px;
      border-radius: 999px;
      background: var(--card);
      color: var(--muted-foreground);
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent), 0 8px 18px rgba(0,0,0,.04);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 0 10px;
      font-size: 12px;
      pointer-events: auto;
    }
    .runtime-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--muted-foreground);
    }
    .runtime-dot.online { background: var(--success); }
    .runtime-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chat-fab {
      position: absolute;
      bottom: 12px;
      right: 12px;
      z-index: 40;
      width: 40px;
      height: 40px;
      border-radius: 999px;
      background: var(--card);
      color: var(--muted-foreground);
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent), 0 8px 22px rgba(0,0,0,.08);
      display: grid;
      place-items: center;
      cursor: pointer;
      transition: transform .15s ease, color .15s ease;
    }
    .chat-fab.running { animation: chat-impulse 1.6s ease-in-out infinite; }
    .chat-fab:hover { transform: scale(1.1); color: var(--accent-foreground); }
    .chat-fab:active { transform: scale(.95); }
    .chat-bubble {
      width: 20px;
      height: 17px;
      border: 1.8px solid currentColor;
      border-radius: 8px;
      position: relative;
    }
    .chat-bubble::after {
      content: "";
      position: absolute;
      right: 2px;
      bottom: -4px;
      width: 7px;
      height: 7px;
      border-right: 1.8px solid currentColor;
      border-bottom: 1.8px solid currentColor;
      transform: rotate(35deg);
      background: var(--card);
    }
    .task-status-pill {
      position: absolute;
      right: 58px;
      bottom: 15px;
      max-width: min(420px, calc(100vw - 330px));
      min-width: 0;
      height: 34px;
      border-radius: 999px;
      background: var(--card);
      color: var(--muted-foreground);
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent), 0 8px 22px rgba(0,0,0,.06);
      display: none;
      align-items: center;
      gap: 8px;
      padding: 0 12px;
      font-size: 12px;
      z-index: 39;
    }
    .task-status-pill.show { display: flex; }
    .spinner {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      border: 2px solid color-mix(in oklab, var(--muted-foreground) 25%, transparent);
      border-top-color: var(--muted-foreground);
      animation: entrance-spin .8s linear infinite;
      flex: 0 0 auto;
    }
    .shimmer {
      background-image: linear-gradient(90deg, var(--muted-foreground) 0%, var(--muted-foreground) 35%, var(--foreground) 50%, var(--muted-foreground) 65%, var(--muted-foreground) 100%);
      background-size: 200% 100%;
      background-clip: text;
      -webkit-background-clip: text;
      color: transparent;
      -webkit-text-fill-color: transparent;
      animation: chat-text-shimmer 2.5s linear infinite;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chat-window {
      position: absolute;
      right: 12px;
      bottom: 58px;
      width: min(380px, calc(100vw - 24px));
      border: 1px solid var(--border);
      border-radius: calc(var(--radius) * 1.3);
      background: var(--card);
      box-shadow: var(--shadow-panel);
      z-index: 41;
      display: none;
      overflow: hidden;
    }
    .chat-window.open { display: grid; grid-template-rows: auto 1fr auto; animation: board-enter .2s ease both; }
    .chat-head {
      height: 44px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px 0 12px;
      font-size: 13px;
      font-weight: 650;
    }
    .chat-log {
      max-height: 260px;
      overflow: auto;
      padding: 10px;
      display: grid;
      align-content: start;
      gap: 8px;
    }
    .chat-entry {
      border: 1px solid var(--border);
      border-radius: calc(var(--radius) * .8);
      padding: 8px;
      display: grid;
      gap: 4px;
      font-size: 12px;
    }
    .chat-entry.user { margin-left: 34px; background: var(--muted); }
    .chat-entry.system { margin-right: 34px; }
    .chat-entry span { color: var(--muted-foreground); font-size: 11px; }
    .chat-form {
      border-top: 1px solid var(--border);
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .chat-form textarea {
      min-height: 78px;
      max-height: 160px;
    }

    @media (max-width: 900px) {
      body { overflow: auto; }
      .app { min-height: 100vh; height: auto; grid-template-columns: 1fr; }
      .sidebar { display: none; }
      .content { min-height: 100vh; }
      .toolbar { align-items: flex-start; padding: 8px 12px; flex-direction: column; }
      .page-header { padding: 0 12px; }
      .board { grid-template-columns: 1fr; overflow: visible; padding: 12px; }
      .task-status-pill { left: 12px; right: 58px; max-width: none; }
      .runtime-strip { display: none; }
      .drawer { top: 0; width: 100%; }
      .detail-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="brand-button">
          <span class="multica-icon"></span>
          <span class="workspace-name">local workspace</span>
        </div>
        <div class="search-trigger" id="searchTrigger"><span>Search</span><span class="kbd">⌘K</span></div>
      </div>
      <div class="quick-create" id="quickCreate">+ New issue</div>
      <div class="nav-scroll">
        <div class="nav-group">
          <div class="nav-label">Personal</div>
          <div class="nav-item" data-page="inbox"><span class="nav-icon"></span><span>Inbox</span></div>
          <div class="nav-item" data-page="my-issues"><span class="nav-icon"></span><span>My Issues</span></div>
        </div>
        <div class="nav-group">
          <div class="nav-label">Workspace</div>
          <div class="nav-item active" data-page="issues"><span class="nav-icon issue"></span><span>Issues</span></div>
          <div class="nav-item" data-page="projects"><span class="nav-icon"></span><span>Projects</span></div>
          <div class="nav-item" data-page="autopilots"><span class="nav-icon"></span><span>Autopilots</span></div>
          <div class="nav-item" data-page="agents"><span class="nav-icon bot"></span><span>Agents</span></div>
          <div class="nav-item" data-page="squads"><span class="nav-icon bot"></span><span>Squads</span></div>
          <div class="nav-item" data-page="usage"><span class="nav-icon"></span><span>Usage</span></div>
        </div>
        <div class="nav-group">
          <div class="nav-label">Configure</div>
          <div class="nav-item" data-page="runtimes"><span class="nav-icon runtime"></span><span>Runtimes</span></div>
          <div class="nav-item" data-page="skills"><span class="nav-icon"></span><span>Skills</span></div>
          <div class="nav-item" data-page="settings"><span class="nav-icon"></span><span>Settings</span></div>
        </div>
      </div>
      <div class="sidebar-footer">
        <div class="user-row"><span class="avatar">B</span><span>Bun runtime</span></div>
      </div>
    </aside>

    <main class="content">
      <div class="nav-progress" id="navProgress"></div>
      <div class="page-header">
        <span class="workspace-avatar">L</span>
        <span class="breadcrumb-muted">local workspace</span>
        <span class="chevron"></span>
        <span id="pageTitle">Issues</span>
      </div>

      <div class="toolbar" id="toolbar"></div>

      <section class="page active" id="issuesPage">
        <div class="board" id="board"></div>
        <div class="list" id="list"></div>
      </section>
      <section class="page" id="agentsPage">
        <div class="collection">
          <div class="entity-grid" id="agentsGrid"></div>
        </div>
      </section>
      <section class="page" id="runtimesPage">
        <div class="collection">
          <div class="entity-grid" id="runtimesGrid"></div>
        </div>
      </section>
      <section class="page" id="placeholderPage">
        <div class="placeholder-panel">
          <div class="placeholder-card">
            <div class="placeholder-title" id="placeholderTitle"></div>
            <div class="placeholder-text" id="placeholderText"></div>
          </div>
        </div>
      </section>

      <div class="floating-panel create-sheet" id="createSheet">
        <div class="sheet-head">
          <span>New issue</span>
          <button class="outline" id="closeSheet">Close</button>
        </div>
        <form class="sheet-form" id="taskForm">
          <label>Agent<select id="agentSelect" required></select></label>
          <label>Workspace<input id="workspace" value="local"></label>
          <label>Title<textarea id="prompt" required placeholder="Describe the issue"></textarea></label>
          <button class="primary" type="submit">Create</button>
          <div class="notice" id="notice"></div>
        </form>
      </div>

      <div class="floating-panel agent-sheet" id="agentSheet">
        <div class="sheet-head">
          <span>New agent</span>
          <button class="outline" id="closeAgentSheet">Close</button>
        </div>
        <form class="sheet-form" id="agentForm">
          <label>Name<input id="agentName" required placeholder="Agent name"></label>
          <label>Provider<select id="agentProvider"><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
          <label>Model<input id="agentModel" placeholder="Optional"></label>
          <label>Working directory<input id="agentCwd" placeholder="Optional"></label>
          <label>Instructions<textarea id="agentInstructions" placeholder="Optional"></textarea></label>
          <button class="primary" type="submit">Create agent</button>
          <div class="notice" id="agentNotice"></div>
        </form>
      </div>

      <aside class="drawer" id="taskDrawer"></aside>

      <div class="command-overlay" id="searchOverlay">
        <div class="command-panel">
          <input class="command-input" id="searchInput" placeholder="Search issues, agents, runtimes">
          <div class="command-results" id="searchResults"></div>
        </div>
      </div>

      <div class="chat-window" id="chatWindow">
        <div class="chat-head">
          <span>Multica chat</span>
          <button class="icon" id="closeChat">x</button>
        </div>
        <div class="chat-log" id="chatLog"></div>
        <form class="chat-form" id="chatForm">
          <select id="chatAgent"></select>
          <textarea id="chatPrompt" required placeholder="Message"></textarea>
          <button class="primary" type="submit">Send</button>
        </form>
      </div>

      <div class="runtime-strip" id="runtimeStrip"></div>
      <div class="task-status-pill" id="taskStatusPill">
        <span class="spinner"></span>
        <span class="shimmer" id="taskStatusText">Thinking</span>
      </div>
      <div class="chat-fab" id="chatFab"><span class="chat-bubble"></span></div>
    </main>
  </div>

  <script>
    const pages = {
      inbox: { title: "Inbox", group: "Personal", placeholder: "Inbox", text: "No inbox items." },
      "my-issues": { title: "My Issues", group: "Personal", placeholder: "My Issues", text: "No assigned issues." },
      issues: { title: "Issues", group: "Workspace" },
      projects: { title: "Projects", group: "Workspace", placeholder: "Projects", text: "No projects." },
      autopilots: { title: "Autopilots", group: "Workspace", placeholder: "Autopilots", text: "No autopilots." },
      agents: { title: "Agents", group: "Workspace" },
      squads: { title: "Squads", group: "Workspace", placeholder: "Squads", text: "No squads." },
      usage: { title: "Usage", group: "Workspace", placeholder: "Usage", text: "No usage data." },
      runtimes: { title: "Runtimes", group: "Configure" },
      skills: { title: "Skills", group: "Configure", placeholder: "Skills", text: "No skills." },
      settings: { title: "Settings", group: "Configure", placeholder: "Settings", text: "No local settings." }
    };

    const state = {
      agents: [],
      tasks: [],
      runtimes: [],
      mode: "board",
      activeOnly: false,
      agentFilter: "all",
      page: "issues",
      selectedTaskId: null,
      selectedTask: null,
      selectedMessages: [],
      chatEntries: []
    };

    const els = {
      toolbar: document.getElementById("toolbar"),
      pageTitle: document.getElementById("pageTitle"),
      issuesPage: document.getElementById("issuesPage"),
      agentsPage: document.getElementById("agentsPage"),
      runtimesPage: document.getElementById("runtimesPage"),
      placeholderPage: document.getElementById("placeholderPage"),
      placeholderTitle: document.getElementById("placeholderTitle"),
      placeholderText: document.getElementById("placeholderText"),
      board: document.getElementById("board"),
      list: document.getElementById("list"),
      agentsGrid: document.getElementById("agentsGrid"),
      runtimesGrid: document.getElementById("runtimesGrid"),
      agentSelect: document.getElementById("agentSelect"),
      chatAgent: document.getElementById("chatAgent"),
      notice: document.getElementById("notice"),
      agentNotice: document.getElementById("agentNotice"),
      workspace: document.getElementById("workspace"),
      prompt: document.getElementById("prompt"),
      sheet: document.getElementById("createSheet"),
      agentSheet: document.getElementById("agentSheet"),
      taskDrawer: document.getElementById("taskDrawer"),
      searchOverlay: document.getElementById("searchOverlay"),
      searchInput: document.getElementById("searchInput"),
      searchResults: document.getElementById("searchResults"),
      chatWindow: document.getElementById("chatWindow"),
      chatLog: document.getElementById("chatLog"),
      chatPrompt: document.getElementById("chatPrompt"),
      runtimeStrip: document.getElementById("runtimeStrip"),
      taskStatusPill: document.getElementById("taskStatusPill"),
      taskStatusText: document.getElementById("taskStatusText"),
      chatFab: document.getElementById("chatFab"),
      navProgress: document.getElementById("navProgress")
    };

    document.querySelectorAll("[data-page]").forEach(item => {
      item.addEventListener("click", () => switchPage(item.dataset.page));
    });
    document.getElementById("quickCreate").addEventListener("click", openSheet);
    document.getElementById("closeSheet").addEventListener("click", closeSheet);
    document.getElementById("taskForm").addEventListener("submit", createTask);
    document.getElementById("closeAgentSheet").addEventListener("click", closeAgentSheet);
    document.getElementById("agentForm").addEventListener("submit", createAgent);
    document.getElementById("searchTrigger").addEventListener("click", openSearch);
    document.getElementById("searchOverlay").addEventListener("click", event => {
      if (event.target === els.searchOverlay) closeSearch();
    });
    els.searchInput.addEventListener("input", renderSearchResults);
    els.chatFab.addEventListener("click", toggleChat);
    document.getElementById("closeChat").addEventListener("click", closeChat);
    document.getElementById("chatForm").addEventListener("submit", submitChat);
    document.addEventListener("keydown", event => {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "k") {
        event.preventDefault();
        openSearch();
      }
      if (event.key === "Escape") {
        closeSearch();
        closeDrawer();
      }
    });

    async function api(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) }
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    async function refresh(options = {}) {
      if (!options.silent) showProgress();
      try {
        const [agents, tasks, runtimes] = await Promise.all([
          api("/api/multica/agents"),
          api("/api/multica/tasks"),
          api("/api/multica/runtimes")
        ]);
        state.agents = agents.agents || [];
        state.tasks = tasks.tasks || [];
        state.runtimes = runtimes.runtimes || [];
        render();
        if (state.selectedTaskId) await loadTaskDetail(state.selectedTaskId, { silent: true });
      } catch (err) {
        showNotice(String(err.message || err), options.agent ? els.agentNotice : els.notice);
      } finally {
        if (!options.silent) hideProgress();
      }
    }

    async function seed(provider) {
      await api("/api/multica/agents/default", {
        method: "POST",
        body: JSON.stringify({ provider })
      });
      showNotice("Added " + provider + " agent", els.agentNotice);
      await refresh();
    }

    async function createAgent(event) {
      event.preventDefault();
      const body = {
        name: document.getElementById("agentName").value,
        provider: document.getElementById("agentProvider").value,
        model: document.getElementById("agentModel").value || null,
        cwd: document.getElementById("agentCwd").value || null,
        instructions: document.getElementById("agentInstructions").value || ""
      };
      await api("/api/multica/agents", { method: "POST", body: JSON.stringify(body) });
      document.getElementById("agentForm").reset();
      closeAgentSheet();
      await refresh();
    }

    async function createTask(event) {
      event.preventDefault();
      try {
        const task = await postTask({
          agentId: els.agentSelect.value,
          workspaceId: els.workspace.value || "local",
          prompt: els.prompt.value
        });
        els.prompt.value = "";
        showNotice("Created " + shortId(task.id), els.notice);
        closeSheet();
        switchPage("issues");
        await refresh();
        openTask(task.id);
      } catch (err) {
        showNotice(String(err.message || err), els.notice);
      }
    }

    async function postTask(body) {
      if (!body.agentId) throw new Error("Create an agent first");
      const result = await api("/api/multica/tasks", {
        method: "POST",
        body: JSON.stringify(body)
      });
      return result.task;
    }

    async function cancelTask(id) {
      await api("/api/multica/tasks/" + encodeURIComponent(id) + "/cancel", { method: "POST" });
      await refresh();
    }

    async function openTask(id) {
      state.selectedTaskId = id;
      els.taskDrawer.classList.add("open");
      renderTaskDrawer({ loading: true });
      await loadTaskDetail(id);
    }

    async function loadTaskDetail(id, options = {}) {
      try {
        const [taskResult, messageResult] = await Promise.all([
          api("/api/multica/tasks/" + encodeURIComponent(id)),
          api("/api/multica/tasks/" + encodeURIComponent(id) + "/messages")
        ]);
        state.selectedTask = taskResult.task;
        state.selectedMessages = messageResult.messages || [];
        renderTaskDrawer();
      } catch (err) {
        if (!options.silent) showNotice(String(err.message || err), els.notice);
      }
    }

    function closeDrawer() {
      state.selectedTaskId = null;
      state.selectedTask = null;
      state.selectedMessages = [];
      els.taskDrawer.classList.remove("open");
    }

    function openSheet() {
      closeAgentSheet();
      els.sheet.classList.add("open");
      setTimeout(() => els.prompt.focus(), 50);
    }

    function closeSheet() {
      els.sheet.classList.remove("open");
    }

    function openAgentSheet() {
      closeSheet();
      els.agentSheet.classList.add("open");
      setTimeout(() => document.getElementById("agentName").focus(), 50);
    }

    function closeAgentSheet() {
      els.agentSheet.classList.remove("open");
    }

    function openSearch() {
      els.searchOverlay.classList.add("open");
      els.searchInput.value = "";
      renderSearchResults();
      setTimeout(() => els.searchInput.focus(), 20);
    }

    function closeSearch() {
      els.searchOverlay.classList.remove("open");
    }

    function toggleChat() {
      els.chatWindow.classList.toggle("open");
      renderChat();
      if (els.chatWindow.classList.contains("open")) setTimeout(() => els.chatPrompt.focus(), 40);
    }

    function closeChat() {
      els.chatWindow.classList.remove("open");
    }

    async function submitChat(event) {
      event.preventDefault();
      const prompt = els.chatPrompt.value.trim();
      const agentId = els.chatAgent.value;
      if (!prompt || !agentId) return;
      state.chatEntries.push({ role: "user", text: prompt });
      els.chatPrompt.value = "";
      renderChat();
      try {
        const task = await postTask({ agentId, workspaceId: "local", prompt });
        state.chatEntries.push({ role: "system", text: "Created " + shortId(task.id) });
        await refresh();
      } catch (err) {
        state.chatEntries.push({ role: "system", text: String(err.message || err) });
      }
      renderChat();
    }

    function switchPage(page) {
      state.page = page || "issues";
      closeSheet();
      closeAgentSheet();
      render();
    }

    function setMode(mode) {
      state.mode = mode;
      render();
    }

    function setAgentFilter(filter) {
      state.agentFilter = filter;
      render();
    }

    function render() {
      renderShell();
      renderToolbar();
      renderAgentSelects();
      renderBoard();
      renderList();
      renderAgents();
      renderRuntimes();
      renderRuntimeStrip();
      renderRunningPill();
      renderSearchResults();
      renderChat();
    }

    function renderShell() {
      const meta = pages[state.page] || pages.issues;
      els.pageTitle.textContent = meta.title;
      document.querySelectorAll("[data-page]").forEach(item => {
        item.classList.toggle("active", item.dataset.page === state.page);
      });
      els.issuesPage.classList.toggle("active", state.page === "issues");
      els.agentsPage.classList.toggle("active", state.page === "agents");
      els.runtimesPage.classList.toggle("active", state.page === "runtimes");
      const isPlaceholder = !["issues", "agents", "runtimes"].includes(state.page);
      els.placeholderPage.classList.toggle("active", isPlaceholder);
      if (isPlaceholder) {
        els.placeholderTitle.textContent = meta.placeholder || meta.title;
        els.placeholderText.textContent = meta.text || "";
      }
    }

    function renderToolbar() {
      if (state.page === "issues") {
        els.toolbar.innerHTML =
          "<div class=\\"toolbar-left\\">" +
            "<div class=\\"tabs\\">" +
              "<div class=\\"tab " + (state.agentFilter === "all" ? "active" : "") + "\\" data-agent-filter=\\"all\\">All</div>" +
              "<div class=\\"tab " + (state.agentFilter === "members" ? "active" : "") + "\\" data-agent-filter=\\"members\\">Members</div>" +
              "<div class=\\"tab " + (state.agentFilter === "agents" ? "active" : "") + "\\" data-agent-filter=\\"agents\\">Agents</div>" +
            "</div>" +
          "</div>" +
          "<div class=\\"toolbar-right\\">" +
            "<button class=\\"chip-button " + (state.activeOnly ? "active" : "") + "\\" id=\\"filterActive\\">Filter</button>" +
            "<button class=\\"chip-button\\" id=\\"refresh\\">Refresh</button>" +
            "<div class=\\"view-toggle\\">" +
              "<button id=\\"boardMode\\" class=\\"" + (state.mode === "board" ? "active" : "") + "\\">Board</button>" +
              "<button id=\\"listMode\\" class=\\"" + (state.mode === "list" ? "active" : "") + "\\">List</button>" +
            "</div>" +
            "<button class=\\"primary\\" id=\\"newIssue\\">New issue</button>" +
          "</div>";
        document.querySelectorAll("[data-agent-filter]").forEach(tab => {
          tab.addEventListener("click", () => setAgentFilter(tab.dataset.agentFilter));
        });
        document.getElementById("filterActive").addEventListener("click", () => {
          state.activeOnly = !state.activeOnly;
          render();
        });
        document.getElementById("refresh").addEventListener("click", () => refresh());
        document.getElementById("boardMode").addEventListener("click", () => setMode("board"));
        document.getElementById("listMode").addEventListener("click", () => setMode("list"));
        document.getElementById("newIssue").addEventListener("click", openSheet);
      } else if (state.page === "agents") {
        els.toolbar.innerHTML =
          "<div class=\\"toolbar-left\\">" +
            "<button class=\\"chip-button\\" id=\\"seedClaude\\">Add Claude agent</button>" +
            "<button class=\\"chip-button\\" id=\\"seedCodex\\">Add Codex agent</button>" +
          "</div>" +
          "<div class=\\"toolbar-right\\">" +
            "<button class=\\"chip-button\\" id=\\"refresh\\">Refresh</button>" +
            "<button class=\\"primary\\" id=\\"newAgent\\">New agent</button>" +
          "</div>";
        document.getElementById("seedClaude").addEventListener("click", () => seed("claude"));
        document.getElementById("seedCodex").addEventListener("click", () => seed("codex"));
        document.getElementById("refresh").addEventListener("click", () => refresh({ agent: true }));
        document.getElementById("newAgent").addEventListener("click", openAgentSheet);
      } else if (state.page === "runtimes") {
        els.toolbar.innerHTML =
          "<div class=\\"toolbar-left\\">" +
            "<span class=\\"status-badge\\">" + state.runtimes.length + " runtimes</span>" +
            "<span class=\\"status-badge\\">" + runningTasks().length + " active tasks</span>" +
          "</div>" +
          "<div class=\\"toolbar-right\\"><button class=\\"chip-button\\" id=\\"refresh\\">Refresh</button></div>";
        document.getElementById("refresh").addEventListener("click", () => refresh());
      } else {
        els.toolbar.innerHTML =
          "<div class=\\"toolbar-left\\"><span class=\\"status-badge\\">" + esc((pages[state.page] || pages.issues).group) + "</span></div>" +
          "<div class=\\"toolbar-right\\"><button class=\\"chip-button\\" id=\\"refresh\\">Refresh</button></div>";
        document.getElementById("refresh").addEventListener("click", () => refresh());
      }
    }

    function renderAgentSelects() {
      const html = state.agents.length
        ? state.agents.map(a => "<option value=\\"" + escAttr(a.id) + "\\">" + esc(a.name) + " / " + esc(a.provider) + "</option>").join("")
        : "<option value=\\"\\">No agents</option>";
      els.agentSelect.innerHTML = html;
      els.chatAgent.innerHTML = html;
    }

    function visibleTasks() {
      let tasks = state.activeOnly
        ? state.tasks.filter(t => ["queued", "dispatched", "running"].includes(t.status))
        : state.tasks;
      if (state.agentFilter === "agents") {
        tasks = tasks.filter(t => Boolean(state.agents.find(a => a.id === t.agentId)));
      } else if (state.agentFilter === "members") {
        tasks = [];
      }
      return tasks.slice().sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    }

    function renderBoard() {
      const groups = [
        { key: "queued", title: "Queued", test: t => t.status === "queued" },
        { key: "running", title: "Running", test: t => t.status === "running" || t.status === "dispatched" },
        { key: "completed", title: "Completed", test: t => t.status === "completed" },
        { key: "blocked", title: "Blocked", test: t => t.status === "failed" || t.status === "cancelled" }
      ];
      const tasks = visibleTasks();
      els.board.style.display = state.mode === "board" ? "grid" : "none";
      els.board.innerHTML = groups.map(group => {
        const items = tasks.filter(group.test);
        return "<section class=\\"column\\">" +
          "<div class=\\"column-head\\"><span>" + esc(group.title) + "</span><span class=\\"count-pill\\">" + items.length + "</span></div>" +
          "<div class=\\"cards\\">" + (items.length ? items.map(renderTaskCard).join("") : "<div class=\\"empty-column\\">No issues</div>") + "</div>" +
        "</section>";
      }).join("");
    }

    function renderTaskCard(t) {
      const agent = state.agents.find(a => a.id === t.agentId);
      const cancellable = isActiveTask(t);
      return "<article class=\\"issue-card\\" onclick=\\"openTask('" + escAttr(t.id) + "')\\">" +
        "<div class=\\"issue-id\\">" + esc(shortId(t.id)) + "</div>" +
        "<div class=\\"issue-title\\">" + esc(t.prompt || "") + "</div>" +
        "<div class=\\"issue-desc\\">" + esc(t.result || t.error || t.progressSummary || "") + "</div>" +
        "<div class=\\"issue-meta\\">" +
          "<span class=\\"agent-avatar\\">" + esc(agentInitial(agent)) + "</span>" +
          "<span class=\\"status-badge " + esc(t.status) + "\\">" + esc(statusLabel(t.status)) + "</span>" +
          "<span class=\\"status-badge\\">" + esc(agent ? agent.name : "agent") + "</span>" +
          (cancellable ? "<button class=\\"destructive\\" onclick=\\"event.stopPropagation(); cancelTask('" + escAttr(t.id) + "')\\">Cancel</button>" : "") +
        "</div>" +
      "</article>";
    }

    function renderList() {
      const tasks = visibleTasks();
      els.list.classList.toggle("active", state.mode === "list");
      if (!tasks.length) {
        els.list.innerHTML = "<div class=\\"empty-column\\" style=\\"margin:16px;\\">No issues</div>";
        return;
      }
      els.list.innerHTML = tasks.map(t => {
        const agent = state.agents.find(a => a.id === t.agentId);
        return "<div class=\\"list-row\\" onclick=\\"openTask('" + escAttr(t.id) + "')\\">" +
          "<span class=\\"priority-dot\\"></span>" +
          "<span class=\\"list-id\\">" + esc(shortId(t.id)) + "</span>" +
          "<span class=\\"list-title\\">" + esc(t.prompt || "") + "</span>" +
          "<span class=\\"status-badge " + esc(t.status) + "\\">" + esc(statusLabel(t.status)) + "</span>" +
          "<span class=\\"list-right\\">" + esc(agent ? agent.name : "agent") + "</span>" +
        "</div>";
      }).join("");
    }

    function renderAgents() {
      if (!state.agents.length) {
        els.agentsGrid.innerHTML = "<div class=\\"empty-column\\">No agents</div>";
        return;
      }
      els.agentsGrid.innerHTML = state.agents.map(agent => {
        const tasks = state.tasks.filter(t => t.agentId === agent.id);
        const active = tasks.filter(isActiveTask).length;
        const completed = tasks.filter(t => t.status === "completed").length;
        return "<article class=\\"entity-card\\">" +
          "<div class=\\"entity-head\\">" +
            "<span class=\\"agent-avatar\\">" + esc(agentInitial(agent)) + "</span>" +
            "<div class=\\"entity-main\\"><div class=\\"entity-title\\">" + esc(agent.name) + "</div><div class=\\"entity-subtitle\\">" + esc(agent.provider) + providerDetail(agent) + "</div></div>" +
          "</div>" +
          "<div class=\\"entity-body\\">" + esc(agent.instructions || "No instructions") + "</div>" +
          "<div class=\\"metric-row\\">" +
            renderMetric(tasks.length, "tasks") +
            renderMetric(active, "active") +
            renderMetric(completed, "done") +
          "</div>" +
          "<div class=\\"issue-meta\\">" +
            (agent.cwd ? "<span class=\\"status-badge\\">" + esc(agent.cwd) + "</span>" : "") +
            (agent.allowedTools && agent.allowedTools.length ? "<span class=\\"status-badge\\">" + agent.allowedTools.length + " tools</span>" : "") +
          "</div>" +
        "</article>";
      }).join("");
    }

    function renderRuntimes() {
      if (!state.runtimes.length) {
        els.runtimesGrid.innerHTML = "<div class=\\"empty-column\\">No runtimes</div>";
        return;
      }
      els.runtimesGrid.innerHTML = state.runtimes.map(runtime => {
        const tasks = state.tasks.filter(t => t.runtimeId === runtime.id);
        const active = tasks.filter(isActiveTask).length;
        const last = runtime.lastHeartbeatAt ? timeAgo(runtime.lastHeartbeatAt) : "never";
        return "<article class=\\"entity-card\\">" +
          "<div class=\\"entity-head\\">" +
            "<span class=\\"agent-avatar\\">" + esc(runtime.provider.slice(0, 1).toUpperCase()) + "</span>" +
            "<div class=\\"entity-main\\"><div class=\\"entity-title\\">" + esc(runtime.name) + "</div><div class=\\"entity-subtitle\\">" + esc(runtime.provider) + " / " + esc(runtime.workspaceId || "local") + "</div></div>" +
            "<span class=\\"runtime-dot " + (runtime.status === "online" ? "online" : "") + "\\"></span>" +
          "</div>" +
          "<div class=\\"metric-row\\">" +
            renderMetric(runtime.maxConcurrency || 1, "capacity") +
            renderMetric(active, "active") +
            renderMetric(tasks.length, "tasks") +
          "</div>" +
          "<div class=\\"issue-meta\\"><span class=\\"status-badge\\">" + esc(runtime.status) + "</span><span class=\\"status-badge\\">" + esc(last) + "</span></div>" +
        "</article>";
      }).join("");
    }

    function renderTaskDrawer(options = {}) {
      if (options.loading || !state.selectedTask) {
        els.taskDrawer.innerHTML =
          "<div class=\\"drawer-head\\"><div class=\\"drawer-title\\"><strong>Loading</strong><span>Issue detail</span></div><button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button></div>" +
          "<div class=\\"drawer-body\\"><div class=\\"empty-column\\">Loading</div></div>";
        return;
      }
      const t = state.selectedTask;
      const agent = t.agent || state.agents.find(a => a.id === t.agentId);
      const cancellable = isActiveTask(t);
      const usage = usageSummary(t.usage || []);
      els.taskDrawer.innerHTML =
        "<div class=\\"drawer-head\\">" +
          "<div class=\\"drawer-title\\"><strong>" + esc(t.prompt || "") + "</strong><span>" + esc(shortId(t.id)) + "</span></div>" +
          (cancellable ? "<button class=\\"destructive\\" onclick=\\"cancelTask('" + escAttr(t.id) + "')\\">Cancel</button>" : "") +
          "<button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button>" +
        "</div>" +
        "<div class=\\"drawer-body\\">" +
          "<div class=\\"issue-meta\\"><span class=\\"status-badge " + esc(t.status) + "\\">" + esc(statusLabel(t.status)) + "</span><span class=\\"status-badge\\">" + esc(agent ? agent.name : "agent") + "</span></div>" +
          renderDetailBlock("Prompt", t.prompt || "") +
          (t.result ? renderDetailBlock("Result", t.result) : "") +
          (t.error ? renderDetailBlock("Error", t.error) : "") +
          (t.progressSummary ? renderDetailBlock("Progress", progressText(t)) : "") +
          "<div class=\\"detail-grid\\">" +
            renderCell("Workspace", t.workspaceId || "local") +
            renderCell("Runtime", t.runtimeId || "unassigned") +
            renderCell("Session", t.sessionId || "none") +
            renderCell("Work dir", t.workDir || "none") +
            renderCell("Branch", t.branchName || "none") +
            renderCell("Usage", usage) +
          "</div>" +
          "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Messages</div><div class=\\"message-list\\">" + renderMessages() + "</div></div>" +
        "</div>";
    }

    function renderMessages() {
      if (!state.selectedMessages.length) return "<div class=\\"empty-column\\">No messages</div>";
      return state.selectedMessages.map(message => {
        const body = message.content || message.output || (message.input ? JSON.stringify(message.input, null, 2) : "");
        return "<div class=\\"message-row\\">" +
          "<div class=\\"message-head\\"><span>" + esc(message.type || "message") + "</span>" + (message.tool ? "<span>" + esc(message.tool) + "</span>" : "") + "<span>#" + esc(message.seq) + "</span></div>" +
          "<div class=\\"message-content\\">" + esc(body || "") + "</div>" +
        "</div>";
      }).join("");
    }

    function renderRuntimeStrip() {
      if (!state.runtimes.length) {
        els.runtimeStrip.innerHTML = "<span class=\\"runtime-pill\\"><span class=\\"runtime-dot\\"></span><span>No runtime</span></span>";
        return;
      }
      els.runtimeStrip.innerHTML = state.runtimes.slice(0, 3).map(r =>
        "<span class=\\"runtime-pill\\"><span class=\\"runtime-dot " + (r.status === "online" ? "online" : "") + "\\"></span><span class=\\"runtime-name\\">" + esc(r.name) + "</span><span>" + esc(r.provider) + "</span></span>"
      ).join("");
    }

    function renderRunningPill() {
      const running = runningTasks()[0];
      els.chatFab.classList.toggle("running", Boolean(running));
      els.taskStatusPill.classList.toggle("show", Boolean(running));
      if (running) els.taskStatusText.textContent = running.status === "dispatched" ? "Starting up" : (running.progressSummary || "Thinking");
    }

    function renderSearchResults() {
      if (!els.searchOverlay.classList.contains("open")) return;
      const q = els.searchInput.value.trim().toLowerCase();
      const rows = [];
      pages.issues && rows.push({ type: "Page", title: "Issues", subtitle: state.tasks.length + " issues", action: () => switchPage("issues") });
      pages.agents && rows.push({ type: "Page", title: "Agents", subtitle: state.agents.length + " agents", action: () => switchPage("agents") });
      pages.runtimes && rows.push({ type: "Page", title: "Runtimes", subtitle: state.runtimes.length + " runtimes", action: () => switchPage("runtimes") });
      state.tasks.forEach(t => rows.push({ type: "Issue", title: t.prompt || shortId(t.id), subtitle: shortId(t.id) + " / " + statusLabel(t.status), action: () => { switchPage("issues"); openTask(t.id); } }));
      state.agents.forEach(a => rows.push({ type: "Agent", title: a.name, subtitle: a.provider, action: () => switchPage("agents") }));
      state.runtimes.forEach(r => rows.push({ type: "Runtime", title: r.name, subtitle: r.provider + " / " + r.status, action: () => switchPage("runtimes") }));
      const filtered = rows.filter(row => !q || (row.title + " " + row.subtitle + " " + row.type).toLowerCase().includes(q)).slice(0, 18);
      els.searchResults.innerHTML = filtered.length ? filtered.map((row, index) =>
        "<div class=\\"command-row\\" data-result-index=\\"" + index + "\\">" +
          "<span class=\\"status-badge\\">" + esc(row.type) + "</span>" +
          "<div class=\\"command-row-main\\"><div class=\\"command-row-title\\">" + esc(row.title) + "</div><div class=\\"command-row-subtitle\\">" + esc(row.subtitle) + "</div></div>" +
        "</div>"
      ).join("") : "<div class=\\"empty-column\\">No results</div>";
      document.querySelectorAll("[data-result-index]").forEach(item => {
        item.addEventListener("click", () => {
          const row = filtered[Number(item.dataset.resultIndex)];
          closeSearch();
          row.action();
        });
      });
    }

    function renderChat() {
      if (!state.chatEntries.length) {
        els.chatLog.innerHTML = "<div class=\\"chat-entry system\\"><span>Multica</span><div>Ready</div></div>";
        return;
      }
      els.chatLog.innerHTML = state.chatEntries.slice(-8).map(entry =>
        "<div class=\\"chat-entry " + esc(entry.role) + "\\"><span>" + esc(entry.role === "user" ? "You" : "Multica") + "</span><div>" + esc(entry.text) + "</div></div>"
      ).join("");
    }

    function renderMetric(value, label) {
      return "<div class=\\"metric\\"><div class=\\"metric-value\\">" + esc(value) + "</div><div class=\\"metric-label\\">" + esc(label) + "</div></div>";
    }

    function renderDetailBlock(label, value) {
      return "<div class=\\"detail-block\\"><div class=\\"detail-label\\">" + esc(label) + "</div><div class=\\"detail-text\\">" + esc(value) + "</div></div>";
    }

    function renderCell(label, value) {
      return "<div class=\\"detail-cell\\"><span>" + esc(label) + "</span><strong title=\\"" + escAttr(value) + "\\">" + esc(value) + "</strong></div>";
    }

    function providerDetail(agent) {
      const parts = [];
      if (agent.model) parts.push(agent.model);
      if (agent.executable) parts.push(agent.executable);
      return parts.length ? " / " + esc(parts.join(" / ")) : "";
    }

    function progressText(task) {
      const summary = task.progressSummary || "";
      if (task.progressStep && task.progressTotal) return summary + " (" + task.progressStep + "/" + task.progressTotal + ")";
      return summary;
    }

    function usageSummary(usage) {
      if (!Array.isArray(usage) || !usage.length) return "none";
      const totals = usage.reduce((acc, item) => {
        acc.input += Number(item.inputTokens || 0);
        acc.output += Number(item.outputTokens || 0);
        return acc;
      }, { input: 0, output: 0 });
      return totals.input + " in / " + totals.output + " out";
    }

    function runningTasks() {
      return state.tasks.filter(isActiveTask);
    }

    function isActiveTask(task) {
      return ["queued", "dispatched", "running"].includes(task.status);
    }

    function showNotice(text, target = els.notice) {
      target.textContent = text;
      target.classList.add("show");
      setTimeout(() => target.classList.remove("show"), 3200);
    }

    function showProgress() { els.navProgress.classList.add("active"); }
    function hideProgress() { setTimeout(() => els.navProgress.classList.remove("active"), 300); }

    function shortId(id) {
      const raw = String(id || "");
      return raw.includes("_") ? raw.split("_")[1].slice(0, 8).toUpperCase() : raw.slice(0, 8).toUpperCase();
    }
    function statusLabel(status) {
      if (status === "dispatched") return "starting";
      if (status === "cancelled") return "cancelled";
      return String(status || "");
    }
    function agentInitial(agent) {
      return (agent?.name || agent?.provider || "A").slice(0, 1).toUpperCase();
    }
    function timeAgo(value) {
      const ms = Date.now() - Date.parse(value);
      if (!Number.isFinite(ms)) return value;
      const minutes = Math.max(0, Math.floor(ms / 60000));
      if (minutes < 1) return "now";
      if (minutes < 60) return minutes + "m ago";
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + "h ago";
      return Math.floor(hours / 24) + "d ago";
    }
    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;" }[ch]));
    }
    function escAttr(value) {
      return esc(value).replace(/\\\\/g, "\\\\\\\\");
    }

    refresh();
    setInterval(() => {
      if (!document.hidden) refresh({ silent: true });
    }, 4000);
    window.cancelTask = cancelTask;
    window.openTask = openTask;
    window.closeDrawer = closeDrawer;
  </script>
</body>
</html>`;
}
