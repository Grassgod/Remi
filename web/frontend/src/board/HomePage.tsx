import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  ArrowRight,
  ArrowUpRight,
  ExternalLink,
  FileText,
  FolderGit2,
  CheckCircle2,
  Activity,
  Search,
  Sparkles,
  LayoutDashboard,
} from "lucide-react";
import * as api from "../api/client";
import { AuthIndicator } from "../components/AuthIndicator";
import type { HostInfo, CurrentUser } from "../api/client";
import type { Project, MissionStats } from "../api/types";

/* ════════════════════════════════════════════
   PRESENTATION CONFIG — quick visual knobs
   ════════════════════════════════════════════ */
const TAGLINE = "A Remi AI workspace";
const SUBLINE =
  "Cross-tool MCP, Skills and prompts. Boards and missions for every project. Always one keystroke from the agent.";
const CARD_ACCENTS = [
  { bar: "from-blue-500 to-cyan-400", badge: "bg-blue-50 text-blue-600 ring-blue-200/60" },
  { bar: "from-violet-500 to-purple-400", badge: "bg-violet-50 text-violet-600 ring-violet-200/60" },
  { bar: "from-emerald-500 to-teal-400", badge: "bg-emerald-50 text-emerald-600 ring-emerald-200/60" },
  { bar: "from-amber-500 to-orange-400", badge: "bg-amber-50 text-amber-600 ring-amber-200/60" },
  { bar: "from-rose-500 to-pink-400", badge: "bg-rose-50 text-rose-600 ring-rose-200/60" },
  { bar: "from-indigo-500 to-sky-400", badge: "bg-indigo-50 text-indigo-600 ring-indigo-200/60" },
];

/* ── Helpers ─────────────────────────────── */

function greetingForHour(h: number): string {
  if (h < 5) return "Late night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function prettyHost(h: string | undefined): string {
  if (!h) return "Remi";
  // Strip trailing public-domain suffixes to make the hero feel personal, not an ops URL.
  return h.replace(/\.byted\.org$|\.bytedance\.(?:net|com)$/, "");
}

