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
    .toolbar-select {
      width: min(220px, 100%);
      height: 32px;
      padding: 0 30px 0 10px;
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
    .chat-entry.system, .chat-entry.assistant { margin-right: 34px; }
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
        <div class="nav-group" id="pinnedNav"></div>
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
      <section class="page" id="myIssuesPage">
        <div class="collection">
          <div class="entity-grid" id="myIssueSummaryGrid"></div>
          <div class="list active" id="myIssueList"></div>
        </div>
      </section>
      <section class="page" id="agentsPage">
        <div class="collection">
          <div class="entity-grid" id="agentsGrid"></div>
        </div>
      </section>
      <section class="page" id="projectsPage">
        <div class="collection">
          <div class="entity-grid" id="projectsGrid"></div>
        </div>
      </section>
      <section class="page" id="autopilotsPage">
        <div class="collection">
          <div class="entity-grid" id="autopilotsGrid"></div>
        </div>
      </section>
      <section class="page" id="squadsPage">
        <div class="collection">
          <div class="entity-grid" id="squadsGrid"></div>
        </div>
      </section>
      <section class="page" id="runtimesPage">
        <div class="collection">
          <div class="entity-grid" id="runtimesGrid"></div>
        </div>
      </section>
      <section class="page" id="skillsPage">
        <div class="collection">
          <div class="entity-grid" id="skillsGrid"></div>
        </div>
      </section>
      <section class="page" id="settingsPage">
        <div class="collection">
          <div class="entity-grid" id="settingsGrid"></div>
          <div class="list active" id="tokenList"></div>
        </div>
      </section>
      <section class="page" id="inboxPage">
        <div class="list active" id="inboxList"></div>
      </section>
      <section class="page" id="usagePage">
        <div class="collection">
          <div class="entity-grid" id="usageSummaryGrid"></div>
          <div class="list active" id="usageList"></div>
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
          <label>Assignee type<select id="issueAssigneeType"><option value="agent">agent</option><option value="member">member</option><option value="squad">squad</option><option value="">none</option></select></label>
          <label>Assignee<select id="agentSelect"></select></label>
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

      <div class="floating-panel agent-sheet" id="entitySheet">
        <div class="sheet-head">
          <span id="entitySheetTitle">New</span>
          <button class="outline" id="closeEntitySheet">Close</button>
        </div>
        <form class="sheet-form" id="entityForm"></form>
      </div>

      <aside class="drawer" id="taskDrawer"></aside>

      <div class="command-overlay" id="searchOverlay">
        <div class="command-panel">
          <input class="command-input" id="searchInput" placeholder="Search issues, projects, agents, runtimes">
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
      "my-issues": { title: "My Issues", group: "Personal" },
      issues: { title: "Issues", group: "Workspace" },
      projects: { title: "Projects", group: "Workspace" },
      autopilots: { title: "Autopilots", group: "Workspace" },
      agents: { title: "Agents", group: "Workspace" },
      squads: { title: "Squads", group: "Workspace" },
      usage: { title: "Usage", group: "Workspace", placeholder: "Usage", text: "No usage data." },
      runtimes: { title: "Runtimes", group: "Configure" },
      skills: { title: "Skills", group: "Configure" },
      settings: { title: "Settings", group: "Configure" }
    };

    const state = {
      agents: [],
      issues: [],
      tasks: [],
      runtimes: [],
      members: [],
      projects: [],
      squads: [],
      autopilots: [],
      skills: [],
      tokens: [],
      createdToken: null,
      labels: [],
      pins: [],
      inboxItems: [],
      usageDaily: [],
      usageByAgent: [],
      runtimeDaily: [],
      mode: "board",
      activeOnly: false,
      myIssuesActiveOnly: true,
      myIssueMemberId: "all",
      agentFilter: "all",
      page: "issues",
      selectedTaskId: null,
      selectedTask: null,
      selectedMessages: [],
      selectedIssueId: null,
      selectedIssue: null,
      selectedIssueChildren: [],
      selectedIssueChildProgress: null,
      selectedIssueDependencies: [],
      selectedIssueComments: [],
      selectedIssueActivity: [],
      selectedSquadId: null,
      selectedSquad: null,
      selectedSquadMembers: [],
      selectedProjectId: null,
      selectedProject: null,
      selectedProjectResources: [],
      selectedAgentId: null,
      selectedAgent: null,
      selectedRuntimeId: null,
      selectedRuntime: null,
      selectedRuntimeUsage: [],
      selectedSkillId: null,
      selectedSkill: null,
      selectedAutopilotId: null,
      selectedAutopilot: null,
      selectedAutopilotRuns: [],
      chatSessions: [],
      selectedChatId: null,
      selectedChatSession: null,
      selectedChatMessages: [],
      chatEntries: []
    };

    const els = {
      toolbar: document.getElementById("toolbar"),
      pageTitle: document.getElementById("pageTitle"),
      issuesPage: document.getElementById("issuesPage"),
      myIssuesPage: document.getElementById("myIssuesPage"),
      agentsPage: document.getElementById("agentsPage"),
      projectsPage: document.getElementById("projectsPage"),
      autopilotsPage: document.getElementById("autopilotsPage"),
      squadsPage: document.getElementById("squadsPage"),
      runtimesPage: document.getElementById("runtimesPage"),
      skillsPage: document.getElementById("skillsPage"),
      settingsPage: document.getElementById("settingsPage"),
      inboxPage: document.getElementById("inboxPage"),
      usagePage: document.getElementById("usagePage"),
      placeholderPage: document.getElementById("placeholderPage"),
      placeholderTitle: document.getElementById("placeholderTitle"),
      placeholderText: document.getElementById("placeholderText"),
      board: document.getElementById("board"),
      list: document.getElementById("list"),
      myIssueSummaryGrid: document.getElementById("myIssueSummaryGrid"),
      myIssueList: document.getElementById("myIssueList"),
      agentsGrid: document.getElementById("agentsGrid"),
      projectsGrid: document.getElementById("projectsGrid"),
      autopilotsGrid: document.getElementById("autopilotsGrid"),
      squadsGrid: document.getElementById("squadsGrid"),
      runtimesGrid: document.getElementById("runtimesGrid"),
      skillsGrid: document.getElementById("skillsGrid"),
      settingsGrid: document.getElementById("settingsGrid"),
      tokenList: document.getElementById("tokenList"),
      inboxList: document.getElementById("inboxList"),
      usageSummaryGrid: document.getElementById("usageSummaryGrid"),
      usageList: document.getElementById("usageList"),
      pinnedNav: document.getElementById("pinnedNav"),
      agentSelect: document.getElementById("agentSelect"),
      chatAgent: document.getElementById("chatAgent"),
      notice: document.getElementById("notice"),
      agentNotice: document.getElementById("agentNotice"),
      workspace: document.getElementById("workspace"),
      prompt: document.getElementById("prompt"),
      sheet: document.getElementById("createSheet"),
      agentSheet: document.getElementById("agentSheet"),
      entitySheet: document.getElementById("entitySheet"),
      entitySheetTitle: document.getElementById("entitySheetTitle"),
      entityForm: document.getElementById("entityForm"),
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
    document.getElementById("issueAssigneeType").addEventListener("change", refreshCreateAssigneeOptions);
    document.getElementById("closeAgentSheet").addEventListener("click", closeAgentSheet);
    document.getElementById("agentForm").addEventListener("submit", createAgent);
    document.getElementById("closeEntitySheet").addEventListener("click", closeEntitySheet);
    document.getElementById("entityForm").addEventListener("submit", submitEntityForm);
    document.getElementById("searchTrigger").addEventListener("click", openSearch);
    document.getElementById("searchOverlay").addEventListener("click", event => {
      if (event.target === els.searchOverlay) closeSearch();
    });
    els.searchInput.addEventListener("input", renderSearchResults);
    els.chatFab.addEventListener("click", toggleChat);
    document.getElementById("closeChat").addEventListener("click", closeChat);
    document.getElementById("chatForm").addEventListener("submit", submitChat);
    els.chatAgent.addEventListener("change", async () => {
      state.selectedChatId = null;
      state.selectedChatSession = null;
      state.selectedChatMessages = [];
      const existing = state.chatSessions.find(session => session.agentId === els.chatAgent.value);
      if (existing) await loadChatDetail(existing.id, { silent: true });
      renderChat();
    });
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
      const headers = options.body instanceof FormData
        ? { ...(options.headers || {}) }
        : { "Content-Type": "application/json", ...(options.headers || {}) };
      const res = await fetch(path, {
        ...options,
        headers
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    async function refresh(options = {}) {
      if (!options.silent) showProgress();
      try {
        const [agents, issues, tasks, runtimes, members, projects, squads, autopilots, skills, tokens, chats, inbox, labels, pins, usageDaily, usageByAgent, runtimeDaily] = await Promise.all([
          api("/api/multica/agents"),
          api("/api/multica/issues"),
          api("/api/multica/tasks"),
          api("/api/multica/runtimes"),
          api("/api/multica/members"),
          api("/api/multica/projects"),
          api("/api/multica/squads"),
          api("/api/multica/autopilots"),
          api("/api/multica/skills"),
          api("/api/multica/tokens"),
          api("/api/multica/chats"),
          api("/api/multica/inbox"),
          api("/api/multica/labels"),
          api("/api/multica/pins"),
          api("/api/dashboard/usage/daily"),
          api("/api/dashboard/usage/by-agent"),
          api("/api/dashboard/runtime/daily")
        ]);
        state.agents = agents.agents || [];
        state.issues = issues.issues || [];
        state.tasks = tasks.tasks || [];
        state.runtimes = runtimes.runtimes || [];
        state.members = members.members || [];
        state.projects = projects.projects || [];
        state.squads = squads.squads || [];
        state.autopilots = autopilots.autopilots || [];
        state.skills = skills.skills || [];
        state.tokens = tokens.tokens || [];
        state.chatSessions = chats.sessions || [];
        state.inboxItems = inbox.items || [];
        state.labels = labels.labels || [];
        state.pins = pins.pins || [];
        state.usageDaily = usageDaily || [];
        state.usageByAgent = usageByAgent || [];
        state.runtimeDaily = runtimeDaily || [];
        render();
        if (state.selectedTaskId) await loadTaskDetail(state.selectedTaskId, { silent: true });
        if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId, { silent: true });
        if (state.selectedSquadId) await loadSquadDetail(state.selectedSquadId, { silent: true });
        if (state.selectedProjectId) await loadProjectDetail(state.selectedProjectId, { silent: true });
        if (state.selectedAgentId) await loadAgentDetail(state.selectedAgentId, { silent: true });
        if (state.selectedRuntimeId) await loadRuntimeDetail(state.selectedRuntimeId, { silent: true });
        if (state.selectedSkillId) await loadSkillDetail(state.selectedSkillId, { silent: true });
        if (state.selectedAutopilotId) await loadAutopilotDetail(state.selectedAutopilotId, { silent: true });
        if (state.selectedChatId) await loadChatDetail(state.selectedChatId, { silent: true });
        else if (els.chatAgent.value) {
          const existing = state.chatSessions.find(session => session.agentId === els.chatAgent.value);
          if (existing) await loadChatDetail(existing.id, { silent: true });
        }
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

    async function createMember() {
      const name = prompt("Member name");
      if (!name || !name.trim()) return;
      try {
        await api("/api/multica/members", {
          method: "POST",
          body: JSON.stringify({ name: name.trim(), workspaceId: els.workspace.value || "local" })
        });
        await refresh();
      } catch (err) {
        showNotice(String(err.message || err), els.notice);
      }
    }

    async function createTask(event) {
      event.preventDefault();
      try {
        const assigneeType = document.getElementById("issueAssigneeType").value || null;
        const assigneeId = els.agentSelect.value || null;
        const result = await api("/api/multica/issues", {
          method: "POST",
          body: JSON.stringify({
            title: els.prompt.value,
            description: "",
            assigneeType,
            assigneeId,
            prompt: els.prompt.value,
            workspaceId: els.workspace.value || "local"
          })
        });
        els.prompt.value = "";
        showNotice("Created " + shortId(result.issue.id), els.notice);
        closeSheet();
        switchPage("issues");
        await refresh();
        openIssue(result.issue.id);
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
      state.selectedIssueId = null;
      state.selectedSquadId = null;
      state.selectedProjectId = null;
      state.selectedAgentId = null;
      state.selectedRuntimeId = null;
      state.selectedAutopilotId = null;
      els.taskDrawer.classList.add("open");
      renderTaskDrawer({ loading: true });
      await loadTaskDetail(id);
    }

    async function openIssue(id) {
      state.selectedIssueId = id;
      state.selectedTaskId = null;
      state.selectedSquadId = null;
      state.selectedProjectId = null;
      state.selectedAgentId = null;
      state.selectedRuntimeId = null;
      state.selectedAutopilotId = null;
      els.taskDrawer.classList.add("open");
      renderIssueDrawer({ loading: true });
      await loadIssueDetail(id);
    }

    async function openSquad(id) {
      state.selectedSquadId = id;
      state.selectedTaskId = null;
      state.selectedIssueId = null;
      state.selectedProjectId = null;
      state.selectedAgentId = null;
      state.selectedRuntimeId = null;
      state.selectedSkillId = null;
      state.selectedAutopilotId = null;
      els.taskDrawer.classList.add("open");
      renderSquadDrawer({ loading: true });
      await loadSquadDetail(id);
    }

    async function openProject(id) {
      state.selectedProjectId = id;
      state.selectedTaskId = null;
      state.selectedIssueId = null;
      state.selectedSquadId = null;
      state.selectedAgentId = null;
      state.selectedRuntimeId = null;
      state.selectedSkillId = null;
      state.selectedAutopilotId = null;
      els.taskDrawer.classList.add("open");
      renderProjectDrawer({ loading: true });
      await loadProjectDetail(id);
    }

    async function openAgent(id) {
      state.selectedAgentId = id;
      state.selectedTaskId = null;
      state.selectedIssueId = null;
      state.selectedSquadId = null;
      state.selectedProjectId = null;
      state.selectedRuntimeId = null;
      state.selectedSkillId = null;
      state.selectedAutopilotId = null;
      els.taskDrawer.classList.add("open");
      renderAgentDrawer({ loading: true });
      await loadAgentDetail(id);
    }

    async function openRuntime(id) {
      state.selectedRuntimeId = id;
      state.selectedTaskId = null;
      state.selectedIssueId = null;
      state.selectedSquadId = null;
      state.selectedProjectId = null;
      state.selectedAgentId = null;
      state.selectedSkillId = null;
      state.selectedAutopilotId = null;
      els.taskDrawer.classList.add("open");
      renderRuntimeDrawer({ loading: true });
      await loadRuntimeDetail(id);
    }

    async function openSkill(id) {
      state.selectedSkillId = id;
      state.selectedTaskId = null;
      state.selectedIssueId = null;
      state.selectedSquadId = null;
      state.selectedProjectId = null;
      state.selectedAgentId = null;
      state.selectedRuntimeId = null;
      state.selectedAutopilotId = null;
      els.taskDrawer.classList.add("open");
      renderSkillDrawer({ loading: true });
      await loadSkillDetail(id);
    }

    async function openAutopilot(id) {
      state.selectedAutopilotId = id;
      state.selectedTaskId = null;
      state.selectedIssueId = null;
      state.selectedSquadId = null;
      state.selectedProjectId = null;
      state.selectedAgentId = null;
      state.selectedRuntimeId = null;
      state.selectedSkillId = null;
      els.taskDrawer.classList.add("open");
      renderAutopilotDrawer({ loading: true });
      await loadAutopilotDetail(id);
    }

    async function loadIssueDetail(id, options = {}) {
      try {
        const issueResult = await api("/api/multica/issues/" + encodeURIComponent(id));
        state.selectedIssue = issueResult.issue;
        state.selectedIssueChildren = issueResult.children || issueResult.issue?.children || [];
        state.selectedIssueChildProgress = issueResult.childProgress || issueResult.issue?.childProgress || null;
        state.selectedIssueDependencies = issueResult.dependencies || issueResult.issue?.dependencies || [];
        state.selectedIssueComments = issueResult.comments || [];
        state.selectedIssueActivity = issueResult.activity || [];
        state.selectedMessages = [];
        state.selectedTask = null;
        renderIssueDrawer();
      } catch (err) {
        if (!options.silent) showNotice(String(err.message || err), els.notice);
      }
    }

    async function loadTaskDetail(id, options = {}) {
      try {
        const [taskResult, messageResult] = await Promise.all([
          api("/api/multica/tasks/" + encodeURIComponent(id)),
          api("/api/multica/tasks/" + encodeURIComponent(id) + "/messages")
        ]);
        state.selectedTask = taskResult.task;
        state.selectedMessages = messageResult.messages || [];
        if (state.selectedTask?.issueId) {
          const issueResult = await api("/api/multica/issues/" + encodeURIComponent(state.selectedTask.issueId));
          state.selectedTask.issue = issueResult.issue;
          state.selectedIssueChildren = issueResult.children || issueResult.issue?.children || [];
          state.selectedIssueChildProgress = issueResult.childProgress || issueResult.issue?.childProgress || null;
          state.selectedIssueDependencies = issueResult.dependencies || issueResult.issue?.dependencies || [];
          state.selectedIssueComments = issueResult.comments || [];
          state.selectedIssueActivity = issueResult.activity || [];
        } else {
          state.selectedIssueChildren = [];
          state.selectedIssueChildProgress = null;
          state.selectedIssueDependencies = [];
          state.selectedIssueComments = [];
          state.selectedIssueActivity = [];
        }
        renderTaskDrawer();
      } catch (err) {
        if (!options.silent) showNotice(String(err.message || err), els.notice);
      }
    }

    async function loadSquadDetail(id, options = {}) {
      try {
        const result = await api("/api/multica/squads/" + encodeURIComponent(id));
        state.selectedSquad = result.squad;
        state.selectedSquadMembers = result.members || [];
        state.selectedTask = null;
        state.selectedIssue = null;
        renderSquadDrawer();
      } catch (err) {
        if (!options.silent) showNotice(String(err.message || err), els.notice);
      }
    }

    async function loadProjectDetail(id, options = {}) {
      try {
        const result = await api("/api/multica/projects/" + encodeURIComponent(id));
        state.selectedProject = result.project;
        state.selectedProjectResources = result.resources || [];
        state.selectedTask = null;
        state.selectedIssue = null;
        state.selectedSquad = null;
        state.selectedRuntime = null;
        renderProjectDrawer();
      } catch (err) {
        if (!options.silent) showNotice(String(err.message || err), els.notice);
      }
    }

    async function loadAgentDetail(id, options = {}) {
      try {
        const result = await api("/api/multica/agents/" + encodeURIComponent(id));
        state.selectedAgent = result.agent;
        state.selectedTask = null;
        state.selectedIssue = null;
        state.selectedSquad = null;
        state.selectedRuntime = null;
        state.selectedSkill = null;
        renderAgentDrawer();
      } catch (err) {
        if (!options.silent) showNotice(String(err.message || err), els.notice);
      }
    }

    async function loadRuntimeDetail(id, options = {}) {
      try {
        const result = await api("/api/multica/runtimes/" + encodeURIComponent(id));
        state.selectedRuntime = result.runtime;
        state.selectedRuntimeUsage = result.usage || [];
        state.selectedTask = null;
        state.selectedIssue = null;
        state.selectedSquad = null;
        state.selectedProject = null;
        state.selectedAgent = null;
        state.selectedSkill = null;
        renderRuntimeDrawer();
      } catch (err) {
        if (!options.silent) showNotice(String(err.message || err), els.notice);
      }
    }

    async function loadSkillDetail(id, options = {}) {
      try {
        const result = await api("/api/multica/skills/" + encodeURIComponent(id));
        state.selectedSkill = result.skill;
        state.selectedTask = null;
        state.selectedIssue = null;
        state.selectedSquad = null;
        state.selectedProject = null;
        state.selectedAgent = null;
        state.selectedRuntime = null;
        state.selectedAutopilot = null;
        renderSkillDrawer();
      } catch (err) {
        if (!options.silent) showNotice(String(err.message || err), els.notice);
      }
    }

    async function loadAutopilotDetail(id, options = {}) {
      try {
        const result = await api("/api/multica/autopilots/" + encodeURIComponent(id));
        state.selectedAutopilot = result.autopilot;
        state.selectedAutopilotRuns = result.runs || [];
        state.selectedTask = null;
        state.selectedIssue = null;
        state.selectedSquad = null;
        state.selectedProject = null;
        state.selectedAgent = null;
        state.selectedRuntime = null;
        state.selectedSkill = null;
        renderAutopilotDrawer();
      } catch (err) {
        if (!options.silent) showNotice(String(err.message || err), els.notice);
      }
    }

    async function loadChatDetail(id, options = {}) {
      try {
        const result = await api("/api/multica/chats/" + encodeURIComponent(id));
        state.selectedChatId = id;
        state.selectedChatSession = result.session;
        state.selectedChatMessages = result.messages || [];
        if (!options.silent) renderChat();
      } catch (err) {
        if (!options.silent) showNotice(String(err.message || err), els.notice);
      }
    }

    function closeDrawer() {
      state.selectedTaskId = null;
      state.selectedTask = null;
      state.selectedIssueId = null;
      state.selectedIssue = null;
      state.selectedIssueChildren = [];
      state.selectedIssueChildProgress = null;
      state.selectedIssueDependencies = [];
      state.selectedMessages = [];
      state.selectedIssueComments = [];
      state.selectedIssueActivity = [];
      state.selectedSquadId = null;
      state.selectedSquad = null;
      state.selectedSquadMembers = [];
      state.selectedProjectId = null;
      state.selectedProject = null;
      state.selectedProjectResources = [];
      state.selectedAgentId = null;
      state.selectedAgent = null;
      state.selectedRuntimeId = null;
      state.selectedRuntime = null;
      state.selectedRuntimeUsage = [];
      state.selectedSkillId = null;
      state.selectedSkill = null;
      state.selectedAutopilotId = null;
      state.selectedAutopilot = null;
      state.selectedAutopilotRuns = [];
      els.taskDrawer.classList.remove("open");
    }

    async function updateSelectedAgent(event) {
      event.preventDefault();
      if (!state.selectedAgent) return;
      const tools = document.getElementById("agentAllowedTools").value
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);
      await api("/api/multica/agents/" + encodeURIComponent(state.selectedAgent.id), {
        method: "PATCH",
        body: JSON.stringify({
          name: document.getElementById("agentEditName").value,
          provider: document.getElementById("agentEditProvider").value,
          model: document.getElementById("agentEditModel").value || null,
          cwd: document.getElementById("agentEditCwd").value || null,
          instructions: document.getElementById("agentEditInstructions").value || "",
          allowedTools: tools
        })
      });
      await loadAgentDetail(state.selectedAgent.id);
      await refresh({ silent: true });
    }

    async function updateSelectedAgentSkills(event) {
      event.preventDefault();
      if (!state.selectedAgent) return;
      const skillIds = Array.from(document.querySelectorAll("input[name='agentSkill']:checked")).map(input => input.value);
      await api("/api/multica/agents/" + encodeURIComponent(state.selectedAgent.id) + "/skills", {
        method: "PUT",
        body: JSON.stringify({ skillIds })
      });
      await loadAgentDetail(state.selectedAgent.id);
      await refresh({ silent: true });
    }

    async function updateSelectedRuntime(event) {
      event.preventDefault();
      if (!state.selectedRuntime) return;
      await api("/api/multica/runtimes/" + encodeURIComponent(state.selectedRuntime.id), {
        method: "PATCH",
        body: JSON.stringify({
          name: document.getElementById("runtimeEditName").value,
          ownerId: document.getElementById("runtimeOwnerId").value || null,
          visibility: document.getElementById("runtimeVisibility").value,
          maxConcurrency: Number(document.getElementById("runtimeMaxConcurrency").value || 1)
        })
      });
      await loadRuntimeDetail(state.selectedRuntime.id);
      await refresh({ silent: true });
    }

    async function updateSelectedSkill(event) {
      event.preventDefault();
      if (!state.selectedSkill) return;
      await api("/api/multica/skills/" + encodeURIComponent(state.selectedSkill.id), {
        method: "PATCH",
        body: JSON.stringify({
          name: document.getElementById("skillEditName").value,
          workspaceId: document.getElementById("skillEditWorkspace").value || "local",
          description: document.getElementById("skillEditDescription").value || "",
          content: document.getElementById("skillEditContent").value || "",
          files: parseSkillFiles(document.getElementById("skillEditFiles").value)
        })
      });
      await loadSkillDetail(state.selectedSkill.id);
      await refresh({ silent: true });
    }

    async function updateSelectedAutopilot(event) {
      event.preventDefault();
      if (!state.selectedAutopilot) return;
      await api("/api/multica/autopilots/" + encodeURIComponent(state.selectedAutopilot.id), {
        method: "PATCH",
        body: JSON.stringify({
          title: document.getElementById("autopilotEditTitle").value,
          description: document.getElementById("autopilotEditDescription").value || null,
          projectId: document.getElementById("autopilotProject").value || null,
          assigneeType: document.getElementById("autopilotAssigneeType").value,
          assigneeId: document.getElementById("autopilotAssigneeId").value,
          status: document.getElementById("autopilotStatus").value,
          executionMode: document.getElementById("autopilotExecutionMode").value,
          issueTitleTemplate: document.getElementById("autopilotPrompt").value || null,
          triggerKind: document.getElementById("autopilotTriggerKind").value,
          triggerLabel: document.getElementById("autopilotTriggerLabel").value || null,
          cronExpression: document.getElementById("autopilotCron").value || null
        })
      });
      await loadAutopilotDetail(state.selectedAutopilot.id);
      await refresh({ silent: true });
    }

    async function addSquadMember(event) {
      event.preventDefault();
      if (!state.selectedSquad) return;
      const memberType = document.getElementById("squadMemberType").value;
      const memberId = document.getElementById("squadMemberId").value;
      const role = document.getElementById("squadMemberRole").value || "member";
      if (!memberId) return;
      await api("/api/multica/squads/" + encodeURIComponent(state.selectedSquad.id) + "/members", {
        method: "POST",
        body: JSON.stringify({ memberType, memberId, role })
      });
      await loadSquadDetail(state.selectedSquad.id);
      await refresh({ silent: true });
    }

    async function removeSquadMember(memberType, memberId) {
      if (!state.selectedSquad) return;
      await api("/api/multica/squads/" + encodeURIComponent(state.selectedSquad.id) + "/members", {
        method: "DELETE",
        body: JSON.stringify({ memberType, memberId })
      });
      await loadSquadDetail(state.selectedSquad.id);
      await refresh({ silent: true });
    }

    async function updateSelectedIssue() {
      const issue = state.selectedIssue || state.selectedTask?.issue;
      if (!issue) return;
      const startDate = readLocalDateTime("issueStartDate");
      const dueDate = readLocalDateTime("issueDueDate");
      await api("/api/multica/issues/" + encodeURIComponent(issue.id), {
        method: "PATCH",
        body: JSON.stringify({
          status: document.getElementById("issueStatus").value,
          priority: document.getElementById("issuePriority").value,
          projectId: document.getElementById("issueProject").value || null,
          parentIssueId: document.getElementById("issueParent").value || null,
          position: Number(document.getElementById("issuePosition").value || 0),
          startDate,
          dueDate
        })
      });
      if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      await refresh();
    }

    async function assignSelectedIssue(event) {
      event.preventDefault();
      const issue = state.selectedIssue || state.selectedTask?.issue;
      if (!issue) return;
      const assigneeType = document.getElementById("issueAssigneeTypeEdit").value || null;
      const assigneeId = document.getElementById("issueAssigneeIdEdit").value || null;
      const prompt = document.getElementById("issueAssignPrompt").value || issue.title;
      await api("/api/multica/issues/" + encodeURIComponent(issue.id) + "/assign", {
        method: "POST",
        body: JSON.stringify({ assigneeType, assigneeId, prompt })
      });
      if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      else if (state.selectedTaskId) await loadTaskDetail(state.selectedTaskId);
      await refresh();
    }

    async function addSelectedIssueComment(event) {
      event.preventDefault();
      const issue = state.selectedIssue || state.selectedTask?.issue;
      const body = document.getElementById("issueCommentBody").value.trim();
      if (!issue || !body) return;
      const parentId = document.getElementById("issueCommentParent")?.value || null;
      const attachmentIds = splitCsv(document.getElementById("issueCommentAttachmentIds")?.value || "");
      await api("/api/multica/issues/" + encodeURIComponent(issue.id) + "/comments", {
        method: "POST",
        body: JSON.stringify({ authorType: "member", body, parentId, attachmentIds })
      });
      document.getElementById("issueCommentBody").value = "";
      if (document.getElementById("issueCommentAttachmentIds")) document.getElementById("issueCommentAttachmentIds").value = "";
      if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      else await loadTaskDetail(state.selectedTaskId);
    }

    async function addSelectedIssueDependency(event) {
      event.preventDefault();
      const issue = state.selectedIssue || state.selectedTask?.issue;
      const dependsOnIssueId = document.getElementById("issueDependencyTarget")?.value || "";
      const type = document.getElementById("issueDependencyType")?.value || "related";
      if (!issue || !dependsOnIssueId) return;
      await api("/api/multica/issues/" + encodeURIComponent(issue.id) + "/dependencies", {
        method: "POST",
        body: JSON.stringify({ dependsOnIssueId, type })
      });
      if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      else await loadTaskDetail(state.selectedTaskId);
      await refresh({ silent: true });
    }

    async function deleteIssueDependency(dependencyId) {
      const issue = state.selectedIssue || state.selectedTask?.issue;
      if (!issue) return;
      await api("/api/multica/issues/" + encodeURIComponent(issue.id) + "/dependencies/" + encodeURIComponent(dependencyId), {
        method: "DELETE"
      });
      if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      else await loadTaskDetail(state.selectedTaskId);
      await refresh({ silent: true });
    }

    async function reactToSelectedIssue(emoji) {
      const issue = state.selectedIssue || state.selectedTask?.issue;
      if (!issue) return;
      await api("/api/multica/issues/" + encodeURIComponent(issue.id) + "/reactions", {
        method: "POST",
        body: JSON.stringify({ actorType: "member", actorId: "local", emoji })
      });
      if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      else await loadTaskDetail(state.selectedTaskId);
    }

    async function reactToComment(commentId, emoji) {
      await api("/api/multica/comments/" + encodeURIComponent(commentId) + "/reactions", {
        method: "POST",
        body: JSON.stringify({ actorType: "member", actorId: "local", emoji })
      });
      if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      else await loadTaskDetail(state.selectedTaskId);
    }

    async function editComment(commentId) {
      const comment = state.selectedIssueComments.find(item => item.id === commentId);
      if (!comment) return;
      const body = prompt("Edit comment", comment.body || "");
      if (body == null || !body.trim()) return;
      await api("/api/multica/comments/" + encodeURIComponent(commentId), {
        method: "PUT",
        body: JSON.stringify({ body })
      });
      if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      else await loadTaskDetail(state.selectedTaskId);
    }

    async function deleteComment(commentId) {
      if (!confirm("Delete this comment?")) return;
      await api("/api/multica/comments/" + encodeURIComponent(commentId), { method: "DELETE" });
      if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      else await loadTaskDetail(state.selectedTaskId);
    }

    async function setCommentResolved(commentId, resolved) {
      await api("/api/multica/comments/" + encodeURIComponent(commentId) + "/resolve", {
        method: resolved ? "POST" : "DELETE",
        body: resolved ? JSON.stringify({ actorType: "member", actorId: "local" }) : undefined
      });
      if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      else await loadTaskDetail(state.selectedTaskId);
    }

    async function addSelectedIssueAttachment(event) {
      event.preventDefault();
      const issue = state.selectedIssue || state.selectedTask?.issue;
      if (!issue) return;
      const fileInput = document.getElementById("issueAttachmentFile");
      const file = fileInput?.files?.[0] || null;
      if (file) {
        const form = new FormData();
        form.append("file", file);
        form.append("workspaceId", issue.workspaceId || "local");
        form.append("issueId", issue.id);
        form.append("uploaderType", "member");
        form.append("uploaderId", "local");
        await api("/api/upload-file", {
          method: "POST",
          body: form
        });
        fileInput.value = "";
        if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
        else await loadTaskDetail(state.selectedTaskId);
        return;
      }
      const filename = document.getElementById("issueAttachmentFilename").value.trim();
      const url = document.getElementById("issueAttachmentUrl").value.trim();
      if (!filename || !url) return;
      await api("/api/multica/issues/" + encodeURIComponent(issue.id) + "/attachments", {
        method: "POST",
        body: JSON.stringify({
          filename,
          url,
          contentType: document.getElementById("issueAttachmentContentType").value.trim() || "application/octet-stream",
          sizeBytes: Number(document.getElementById("issueAttachmentSize").value || 0),
          uploaderType: "member",
          uploaderId: "local"
        })
      });
      document.getElementById("issueAttachmentFilename").value = "";
      document.getElementById("issueAttachmentUrl").value = "";
      if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      else await loadTaskDetail(state.selectedTaskId);
    }

    async function attachSelectedIssueLabel(event) {
      event.preventDefault();
      const issue = state.selectedIssue || state.selectedTask?.issue;
      const labelId = document.getElementById("issueLabelId")?.value || "";
      if (!issue || !labelId) return;
      await api("/api/multica/issues/" + encodeURIComponent(issue.id) + "/labels", {
        method: "POST",
        body: JSON.stringify({ labelId })
      });
      if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      else await loadTaskDetail(state.selectedTaskId);
      await refresh({ silent: true });
    }

    async function createSelectedIssueLabel(event) {
      event.preventDefault();
      const issue = state.selectedIssue || state.selectedTask?.issue;
      if (!issue) return;
      const name = document.getElementById("issueLabelName").value.trim();
      const color = document.getElementById("issueLabelColor").value.trim();
      if (!name || !color) return;
      const result = await api("/api/multica/labels", {
        method: "POST",
        body: JSON.stringify({ workspaceId: issue.workspaceId || "local", name, color })
      });
      await api("/api/multica/issues/" + encodeURIComponent(issue.id) + "/labels", {
        method: "POST",
        body: JSON.stringify({ labelId: result.label.id })
      });
      if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      else await loadTaskDetail(state.selectedTaskId);
      await refresh({ silent: true });
    }

    async function detachSelectedIssueLabel(labelId) {
      const issue = state.selectedIssue || state.selectedTask?.issue;
      if (!issue || !labelId) return;
      await api("/api/multica/issues/" + encodeURIComponent(issue.id) + "/labels/" + encodeURIComponent(labelId), {
        method: "DELETE"
      });
      if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      else await loadTaskDetail(state.selectedTaskId);
      await refresh({ silent: true });
    }

    async function setSelectedIssueMetadata(event) {
      event.preventDefault();
      const issue = state.selectedIssue || state.selectedTask?.issue;
      if (!issue) return;
      const key = document.getElementById("issueMetadataKey").value.trim();
      const type = document.getElementById("issueMetadataType").value;
      const rawValue = document.getElementById("issueMetadataValue").value.trim();
      if (!key || rawValue === "") return;
      let value;
      try {
        value = parseMetadataValue(rawValue, type);
      } catch (err) {
        alert(String(err.message || err));
        return;
      }
      await api("/api/multica/issues/" + encodeURIComponent(issue.id) + "/metadata/" + encodeURIComponent(key), {
        method: "PUT",
        body: JSON.stringify({ value })
      });
      if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      else await loadTaskDetail(state.selectedTaskId);
    }

    async function deleteSelectedIssueMetadata(key) {
      const issue = state.selectedIssue || state.selectedTask?.issue;
      if (!issue) return;
      await api("/api/multica/issues/" + encodeURIComponent(issue.id) + "/metadata/" + encodeURIComponent(key), {
        method: "DELETE"
      });
      if (state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      else await loadTaskDetail(state.selectedTaskId);
    }

    function insertIssueMention() {
      const select = document.getElementById("issueMentionTarget");
      const textarea = document.getElementById("issueCommentBody");
      if (!select || !textarea || !select.value) return;
      const [type, id] = select.value.split(":", 2);
      if (type === "all") {
        const prefixAll = textarea.value && !textarea.value.endsWith(" ") ? " " : "";
        textarea.value += prefixAll + "@all ";
        textarea.focus();
        return;
      }
      const label = select.options[select.selectedIndex]?.textContent?.split(" / ")[0] || "Target";
      const mention = "[@" + label + "](mention://" + type + "/" + id + ")";
      const prefix = textarea.value && !textarea.value.endsWith(" ") ? " " : "";
      textarea.value += prefix + mention + " ";
      textarea.focus();
    }

    function openSheet() {
      closeAgentSheet();
      closeEntitySheet();
      els.sheet.classList.add("open");
      setTimeout(() => els.prompt.focus(), 50);
    }

    function closeSheet() {
      els.sheet.classList.remove("open");
    }

    function openAgentSheet() {
      closeSheet();
      closeEntitySheet();
      els.agentSheet.classList.add("open");
      setTimeout(() => document.getElementById("agentName").focus(), 50);
    }

    function closeAgentSheet() {
      els.agentSheet.classList.remove("open");
    }

    function openEntitySheet(kind) {
      closeSheet();
      closeAgentSheet();
      els.entitySheet.dataset.kind = kind;
      els.entitySheetTitle.textContent = kind === "project" ? "New project" : kind === "squad" ? "New squad" : kind === "skill" ? "New skill" : "New autopilot";
      els.entityForm.innerHTML = entityFormHtml(kind);
      els.entitySheet.classList.add("open");
      setTimeout(() => els.entityForm.querySelector("input, textarea, select")?.focus(), 50);
    }

    function closeEntitySheet() {
      els.entitySheet.classList.remove("open");
      els.entityForm.innerHTML = "";
    }

    async function submitEntityForm(event) {
      event.preventDefault();
      const kind = els.entitySheet.dataset.kind;
      try {
        if (kind === "project") {
          const repoUrl = document.getElementById("entityRepoUrl").value.trim();
          await api("/api/multica/projects", {
            method: "POST",
            body: JSON.stringify({
              title: document.getElementById("entityTitle").value,
              description: document.getElementById("entityDescription").value || null,
              priority: document.getElementById("entityPriority").value,
              status: document.getElementById("entityStatus").value,
              resources: repoUrl ? [{
                resourceType: "github_repo",
                resourceRef: {
                  url: repoUrl,
                  defaultBranchHint: document.getElementById("entityRepoBranch").value.trim() || undefined
                },
                label: document.getElementById("entityRepoLabel").value.trim() || null
              }] : []
            })
          });
        } else if (kind === "squad") {
          const leaderId = document.getElementById("entityLeader").value || null;
          await api("/api/multica/squads", {
            method: "POST",
            body: JSON.stringify({
              name: document.getElementById("entityTitle").value,
              description: document.getElementById("entityDescription").value || "",
              instructions: document.getElementById("entityInstructions").value || "",
              leaderId,
              memberIds: leaderId ? [leaderId] : []
            })
          });
        } else if (kind === "skill") {
          await api("/api/multica/skills", {
            method: "POST",
            body: JSON.stringify({
              name: document.getElementById("entityTitle").value,
              description: document.getElementById("entityDescription").value || "",
              content: document.getElementById("entityContent").value || "",
              files: parseSkillFiles(document.getElementById("entityFiles").value)
            })
          });
        } else if (kind === "autopilot") {
          await api("/api/multica/autopilots", {
            method: "POST",
            body: JSON.stringify({
              title: document.getElementById("entityTitle").value,
              description: document.getElementById("entityDescription").value || null,
              projectId: document.getElementById("entityProject").value || null,
              assigneeType: document.getElementById("entityAssigneeType").value,
              assigneeId: document.getElementById("entityAssignee").value,
              executionMode: document.getElementById("entityMode").value,
              issueTitleTemplate: document.getElementById("entityPrompt").value || null,
              triggerKind: document.getElementById("entityTrigger").value,
              cronExpression: document.getElementById("entityCron").value || null
            })
          });
        }
        closeEntitySheet();
        await refresh();
      } catch (err) {
        els.entityForm.querySelector(".notice").textContent = String(err.message || err);
        els.entityForm.querySelector(".notice").classList.add("show");
      }
    }

    async function runAutopilot(id) {
      try {
        const result = await api("/api/multica/autopilots/" + encodeURIComponent(id) + "/run", {
          method: "POST",
          body: JSON.stringify({ source: "manual" })
        });
        await refresh();
        if (state.selectedAutopilotId === id) {
          await loadAutopilotDetail(id);
          return;
        }
        if (result.run?.taskId) {
          switchPage("issues");
          openTask(result.run.taskId);
        }
      } catch (err) {
        showNotice(String(err.message || err), els.notice);
      }
    }

    async function archiveProject(id) {
      try {
        await api("/api/multica/projects/" + encodeURIComponent(id), { method: "DELETE" });
        if (state.selectedProjectId === id) closeDrawer();
        await refresh();
      } catch (err) {
        showNotice(String(err.message || err), els.notice);
      }
    }

    async function addProjectResource(event) {
      event.preventDefault();
      if (!state.selectedProject) return;
      const url = document.getElementById("projectResourceUrl").value.trim();
      if (!url) return;
      await api("/api/multica/projects/" + encodeURIComponent(state.selectedProject.id) + "/resources", {
        method: "POST",
        body: JSON.stringify({
          resourceType: "github_repo",
          resourceRef: {
            url,
            defaultBranchHint: document.getElementById("projectResourceBranch").value.trim() || undefined
          },
          label: document.getElementById("projectResourceLabel").value.trim() || null
        })
      });
      await loadProjectDetail(state.selectedProject.id);
      await refresh({ silent: true });
    }

    async function removeProjectResource(resourceId) {
      if (!state.selectedProject) return;
      await api("/api/multica/projects/" + encodeURIComponent(state.selectedProject.id) + "/resources/" + encodeURIComponent(resourceId), {
        method: "DELETE"
      });
      await loadProjectDetail(state.selectedProject.id);
      await refresh({ silent: true });
    }

    async function pinItem(itemType, itemId, workspaceId = "local") {
      try {
        await api("/api/multica/pins", {
          method: "POST",
          body: JSON.stringify({ itemType, itemId, workspaceId })
        });
        await refresh({ silent: true });
        if (itemType === "issue" && state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
        if (itemType === "project" && state.selectedProjectId) await loadProjectDetail(state.selectedProjectId);
      } catch (err) {
        showNotice(String(err.message || err), els.notice);
      }
    }

    async function unpinItem(itemType, itemId) {
      await api("/api/multica/pins/" + encodeURIComponent(itemType) + "/" + encodeURIComponent(itemId), {
        method: "DELETE"
      });
      await refresh({ silent: true });
      if (itemType === "issue" && state.selectedIssueId) await loadIssueDetail(state.selectedIssueId);
      if (itemType === "project" && state.selectedProjectId) await loadProjectDetail(state.selectedProjectId);
    }

    async function openPinnedItem(pinId) {
      const pin = state.pins.find(item => item.id === pinId);
      if (!pin) return;
      if (pin.itemType === "issue") {
        switchPage("issues");
        await openIssue(pin.itemId);
      } else if (pin.itemType === "project") {
        switchPage("projects");
        await openProject(pin.itemId);
      }
    }

    async function archiveSquad(id) {
      try {
        await api("/api/multica/squads/" + encodeURIComponent(id), { method: "DELETE" });
        await refresh();
      } catch (err) {
        showNotice(String(err.message || err), els.notice);
      }
    }

    async function setAutopilotStatus(id, status) {
      try {
        await api("/api/multica/autopilots/" + encodeURIComponent(id), {
          method: "PATCH",
          body: JSON.stringify({ status })
        });
        await refresh();
        if (state.selectedAutopilotId === id) await loadAutopilotDetail(id);
      } catch (err) {
        showNotice(String(err.message || err), els.notice);
      }
    }

    async function archiveAutopilot(id) {
      try {
        await api("/api/multica/autopilots/" + encodeURIComponent(id), { method: "DELETE" });
        if (state.selectedAutopilotId === id) closeDrawer();
        await refresh();
      } catch (err) {
        showNotice(String(err.message || err), els.notice);
      }
    }

    async function archiveAgent(id) {
      try {
        await api("/api/multica/agents/" + encodeURIComponent(id), { method: "DELETE" });
        if (state.selectedAgentId === id) closeDrawer();
        await refresh();
      } catch (err) {
        showNotice(String(err.message || err), els.agentNotice);
      }
    }

    async function archiveSkill(id) {
      try {
        await api("/api/multica/skills/" + encodeURIComponent(id), { method: "DELETE" });
        if (state.selectedSkillId === id) closeDrawer();
        await refresh();
      } catch (err) {
        showNotice(String(err.message || err), els.notice);
      }
    }

    async function createToken(event) {
      if (event?.preventDefault) event.preventDefault();
      const nameInput = document.getElementById("tokenName");
      if (!nameInput) return;
      try {
        const result = await api("/api/multica/tokens", {
          method: "POST",
          body: JSON.stringify({
            name: nameInput.value.trim() || "Local token",
            type: document.getElementById("tokenType").value,
            expiresInDays: document.getElementById("tokenExpires").value ? Number(document.getElementById("tokenExpires").value) : null,
          })
        });
        state.createdToken = result.token?.token || null;
        await refresh({ silent: true });
        state.createdToken = result.token?.token || state.createdToken;
        renderSettings();
      } catch (err) {
        showNotice(String(err.message || err), els.notice);
      }
    }

    async function revokeToken(id) {
      await api("/api/multica/tokens/" + encodeURIComponent(id), { method: "DELETE" });
      await refresh({ silent: true });
    }

    async function markInboxRead(id) {
      await api("/api/multica/inbox/" + encodeURIComponent(id) + "/read", { method: "POST" });
      await refresh({ silent: true });
    }

    async function archiveInbox(id) {
      await api("/api/multica/inbox/" + encodeURIComponent(id) + "/archive", { method: "POST" });
      await refresh({ silent: true });
    }

    async function openInboxIssue(inboxId, issueId) {
      await markInboxRead(inboxId);
      switchPage("issues");
      openIssue(issueId);
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
      els.chatPrompt.value = "";
      renderChat();
      try {
        const session = await ensureChatSession(agentId, prompt);
        const result = await api("/api/multica/chats/" + encodeURIComponent(session.id) + "/messages", {
          method: "POST",
          body: JSON.stringify({ body: prompt })
        });
        state.selectedChatId = session.id;
        state.selectedChatSession = result.session;
        await loadChatDetail(session.id, { silent: true });
        await refresh();
      } catch (err) {
        state.chatEntries = [{ role: "system", text: String(err.message || err) }];
      }
      renderChat();
    }

    async function ensureChatSession(agentId, firstPrompt) {
      const existing = state.selectedChatSession && state.selectedChatSession.agentId === agentId
        ? state.selectedChatSession
        : state.chatSessions.find(session => session.agentId === agentId);
      if (existing) {
        if (!state.selectedChatId) await loadChatDetail(existing.id, { silent: true });
        return existing;
      }
      const result = await api("/api/multica/chats", {
        method: "POST",
        body: JSON.stringify({
          agentId,
          workspaceId: "local",
          title: firstPrompt.length > 60 ? firstPrompt.slice(0, 57) + "..." : firstPrompt
        })
      });
      state.chatSessions.unshift(result.session);
      state.selectedChatId = result.session.id;
      state.selectedChatSession = result.session;
      state.selectedChatMessages = [];
      return result.session;
    }

    function switchPage(page) {
      state.page = page || "issues";
      closeSheet();
      closeAgentSheet();
      closeEntitySheet();
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
      renderMyIssues();
      renderProjects();
      renderSquads();
      renderAutopilots();
      renderAgents();
      renderRuntimes();
      renderSkills();
      renderSettings();
      renderInbox();
      renderUsage();
      renderPinnedNav();
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
      els.myIssuesPage.classList.toggle("active", state.page === "my-issues");
      els.agentsPage.classList.toggle("active", state.page === "agents");
      els.projectsPage.classList.toggle("active", state.page === "projects");
      els.autopilotsPage.classList.toggle("active", state.page === "autopilots");
      els.squadsPage.classList.toggle("active", state.page === "squads");
      els.runtimesPage.classList.toggle("active", state.page === "runtimes");
      els.skillsPage.classList.toggle("active", state.page === "skills");
      els.settingsPage.classList.toggle("active", state.page === "settings");
      els.inboxPage.classList.toggle("active", state.page === "inbox");
      els.usagePage.classList.toggle("active", state.page === "usage");
      const isPlaceholder = !["issues", "my-issues", "agents", "projects", "autopilots", "squads", "runtimes", "skills", "settings", "inbox", "usage"].includes(state.page);
      els.placeholderPage.classList.toggle("active", isPlaceholder);
      if (isPlaceholder) {
        els.placeholderTitle.textContent = meta.placeholder || meta.title;
        els.placeholderText.textContent = meta.text || "";
      }
    }

    function renderPinnedNav() {
      if (!els.pinnedNav) return;
      if (!state.pins.length) {
        els.pinnedNav.innerHTML = "";
        return;
      }
      els.pinnedNav.innerHTML =
        "<div class=\\"nav-label\\">Pinned</div>" +
        state.pins.slice(0, 8).map(pin => {
          const target = pinnedTarget(pin);
          return "<div class=\\"nav-item\\" onclick=\\"openPinnedItem('" + escAttr(pin.id) + "')\\">" +
            "<span class=\\"nav-icon " + (pin.itemType === "issue" ? "issue" : "") + "\\"></span>" +
            "<span class=\\"workspace-name\\">" + esc(target.label) + "</span>" +
          "</div>";
        }).join("");
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
            "<button class=\\"chip-button\\" id=\\"newMember\\">New member</button>" +
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
        document.getElementById("newMember").addEventListener("click", createMember);
        document.getElementById("boardMode").addEventListener("click", () => setMode("board"));
        document.getElementById("listMode").addEventListener("click", () => setMode("list"));
        document.getElementById("newIssue").addEventListener("click", openSheet);
      } else if (state.page === "my-issues") {
        const items = visibleMyIssues();
        els.toolbar.innerHTML =
          "<div class=\\"toolbar-left\\">" +
            "<select class=\\"toolbar-select\\" id=\\"myIssueMember\\">" + myIssueMemberOptions() + "</select>" +
            "<span class=\\"status-badge\\">" + items.length + " assigned</span>" +
          "</div>" +
          "<div class=\\"toolbar-right\\">" +
            "<button class=\\"chip-button " + (state.myIssuesActiveOnly ? "active" : "") + "\\" id=\\"myIssuesActiveOnly\\">Active</button>" +
            "<button class=\\"chip-button\\" id=\\"refresh\\">Refresh</button>" +
            "<button class=\\"primary\\" id=\\"newIssue\\">New issue</button>" +
          "</div>";
        document.getElementById("myIssueMember").addEventListener("change", event => {
          state.myIssueMemberId = event.target.value || "all";
          render();
        });
        document.getElementById("myIssuesActiveOnly").addEventListener("click", () => {
          state.myIssuesActiveOnly = !state.myIssuesActiveOnly;
          render();
        });
        document.getElementById("refresh").addEventListener("click", () => refresh());
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
      } else if (state.page === "projects") {
        els.toolbar.innerHTML =
          "<div class=\\"toolbar-left\\"><span class=\\"status-badge\\">" + state.projects.length + " projects</span><span class=\\"status-badge\\">" + state.tasks.length + " issues</span></div>" +
          "<div class=\\"toolbar-right\\"><button class=\\"chip-button\\" id=\\"refresh\\">Refresh</button><button class=\\"primary\\" id=\\"newProject\\">New project</button></div>";
        document.getElementById("refresh").addEventListener("click", () => refresh());
        document.getElementById("newProject").addEventListener("click", () => openEntitySheet("project"));
      } else if (state.page === "squads") {
        els.toolbar.innerHTML =
          "<div class=\\"toolbar-left\\"><span class=\\"status-badge\\">" + state.squads.length + " squads</span><span class=\\"status-badge\\">" + state.agents.length + " agents</span></div>" +
          "<div class=\\"toolbar-right\\"><button class=\\"chip-button\\" id=\\"refresh\\">Refresh</button><button class=\\"primary\\" id=\\"newSquad\\">New squad</button></div>";
        document.getElementById("refresh").addEventListener("click", () => refresh());
        document.getElementById("newSquad").addEventListener("click", () => openEntitySheet("squad"));
      } else if (state.page === "autopilots") {
        const active = state.autopilots.filter(a => a.status === "active").length;
        els.toolbar.innerHTML =
          "<div class=\\"toolbar-left\\"><span class=\\"status-badge\\">" + state.autopilots.length + " autopilots</span><span class=\\"status-badge completed\\">" + active + " active</span></div>" +
          "<div class=\\"toolbar-right\\"><button class=\\"chip-button\\" id=\\"refresh\\">Refresh</button><button class=\\"primary\\" id=\\"newAutopilot\\">New autopilot</button></div>";
        document.getElementById("refresh").addEventListener("click", () => refresh());
        document.getElementById("newAutopilot").addEventListener("click", () => openEntitySheet("autopilot"));
      } else if (state.page === "runtimes") {
        els.toolbar.innerHTML =
          "<div class=\\"toolbar-left\\">" +
            "<span class=\\"status-badge\\">" + state.runtimes.length + " runtimes</span>" +
            "<span class=\\"status-badge\\">" + runningTasks().length + " active tasks</span>" +
          "</div>" +
          "<div class=\\"toolbar-right\\"><button class=\\"chip-button\\" id=\\"refresh\\">Refresh</button></div>";
        document.getElementById("refresh").addEventListener("click", () => refresh());
      } else if (state.page === "skills") {
        const attached = state.agents.reduce((count, agent) => count + (agent.skills || []).length, 0);
        els.toolbar.innerHTML =
          "<div class=\\"toolbar-left\\">" +
            "<span class=\\"status-badge\\">" + state.skills.length + " skills</span>" +
            "<span class=\\"status-badge\\">" + attached + " agent links</span>" +
          "</div>" +
          "<div class=\\"toolbar-right\\"><button class=\\"chip-button\\" id=\\"refresh\\">Refresh</button><button class=\\"primary\\" id=\\"newSkill\\">New skill</button></div>";
        document.getElementById("refresh").addEventListener("click", () => refresh());
        document.getElementById("newSkill").addEventListener("click", () => openEntitySheet("skill"));
      } else if (state.page === "settings") {
        els.toolbar.innerHTML =
          "<div class=\\"toolbar-left\\">" +
            "<span class=\\"status-badge\\">" + state.tokens.length + " tokens</span>" +
            "<span class=\\"status-badge\\">local workspace</span>" +
          "</div>" +
          "<div class=\\"toolbar-right\\"><button class=\\"chip-button\\" id=\\"refresh\\">Refresh</button><button class=\\"primary\\" id=\\"newToken\\">New token</button></div>";
        document.getElementById("refresh").addEventListener("click", () => refresh());
        document.getElementById("newToken").addEventListener("click", () => document.getElementById("tokenName")?.focus());
      } else if (state.page === "usage") {
        const totals = usageTotals(state.usageDaily);
        els.toolbar.innerHTML =
          "<div class=\\"toolbar-left\\">" +
            "<span class=\\"status-badge\\">" + esc(formatCompact(totals.tokens)) + " tokens</span>" +
            "<span class=\\"status-badge\\">" + esc(String(totals.tasks)) + " tasks</span>" +
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
      refreshCreateAssigneeOptions();
      const html = state.agents.length
        ? state.agents.map(a => "<option value=\\"" + escAttr(a.id) + "\\">" + esc(a.name) + " / " + esc(a.provider) + "</option>").join("")
        : "<option value=\\"\\">No agents</option>";
      els.chatAgent.innerHTML = html;
    }

    function visibleTasks() {
      let tasks = state.issues.slice();
      if (state.activeOnly) {
        tasks = tasks.filter(issue => ["open", "in_progress", "blocked"].includes(issue.status));
      }
      if (state.agentFilter === "agents") {
        tasks = tasks.filter(issue => issue.assigneeType === "agent" || issue.assigneeType === "squad" || Boolean(issue.latestTaskId));
      } else if (state.agentFilter === "members") {
        tasks = tasks.filter(issue => issue.assigneeType === "member" || (!issue.assigneeType && !issue.latestTaskId));
      }
      return tasks.slice().sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    }

    function visibleMyIssues() {
      let issues = state.issues.filter(issue => issue.assigneeType === "member");
      if (state.myIssueMemberId !== "all") {
        issues = issues.filter(issue => issue.assigneeId === state.myIssueMemberId);
      }
      if (state.myIssuesActiveOnly) {
        issues = issues.filter(issue => ["open", "in_progress", "blocked"].includes(issue.status));
      }
      return issues.slice().sort((a, b) => {
        const priority = priorityRank(a.priority) - priorityRank(b.priority);
        if (priority !== 0) return priority;
        return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      });
    }

    function renderBoard() {
      const groups = [
        { key: "open", title: "Open", test: t => t.status === "open" },
        { key: "running", title: "In progress", test: t => t.status === "in_progress" || t.latestTaskStatus === "running" || t.latestTaskStatus === "dispatched" || t.latestTaskStatus === "queued" },
        { key: "completed", title: "Done", test: t => t.status === "done" || t.status === "completed" },
        { key: "blocked", title: "Blocked", test: t => t.status === "blocked" || t.status === "failed" || t.status === "cancelled" }
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
      const project = t.projectId ? state.projects.find(p => p.id === t.projectId) : null;
      const latestTask = t.latestTaskId ? state.tasks.find(task => task.id === t.latestTaskId) : null;
      const agent = latestTask ? state.agents.find(a => a.id === latestTask.agentId) : null;
      const assignee = assigneeLabel(t);
      const cancellable = latestTask && isActiveTask(latestTask);
      return "<article class=\\"issue-card\\" onclick=\\"openIssue('" + escAttr(t.id) + "')\\">" +
        "<div class=\\"issue-id\\">" + esc(issueLabel(t)) + "</div>" +
        "<div class=\\"issue-title\\">" + esc(t.title || "") + "</div>" +
        "<div class=\\"issue-desc\\">" + esc(t.description || project?.title || "") + "</div>" +
        "<div class=\\"issue-meta\\">" +
          "<span class=\\"agent-avatar\\">" + esc(agentInitial(agent)) + "</span>" +
          "<span class=\\"status-badge " + esc(t.latestTaskStatus || t.status) + "\\">" + esc(statusLabel(t.status)) + "</span>" +
          "<span class=\\"status-badge\\">" + esc(project ? project.title : "no project") + "</span>" +
          (assignee ? "<span class=\\"status-badge\\">" + esc(assignee) + "</span>" : "") +
          (agent ? "<span class=\\"status-badge\\">" + esc(agent.name) + "</span>" : "") +
          renderLabelChips(t.labels || []) +
          (cancellable ? "<button class=\\"destructive\\" onclick=\\"event.stopPropagation(); cancelTask('" + escAttr(latestTask.id) + "')\\">Cancel</button>" : "") +
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
        const project = t.projectId ? state.projects.find(p => p.id === t.projectId) : null;
        return "<div class=\\"list-row\\" onclick=\\"openIssue('" + escAttr(t.id) + "')\\">" +
          "<span class=\\"priority-dot\\"></span>" +
          "<span class=\\"list-id\\">" + esc(issueLabel(t)) + "</span>" +
          "<span class=\\"list-title\\">" + esc(t.title || "") + "</span>" +
          renderLabelChips(t.labels || []) +
          "<span class=\\"status-badge " + esc(t.status) + "\\">" + esc(statusLabel(t.status)) + "</span>" +
          "<span class=\\"status-badge\\">" + esc(assigneeLabel(t) || "unassigned") + "</span>" +
          "<span class=\\"list-right\\">" + esc(project ? project.title : "no project") + "</span>" +
        "</div>";
      }).join("");
    }

    function renderMyIssues() {
      if (!els.myIssueSummaryGrid || !els.myIssueList) return;
      const issues = visibleMyIssues();
      const allMemberIssues = state.issues.filter(issue => issue.assigneeType === "member");
      const scopedMemberIssues = state.myIssueMemberId === "all"
        ? allMemberIssues
        : allMemberIssues.filter(issue => issue.assigneeId === state.myIssueMemberId);
      const active = scopedMemberIssues.filter(issue => ["open", "in_progress", "blocked"].includes(issue.status));
      const blocked = scopedMemberIssues.filter(issue => issue.status === "blocked" || issue.status === "failed");
      const dueSoon = scopedMemberIssues.filter(issue => isDueSoon(issue));
      const selectedMember = state.myIssueMemberId === "all" ? null : state.members.find(member => member.id === state.myIssueMemberId);
      els.myIssueSummaryGrid.innerHTML =
        "<article class=\\"entity-card\\">" +
          "<div class=\\"entity-head\\"><span class=\\"agent-avatar\\">M</span><div class=\\"entity-main\\"><div class=\\"entity-title\\">" + esc(selectedMember ? selectedMember.name : "All members") + "</div><div class=\\"entity-subtitle\\">Assigned workspace issues</div></div></div>" +
          "<div class=\\"metric-row\\">" +
            renderMetric(scopedMemberIssues.length, "assigned") +
            renderMetric(active.length, "active") +
            renderMetric(blocked.length, "blocked") +
            renderMetric(dueSoon.length, "due soon") +
          "</div>" +
        "</article>";
      if (!issues.length) {
        els.myIssueList.innerHTML = "<div class=\\"empty-column\\" style=\\"margin:16px;\\">No assigned issues</div>";
        return;
      }
      els.myIssueList.innerHTML = issues.map(issue => {
        const project = issue.projectId ? state.projects.find(project => project.id === issue.projectId) : null;
        return "<div class=\\"list-row\\" onclick=\\"openIssue('" + escAttr(issue.id) + "')\\">" +
          "<span class=\\"priority-dot\\" style=\\"background:" + priorityColor(issue.priority) + "\\"></span>" +
          "<span class=\\"list-id\\">" + esc(issueLabel(issue)) + "</span>" +
          "<span class=\\"list-title\\">" + esc(issue.title || "") + "</span>" +
          renderLabelChips(issue.labels || []) +
          "<span class=\\"status-badge " + esc(issue.status) + "\\">" + esc(statusLabel(issue.status)) + "</span>" +
          "<span class=\\"status-badge\\">" + esc(assigneeLabel(issue) || "unassigned") + "</span>" +
          "<span class=\\"status-badge\\">" + esc(issue.dueDate ? "due " + shortDate(issue.dueDate) : "no due date") + "</span>" +
          "<span class=\\"list-right\\">" + esc(project ? project.title : "no project") + "</span>" +
        "</div>";
      }).join("");
    }

    function renderProjects() {
      if (!state.projects.length) {
        els.projectsGrid.innerHTML = "<div class=\\"empty-column\\">No projects</div>";
        return;
      }
      els.projectsGrid.innerHTML = state.projects.map(project => {
        const progress = project.issueCount > 0 ? Math.round((project.doneCount / project.issueCount) * 100) : 0;
        const lead = project.leadId ? state.agents.find(a => a.id === project.leadId) : null;
        return "<article class=\\"entity-card\\" onclick=\\"openProject('" + escAttr(project.id) + "')\\">" +
          "<div class=\\"entity-head\\">" +
            "<span class=\\"agent-avatar\\">" + esc((project.icon || project.title || "P").slice(0, 1).toUpperCase()) + "</span>" +
            "<div class=\\"entity-main\\"><div class=\\"entity-title\\">" + esc(project.title) + "</div><div class=\\"entity-subtitle\\">" + esc(project.status) + " / " + esc(project.priority) + "</div></div>" +
          "</div>" +
          "<div class=\\"entity-body\\">" + esc(project.description || "No description") + "</div>" +
          "<div class=\\"metric-row\\">" +
            renderMetric(project.issueCount || 0, "issues") +
            renderMetric(project.doneCount || 0, "done") +
            renderMetric(progress + "%", "progress") +
            renderMetric(project.resourceCount || 0, "resources") +
          "</div>" +
          "<div class=\\"issue-meta\\">" +
            (lead ? "<span class=\\"status-badge\\">" + esc(lead.name) + "</span>" : "") +
            "<span class=\\"status-badge\\">" + esc(timeAgo(project.updatedAt)) + "</span>" +
          "</div>" +
          "<button class=\\"destructive\\" onclick=\\"event.stopPropagation(); archiveProject('" + escAttr(project.id) + "')\\">Archive</button>" +
        "</article>";
      }).join("");
    }

    function renderSquads() {
      if (!state.squads.length) {
        els.squadsGrid.innerHTML = "<div class=\\"empty-column\\">No squads</div>";
        return;
      }
      els.squadsGrid.innerHTML = state.squads.map(squad => {
        const leader = squad.leaderId ? state.agents.find(a => a.id === squad.leaderId) : null;
        const active = state.tasks.filter(t => leader && t.agentId === leader.id && isActiveTask(t)).length;
        return "<article class=\\"entity-card\\" onclick=\\"openSquad('" + escAttr(squad.id) + "')\\">" +
          "<div class=\\"entity-head\\">" +
            "<span class=\\"agent-avatar\\">" + esc(initials(squad.name)) + "</span>" +
            "<div class=\\"entity-main\\"><div class=\\"entity-title\\">" + esc(squad.name) + "</div><div class=\\"entity-subtitle\\">" + esc(leader ? leader.name : "No leader") + "</div></div>" +
          "</div>" +
          "<div class=\\"entity-body\\">" + esc(squad.description || squad.instructions || "No description") + "</div>" +
          "<div class=\\"metric-row\\">" +
            renderMetric(squad.memberCount || 0, "members") +
            renderMetric(active, "active") +
            renderMetric(timeAgo(squad.updatedAt), "updated") +
          "</div>" +
          "<button class=\\"destructive\\" onclick=\\"event.stopPropagation(); archiveSquad('" + escAttr(squad.id) + "')\\">Archive</button>" +
        "</article>";
      }).join("");
    }

    function renderAutopilots() {
      if (!state.autopilots.length) {
        els.autopilotsGrid.innerHTML = "<div class=\\"empty-column\\">No autopilots</div>";
        return;
      }
      els.autopilotsGrid.innerHTML = state.autopilots.map(autopilot => {
        const assignee = autopilot.assigneeType === "squad"
          ? state.squads.find(s => s.id === autopilot.assigneeId)
          : state.agents.find(a => a.id === autopilot.assigneeId);
        const project = autopilot.projectId ? state.projects.find(p => p.id === autopilot.projectId) : null;
        return "<article class=\\"entity-card\\" onclick=\\"openAutopilot('" + escAttr(autopilot.id) + "')\\">" +
          "<div class=\\"entity-head\\">" +
            "<span class=\\"agent-avatar\\">" + esc(autopilot.triggerKind.slice(0, 1).toUpperCase()) + "</span>" +
            "<div class=\\"entity-main\\"><div class=\\"entity-title\\">" + esc(autopilot.title) + "</div><div class=\\"entity-subtitle\\">" + esc(autopilot.triggerKind) + " / " + esc(autopilot.executionMode) + "</div></div>" +
            "<span class=\\"status-badge " + (autopilot.status === "active" ? "completed" : "") + "\\">" + esc(autopilot.status) + "</span>" +
          "</div>" +
          "<div class=\\"entity-body\\">" + esc(autopilot.issueTitleTemplate || autopilot.description || "No prompt") + "</div>" +
          "<div class=\\"issue-meta\\">" +
            "<span class=\\"status-badge\\">" + esc(autopilot.assigneeType) + ": " + esc(assignee ? (assignee.name || assignee.title) : "missing") + "</span>" +
            (project ? "<span class=\\"status-badge\\">" + esc(project.title) + "</span>" : "") +
            (autopilot.cronExpression ? "<span class=\\"status-badge\\">" + esc(autopilot.cronExpression) + "</span>" : "") +
            (autopilot.lastRunAt ? "<span class=\\"status-badge\\">" + esc(timeAgo(autopilot.lastRunAt)) + "</span>" : "") +
          "</div>" +
          "<div class=\\"issue-meta\\">" +
            "<button class=\\"outline\\" onclick=\\"event.stopPropagation(); runAutopilot('" + escAttr(autopilot.id) + "')\\">Run</button>" +
            (autopilot.status === "active" ?
              "<button class=\\"outline\\" onclick=\\"event.stopPropagation(); setAutopilotStatus('" + escAttr(autopilot.id) + "', 'paused')\\">Pause</button>" :
              "<button class=\\"outline\\" onclick=\\"event.stopPropagation(); setAutopilotStatus('" + escAttr(autopilot.id) + "', 'active')\\">Resume</button>") +
            "<button class=\\"destructive\\" onclick=\\"event.stopPropagation(); archiveAutopilot('" + escAttr(autopilot.id) + "')\\">Archive</button>" +
          "</div>" +
        "</article>";
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
        return "<article class=\\"entity-card\\" onclick=\\"openAgent('" + escAttr(agent.id) + "')\\">" +
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
            (agent.skills && agent.skills.length ? "<span class=\\"status-badge\\">" + agent.skills.length + " skills</span>" : "") +
          "</div>" +
          "<button class=\\"destructive\\" onclick=\\"event.stopPropagation(); archiveAgent('" + escAttr(agent.id) + "')\\">Archive</button>" +
        "</article>";
      }).join("");
    }

    function renderRuntimes() {
      if (!state.runtimes.length) {
        els.runtimesGrid.innerHTML = "<div class=\\"empty-column\\">No runtimes</div>";
        return;
      }
      els.runtimesGrid.innerHTML = state.runtimes.map(runtime => {
        const last = runtime.lastHeartbeatAt ? timeAgo(runtime.lastHeartbeatAt) : "never";
        const tokens = Number(runtime.inputTokens || 0) + Number(runtime.outputTokens || 0);
        return "<article class=\\"entity-card\\" onclick=\\"openRuntime('" + escAttr(runtime.id) + "')\\">" +
          "<div class=\\"entity-head\\">" +
            "<span class=\\"agent-avatar\\">" + esc(runtime.provider.slice(0, 1).toUpperCase()) + "</span>" +
            "<div class=\\"entity-main\\"><div class=\\"entity-title\\">" + esc(runtime.name) + "</div><div class=\\"entity-subtitle\\">" + esc(runtime.provider) + " / " + esc(runtime.workspaceId || "local") + " / " + esc(runtime.visibility || "private") + "</div></div>" +
            "<span class=\\"runtime-dot " + (runtime.status === "online" ? "online" : "") + "\\"></span>" +
          "</div>" +
          "<div class=\\"metric-row\\">" +
            renderMetric(runtime.maxConcurrency || 1, "capacity") +
            renderMetric(runtime.activeTaskCount || 0, "active") +
            renderMetric(runtime.taskCount || 0, "tasks") +
            renderMetric(formatCompact(tokens), "tokens") +
            renderMetric((runtime.models || []).length, "models") +
          "</div>" +
          "<div class=\\"issue-meta\\"><span class=\\"status-badge\\">" + esc(runtime.status) + "</span><span class=\\"status-badge\\">" + esc(ownerLabel(runtime.ownerId)) + "</span><span class=\\"status-badge\\">" + esc(last) + "</span></div>" +
        "</article>";
      }).join("");
    }

    function renderSkills() {
      if (!state.skills.length) {
        els.skillsGrid.innerHTML = "<div class=\\"empty-column\\">No skills</div>";
        return;
      }
      els.skillsGrid.innerHTML = state.skills.map(skill => {
        const agents = state.agents.filter(agent => (agent.skills || []).some(item => item.id === skill.id));
        const origin = skill.config?.origin?.type || skill.config?.origin?.source || "local";
        return "<article class=\\"entity-card\\" onclick=\\"openSkill('" + escAttr(skill.id) + "')\\">" +
          "<div class=\\"entity-head\\">" +
            "<span class=\\"agent-avatar\\">" + esc((skill.name || "S").slice(0, 1).toUpperCase()) + "</span>" +
            "<div class=\\"entity-main\\"><div class=\\"entity-title\\">" + esc(skill.name || "") + "</div><div class=\\"entity-subtitle\\">" + esc(skill.workspaceId || "local") + " / " + esc(origin) + "</div></div>" +
          "</div>" +
          "<div class=\\"entity-body\\">" + esc(skill.description || "No description") + "</div>" +
          "<div class=\\"metric-row\\">" +
            renderMetric(agents.length, "agents") +
            renderMetric(skill.files ? skill.files.length : 0, "files") +
            renderMetric(shortDate(skill.updatedAt || skill.createdAt), "updated") +
          "</div>" +
          "<div class=\\"issue-meta\\">" + agents.slice(0, 3).map(agent => "<span class=\\"status-badge\\">" + esc(agent.name) + "</span>").join("") + "</div>" +
        "</article>";
      }).join("");
    }

    function renderSettings() {
      const origin = window.location.origin;
      els.settingsGrid.innerHTML =
        "<article class=\\"entity-card\\">" +
          "<div class=\\"entity-head\\"><span class=\\"agent-avatar\\">S</span><div class=\\"entity-main\\"><div class=\\"entity-title\\">Server</div><div class=\\"entity-subtitle\\">Bun Multica local API</div></div></div>" +
          "<div class=\\"detail-grid\\">" +
            renderCell("Browser URL", origin) +
            renderCell("Daemon URL", origin) +
            renderCell("Workspace", "local") +
            renderCell("Auth mode", state.tokens.length ? "local tokens available" : "open local mode") +
          "</div>" +
        "</article>" +
        "<article class=\\"entity-card\\">" +
          "<div class=\\"entity-head\\"><span class=\\"agent-avatar\\">T</span><div class=\\"entity-main\\"><div class=\\"entity-title\\">Access token</div><div class=\\"entity-subtitle\\">Personal and daemon tokens</div></div></div>" +
          (state.createdToken ? "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Created token</div><div class=\\"detail-text\\">" + esc(state.createdToken) + "</div></div>" : "") +
          "<form class=\\"sheet-form\\" onsubmit=\\"createToken(event)\\" style=\\"padding:0;\\">" +
            "<div class=\\"detail-grid\\">" +
              "<label>Name<input id=\\"tokenName\\" placeholder=\\"Local daemon\\"></label>" +
              "<label>Type<select id=\\"tokenType\\"><option value=\\"daemon\\">daemon</option><option value=\\"pat\\">pat</option></select></label>" +
              "<label>Expires in days<input id=\\"tokenExpires\\" type=\\"number\\" min=\\"1\\" placeholder=\\"Never\\"></label>" +
            "</div>" +
            "<button class=\\"outline\\" type=\\"submit\\">Create token</button>" +
          "</form>" +
        "</article>";
      els.tokenList.innerHTML = state.tokens.length ? state.tokens.map(token =>
        "<div class=\\"message-row\\">" +
          "<div class=\\"message-head\\"><span>" + esc(token.name) + "</span><span>" + esc(token.type) + "</span><span>" + esc(token.revokedAt ? "revoked" : "active") + "</span></div>" +
          "<div class=\\"message-content\\">" + esc(token.tokenPrefix || "") + " / last used " + esc(token.lastUsedAt ? timeAgo(token.lastUsedAt) : "never") + (token.expiresAt ? " / expires " + esc(shortDate(token.expiresAt)) : "") + "</div>" +
          (token.revokedAt ? "" : "<button class=\\"destructive\\" onclick=\\"revokeToken('" + escAttr(token.id) + "')\\">Revoke</button>") +
        "</div>"
      ).join("") : "<div class=\\"empty-column\\">No access tokens</div>";
    }

    function renderInbox() {
      if (!els.inboxList) return;
      if (!state.inboxItems.length) {
        els.inboxList.innerHTML = "<div class=\\"empty-column\\" style=\\"margin:16px;\\">No inbox items</div>";
        return;
      }
      els.inboxList.innerHTML = state.inboxItems.map(item => {
        const issue = item.issue;
        return "<div class=\\"list-row\\" onclick=\\"openInboxIssue('" + escAttr(item.id) + "', '" + escAttr(item.issueId) + "')\\">" +
          "<span class=\\"priority-dot\\" style=\\"background:" + (item.read ? "transparent" : "var(--brand)") + "\\"></span>" +
          "<span class=\\"list-id\\">" + esc(issue ? issueLabel(issue) : shortId(item.issueId)) + "</span>" +
          "<span class=\\"list-title\\">" + esc(item.title || "") + "</span>" +
          "<span class=\\"status-badge\\">" + esc(item.type) + "</span>" +
          "<span class=\\"status-badge\\">" + esc(timeAgo(item.createdAt)) + "</span>" +
          "<button class=\\"outline\\" onclick=\\"event.stopPropagation(); markInboxRead('" + escAttr(item.id) + "')\\">Read</button>" +
          "<button class=\\"destructive\\" onclick=\\"event.stopPropagation(); archiveInbox('" + escAttr(item.id) + "')\\">Archive</button>" +
        "</div>";
      }).join("");
    }

    function renderUsage() {
      if (!els.usageSummaryGrid || !els.usageList) return;
      const totals = usageTotals(state.usageDaily);
      const runtimeTotals = state.runtimeDaily.reduce((acc, row) => {
        acc.seconds += Number(row.totalSeconds || row.total_seconds || 0);
        acc.failed += Number(row.failedCount || row.failed_count || 0);
        return acc;
      }, { seconds: 0, failed: 0 });
      els.usageSummaryGrid.innerHTML =
        "<article class=\\"entity-card\\">" +
          "<div class=\\"entity-head\\"><span class=\\"agent-avatar\\">T</span><div class=\\"entity-main\\"><div class=\\"entity-title\\">Tokens</div><div class=\\"entity-subtitle\\">workspace usage</div></div></div>" +
          "<div class=\\"metric-row\\">" +
            renderMetric(formatCompact(totals.input), "input") +
            renderMetric(formatCompact(totals.output), "output") +
            renderMetric(formatCompact(totals.cache), "cache") +
            renderMetric(formatCompact(totals.tokens), "total") +
          "</div>" +
        "</article>" +
        "<article class=\\"entity-card\\">" +
          "<div class=\\"entity-head\\"><span class=\\"agent-avatar\\">R</span><div class=\\"entity-main\\"><div class=\\"entity-title\\">Runtime</div><div class=\\"entity-subtitle\\">terminal task time</div></div></div>" +
          "<div class=\\"metric-row\\">" +
            renderMetric(totals.tasks, "usage tasks") +
            renderMetric(formatDuration(runtimeTotals.seconds), "time") +
            renderMetric(runtimeTotals.failed, "failed") +
          "</div>" +
        "</article>";

      const dailyRows = state.usageDaily.slice(-14).reverse().map(row =>
        "<div class=\\"list-row\\">" +
          "<span class=\\"list-id\\">" + esc(row.date) + "</span>" +
          "<span class=\\"list-title\\">" + esc(row.model) + "</span>" +
          "<span class=\\"status-badge\\">" + esc(formatCompact((row.inputTokens || 0) + (row.outputTokens || 0))) + " tokens</span>" +
          "<span class=\\"status-badge\\">" + esc(String(row.taskCount || 0)) + " tasks</span>" +
        "</div>"
      );
      const agentRows = state.usageByAgent.slice(0, 12).map(row => {
        const agent = state.agents.find(item => item.id === (row.agentId || row.agent_id));
        return "<div class=\\"list-row\\">" +
          "<span class=\\"list-id\\">agent</span>" +
          "<span class=\\"list-title\\">" + esc(agent ? agent.name : shortId(row.agentId || row.agent_id)) + " / " + esc(row.model) + "</span>" +
          "<span class=\\"status-badge\\">" + esc(formatCompact((row.inputTokens || 0) + (row.outputTokens || 0))) + " tokens</span>" +
          "<span class=\\"status-badge\\">" + esc(String(row.taskCount || 0)) + " tasks</span>" +
        "</div>";
      });
      const runtimeRows = state.runtimeDaily.slice(-10).reverse().map(row =>
        "<div class=\\"list-row\\">" +
          "<span class=\\"list-id\\">runtime</span>" +
          "<span class=\\"list-title\\">" + esc(row.date) + "</span>" +
          "<span class=\\"status-badge\\">" + esc(formatDuration(row.totalSeconds || row.total_seconds || 0)) + "</span>" +
          "<span class=\\"status-badge\\">" + esc(String(row.taskCount || row.task_count || 0)) + " tasks</span>" +
        "</div>"
      );
      const rows = dailyRows.concat(agentRows, runtimeRows);
      els.usageList.innerHTML = rows.length ? rows.join("") : "<div class=\\"empty-column\\" style=\\"margin:16px;\\">No usage data</div>";
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
      const issue = t.issue;
      const cancellable = isActiveTask(t);
      const usage = usageSummary(t.usage || []);
      els.taskDrawer.innerHTML =
        "<div class=\\"drawer-head\\">" +
          "<div class=\\"drawer-title\\"><strong>" + esc(t.prompt || "") + "</strong><span>" + esc(issue ? issueLabel(issue) : shortId(t.id)) + "</span></div>" +
          (cancellable ? "<button class=\\"destructive\\" onclick=\\"cancelTask('" + escAttr(t.id) + "')\\">Cancel</button>" : "") +
          "<button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button>" +
        "</div>" +
        "<div class=\\"drawer-body\\">" +
          "<div class=\\"issue-meta\\"><span class=\\"status-badge " + esc(t.status) + "\\">" + esc(statusLabel(t.status)) + "</span><span class=\\"status-badge\\">" + esc(agent ? agent.name : "agent") + "</span></div>" +
          renderDetailBlock("Prompt", t.prompt || "") +
          (issue ? renderIssueControls(issue) : "") +
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
          (issue ? "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Comments</div><div class=\\"message-list\\">" + renderIssueComments() + "</div></div>" : "") +
          (issue ? "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Activity</div><div class=\\"message-list\\">" + renderIssueActivity() + "</div></div>" : "") +
          "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Messages</div><div class=\\"message-list\\">" + renderMessages() + "</div></div>" +
        "</div>";
    }

    function renderIssueDrawer(options = {}) {
      if (options.loading || !state.selectedIssue) {
        els.taskDrawer.innerHTML =
          "<div class=\\"drawer-head\\"><div class=\\"drawer-title\\"><strong>Loading</strong><span>Issue detail</span></div><button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button></div>" +
          "<div class=\\"drawer-body\\"><div class=\\"empty-column\\">Loading</div></div>";
        return;
      }
      const issue = state.selectedIssue;
      const project = issue.projectId ? state.projects.find(p => p.id === issue.projectId) : null;
      const parent = issue.parentIssueId ? state.issues.find(item => item.id === issue.parentIssueId) : null;
      const assignee = assigneeLabel(issue);
      els.taskDrawer.innerHTML =
        "<div class=\\"drawer-head\\">" +
          "<div class=\\"drawer-title\\"><strong>" + esc(issue.title || "") + "</strong><span>" + esc(issueLabel(issue)) + "</span></div>" +
          renderPinButton("issue", issue.id, issue.workspaceId) +
          "<button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button>" +
        "</div>" +
        "<div class=\\"drawer-body\\">" +
          "<div class=\\"issue-meta\\"><span class=\\"status-badge " + esc(issue.status) + "\\">" + esc(statusLabel(issue.status)) + "</span><span class=\\"status-badge\\">" + esc(issue.priority || "none") + "</span>" + (project ? "<span class=\\"status-badge\\">" + esc(project.title) + "</span>" : "") + (parent ? "<span class=\\"status-badge\\">parent " + esc(issueLabel(parent)) + "</span>" : "") + (assignee ? "<span class=\\"status-badge\\">" + esc(assignee) + "</span>" : "") + renderIssueScheduleBadges(issue) + "</div>" +
          renderIssueLabels(issue.labels || []) +
          renderDetailBlock("Description", issue.description || "") +
          renderIssuePlanning(issue) +
          renderIssueControls(issue) +
          "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Reactions</div><div class=\\"message-list\\">" + renderReactions(issue.reactions || []) + "</div></div>" +
          "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Attachments</div><div class=\\"message-list\\">" + renderAttachments(issue.attachments || []) + "</div></div>" +
          "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Child issues</div><div class=\\"message-list\\">" + renderChildIssues() + "</div></div>" +
          "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Dependencies</div><div class=\\"message-list\\">" + renderIssueDependencies(issue) + "</div></div>" +
          "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Tasks</div><div class=\\"message-list\\">" + renderIssueTasks(issue.tasks || []) + "</div></div>" +
          "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Comments</div><div class=\\"message-list\\">" + renderIssueComments() + "</div></div>" +
          "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Activity</div><div class=\\"message-list\\">" + renderIssueActivity() + "</div></div>" +
        "</div>";
    }

    function renderProjectDrawer(options = {}) {
      if (options.loading || !state.selectedProject) {
        els.taskDrawer.innerHTML =
          "<div class=\\"drawer-head\\"><div class=\\"drawer-title\\"><strong>Loading</strong><span>Project detail</span></div><button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button></div>" +
          "<div class=\\"drawer-body\\"><div class=\\"empty-column\\">Loading</div></div>";
        return;
      }
      const project = state.selectedProject;
      const progress = project.issueCount > 0 ? Math.round((project.doneCount / project.issueCount) * 100) : 0;
      els.taskDrawer.innerHTML =
        "<div class=\\"drawer-head\\">" +
          "<div class=\\"drawer-title\\"><strong>" + esc(project.title || "") + "</strong><span>" + esc(project.status) + " / " + esc(shortId(project.id)) + "</span></div>" +
          renderPinButton("project", project.id, project.workspaceId) +
          "<button class=\\"destructive\\" onclick=\\"archiveProject('" + escAttr(project.id) + "')\\">Archive</button>" +
          "<button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button>" +
        "</div>" +
        "<div class=\\"drawer-body\\">" +
          "<div class=\\"metric-row\\">" +
            renderMetric(project.issueCount || 0, "issues") +
            renderMetric(project.doneCount || 0, "done") +
            renderMetric(progress + "%", "progress") +
            renderMetric(state.selectedProjectResources.length, "resources") +
          "</div>" +
          renderDetailBlock("Description", project.description || "") +
          "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Resources</div><div class=\\"message-list\\">" + renderProjectResources() + "</div></div>" +
          "<form class=\\"sheet-form\\" onsubmit=\\"addProjectResource(event)\\" style=\\"padding:0;\\">" +
            "<div class=\\"detail-grid\\">" +
              "<label>Git repo URL<input id=\\"projectResourceUrl\\" required placeholder=\\"https://github.com/owner/repo\\"></label>" +
              "<label>Default branch<input id=\\"projectResourceBranch\\" placeholder=\\"main\\"></label>" +
              "<label>Label<input id=\\"projectResourceLabel\\" placeholder=\\"Optional\\"></label>" +
            "</div>" +
            "<button class=\\"outline\\" type=\\"submit\\">Add resource</button>" +
          "</form>" +
        "</div>";
    }

    function renderProjectResources() {
      if (!state.selectedProjectResources.length) return "<div class=\\"empty-column\\">No resources</div>";
      return state.selectedProjectResources.map(resource => {
        const url = resource.resourceRef?.url || "";
        const branch = resource.resourceRef?.defaultBranchHint || resource.resourceRef?.default_branch_hint || "";
        return "<div class=\\"message-row\\">" +
          "<div class=\\"message-head\\"><span>" + esc(resource.resourceType) + "</span><span>" + esc(resource.label || "resource") + "</span></div>" +
          "<div class=\\"message-content\\">" + esc(url || JSON.stringify(resource.resourceRef || {})) + (branch ? " / " + esc(branch) : "") + "</div>" +
          "<button class=\\"destructive\\" onclick=\\"removeProjectResource('" + escAttr(resource.id) + "')\\">Remove</button>" +
        "</div>";
      }).join("");
    }

    function renderAgentDrawer(options = {}) {
      if (options.loading || !state.selectedAgent) {
        els.taskDrawer.innerHTML =
          "<div class=\\"drawer-head\\"><div class=\\"drawer-title\\"><strong>Loading</strong><span>Agent detail</span></div><button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button></div>" +
          "<div class=\\"drawer-body\\"><div class=\\"empty-column\\">Loading</div></div>";
        return;
      }
      const agent = state.selectedAgent;
      const tasks = state.tasks.filter(t => t.agentId === agent.id);
      const active = tasks.filter(isActiveTask).length;
      const tools = (agent.allowedTools || []).join(", ");
      els.taskDrawer.innerHTML =
        "<div class=\\"drawer-head\\">" +
          "<div class=\\"drawer-title\\"><strong>" + esc(agent.name || "") + "</strong><span>" + esc(agent.provider) + " / " + esc(shortId(agent.id)) + "</span></div>" +
          "<button class=\\"destructive\\" onclick=\\"archiveAgent('" + escAttr(agent.id) + "')\\">Archive</button>" +
          "<button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button>" +
        "</div>" +
        "<div class=\\"drawer-body\\">" +
          "<div class=\\"metric-row\\">" +
            renderMetric(tasks.length, "tasks") +
            renderMetric(active, "active") +
            renderMetric((agent.allowedTools || []).length, "tools") +
          "</div>" +
          "<form class=\\"sheet-form\\" onsubmit=\\"updateSelectedAgent(event)\\" style=\\"padding:0;\\">" +
            "<div class=\\"detail-grid\\">" +
              "<label>Name<input id=\\"agentEditName\\" value=\\"" + escAttr(agent.name || "") + "\\" required></label>" +
              "<label>Provider<select id=\\"agentEditProvider\\"><option value=\\"claude\\" " + (agent.provider === "claude" ? "selected" : "") + ">Claude</option><option value=\\"codex\\" " + (agent.provider === "codex" ? "selected" : "") + ">Codex</option></select></label>" +
              "<label>Model<input id=\\"agentEditModel\\" value=\\"" + escAttr(agent.model || "") + "\\" list=\\"agentModelOptions\\" placeholder=\\"Optional\\"><datalist id=\\"agentModelOptions\\">" + runtimeModelOptions(agent.provider) + "</datalist></label>" +
              "<label>Working directory<input id=\\"agentEditCwd\\" value=\\"" + escAttr(agent.cwd || "") + "\\" placeholder=\\"Optional\\"></label>" +
            "</div>" +
            "<label>Allowed tools<input id=\\"agentAllowedTools\\" value=\\"" + escAttr(tools) + "\\" placeholder=\\"Read, Bash, Edit\\"></label>" +
            "<label>Instructions<textarea id=\\"agentEditInstructions\\" placeholder=\\"Optional\\">" + esc(agent.instructions || "") + "</textarea></label>" +
            "<button class=\\"outline\\" type=\\"submit\\">Save agent</button>" +
          "</form>" +
          "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Skills</div><div class=\\"message-list\\">" + renderAgentSkillPicker(agent) + "</div></div>" +
        "</div>";
    }

    function renderAgentSkillPicker(agent) {
      if (!state.skills.length) return "<div class=\\"empty-column\\">No workspace skills</div>";
      const selected = new Set((agent.skills || []).map(skill => skill.id));
      return "<form class=\\"sheet-form\\" onsubmit=\\"updateSelectedAgentSkills(event)\\" style=\\"padding:0;\\">" +
        state.skills.map(skill =>
          "<label class=\\"message-row\\" style=\\"display:flex; gap:10px; align-items:flex-start;\\">" +
            "<input type=\\"checkbox\\" name=\\"agentSkill\\" value=\\"" + escAttr(skill.id) + "\\" " + (selected.has(skill.id) ? "checked" : "") + ">" +
            "<span><strong>" + esc(skill.name) + "</strong><span class=\\"message-content\\">" + esc(skill.description || "") + "</span></span>" +
          "</label>"
        ).join("") +
        "<button class=\\"outline\\" type=\\"submit\\">Save skills</button>" +
      "</form>";
    }

    function renderRuntimeDrawer(options = {}) {
      if (options.loading || !state.selectedRuntime) {
        els.taskDrawer.innerHTML =
          "<div class=\\"drawer-head\\"><div class=\\"drawer-title\\"><strong>Loading</strong><span>Runtime detail</span></div><button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button></div>" +
          "<div class=\\"drawer-body\\"><div class=\\"empty-column\\">Loading</div></div>";
        return;
      }
      const runtime = state.selectedRuntime;
      const totalTokens = Number(runtime.inputTokens || 0) + Number(runtime.outputTokens || 0);
      const last = runtime.lastHeartbeatAt ? timeAgo(runtime.lastHeartbeatAt) : "never";
      els.taskDrawer.innerHTML =
        "<div class=\\"drawer-head\\">" +
          "<div class=\\"drawer-title\\"><strong>" + esc(runtime.name || "") + "</strong><span>" + esc(runtime.provider) + " / " + esc(shortId(runtime.id)) + "</span></div>" +
          "<button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button>" +
        "</div>" +
        "<div class=\\"drawer-body\\">" +
          "<div class=\\"metric-row\\">" +
            renderMetric(runtime.maxConcurrency || 1, "capacity") +
            renderMetric(runtime.activeTaskCount || 0, "active") +
            renderMetric(runtime.completedTaskCount || 0, "done") +
            renderMetric(formatCompact(totalTokens), "tokens") +
          "</div>" +
          "<div class=\\"issue-meta\\"><span class=\\"status-badge\\">" + esc(runtime.status) + "</span><span class=\\"status-badge\\">" + esc(runtime.visibility || "private") + "</span><span class=\\"status-badge\\">" + esc(last) + "</span></div>" +
          "<form class=\\"sheet-form\\" onsubmit=\\"updateSelectedRuntime(event)\\" style=\\"padding:0;\\">" +
            "<div class=\\"detail-grid\\">" +
              "<label>Name<input id=\\"runtimeEditName\\" value=\\"" + escAttr(runtime.name || "") + "\\" required></label>" +
              "<label>Owner<select id=\\"runtimeOwnerId\\">" + runtimeOwnerOptions(runtime.ownerId) + "</select></label>" +
              "<label>Visibility<select id=\\"runtimeVisibility\\">" + runtimeVisibilityOptions(runtime.visibility) + "</select></label>" +
              "<label>Max concurrency<input id=\\"runtimeMaxConcurrency\\" type=\\"number\\" min=\\"1\\" step=\\"1\\" value=\\"" + escAttr(runtime.maxConcurrency || 1) + "\\"></label>" +
            "</div>" +
            "<button class=\\"outline\\" type=\\"submit\\">Save runtime</button>" +
          "</form>" +
          "<div class=\\"detail-grid\\">" +
            renderCell("Workspace", runtime.workspaceId || "local") +
            renderCell("Owner", ownerLabel(runtime.ownerId)) +
            renderCell("Input tokens", formatCompact(runtime.inputTokens || 0)) +
            renderCell("Output tokens", formatCompact(runtime.outputTokens || 0)) +
          "</div>" +
          "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Usage by model</div><div class=\\"message-list\\">" + renderRuntimeUsageRows() + "</div></div>" +
          "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Available models</div><div class=\\"message-list\\">" + renderRuntimeModels(runtime) + "</div></div>" +
        "</div>";
    }

    function renderRuntimeModels(runtime) {
      const models = runtime.models || [];
      if (!models.length) return "<div class=\\"empty-column\\">No models reported</div>";
      return models.map(model =>
        "<div class=\\"message-row\\">" +
          "<div class=\\"message-head\\"><span>" + esc(model.label || model.id) + "</span><span>" + esc(model.provider || runtime.provider) + "</span>" + (model.default ? "<span>default</span>" : "") + "</div>" +
          "<div class=\\"message-content\\">" + esc(model.id) + (model.thinking?.supportedLevels?.length ? " / " + esc(model.thinking.supportedLevels.map(level => level.label || level.value).join(", ")) : "") + "</div>" +
        "</div>"
      ).join("");
    }

    function renderSkillDrawer(options = {}) {
      if (options.loading || !state.selectedSkill) {
        els.taskDrawer.innerHTML =
          "<div class=\\"drawer-head\\"><div class=\\"drawer-title\\"><strong>Loading</strong><span>Skill detail</span></div><button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button></div>" +
          "<div class=\\"drawer-body\\"><div class=\\"empty-column\\">Loading</div></div>";
        return;
      }
      const skill = state.selectedSkill;
      const agents = state.agents.filter(agent => (agent.skills || []).some(item => item.id === skill.id));
      const filesText = formatSkillFiles(skill.files || []);
      els.taskDrawer.innerHTML =
        "<div class=\\"drawer-head\\">" +
          "<div class=\\"drawer-title\\"><strong>" + esc(skill.name || "") + "</strong><span>" + esc(skill.workspaceId || "local") + " / " + esc(shortId(skill.id)) + "</span></div>" +
          "<button class=\\"destructive\\" onclick=\\"archiveSkill('" + escAttr(skill.id) + "')\\">Archive</button>" +
          "<button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button>" +
        "</div>" +
        "<div class=\\"drawer-body\\">" +
          "<div class=\\"metric-row\\">" +
            renderMetric(agents.length, "agents") +
            renderMetric((skill.files || []).length, "files") +
            renderMetric(shortDate(skill.updatedAt || skill.createdAt), "updated") +
          "</div>" +
          "<div class=\\"issue-meta\\">" + (agents.length ? agents.map(agent => "<span class=\\"status-badge\\">" + esc(agent.name) + "</span>").join("") : "<span class=\\"status-badge\\">unused</span>") + "</div>" +
          "<form class=\\"sheet-form\\" onsubmit=\\"updateSelectedSkill(event)\\" style=\\"padding:0;\\">" +
            "<div class=\\"detail-grid\\">" +
              "<label>Name<input id=\\"skillEditName\\" value=\\"" + escAttr(skill.name || "") + "\\" required></label>" +
              "<label>Workspace<input id=\\"skillEditWorkspace\\" value=\\"" + escAttr(skill.workspaceId || "local") + "\\"></label>" +
            "</div>" +
            "<label>Description<textarea id=\\"skillEditDescription\\" placeholder=\\"Optional\\">" + esc(skill.description || "") + "</textarea></label>" +
            "<label>SKILL.md<textarea id=\\"skillEditContent\\" placeholder=\\"Skill instructions\\">" + esc(skill.content || "") + "</textarea></label>" +
            "<label>Supporting files<textarea id=\\"skillEditFiles\\" placeholder=\\"path/to/file.md\\n---\\ncontent\\">" + esc(filesText) + "</textarea></label>" +
            "<button class=\\"outline\\" type=\\"submit\\">Save skill</button>" +
          "</form>" +
        "</div>";
    }

    function renderAutopilotDrawer(options = {}) {
      if (options.loading || !state.selectedAutopilot) {
        els.taskDrawer.innerHTML =
          "<div class=\\"drawer-head\\"><div class=\\"drawer-title\\"><strong>Loading</strong><span>Autopilot detail</span></div><button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button></div>" +
          "<div class=\\"drawer-body\\"><div class=\\"empty-column\\">Loading</div></div>";
        return;
      }
      const autopilot = state.selectedAutopilot;
      const project = autopilot.projectId ? state.projects.find(item => item.id === autopilot.projectId) : null;
      const assignee = autopilot.assigneeType === "squad"
        ? state.squads.find(item => item.id === autopilot.assigneeId)
        : state.agents.find(item => item.id === autopilot.assigneeId);
      const runs = state.selectedAutopilotRuns || [];
      const webhookUrl = window.location.origin + "/api/multica/autopilots/" + encodeURIComponent(autopilot.id) + "/webhook";
      els.taskDrawer.innerHTML =
        "<div class=\\"drawer-head\\">" +
          "<div class=\\"drawer-title\\"><strong>" + esc(autopilot.title || "") + "</strong><span>" + esc(autopilot.triggerKind) + " / " + esc(shortId(autopilot.id)) + "</span></div>" +
          "<button class=\\"outline\\" onclick=\\"runAutopilot('" + escAttr(autopilot.id) + "')\\">Run</button>" +
          "<button class=\\"destructive\\" onclick=\\"archiveAutopilot('" + escAttr(autopilot.id) + "')\\">Archive</button>" +
          "<button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button>" +
        "</div>" +
        "<div class=\\"drawer-body\\">" +
          "<div class=\\"metric-row\\">" +
            renderMetric(runs.length, "runs") +
            renderMetric(runs.filter(run => run.status === "running").length, "running") +
            renderMetric(runs.filter(run => run.status === "failed" || run.status === "skipped").length, "failed") +
          "</div>" +
          "<div class=\\"issue-meta\\"><span class=\\"status-badge " + (autopilot.status === "active" ? "completed" : "") + "\\">" + esc(autopilot.status) + "</span><span class=\\"status-badge\\">" + esc(autopilot.executionMode) + "</span>" + (project ? "<span class=\\"status-badge\\">" + esc(project.title) + "</span>" : "") + "<span class=\\"status-badge\\">" + esc(autopilot.assigneeType) + ": " + esc(assignee ? (assignee.name || assignee.title) : "missing") + "</span></div>" +
          "<form class=\\"sheet-form\\" onsubmit=\\"updateSelectedAutopilot(event)\\" style=\\"padding:0;\\">" +
            "<div class=\\"detail-grid\\">" +
              "<label>Title<input id=\\"autopilotEditTitle\\" value=\\"" + escAttr(autopilot.title || "") + "\\" required></label>" +
              "<label>Status<select id=\\"autopilotStatus\\">" + autopilotStatusOptions(autopilot.status) + "</select></label>" +
              "<label>Project<select id=\\"autopilotProject\\">" + projectOptions(true, autopilot.projectId || "") + "</select></label>" +
              "<label>Execution<select id=\\"autopilotExecutionMode\\">" + autopilotExecutionOptions(autopilot.executionMode) + "</select></label>" +
              "<label>Assignee type<select id=\\"autopilotAssigneeType\\" onchange=\\"refreshAutopilotAssigneeOptions()\\">" + autopilotAssigneeTypeOptions(autopilot.assigneeType) + "</select></label>" +
              "<label>Assignee<select id=\\"autopilotAssigneeId\\">" + autopilotAssigneeOptions(autopilot.assigneeType, autopilot.assigneeId) + "</select></label>" +
              "<label>Trigger<input id=\\"autopilotTriggerKind\\" value=\\"" + escAttr(autopilot.triggerKind || "manual") + "\\"></label>" +
              "<label>Trigger label<input id=\\"autopilotTriggerLabel\\" value=\\"" + escAttr(autopilot.triggerLabel || "") + "\\" placeholder=\\"Optional\\"></label>" +
              "<label>Cron<input id=\\"autopilotCron\\" value=\\"" + escAttr(autopilot.cronExpression || "") + "\\" placeholder=\\"*/5 * * * *\\"></label>" +
            "</div>" +
            "<label>Description<textarea id=\\"autopilotEditDescription\\" placeholder=\\"Optional\\">" + esc(autopilot.description || "") + "</textarea></label>" +
            "<label>Prompt<textarea id=\\"autopilotPrompt\\" placeholder=\\"Prompt template\\">" + esc(autopilot.issueTitleTemplate || "") + "</textarea></label>" +
            "<button class=\\"outline\\" type=\\"submit\\">Save autopilot</button>" +
          "</form>" +
          "<div class=\\"detail-grid\\">" +
            renderCell("Webhook URL", webhookUrl) +
            renderCell("Last run", autopilot.lastRunAt ? timeAgo(autopilot.lastRunAt) : "never") +
          "</div>" +
          "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Runs</div><div class=\\"message-list\\">" + renderAutopilotRuns() + "</div></div>" +
        "</div>";
    }

    function renderAutopilotRuns() {
      const runs = state.selectedAutopilotRuns || [];
      if (!runs.length) return "<div class=\\"empty-column\\">No runs</div>";
      return runs.map(run =>
        "<div class=\\"message-row\\">" +
          "<div class=\\"message-head\\"><span>" + esc(run.status) + "</span><span>" + esc(run.source) + "</span><span>" + esc(timeAgo(run.triggeredAt || run.createdAt)) + "</span></div>" +
          "<div class=\\"message-content\\">" + esc(run.failureReason || autopilotRunSummary(run)) + "</div>" +
          "<div class=\\"issue-meta\\">" +
            (run.issueId ? "<button class=\\"outline\\" onclick=\\"openIssue('" + escAttr(run.issueId) + "')\\">Open issue</button>" : "") +
            (run.taskId ? "<button class=\\"outline\\" onclick=\\"openTask('" + escAttr(run.taskId) + "')\\">Open task</button>" : "") +
          "</div>" +
        "</div>"
      ).join("");
    }

    function renderSquadDrawer(options = {}) {
      if (options.loading || !state.selectedSquad) {
        els.taskDrawer.innerHTML =
          "<div class=\\"drawer-head\\"><div class=\\"drawer-title\\"><strong>Loading</strong><span>Squad detail</span></div><button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button></div>" +
          "<div class=\\"drawer-body\\"><div class=\\"empty-column\\">Loading</div></div>";
        return;
      }
      const squad = state.selectedSquad;
      const leader = squad.leaderId ? state.agents.find(a => a.id === squad.leaderId) : null;
      els.taskDrawer.innerHTML =
        "<div class=\\"drawer-head\\">" +
          "<div class=\\"drawer-title\\"><strong>" + esc(squad.name || "") + "</strong><span>" + esc(shortId(squad.id)) + "</span></div>" +
          "<button class=\\"destructive\\" onclick=\\"archiveSquad('" + escAttr(squad.id) + "')\\">Archive</button>" +
          "<button class=\\"icon\\" onclick=\\"closeDrawer()\\">x</button>" +
        "</div>" +
        "<div class=\\"drawer-body\\">" +
          "<div class=\\"issue-meta\\"><span class=\\"status-badge\\">" + esc(leader ? leader.name : "No leader") + "</span><span class=\\"status-badge\\">" + esc(String(squad.memberCount || 0)) + " members</span></div>" +
          renderDetailBlock("Description", squad.description || squad.instructions || "") +
          "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Members</div><div class=\\"message-list\\">" + renderSquadMembers() + "</div></div>" +
          "<form class=\\"sheet-form\\" onsubmit=\\"addSquadMember(event)\\" style=\\"padding:0;\\">" +
            "<div class=\\"detail-grid\\">" +
              "<label>Type<select id=\\"squadMemberType\\" onchange=\\"refreshSquadMemberOptions()\\"><option value=\\"agent\\">agent</option><option value=\\"member\\">member</option></select></label>" +
              "<label>Member<select id=\\"squadMemberId\\">" + squadMemberOptions("agent") + "</select></label>" +
              "<label>Role<select id=\\"squadMemberRole\\"><option value=\\"member\\">member</option><option value=\\"leader\\">leader</option><option value=\\"reviewer\\">reviewer</option></select></label>" +
            "</div>" +
            "<button class=\\"outline\\" type=\\"submit\\">Add member</button>" +
          "</form>" +
        "</div>";
    }

    function renderSquadMembers() {
      if (!state.selectedSquadMembers.length) return "<div class=\\"empty-column\\">No members</div>";
      return state.selectedSquadMembers.map(member => {
        const agent = member.memberType === "agent" ? state.agents.find(a => a.id === member.memberId) : null;
        const workspaceMember = member.memberType === "member" ? state.members.find(item => item.id === member.memberId) : null;
        return "<div class=\\"message-row\\">" +
          "<div class=\\"message-head\\"><span>" + esc(member.role || "member") + "</span><span>" + esc(member.memberType) + "</span><span>" + esc(shortId(member.memberId)) + "</span></div>" +
          "<div class=\\"message-content\\">" + esc(agent ? agent.name + " / " + agent.provider : workspaceMember ? workspaceMember.name + " / " + workspaceMember.role : member.memberId) + "</div>" +
          "<button class=\\"destructive\\" onclick=\\"removeSquadMember('" + escAttr(member.memberType) + "', '" + escAttr(member.memberId) + "')\\">Remove</button>" +
        "</div>";
      }).join("");
    }

    function renderIssueTasks(tasks) {
      if (!tasks.length) return "<div class=\\"empty-column\\">No tasks</div>";
      return tasks.map(task => {
        const agent = state.agents.find(a => a.id === task.agentId);
        return "<div class=\\"message-row\\" onclick=\\"openTask('" + escAttr(task.id) + "')\\">" +
          "<div class=\\"message-head\\"><span>" + esc(statusLabel(task.status)) + "</span><span>" + esc(agent ? agent.name : "agent") + "</span><span>" + esc(shortId(task.id)) + "</span></div>" +
          "<div class=\\"message-content\\">" + esc(task.prompt || task.result || task.error || "") + "</div>" +
        "</div>";
      }).join("");
    }

    function renderIssuePlanning(issue) {
      const acceptance = Array.isArray(issue.acceptanceCriteria) ? issue.acceptanceCriteria : [];
      const refs = Array.isArray(issue.contextRefs) ? issue.contextRefs : [];
      if (!acceptance.length && !refs.length && !issue.startDate && !issue.dueDate) return "";
      const acceptanceText = acceptance.map(item => typeof item === "string" ? item : JSON.stringify(item)).join("\\n");
      const refsText = refs.map(item => typeof item === "string" ? item : JSON.stringify(item)).join("\\n");
      return "<div class=\\"detail-block\\"><div class=\\"detail-label\\">Planning</div>" +
        "<div class=\\"message-list\\">" +
          (issue.startDate || issue.dueDate ? "<div class=\\"message-row\\"><div class=\\"message-head\\"><span>Schedule</span></div><div class=\\"message-content\\">" + esc([issue.startDate ? "start " + new Date(issue.startDate).toLocaleString() : "", issue.dueDate ? "due " + new Date(issue.dueDate).toLocaleString() : ""].filter(Boolean).join(" / ")) + "</div></div>" : "") +
          (acceptanceText ? "<div class=\\"message-row\\"><div class=\\"message-head\\"><span>Acceptance</span></div><div class=\\"message-content\\">" + esc(acceptanceText) + "</div></div>" : "") +
          (refsText ? "<div class=\\"message-row\\"><div class=\\"message-head\\"><span>Context refs</span></div><div class=\\"message-content\\">" + esc(refsText) + "</div></div>" : "") +
        "</div>" +
      "</div>";
    }

    function renderChildIssues() {
      const progress = state.selectedIssueChildProgress || { total: 0, done: 0 };
      const children = state.selectedIssueChildren || [];
      const progressLine = "<div class=\\"issue-meta\\"><span class=\\"status-badge\\">" + esc(String(progress.done || 0)) + " / " + esc(String(progress.total || 0)) + " done</span></div>";
      if (!children.length) return progressLine + "<div class=\\"empty-column\\">No child issues</div>";
      return progressLine + children.map(child =>
        "<div class=\\"message-row\\" onclick=\\"openIssue('" + escAttr(child.id) + "')\\">" +
          "<div class=\\"message-head\\"><span>" + esc(issueLabel(child)) + "</span><span>" + esc(child.status) + "</span><span>" + esc(child.priority || "none") + "</span></div>" +
          "<div class=\\"message-content\\">" + esc(child.title || "") + "</div>" +
        "</div>"
      ).join("");
    }

    function renderIssueDependencies(issue) {
      const dependencies = state.selectedIssueDependencies || [];
      if (!dependencies.length) return "<div class=\\"empty-column\\">No dependencies</div>";
      return dependencies.map(dependency => {
        const currentIsSource = dependency.issueId === issue.id;
        const otherIssue = currentIsSource ? dependency.dependsOnIssue : dependency.issue;
        const direction = currentIsSource ? dependency.type : inverseDependencyType(dependency.type);
        return "<div class=\\"message-row\\">" +
          "<div class=\\"message-head\\"><span>" + esc(direction) + "</span><span>" + esc(otherIssue ? issueLabel(otherIssue) : shortId(currentIsSource ? dependency.dependsOnIssueId : dependency.issueId)) + "</span></div>" +
          "<div class=\\"message-content\\">" + esc(otherIssue?.title || "") + "</div>" +
          "<div class=\\"issue-meta\\">" +
            (otherIssue ? "<button class=\\"outline\\" onclick=\\"openIssue('" + escAttr(otherIssue.id) + "')\\">Open</button>" : "") +
            "<button class=\\"destructive\\" onclick=\\"deleteIssueDependency('" + escAttr(dependency.id) + "')\\">Remove</button>" +
          "</div>" +
        "</div>";
      }).join("");
    }

    function inverseDependencyType(type) {
      if (type === "blocks") return "blocked_by";
      if (type === "blocked_by") return "blocks";
      return "related";
    }

    function renderIssueScheduleBadges(issue) {
      const parts = [];
      if (issue.startDate) parts.push("<span class=\\"status-badge\\">start " + esc(new Date(issue.startDate).toLocaleDateString()) + "</span>");
      if (issue.dueDate) parts.push("<span class=\\"status-badge\\">due " + esc(new Date(issue.dueDate).toLocaleDateString()) + "</span>");
      return parts.join("");
    }

    function renderIssueControls(issue) {
      return "<div class=\\"detail-block\\">" +
        "<div class=\\"detail-label\\">Issue</div>" +
        "<div class=\\"detail-grid\\">" +
          "<label>Status<select id=\\"issueStatus\\">" + issueStatusOptions(issue.status) + "</select></label>" +
          "<label>Priority<select id=\\"issuePriority\\">" + issuePriorityOptions(issue.priority || "none") + "</select></label>" +
          "<label>Project<select id=\\"issueProject\\">" + projectOptions(true, issue.projectId) + "</select></label>" +
          "<label>Parent<select id=\\"issueParent\\">" + issueParentOptions(issue) + "</select></label>" +
          "<label>Position<input id=\\"issuePosition\\" type=\\"number\\" step=\\"0.1\\" value=\\"" + escAttr(issue.position || 0) + "\\"></label>" +
          "<label>Start<input id=\\"issueStartDate\\" type=\\"datetime-local\\" value=\\"" + escAttr(toLocalDateTimeValue(issue.startDate)) + "\\"></label>" +
          "<label>Due<input id=\\"issueDueDate\\" type=\\"datetime-local\\" value=\\"" + escAttr(toLocalDateTimeValue(issue.dueDate)) + "\\"></label>" +
        "</div>" +
        "<button class=\\"outline\\" onclick=\\"updateSelectedIssue()\\">Save issue</button>" +
        "<form class=\\"sheet-form\\" onsubmit=\\"assignSelectedIssue(event)\\" style=\\"padding:0;\\">" +
          "<div class=\\"detail-grid\\">" +
            "<label>Assignee type<select id=\\"issueAssigneeTypeEdit\\" onchange=\\"refreshIssueAssigneeOptions()\\">" + assigneeTypeOptions(issue.assigneeType) + "</select></label>" +
            "<label>Assignee<select id=\\"issueAssigneeIdEdit\\">" + assigneeOptions(issue.assigneeType || "agent", true, issue.assigneeId) + "</select></label>" +
          "</div>" +
          "<label>Prompt<textarea id=\\"issueAssignPrompt\\" placeholder=\\"Prompt for agent or squad\\">" + esc(issue.title || "") + "</textarea></label>" +
          "<button class=\\"outline\\" type=\\"submit\\">Assign</button>" +
        "</form>" +
        "<form class=\\"sheet-form\\" onsubmit=\\"addSelectedIssueComment(event)\\" style=\\"padding:0;\\">" +
          "<div class=\\"detail-grid\\">" +
            "<label>Mention<select id=\\"issueMentionTarget\\">" + mentionOptions() + "</select></label>" +
            "<label>Reply to<select id=\\"issueCommentParent\\">" + commentParentOptions() + "</select></label>" +
            "<button class=\\"outline\\" type=\\"button\\" onclick=\\"insertIssueMention()\\">Insert mention</button>" +
          "</div>" +
          "<label>Attachment IDs<input id=\\"issueCommentAttachmentIds\\" placeholder=\\"att_..., att_...\\"></label>" +
          "<label>Comment<textarea id=\\"issueCommentBody\\" placeholder=\\"Comment\\"></textarea></label>" +
          "<button class=\\"outline\\" type=\\"submit\\">Add comment</button>" +
        "</form>" +
        "<form class=\\"sheet-form\\" onsubmit=\\"addSelectedIssueDependency(event)\\" style=\\"padding:0;\\">" +
          "<div class=\\"detail-grid\\">" +
            "<label>Relation<select id=\\"issueDependencyType\\"><option value=\\"blocks\\">blocks</option><option value=\\"blocked_by\\">blocked_by</option><option value=\\"related\\">related</option></select></label>" +
            "<label>Issue<select id=\\"issueDependencyTarget\\">" + issueDependencyTargetOptions(issue) + "</select></label>" +
          "</div>" +
          "<button class=\\"outline\\" type=\\"submit\\">Add dependency</button>" +
        "</form>" +
        "<div class=\\"issue-meta\\">" +
          "<button class=\\"outline\\" onclick=\\"reactToSelectedIssue('👍')\\">👍</button>" +
          "<button class=\\"outline\\" onclick=\\"reactToSelectedIssue('👀')\\">👀</button>" +
          "<button class=\\"outline\\" onclick=\\"reactToSelectedIssue('✅')\\">✅</button>" +
        "</div>" +
        "<div class=\\"detail-block\\" style=\\"padding:0;border:0;\\"><div class=\\"detail-label\\">Labels</div>" + renderIssueLabels(issue.labels || [], true) + "</div>" +
        "<form class=\\"sheet-form\\" onsubmit=\\"attachSelectedIssueLabel(event)\\" style=\\"padding:0;\\">" +
          "<div class=\\"detail-grid\\">" +
            "<label>Existing label<select id=\\"issueLabelId\\">" + labelOptions(issue) + "</select></label>" +
          "</div>" +
          "<button class=\\"outline\\" type=\\"submit\\">Attach label</button>" +
        "</form>" +
        "<form class=\\"sheet-form\\" onsubmit=\\"createSelectedIssueLabel(event)\\" style=\\"padding:0;\\">" +
          "<div class=\\"detail-grid\\">" +
            "<label>Name<input id=\\"issueLabelName\\" maxlength=\\"32\\" placeholder=\\"bug\\"></label>" +
            "<label>Color<input id=\\"issueLabelColor\\" value=\\"#6b7280\\" placeholder=\\"#6b7280\\"></label>" +
          "</div>" +
          "<button class=\\"outline\\" type=\\"submit\\">Create and attach label</button>" +
        "</form>" +
        "<form class=\\"sheet-form\\" onsubmit=\\"addSelectedIssueAttachment(event)\\" style=\\"padding:0;\\">" +
          "<label>Upload file<input id=\\"issueAttachmentFile\\" type=\\"file\\"></label>" +
          "<div class=\\"detail-grid\\">" +
            "<label>Filename<input id=\\"issueAttachmentFilename\\" placeholder=\\"screenshot.png\\"></label>" +
            "<label>URL<input id=\\"issueAttachmentUrl\\" placeholder=\\"https://...\\"></label>" +
            "<label>Type<input id=\\"issueAttachmentContentType\\" placeholder=\\"image/png\\"></label>" +
            "<label>Size<input id=\\"issueAttachmentSize\\" type=\\"number\\" min=\\"0\\" placeholder=\\"0\\"></label>" +
          "</div>" +
          "<button class=\\"outline\\" type=\\"submit\\">Add attachment</button>" +
        "</form>" +
        "<div class=\\"detail-block\\" style=\\"padding:0;border:0;\\"><div class=\\"detail-label\\">Metadata</div><div class=\\"message-list\\">" + renderIssueMetadata(issue) + "</div></div>" +
        "<form class=\\"sheet-form\\" onsubmit=\\"setSelectedIssueMetadata(event)\\" style=\\"padding:0;\\">" +
          "<div class=\\"detail-grid\\">" +
            "<label>Key<input id=\\"issueMetadataKey\\" placeholder=\\"pr_url\\"></label>" +
            "<label>Type<select id=\\"issueMetadataType\\"><option value=\\"string\\">string</option><option value=\\"number\\">number</option><option value=\\"bool\\">bool</option></select></label>" +
          "</div>" +
          "<label>Value<input id=\\"issueMetadataValue\\" placeholder=\\"Pinned value\\"></label>" +
          "<button class=\\"outline\\" type=\\"submit\\">Set metadata</button>" +
        "</form>" +
      "</div>";
    }

    function renderIssueMetadata(issue) {
      const entries = Object.entries(issue.metadata || {}).sort(([left], [right]) => left.localeCompare(right));
      if (!entries.length) return "<div class=\\"empty-column\\">No metadata</div>";
      return entries.map(([key, value]) =>
        "<div class=\\"message-row\\">" +
          "<div class=\\"message-head\\"><span>" + esc(key) + "</span><span>" + esc(typeof value) + "</span></div>" +
          "<div class=\\"message-content\\">" + esc(String(value)) + "</div>" +
          "<button class=\\"destructive\\" onclick=\\"deleteSelectedIssueMetadata('" + escAttr(key) + "')\\">Delete</button>" +
        "</div>"
      ).join("");
    }

    function renderIssueComments() {
      if (!state.selectedIssueComments.length) return "<div class=\\"empty-column\\">No comments</div>";
      return state.selectedIssueComments.map(comment => {
        const parent = comment.parentId ? state.selectedIssueComments.find(item => item.id === comment.parentId) : null;
        return "<div class=\\"message-row\\" style=\\"" + (comment.parentId ? "margin-left:18px;" : "") + "\\">" +
          "<div class=\\"message-head\\"><span>" + esc(comment.authorType) + "</span><span>" + esc(timeAgo(comment.createdAt)) + "</span>" + (parent ? "<span>reply " + esc(shortId(parent.id)) + "</span>" : "") + (comment.resolvedAt ? "<span>resolved " + esc(timeAgo(comment.resolvedAt)) + "</span>" : "") + "</div>" +
          "<div class=\\"message-content\\">" + esc(comment.body) + "</div>" +
          (comment.reactions?.length ? "<div class=\\"issue-meta\\">" + renderReactions(comment.reactions) + "</div>" : "") +
          (comment.attachments?.length ? "<div class=\\"message-list\\">" + renderAttachments(comment.attachments) + "</div>" : "") +
          "<div class=\\"issue-meta\\">" +
            "<button class=\\"outline\\" onclick=\\"reactToComment('" + escAttr(comment.id) + "', '👍')\\">👍</button>" +
            "<button class=\\"outline\\" onclick=\\"reactToComment('" + escAttr(comment.id) + "', '👀')\\">👀</button>" +
            "<button class=\\"outline\\" onclick=\\"editComment('" + escAttr(comment.id) + "')\\">Edit</button>" +
            "<button class=\\"destructive\\" onclick=\\"deleteComment('" + escAttr(comment.id) + "')\\">Delete</button>" +
            (!comment.parentId ? (comment.resolvedAt
              ? "<button class=\\"outline\\" onclick=\\"setCommentResolved('" + escAttr(comment.id) + "', false)\\">Unresolve</button>"
              : "<button class=\\"outline\\" onclick=\\"setCommentResolved('" + escAttr(comment.id) + "', true)\\">Resolve</button>") : "") +
          "</div>" +
        "</div>";
      }).join("");
    }

    function renderReactions(reactions) {
      if (!reactions.length) return "<div class=\\"empty-column\\">No reactions</div>";
      const counts = reactions.reduce((acc, reaction) => {
        acc[reaction.emoji] = (acc[reaction.emoji] || 0) + 1;
        return acc;
      }, {});
      return Object.entries(counts).map(([emoji, count]) =>
        "<span class=\\"status-badge\\">" + esc(emoji) + " " + esc(count) + "</span>"
      ).join("");
    }

    function renderAttachments(attachments) {
      if (!attachments.length) return "<div class=\\"empty-column\\">No attachments</div>";
      return attachments.map(attachment => {
        const href = attachment.url || ("/api/attachments/" + encodeURIComponent(attachment.id) + "/content");
        return (
        "<div class=\\"message-row\\">" +
          "<div class=\\"message-head\\"><span>" + esc(attachment.filename) + "</span><span>" + esc(attachment.contentType || "file") + "</span><span>" + esc(shortId(attachment.id)) + "</span></div>" +
          "<div class=\\"message-content\\">" + esc(href) + "</div>" +
          "<div class=\\"issue-meta\\"><a class=\\"outline\\" href=\\"" + escAttr(href) + "\\" target=\\"_blank\\" rel=\\"noreferrer\\">Download</a></div>" +
        "</div>"
        );
      }).join("");
    }

    function renderLabelChips(labels) {
      if (!labels || !labels.length) return "";
      return labels.slice(0, 4).map(label =>
        "<span class=\\"status-badge\\" style=\\"" + labelStyle(label) + "\\"><span class=\\"priority-dot\\" style=\\"background:" + escAttr(label.color || "#6b7280") + ";width:8px;height:8px;border-radius:999px;\\"></span>" + esc(label.name) + "</span>"
      ).join("") + (labels.length > 4 ? "<span class=\\"status-badge\\">+" + esc(labels.length - 4) + "</span>" : "");
    }

    function renderIssueLabels(labels, removable = false) {
      if (!labels || !labels.length) return "<div class=\\"empty-column\\">No labels</div>";
      return "<div class=\\"issue-meta\\">" + labels.map(label =>
        "<span class=\\"status-badge\\" style=\\"" + labelStyle(label) + "\\">" +
          "<span class=\\"priority-dot\\" style=\\"background:" + escAttr(label.color || "#6b7280") + ";width:8px;height:8px;border-radius:999px;\\"></span>" +
          esc(label.name) +
          (removable ? "<button class=\\"icon\\" style=\\"width:20px;height:20px;\\" onclick=\\"detachSelectedIssueLabel('" + escAttr(label.id) + "')\\">x</button>" : "") +
        "</span>"
      ).join("") + "</div>";
    }

    function labelOptions(issue) {
      const attached = new Set((issue.labels || []).map(label => label.id));
      const labels = state.labels.filter(label => (label.workspaceId || "local") === (issue.workspaceId || "local") && !attached.has(label.id));
      if (!labels.length) return "<option value=\\"\\">No labels</option>";
      return labels.map(label =>
        "<option value=\\"" + escAttr(label.id) + "\\">" + esc(label.name) + " / " + esc(label.color) + "</option>"
      ).join("");
    }

    function labelStyle(label) {
      const color = String(label?.color || "#6b7280");
      return "background: color-mix(in oklab, " + escAttr(color) + " 14%, transparent); color: color-mix(in oklab, " + escAttr(color) + " 72%, var(--foreground));";
    }

    function renderPinButton(itemType, itemId, workspaceId = "local") {
      const pinned = state.pins.some(pin => pin.itemType === itemType && pin.itemId === itemId);
      if (pinned) {
        return "<button class=\\"outline\\" onclick=\\"unpinItem('" + escAttr(itemType) + "', '" + escAttr(itemId) + "')\\">Unpin</button>";
      }
      return "<button class=\\"outline\\" onclick=\\"pinItem('" + escAttr(itemType) + "', '" + escAttr(itemId) + "', '" + escAttr(workspaceId || "local") + "')\\">Pin</button>";
    }

    function pinnedTarget(pin) {
      if (pin.itemType === "issue") {
        const issue = state.issues.find(item => item.id === pin.itemId);
        return { label: issue ? issueLabel(issue) + " " + issue.title : shortId(pin.itemId), target: issue };
      }
      const project = state.projects.find(item => item.id === pin.itemId);
      return { label: project ? project.title : shortId(pin.itemId), target: project };
    }

    function renderIssueActivity() {
      if (!state.selectedIssueActivity.length) return "<div class=\\"empty-column\\">No activity</div>";
      return state.selectedIssueActivity.map(item =>
        "<div class=\\"message-row\\"><div class=\\"message-head\\"><span>" + esc(item.type) + "</span><span>" + esc(timeAgo(item.createdAt)) + "</span></div><div class=\\"message-content\\">" + esc(item.body || activitySummary(item)) + "</div></div>"
      ).join("");
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

    function renderRuntimeUsageRows() {
      if (!state.selectedRuntimeUsage.length) return "<div class=\\"empty-column\\">No usage</div>";
      return state.selectedRuntimeUsage.map(row =>
        "<div class=\\"message-row\\">" +
          "<div class=\\"message-head\\"><span>" + esc(row.provider) + "</span><span>" + esc(row.model) + "</span><span>" + esc(String(row.taskCount || 0)) + " tasks</span></div>" +
          "<div class=\\"message-content\\">" + esc(formatCompact(row.inputTokens || 0)) + " in / " + esc(formatCompact(row.outputTokens || 0)) + " out / " + esc(formatCompact((row.cacheReadTokens || 0) + (row.cacheWriteTokens || 0))) + " cache</div>" +
        "</div>"
      ).join("");
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
      pages["my-issues"] && rows.push({ type: "Page", title: "My Issues", subtitle: visibleMyIssues().length + " assigned issues", action: () => switchPage("my-issues") });
      pages.issues && rows.push({ type: "Page", title: "Issues", subtitle: state.issues.length + " issues", action: () => switchPage("issues") });
      pages.projects && rows.push({ type: "Page", title: "Projects", subtitle: state.projects.length + " projects", action: () => switchPage("projects") });
      pages.autopilots && rows.push({ type: "Page", title: "Autopilots", subtitle: state.autopilots.length + " autopilots", action: () => switchPage("autopilots") });
      pages.agents && rows.push({ type: "Page", title: "Agents", subtitle: state.agents.length + " agents", action: () => switchPage("agents") });
      pages.squads && rows.push({ type: "Page", title: "Squads", subtitle: state.squads.length + " squads", action: () => switchPage("squads") });
      pages.runtimes && rows.push({ type: "Page", title: "Runtimes", subtitle: state.runtimes.length + " runtimes", action: () => switchPage("runtimes") });
      pages.skills && rows.push({ type: "Page", title: "Skills", subtitle: state.skills.length + " skills", action: () => switchPage("skills") });
      pages.settings && rows.push({ type: "Page", title: "Settings", subtitle: state.tokens.length + " tokens", action: () => switchPage("settings") });
      state.issues.forEach(i => rows.push({ type: "Issue", title: i.title || issueLabel(i), subtitle: issueLabel(i) + " / " + statusLabel(i.status), action: () => { switchPage("issues"); openIssue(i.id); } }));
      state.projects.forEach(p => rows.push({ type: "Project", title: p.title, subtitle: p.status + " / " + p.issueCount + " issues", action: () => switchPage("projects") }));
      state.autopilots.forEach(a => rows.push({ type: "Autopilot", title: a.title, subtitle: a.status + " / " + a.triggerKind, action: () => { switchPage("autopilots"); openAutopilot(a.id); } }));
      state.agents.forEach(a => rows.push({ type: "Agent", title: a.name, subtitle: a.provider, action: () => { switchPage("agents"); openAgent(a.id); } }));
      state.members.forEach(m => rows.push({ type: "Member", title: m.name, subtitle: m.role + " / " + m.workspaceId, action: () => { state.agentFilter = "members"; switchPage("issues"); } }));
      state.squads.forEach(s => rows.push({ type: "Squad", title: s.name, subtitle: s.memberCount + " members", action: () => { switchPage("squads"); openSquad(s.id); } }));
      state.runtimes.forEach(r => rows.push({ type: "Runtime", title: r.name, subtitle: r.provider + " / " + r.status, action: () => switchPage("runtimes") }));
      state.skills.forEach(s => rows.push({ type: "Skill", title: s.name, subtitle: (s.description || "No description"), action: () => { switchPage("skills"); openSkill(s.id); } }));
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
      const entries = state.selectedChatMessages.length
        ? state.selectedChatMessages.map(message => ({
          role: message.role,
          text: message.body,
          label: message.role === "user" ? "You" : message.role === "assistant" ? "Agent" : "Multica"
        }))
        : state.chatEntries;
      if (!entries.length) {
        const latest = els.chatAgent.value ? state.chatSessions.find(session => session.agentId === els.chatAgent.value) : null;
        els.chatLog.innerHTML = latest
          ? "<div class=\\"chat-entry system\\"><span>Multica</span><div>Open chat: " + esc(latest.title) + "</div></div>"
          : "<div class=\\"chat-entry system\\"><span>Multica</span><div>Ready</div></div>";
        return;
      }
      els.chatLog.innerHTML = entries.slice(-12).map(entry =>
        "<div class=\\"chat-entry " + esc(entry.role) + "\\"><span>" + esc(entry.label || (entry.role === "user" ? "You" : "Multica")) + "</span><div>" + esc(entry.text) + "</div></div>"
      ).join("");
    }

    function renderMetric(value, label) {
      return "<div class=\\"metric\\"><div class=\\"metric-value\\">" + esc(value) + "</div><div class=\\"metric-label\\">" + esc(label) + "</div></div>";
    }

    function entityFormHtml(kind) {
      if (kind === "project") {
        return "<label>Title<input id=\\"entityTitle\\" required placeholder=\\"Project title\\"></label>" +
          "<label>Description<textarea id=\\"entityDescription\\" placeholder=\\"Optional\\"></textarea></label>" +
          "<label>Status<select id=\\"entityStatus\\"><option value=\\"planned\\">planned</option><option value=\\"in_progress\\">in_progress</option><option value=\\"paused\\">paused</option><option value=\\"completed\\">completed</option></select></label>" +
          "<label>Priority<select id=\\"entityPriority\\"><option value=\\"none\\">none</option><option value=\\"low\\">low</option><option value=\\"medium\\">medium</option><option value=\\"high\\">high</option><option value=\\"urgent\\">urgent</option></select></label>" +
          "<label>Git repo URL<input id=\\"entityRepoUrl\\" placeholder=\\"https://github.com/owner/repo\\"></label>" +
          "<label>Default branch<input id=\\"entityRepoBranch\\" placeholder=\\"main\\"></label>" +
          "<label>Resource label<input id=\\"entityRepoLabel\\" placeholder=\\"Optional\\"></label>" +
          "<button class=\\"primary\\" type=\\"submit\\">Create project</button><div class=\\"notice\\"></div>";
      }
      if (kind === "squad") {
        return "<label>Name<input id=\\"entityTitle\\" required placeholder=\\"Squad name\\"></label>" +
          "<label>Description<textarea id=\\"entityDescription\\" placeholder=\\"Optional\\"></textarea></label>" +
          "<label>Leader<select id=\\"entityLeader\\">" + agentOptions(true) + "</select></label>" +
          "<label>Instructions<textarea id=\\"entityInstructions\\" placeholder=\\"Optional\\"></textarea></label>" +
          "<button class=\\"primary\\" type=\\"submit\\">Create squad</button><div class=\\"notice\\"></div>";
      }
      if (kind === "skill") {
        return "<label>Name<input id=\\"entityTitle\\" required placeholder=\\"review-helper\\"></label>" +
          "<label>Description<textarea id=\\"entityDescription\\" placeholder=\\"Optional\\"></textarea></label>" +
          "<label>SKILL.md<textarea id=\\"entityContent\\" placeholder=\\"Skill instructions\\"></textarea></label>" +
          "<label>Supporting files<textarea id=\\"entityFiles\\" placeholder=\\"path/to/file.md\\n---\\ncontent\\n===\\nnotes.md\\n---\\nmore content\\"></textarea></label>" +
          "<button class=\\"primary\\" type=\\"submit\\">Create skill</button><div class=\\"notice\\"></div>";
      }
      return "<label>Title<input id=\\"entityTitle\\" required placeholder=\\"Autopilot title\\"></label>" +
        "<label>Description<textarea id=\\"entityDescription\\" placeholder=\\"Optional\\"></textarea></label>" +
        "<label>Project<select id=\\"entityProject\\">" + projectOptions(true) + "</select></label>" +
        "<label>Assignee type<select id=\\"entityAssigneeType\\" onchange=\\"refreshAssigneeOptions()\\"><option value=\\"agent\\">agent</option><option value=\\"squad\\">squad</option></select></label>" +
        "<label>Assignee<select id=\\"entityAssignee\\">" + agentOptions(false) + "</select></label>" +
        "<label>Mode<select id=\\"entityMode\\"><option value=\\"create_issue\\">create_issue</option><option value=\\"run_only\\">run_only</option></select></label>" +
        "<label>Trigger<select id=\\"entityTrigger\\"><option value=\\"manual\\">manual</option><option value=\\"schedule\\">schedule</option><option value=\\"webhook\\">webhook</option><option value=\\"api\\">api</option></select></label>" +
        "<label>Cron<input id=\\"entityCron\\" placeholder=\\"*/5 * * * *\\"></label>" +
        "<label>Prompt<textarea id=\\"entityPrompt\\" placeholder=\\"Optional\\"></textarea></label>" +
        "<button class=\\"primary\\" type=\\"submit\\">Create autopilot</button><div class=\\"notice\\"></div>";
    }

    function agentOptions(allowEmpty) {
      const empty = allowEmpty ? "<option value=\\"\\">None</option>" : "";
      return empty + state.agents.map(a => "<option value=\\"" + escAttr(a.id) + "\\">" + esc(a.name) + " / " + esc(a.provider) + "</option>").join("");
    }

    function autopilotStatusOptions(current) {
      return ["active", "paused"].map(status =>
        "<option value=\\"" + status + "\\" " + (status === current ? "selected" : "") + ">" + status + "</option>"
      ).join("");
    }

    function autopilotExecutionOptions(current) {
      return ["create_issue", "run_only"].map(mode =>
        "<option value=\\"" + mode + "\\" " + (mode === current ? "selected" : "") + ">" + mode + "</option>"
      ).join("");
    }

    function autopilotAssigneeTypeOptions(current) {
      return ["agent", "squad"].map(type =>
        "<option value=\\"" + type + "\\" " + (type === current ? "selected" : "") + ">" + type + "</option>"
      ).join("");
    }

    function autopilotAssigneeOptions(type, selectedId = "") {
      if (type === "squad") {
        return state.squads.map(squad =>
          "<option value=\\"" + escAttr(squad.id) + "\\" " + (squad.id === selectedId ? "selected" : "") + ">" + esc(squad.name) + "</option>"
        ).join("") || "<option value=\\"\\">No squads</option>";
      }
      return state.agents.map(agent =>
        "<option value=\\"" + escAttr(agent.id) + "\\" " + (agent.id === selectedId ? "selected" : "") + ">" + esc(agent.name) + " / " + esc(agent.provider) + "</option>"
      ).join("") || "<option value=\\"\\">No agents</option>";
    }

    function refreshAutopilotAssigneeOptions() {
      const type = document.getElementById("autopilotAssigneeType")?.value || "agent";
      const select = document.getElementById("autopilotAssigneeId");
      if (select) select.innerHTML = autopilotAssigneeOptions(type);
    }

    function assigneeTypeOptions(current) {
      const values = [
        ["", "none"],
        ["agent", "agent"],
        ["member", "member"],
        ["squad", "squad"]
      ];
      return values.map(([value, label]) =>
        "<option value=\\"" + escAttr(value) + "\\" " + (value === (current || "") ? "selected" : "") + ">" + esc(label) + "</option>"
      ).join("");
    }

    function assigneeOptions(type, allowEmpty, selectedId = "") {
      const empty = allowEmpty ? "<option value=\\"\\">None</option>" : "";
      if (!type) return empty;
      if (type === "member") {
        const rows = state.members.map(m => "<option value=\\"" + escAttr(m.id) + "\\" " + (m.id === selectedId ? "selected" : "") + ">" + esc(m.name) + " / " + esc(m.role) + "</option>").join("");
        return empty + (rows || "<option value=\\"\\">No members</option>");
      }
      if (type === "squad") {
        const rows = state.squads.map(s => "<option value=\\"" + escAttr(s.id) + "\\" " + (s.id === selectedId ? "selected" : "") + ">" + esc(s.name) + "</option>").join("");
        return empty + (rows || "<option value=\\"\\">No squads</option>");
      }
      const rows = state.agents.map(a => "<option value=\\"" + escAttr(a.id) + "\\" " + (a.id === selectedId ? "selected" : "") + ">" + esc(a.name) + " / " + esc(a.provider) + "</option>").join("");
      return empty + (rows || "<option value=\\"\\">No agents</option>");
    }

    function refreshCreateAssigneeOptions() {
      const type = document.getElementById("issueAssigneeType")?.value || "";
      if (els.agentSelect) els.agentSelect.innerHTML = assigneeOptions(type, true);
    }

    function refreshIssueAssigneeOptions() {
      const type = document.getElementById("issueAssigneeTypeEdit").value || "";
      document.getElementById("issueAssigneeIdEdit").innerHTML = assigneeOptions(type, true);
    }

    function assigneeLabel(item) {
      if (!item.assigneeType || !item.assigneeId) return "";
      if (item.assigneeType === "agent") {
        const agent = state.agents.find(a => a.id === item.assigneeId);
        return agent ? "agent: " + agent.name : "agent: " + shortId(item.assigneeId);
      }
      if (item.assigneeType === "member") {
        const member = state.members.find(m => m.id === item.assigneeId);
        return member ? "member: " + member.name : "member: " + shortId(item.assigneeId);
      }
      const squad = state.squads.find(s => s.id === item.assigneeId);
      return squad ? "squad: " + squad.name : "squad: " + shortId(item.assigneeId);
    }

    function myIssueMemberOptions() {
      return "<option value=\\"all\\">All members</option>" + state.members.map(member =>
        "<option value=\\"" + escAttr(member.id) + "\\" " + (member.id === state.myIssueMemberId ? "selected" : "") + ">" + esc(member.name) + " / " + esc(member.role) + "</option>"
      ).join("");
    }

    function mentionOptions() {
      const memberRows = state.members.map(member =>
        "<option value=\\"member:" + escAttr(member.id) + "\\">" + esc(member.name) + " / member</option>"
      ).join("");
      const agentRows = state.agents.map(agent =>
        "<option value=\\"agent:" + escAttr(agent.id) + "\\">" + esc(agent.name) + " / agent</option>"
      ).join("");
      const squadRows = state.squads.map(squad =>
        "<option value=\\"squad:" + escAttr(squad.id) + "\\">" + esc(squad.name) + " / squad</option>"
      ).join("");
      return "<option value=\\"\\">None</option><option value=\\"all:all\\">@all</option>" + memberRows + agentRows + squadRows;
    }

    function commentParentOptions() {
      return "<option value=\\"\\">New thread</option>" + state.selectedIssueComments.map(comment =>
        "<option value=\\"" + escAttr(comment.id) + "\\">" + esc(shortId(comment.id)) + " / " + esc((comment.body || "").slice(0, 48)) + "</option>"
      ).join("");
    }

    function projectOptions(allowEmpty, selectedId = "") {
      const empty = allowEmpty ? "<option value=\\"\\">None</option>" : "";
      return empty + state.projects.map(p =>
        "<option value=\\"" + escAttr(p.id) + "\\" " + (p.id === selectedId ? "selected" : "") + ">" + esc(p.title) + "</option>"
      ).join("");
    }

    function issueParentOptions(issue) {
      return "<option value=\\"\\">None</option>" + state.issues
        .filter(item => item.id !== issue.id)
        .map(item => "<option value=\\"" + escAttr(item.id) + "\\" " + (item.id === issue.parentIssueId ? "selected" : "") + ">" + esc(issueLabel(item)) + " / " + esc(item.title || "") + "</option>")
        .join("");
    }

    function issueDependencyTargetOptions(issue) {
      const rows = state.issues
        .filter(item => item.id !== issue.id)
        .map(item => "<option value=\\"" + escAttr(item.id) + "\\">" + esc(issueLabel(item)) + " / " + esc(item.title || "") + "</option>")
        .join("");
      return rows || "<option value=\\"\\">No other issues</option>";
    }

    function squadOptions() {
      return state.squads.map(s => "<option value=\\"" + escAttr(s.id) + "\\">" + esc(s.name) + "</option>").join("");
    }

    function squadMemberOptions(type) {
      if (type === "member") {
        return state.members.length
          ? state.members.map(m => "<option value=\\"" + escAttr(m.id) + "\\">" + esc(m.name) + " / " + esc(m.role) + "</option>").join("")
          : "<option value=\\"\\">No members</option>";
      }
      return agentOptions(false);
    }

    function runtimeOwnerOptions(current) {
      const empty = "<option value=\\"\\">Unassigned</option>";
      return empty + state.members.map(member =>
        "<option value=\\"" + escAttr(member.id) + "\\" " + (member.id === current ? "selected" : "") + ">" + esc(member.name) + " / " + esc(member.role) + "</option>"
      ).join("");
    }

    function runtimeVisibilityOptions(current) {
      return ["private", "public"].map(value =>
        "<option value=\\"" + value + "\\" " + (value === current ? "selected" : "") + ">" + value + "</option>"
      ).join("");
    }

    function runtimeModelOptions(provider) {
      const seen = new Set();
      return state.runtimes
        .filter(runtime => !provider || runtime.provider === provider || runtime.provider === "any")
        .flatMap(runtime => runtime.models || [])
        .filter(model => {
          if (!model.id || seen.has(model.id)) return false;
          seen.add(model.id);
          return true;
        })
        .map(model => "<option value=\\"" + escAttr(model.id) + "\\">" + esc(model.label || model.id) + "</option>")
        .join("");
    }

    function refreshSquadMemberOptions() {
      const type = document.getElementById("squadMemberType").value;
      document.getElementById("squadMemberId").innerHTML = squadMemberOptions(type);
    }

    function refreshAssigneeOptions() {
      const type = document.getElementById("entityAssigneeType").value;
      document.getElementById("entityAssignee").innerHTML = type === "squad" ? squadOptions() : agentOptions(false);
    }

    function issueStatusOptions(current) {
      return ["open", "in_progress", "blocked", "done", "failed", "cancelled"].map(status =>
        "<option value=\\"" + status + "\\" " + (status === current ? "selected" : "") + ">" + status + "</option>"
      ).join("");
    }

    function issuePriorityOptions(current) {
      return ["urgent", "high", "medium", "low", "none"].map(priority =>
        "<option value=\\"" + priority + "\\" " + (priority === current ? "selected" : "") + ">" + priority + "</option>"
      ).join("");
    }

    function priorityRank(priority) {
      return { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }[priority || "none"] ?? 4;
    }

    function priorityColor(priority) {
      if (priority === "urgent") return "var(--destructive)";
      if (priority === "high") return "var(--warning)";
      if (priority === "medium") return "var(--brand)";
      if (priority === "low") return "var(--success)";
      return "var(--muted-foreground)";
    }

    function isDueSoon(issue) {
      if (!issue.dueDate || ["done", "completed", "failed", "cancelled"].includes(issue.status)) return false;
      const time = Date.parse(issue.dueDate);
      if (!Number.isFinite(time)) return false;
      const now = Date.now();
      const soon = now + 7 * 24 * 60 * 60 * 1000;
      return time <= soon;
    }

    function activitySummary(item) {
      if (!item.data) return "";
      try {
        return JSON.stringify(item.data);
      } catch {
        return "";
      }
    }

    function parseMetadataValue(raw, type) {
      if (type === "number") {
        const value = Number(raw);
        if (!Number.isFinite(value)) throw new Error("Metadata value must be a number");
        return value;
      }
      if (type === "bool") {
        const normalized = raw.trim().toLowerCase();
        if (["true", "1", "yes"].includes(normalized)) return true;
        if (["false", "0", "no"].includes(normalized)) return false;
        throw new Error("Metadata value must be true or false");
      }
      return raw;
    }

    function splitCsv(value) {
      return String(value || "").split(",").map(item => item.trim()).filter(Boolean);
    }

    function parseSkillFiles(value) {
      const raw = String(value || "").trim();
      if (!raw) return [];
      return raw.split(/\\n={3,}\\n/g).map(block => {
        const parts = block.split(/\\n---\\n/);
        if (parts.length < 2) throw new Error("Skill file blocks require path, ---, and content");
        const path = parts.shift().trim();
        const content = parts.join("\\n---\\n");
        if (!path) throw new Error("Skill file path is required");
        return { path, content };
      });
    }

    function formatSkillFiles(files) {
      return (files || []).map(file => file.path + "\\n---\\n" + (file.content || "")).join("\\n===\\n");
    }

    function readLocalDateTime(id) {
      const raw = document.getElementById(id)?.value || "";
      if (!raw) return null;
      const date = new Date(raw);
      return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    }

    function toLocalDateTimeValue(value) {
      if (!value) return "";
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return "";
      const pad = n => String(n).padStart(2, "0");
      return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
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

    function autopilotRunSummary(run) {
      if (run.result) {
        try {
          return JSON.stringify(run.result);
        } catch {
          return String(run.result);
        }
      }
      const parts = [];
      if (run.issueId) parts.push("issue " + shortId(run.issueId));
      if (run.taskId) parts.push("task " + shortId(run.taskId));
      if (run.completedAt) parts.push("completed " + timeAgo(run.completedAt));
      return parts.join(" / ") || "No result";
    }

    function usageTotals(rows) {
      return (rows || []).reduce((acc, row) => {
        const input = Number(row.inputTokens || row.input_tokens || 0);
        const output = Number(row.outputTokens || row.output_tokens || 0);
        const cache = Number(row.cacheReadTokens || row.cache_read_tokens || 0) + Number(row.cacheWriteTokens || row.cache_write_tokens || 0);
        acc.input += input;
        acc.output += output;
        acc.cache += cache;
        acc.tokens += input + output + cache;
        acc.tasks += Number(row.taskCount || row.task_count || 0);
        return acc;
      }, { input: 0, output: 0, cache: 0, tokens: 0, tasks: 0 });
    }

    function ownerLabel(ownerId) {
      if (!ownerId) return "unassigned";
      const member = state.members.find(item => item.id === ownerId);
      return member ? member.name : shortId(ownerId);
    }

    function formatCompact(value) {
      const number = Number(value || 0);
      if (!Number.isFinite(number)) return "0";
      if (Math.abs(number) >= 1000000) return (number / 1000000).toFixed(1).replace(/\\.0$/, "") + "m";
      if (Math.abs(number) >= 1000) return (number / 1000).toFixed(1).replace(/\\.0$/, "") + "k";
      return String(Math.floor(number));
    }

    function formatDuration(seconds) {
      const value = Math.max(0, Number(seconds || 0));
      if (value >= 3600) return (value / 3600).toFixed(1).replace(/\\.0$/, "") + "h";
      if (value >= 60) return Math.floor(value / 60) + "m";
      return Math.floor(value) + "s";
    }

    function shortDate(value) {
      if (!value) return "never";
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return String(value);
      return String(date.getMonth() + 1).padStart(2, "0") + "/" + String(date.getDate()).padStart(2, "0");
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
    function issueLabel(issue) {
      return issue?.key || shortId(issue?.id);
    }
    function statusLabel(status) {
      if (status === "dispatched") return "starting";
      if (status === "cancelled") return "cancelled";
      return String(status || "");
    }
    function agentInitial(agent) {
      return (agent?.name || agent?.provider || "A").slice(0, 1).toUpperCase();
    }
    function initials(value) {
      return String(value || "M").split(/\\s+/).filter(Boolean).map(part => part.slice(0, 1)).join("").slice(0, 2).toUpperCase() || "M";
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
    window.openAgent = openAgent;
    window.openSquad = openSquad;
    window.openProject = openProject;
    window.openRuntime = openRuntime;
    window.openSkill = openSkill;
    window.openAutopilot = openAutopilot;
    window.closeDrawer = closeDrawer;
    window.runAutopilot = runAutopilot;
    window.archiveProject = archiveProject;
    window.addProjectResource = addProjectResource;
    window.removeProjectResource = removeProjectResource;
    window.pinItem = pinItem;
    window.unpinItem = unpinItem;
    window.openPinnedItem = openPinnedItem;
    window.archiveSquad = archiveSquad;
    window.addSquadMember = addSquadMember;
    window.removeSquadMember = removeSquadMember;
    window.setAutopilotStatus = setAutopilotStatus;
    window.archiveAutopilot = archiveAutopilot;
    window.archiveAgent = archiveAgent;
    window.archiveSkill = archiveSkill;
    window.createToken = createToken;
    window.revokeToken = revokeToken;
    window.updateSelectedAgent = updateSelectedAgent;
    window.updateSelectedAgentSkills = updateSelectedAgentSkills;
    window.updateSelectedRuntime = updateSelectedRuntime;
    window.updateSelectedSkill = updateSelectedSkill;
    window.updateSelectedAutopilot = updateSelectedAutopilot;
    window.refreshSquadMemberOptions = refreshSquadMemberOptions;
    window.refreshAssigneeOptions = refreshAssigneeOptions;
    window.refreshAutopilotAssigneeOptions = refreshAutopilotAssigneeOptions;
    window.refreshIssueAssigneeOptions = refreshIssueAssigneeOptions;
    window.assignSelectedIssue = assignSelectedIssue;
    window.insertIssueMention = insertIssueMention;
    window.updateSelectedIssue = updateSelectedIssue;
    window.addSelectedIssueComment = addSelectedIssueComment;
    window.reactToSelectedIssue = reactToSelectedIssue;
    window.reactToComment = reactToComment;
    window.editComment = editComment;
    window.deleteComment = deleteComment;
    window.setCommentResolved = setCommentResolved;
    window.addSelectedIssueAttachment = addSelectedIssueAttachment;
    window.attachSelectedIssueLabel = attachSelectedIssueLabel;
    window.createSelectedIssueLabel = createSelectedIssueLabel;
    window.detachSelectedIssueLabel = detachSelectedIssueLabel;
    window.setSelectedIssueMetadata = setSelectedIssueMetadata;
    window.deleteSelectedIssueMetadata = deleteSelectedIssueMetadata;
    window.markInboxRead = markInboxRead;
    window.archiveInbox = archiveInbox;
    window.openInboxIssue = openInboxIssue;
  </script>
</body>
</html>`;
}
