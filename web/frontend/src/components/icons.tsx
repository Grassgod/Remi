// SVG icon components — extracted from prototype
const s = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5 } as const;

export const IconDashboard = () => (
  <svg {...s}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
);

export const IconMemory = () => (
  <svg {...s}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>
);

export const IconSessions = () => (
  <svg {...s}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
);

export const IconAuth = () => (
  <svg {...s}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
);

export const IconScheduler = () => (
  <svg {...s}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
);

export const IconBotMenu = () => (
  <svg {...s}><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="8" cy="6" r="1.5" fill="currentColor"/><circle cx="14" cy="12" r="1.5" fill="currentColor"/><circle cx="10" cy="18" r="1.5" fill="currentColor"/></svg>
);

export const IconTools = () => (
  <svg {...s}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
);

export const IconConfig = () => (
  <svg {...s}><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
);

export const IconMonitor = () => (
  <svg {...s}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
);

export const IconProjects = () => (
  <svg {...s}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
);

export const IconAnalytics = () => (
  <svg {...s}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/><line x1="2" y1="20" x2="22" y2="20" strokeDasharray="2 2" opacity="0.4"/></svg>
);

export const IconTraces = () => (
  <svg {...s}><path d="M3 12h4l3-9 4 18 3-9h4"/></svg>
);

export const IconLogs = () => (
  <svg {...s}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>
);

export const IconDatabase = () => (
  <svg {...s}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
);

export const IconActivity = () => (
  <svg {...s} width={13} height={13}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
);

export const IconTrash = () => (
  <svg {...s}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
);

// Larger versions for bottom nav
const m = { ...s, width: 20, height: 20 } as const;

export const IconDashboardLg = () => (
  <svg {...m}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
);

export const IconMemoryLg = () => (
  <svg {...m}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg>
);

export const IconSessionsLg = () => (
  <svg {...m}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
);

export const IconConfigLg = () => (
  <svg {...m}><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2"/></svg>
);

export const IconMonitorLg = () => (
  <svg {...m}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
);

export const IconMoreLg = () => (
  <svg {...m}><circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/></svg>
);

export const IconAnalyticsLg = () => (
  <svg {...m}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/><line x1="2" y1="20" x2="22" y2="20" strokeDasharray="2 2" opacity="0.4"/></svg>
);