/** Tiny count-up animation for the stats tiles. */
function useCountUp(target: number, durationMs = 600): number {
  const [value, setValue] = useState(0);
  const start = useRef<number | null>(null);
  useEffect(() => {
    let raf = 0;
    start.current = null;
    const step = (t: number) => {
      if (start.current === null) start.current = t;
      const p = Math.min(1, (t - start.current) / durationMs);
      setValue(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}

/* ── Stat tile ──────────────────────────── */

function StatTile({
  label,
  value,
  icon: Icon,
  accent,
  delayMs = 0,
}: {
  label: string;
  value: number;
  icon: React.FC<{ className?: string }>;
  accent: { bar: string; text: string; ring: string };
  delayMs?: number;
}) {
  const animated = useCountUp(value);
  return (
    <div
      className="group relative overflow-hidden rounded-2xl border border-gray-200/80 bg-white/90 p-4 shadow-sm backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
      style={{ animation: `fade-in 0.5s ease-out ${delayMs}ms both` }}
    >
      <div className={`absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r ${accent.bar} opacity-70`} />
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-gray-400">{label}</span>
        <div className={`flex h-7 w-7 items-center justify-center rounded-lg ring-1 ${accent.ring}`}>
          <Icon className={`h-3.5 w-3.5 ${accent.text}`} />
        </div>
      </div>
      <div className="mt-2 text-[28px] font-semibold leading-none tabular-nums text-gray-900">
        {animated}
      </div>
    </div>
  );
}

/* ── Project card ───────────────────────── */

function ProjectCard({
  project,
  index,
  stats,
  onClick,
}: {
  project: Project;
  index: number;
  stats?: MissionStats;
  onClick: () => void;
}) {
  const accent = CARD_ACCENTS[index % CARD_ACCENTS.length];
  const total = stats?.total ?? 0;
  const done = stats?.byStatus?.done ?? 0;
  const inProgress = (stats?.byStatus?.in_progress ?? 0) + (stats?.byStatus?.open ?? 0);
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <button
      onClick={onClick}
      className="group relative flex flex-col overflow-hidden rounded-2xl border border-gray-200/80 bg-white p-5 text-left shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-gray-200/50"
      style={{ animation: `fade-in 0.4s ease-out ${index * 60}ms both` }}
    >
      <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${accent.bar} opacity-80`} />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold text-gray-900 group-hover:text-gray-700">
            {project.name || project.id}
          </h3>
          {project.repoUrl && (
            <p className="mt-1 truncate font-mono text-[11px] text-gray-400">
              {project.repoUrl.replace(/^https?:\/\/(github\.com|code\.byted\.org)\//, "")}
            </p>
          )}
        </div>
        <ArrowRight className="mt-1 h-4 w-4 flex-shrink-0 text-gray-300 transition-all duration-200 group-hover:translate-x-1 group-hover:text-gray-500" />
      </div>

      <div className="mt-4 flex items-center gap-3 text-[11px] text-gray-500">
        {total > 0 ? (
          <>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
              <div
                className={`h-full rounded-full bg-gradient-to-r ${accent.bar} transition-all duration-500`}
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className={`flex-shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums ring-1 ${accent.badge}`}>
              {done}/{total}
            </span>
          </>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-wider text-gray-300">
            no missions yet
          </span>
        )}
      </div>

      {inProgress > 0 && (
        <div className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-gray-400">
          <Activity className="h-3 w-3 animate-pulse text-emerald-500" />
          {inProgress} active
        </div>
      )}
    </button>
  );
}

/* ── Skeleton loaders ────────────────────── */

function SkeletonCard() {
  return (
    <div className="h-32 animate-pulse rounded-2xl border border-gray-200/60 bg-white/60" />
  );
}

/* ── Page entry type ─────────────────────── */

interface PageEntry {
  slug: string;
  updatedAt: string;
}

/* ════════════════════════════════════════════
   HomePage
   ════════════════════════════════════════════ */

type SortKey = "recent" | "name" | "progress";

export function HomePage() {
  const [, navigate] = useLocation();
  const [host, setHost] = useState<HostInfo | null>(null);
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [statsMap, setStatsMap] = useState<Record<string, MissionStats>>({});
  const [pages, setPages] = useState<PageEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // UI state
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("recent");

  /* ── Fetch ─────────────────────────────── */
  useEffect(() => {
    api.getHostInfo().then(setHost).catch(() => {});
    api.getCurrentUser().then((r) => setMe(r.user)).catch(() => {});

    api
      .getProjects()
      .then((list) => {
        const completed = list.filter((p) => p.initStatus === "completed");
        setProjects(completed);
        completed.forEach((p) => {
          api
            .getMissionStats(p.id)
            .then((s) => setStatsMap((prev) => ({ ...prev, [p.id]: s })))
            .catch(() => {});
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    fetch("/api/v1/pages")
      .then((r) => r.json())
      .then((list) => setPages(list))
      .catch(() => {});
  }, []);

  /* ── Aggregates for the stats strip ────── */
  const totals = useMemo(() => {
    let totalMissions = 0;
    let inProgress = 0;
    let done = 0;
    for (const s of Object.values(statsMap)) {
      totalMissions += s.total;
      inProgress += (s.byStatus?.in_progress ?? 0) + (s.byStatus?.open ?? 0);
      done += s.byStatus?.done ?? 0;
    }
    return {
      projects: projects.length,
      inProgress,
      done,
      pages: pages.length,
      totalMissions,
    };
  }, [projects.length, statsMap, pages.length]);

  /* ── Project filter + sort ─────────────── */
  const visibleProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = projects;
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q) ||
          (p.repoUrl ?? "").toLowerCase().includes(q),
      );
    }
    list = [...list];
    if (sortKey === "name") {
      list.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    } else if (sortKey === "progress") {
      list.sort((a, b) => {
        const pa = pct(statsMap[a.id]);
        const pb = pct(statsMap[b.id]);
        return pb - pa;
      });
    } else {
      list.sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
    }
    return list;
  }, [projects, statsMap, query, sortKey]);

  const greeting = greetingForHour(new Date().getHours());
  const hostName = prettyHost(host?.hostname);

  /* ── Render ────────────────────────────── */
  return (
    <div className="relative h-dvh overflow-y-auto bg-[#fafafa] text-gray-900">
      {/* Background orbs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -right-[15%] -top-[20%] h-[600px] w-[600px] rounded-full bg-blue-200/30 blur-[100px]" />
        <div className="absolute -left-[10%] top-[40%] h-[500px] w-[500px] rounded-full bg-violet-200/20 blur-[100px]" />
        <div className="absolute bottom-[-5%] right-[20%] h-[400px] w-[400px] rounded-full bg-cyan-200/20 blur-[100px]" />
      </div>

      {/* Top-right auth widget */}
      <div className="absolute right-4 top-4 z-20 sm:right-6">
        <AuthIndicator />
      </div>

      {/* Content */}
      <div className="relative">
        {/* ── Hero ─────────────────────────── */}
        <section className="flex min-h-[58vh] items-center px-6 pt-16 sm:px-12 lg:px-20">
          <div
            className="mx-auto w-full max-w-5xl"
            style={{ animation: "fade-in 0.55s ease-out both" }}
          >
            <div className="mb-6 flex items-center gap-2 text-[12px] text-gray-400">
              <Sparkles className="h-3.5 w-3.5 text-amber-400" />
              <span>
                {greeting}
                {me?.name ? `, ${me.name}` : ""} — welcome to your workspace.
              </span>
            </div>

            <h1 className="text-[clamp(2.5rem,6.5vw,4.75rem)] font-bold leading-[1.02] tracking-tight text-gray-900">
              {hostName}
              <span className="ml-3 align-middle text-[clamp(1.1rem,2.4vw,1.6rem)] font-normal text-gray-300">
                · {TAGLINE}
              </span>
            </h1>

            <p className="mt-6 max-w-2xl text-[17px] leading-relaxed text-gray-500">
              {SUBLINE}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href="/home/"
                className="group inline-flex items-center gap-2 rounded-xl bg-gray-900 px-5 py-2.5 text-[13px] font-medium text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-gray-800 hover:shadow-md"
              >
                <LayoutDashboard className="h-4 w-4" />
                Open Dashboard
                <ArrowUpRight className="h-3.5 w-3.5 opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </a>
              <button
                onClick={() => {
                  document.getElementById("projects")?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className="inline-flex items-center gap-2 rounded-xl border border-gray-200/80 bg-white px-5 py-2.5 text-[13px] text-gray-700 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-md"
              >
                <FolderGit2 className="h-4 w-4 text-gray-500" />
                Browse Projects
              </button>
            </div>

            {/* Host meta */}
            {host && (
              <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-gray-300">
                <span>{host.currentBaseUrl}</span>
                {host.ips?.[0] && (
                  <span>
                    {host.ips[0].address}
                    <span className="ml-1 text-gray-200/80">({host.ips[0].interface})</span>
                  </span>
                )}
              </div>
            )}
          </div>
        </section>

        {/* ── Stats strip ──────────────────── */}
        <section className="px-6 pb-12 sm:px-12 lg:px-20">
          <div className="mx-auto grid max-w-5xl grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile
              label="Projects"
              value={totals.projects}
              icon={FolderGit2}
              accent={{ bar: "from-blue-500 to-cyan-400", text: "text-blue-600", ring: "ring-blue-200/60" }}
              delayMs={100}
            />
            <StatTile
              label="In Progress"
              value={totals.inProgress}
              icon={Activity}
              accent={{ bar: "from-emerald-500 to-teal-400", text: "text-emerald-600", ring: "ring-emerald-200/60" }}
              delayMs={160}
            />
            <StatTile
              label="Done"
              value={totals.done}
              icon={CheckCircle2}
              accent={{ bar: "from-violet-500 to-purple-400", text: "text-violet-600", ring: "ring-violet-200/60" }}
              delayMs={220}
            />
            <StatTile
              label="Pages"
              value={totals.pages}
              icon={FileText}
              accent={{ bar: "from-amber-500 to-orange-400", text: "text-amber-600", ring: "ring-amber-200/60" }}
              delayMs={280}
            />
          </div>
        </section>

        {/* ── Projects ─────────────────────── */}
        <section id="projects" className="px-6 pb-16 sm:px-12 lg:px-20">
          <div className="mx-auto max-w-5xl">
            <div
              className="mb-6 flex flex-wrap items-end justify-between gap-3"
              style={{ animation: "fade-in 0.5s ease-out 150ms both" }}
            >
              <div>
                <h2 className="font-mono text-[12px] uppercase tracking-widest text-gray-500">
                  Projects
                  <span className="ml-2 text-gray-300">({projects.length})</span>
                </h2>
                <p className="mt-1 text-[12px] text-gray-400">
                  Pick a project to open its mission board.
                </p>
              </div>

              {projects.length > 0 && (
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search projects..."
                      className="h-8 w-56 rounded-lg border border-gray-200 bg-white/80 pl-8 pr-2.5 text-[12px] text-gray-700 outline-none placeholder:text-gray-400 focus:border-gray-300 focus:ring-2 focus:ring-gray-100"
                    />
                  </div>
                  <select
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as SortKey)}
                    className="h-8 rounded-lg border border-gray-200 bg-white/80 px-2 text-[12px] text-gray-700 outline-none focus:border-gray-300 focus:ring-2 focus:ring-gray-100"
                  >
                    <option value="recent">Recent</option>
                    <option value="name">Name</option>
                    <option value="progress">Progress</option>
                  </select>
                </div>
              )}
            </div>

            {loading ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <SkeletonCard />
                <SkeletonCard />
                <SkeletonCard />
              </div>
            ) : visibleProjects.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-gray-200/80 bg-white/40 p-12 text-center">
                <FolderGit2 className="h-6 w-6 text-gray-300" />
                <p className="text-sm text-gray-500">
                  {query ? "No projects match this filter." : "No projects yet."}
                </p>
                {!query && (
                  <a
                    href="/home/#/projects"
                    className="inline-flex items-center gap-1.5 text-[12px] font-medium text-gray-700 hover:text-gray-900"
                  >
                    Create one in Dashboard <ArrowRight className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {visibleProjects.map((project, i) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    index={i}
                    stats={statsMap[project.id]}
                    onClick={() => navigate(`/board/${project.id}`)}
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ── Pages ─────────────────────────── */}
        {pages.length > 0 && (
          <section className="px-6 pb-16 sm:px-12 lg:px-20">
            <div className="mx-auto max-w-5xl">
              <div
                className="mb-6"
                style={{ animation: "fade-in 0.5s ease-out 250ms both" }}
              >
                <h2 className="font-mono text-[12px] uppercase tracking-widest text-gray-500">
                  Pages
                  <span className="ml-2 text-gray-300">({pages.length})</span>
                </h2>
                <p className="mt-1 text-[12px] text-gray-400">
                  Static artefacts produced under ~/tasks/.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {pages.map((page, i) => (
                  <a
                    key={page.slug}
                    href={`/p/${page.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-center gap-3 rounded-xl border border-gray-200/80 bg-white p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
                    style={{ animation: `fade-in 0.4s ease-out ${300 + i * 60}ms both` }}
                  >
                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-gray-50">
                      <FileText className="h-4 w-4 text-gray-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-gray-700 group-hover:text-gray-900">
                        {page.slug.replace(/[-_]/g, " ")}
                      </p>
                      <p className="font-mono text-[10px] text-gray-300">
                        {new Date(page.updatedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <ExternalLink className="h-3.5 w-3.5 flex-shrink-0 text-gray-300 transition-colors group-hover:text-gray-500" />
                  </a>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* ── Footer ────────────────────────── */}
        <footer className="px-6 pb-10 sm:px-12 lg:px-20">
          <div
            className="mx-auto max-w-5xl"
            style={{ animation: "fade-in 0.5s ease-out 400ms both" }}
          >
            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-gray-100 pt-6 text-[11px] text-gray-400">
              <div className="flex items-center gap-4">
                <a href="/home/" className="font-mono hover:text-gray-700">
                  Dashboard
                </a>
                <span className="text-gray-200">·</span>
                <a href="/board" className="font-mono hover:text-gray-700">
                  All boards
                </a>
                <span className="text-gray-200">·</span>
                <span className="font-mono text-gray-300">
                  {totals.totalMissions} missions tracked
                </span>
              </div>
              <p className="font-mono text-gray-300">Powered by Remi · {new Date().getFullYear()}</p>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

/* ── Local utils ─────────────────────────── */

function pct(s: MissionStats | undefined): number {
  if (!s || s.total === 0) return 0;
  return ((s.byStatus?.done ?? 0) / s.total) * 100;
}
