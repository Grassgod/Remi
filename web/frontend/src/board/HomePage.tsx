import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ArrowRight, ExternalLink, FileText, Mail } from "lucide-react";
import * as api from "../api/client";
import type { Project, MissionStats } from "../api/types";

/* ── Brand SVG icons ── */
function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function ByteDanceIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12.07 5.3c.68 0 1.23-.55 1.23-1.23V1.23C13.3.55 12.75 0 12.07 0s-1.23.55-1.23 1.23v2.84c0 .68.55 1.23 1.23 1.23zM6.55 7.81c.47-.47.47-1.24 0-1.71L4.54 4.09c-.47-.47-1.24-.47-1.71 0s-.47 1.24 0 1.71L4.84 7.8c.47.48 1.24.48 1.71.01zM17.59 7.81c.47.47 1.24.47 1.71 0l2.01-2.01c.47-.47.47-1.24 0-1.71s-1.24-.47-1.71 0L17.59 6.1c-.47.47-.47 1.24 0 1.71zM12.07 7.15c-4.47 0-8.1 3.63-8.1 8.1 0 4.47 3.63 8.1 8.1 8.1s8.1-3.63 8.1-8.1c0-4.47-3.63-8.1-8.1-8.1zm0 13.35c-2.9 0-5.25-2.35-5.25-5.25s2.35-5.25 5.25-5.25 5.25 2.35 5.25 5.25-2.35 5.25-5.25 5.25zm0-8.57c-1.83 0-3.32 1.49-3.32 3.32s1.49 3.32 3.32 3.32 3.32-1.49 3.32-3.32-1.49-3.32-3.32-3.32z" />
    </svg>
  );
}

type IconComponent = React.FC<{ className?: string }>;

/* ════════════════════════════════════════════
   PLACEHOLDER CONFIG — edit these values
   ════════════════════════════════════════════ */
const PROFILE = {
  name: "贺华杰",
  nameEn: "Jack Ho",
  title: "AI Agent Engineer",
  org: "ByteDance · Shanghai",
  bio: "Building intelligent tools that augment human capability. Interested in AI agents, developer experience, and systems that learn.",
  avatar: "", // URL or leave empty for initials
  links: [
    { icon: "github", label: "GitHub", href: "https://github.com/hehuajie" },
    { icon: "twitter", label: "X", href: "https://x.com/" },
    { icon: "email", label: "Email", href: "mailto:hehuajie@example.com" },
  ],
};
/* ════════════════════════════════════════════ */

const iconMap: Record<string, IconComponent> = {
  github: GitHubIcon,
  twitter: XIcon,
  email: ({ className }) => <Mail className={className} />,
};

const CARD_ACCENTS = [
  { bar: "from-blue-500 to-cyan-400", badge: "bg-blue-50 text-blue-600 ring-blue-200/60" },
  { bar: "from-violet-500 to-purple-400", badge: "bg-violet-50 text-violet-600 ring-violet-200/60" },
  { bar: "from-emerald-500 to-teal-400", badge: "bg-emerald-50 text-emerald-600 ring-emerald-200/60" },
  { bar: "from-amber-500 to-orange-400", badge: "bg-amber-50 text-amber-600 ring-amber-200/60" },
  { bar: "from-rose-500 to-pink-400", badge: "bg-rose-50 text-rose-600 ring-rose-200/60" },
  { bar: "from-indigo-500 to-sky-400", badge: "bg-indigo-50 text-indigo-600 ring-indigo-200/60" },
];

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
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <button
      onClick={onClick}
      className="group relative flex flex-col overflow-hidden rounded-2xl border border-gray-200/80 bg-white p-6 text-left shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-gray-200/50"
      style={{
        animation: `fade-in 0.5s ease-out ${200 + index * 100}ms both`,
      }}
    >
      {/* Top gradient bar */}
      <div
        className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${accent.bar} opacity-80`}
      />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[16px] font-semibold text-gray-900 group-hover:text-gray-700">
            {project.name || project.id}
          </h3>
          {project.repoUrl && (
            <p className="mt-1 truncate font-mono text-[11px] text-gray-400">
              {project.repoUrl.replace(
                /^https?:\/\/(github\.com|code\.byted\.org)\//,
                ""
              )}
            </p>
          )}
        </div>
        <ArrowRight className="mt-1 h-4 w-4 flex-shrink-0 text-gray-300 transition-all duration-200 group-hover:translate-x-1 group-hover:text-gray-500" />
      </div>

      {/* Stats */}
      {total > 0 && (
        <div className="mt-5 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
            <div
              className={`h-full rounded-full bg-gradient-to-r ${accent.bar} transition-all duration-500`}
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className={`flex-shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums ring-1 ${accent.badge}`}>
            {done}/{total}
          </span>
        </div>
      )}
    </button>
  );
}

interface PageEntry {
  slug: string;
  updatedAt: string;
}

export function HomePage() {
  const [, navigate] = useLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [statsMap, setStatsMap] = useState<Record<string, MissionStats>>({});
  const [pages, setPages] = useState<PageEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getProjects()
      .then((list) => {
        const completed = list.filter((p) => p.initStatus === "completed");
        setProjects(completed);
        completed.forEach((p) => {
          api
            .getMissionStats(p.id)
            .then((s) =>
              setStatsMap((prev) => ({ ...prev, [p.id]: s }))
            )
            .catch(() => {});
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    // Fetch pages from ~/tasks/
    fetch("/api/v1/pages")
      .then((r) => r.json())
      .then((list) => setPages(list))
      .catch(() => {});
  }, []);

  return (
    <div className="relative min-h-dvh overflow-y-auto bg-[#fafafa]">
      {/* ── Background ── */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -right-[15%] -top-[20%] h-[600px] w-[600px] rounded-full bg-blue-200/30 blur-[100px]" />
        <div className="absolute -left-[10%] top-[40%] h-[500px] w-[500px] rounded-full bg-violet-200/20 blur-[100px]" />
        <div className="absolute bottom-[-5%] right-[20%] h-[400px] w-[400px] rounded-full bg-cyan-200/20 blur-[100px]" />
      </div>

      {/* ── Content ── */}
      <div className="relative">
        {/* Hero */}
        <section className="flex min-h-[65vh] items-center px-6 sm:px-12 lg:px-20">
          <div
            className="mx-auto w-full max-w-5xl"
            style={{ animation: "fade-in 0.6s ease-out both" }}
          >
            {/* Avatar + org tag */}
            <div className="mb-8 flex items-center gap-3">
              {PROFILE.avatar ? (
                <img
                  src={PROFILE.avatar}
                  alt={PROFILE.name}
                  className="h-14 w-14 rounded-full object-cover ring-2 ring-gray-200 shadow-sm"
                />
              ) : (
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-violet-500 text-sm font-bold text-white shadow-lg shadow-blue-300/30">
                  {PROFILE.nameEn
                    .split(" ")
                    .map((w) => w[0])
                    .join("")}
                </div>
              )}
              <div className="h-7 w-px bg-gray-200" />
              <span className="flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 font-mono text-[11px] tracking-wide text-gray-500">
                <ByteDanceIcon className="h-3.5 w-3.5" />
                {PROFILE.org}
              </span>
            </div>

            {/* Name */}
            <h1 className="text-[clamp(2.5rem,6vw,4.5rem)] font-bold leading-[1.05] tracking-tight text-gray-900">
              {PROFILE.nameEn}
              <span className="ml-4 text-[clamp(1.2rem,3vw,2rem)] font-normal text-gray-300">
                {PROFILE.name}
              </span>
            </h1>

            <p className="mt-3 text-[clamp(1rem,2vw,1.25rem)] font-light text-gray-400">
              {PROFILE.title}
            </p>

            <p className="mt-6 max-w-xl text-[16px] leading-relaxed text-gray-500">
              {PROFILE.bio}
            </p>

            {/* Links */}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              {PROFILE.links.map((link) => {
                const Icon = iconMap[link.icon] ?? GitHubIcon;
                return (
                  <a
                    key={link.label}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 rounded-xl border border-gray-200/80 bg-white px-4 py-2.5 text-[13px] text-gray-500 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-gray-300 hover:text-gray-700 hover:shadow-md"
                  >
                    <Icon className="h-4 w-4" />
                    {link.label}
                  </a>
                );
              })}
            </div>
          </div>
        </section>

        {/* ── Projects ── */}
        <section className="px-6 pb-20 sm:px-12 lg:px-20">
          <div className="mx-auto max-w-5xl">
            <div
              className="mb-8 flex items-center gap-4"
              style={{ animation: "fade-in 0.5s ease-out 150ms both" }}
            >
              <div className="h-px flex-1 bg-gradient-to-r from-gray-200 to-transparent" />
              <h2 className="flex-shrink-0 font-mono text-[12px] tracking-widest text-gray-400 uppercase">
                Projects
                <span className="ml-2 text-gray-300">
                  ({projects.length})
                </span>
              </h2>
              <div className="h-px flex-1 bg-gradient-to-l from-gray-200 to-transparent" />
            </div>

            {loading ? (
              <div className="py-16 text-center text-sm text-gray-300 animate-pulse">
                Loading...
              </div>
            ) : projects.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-gray-200 p-12 text-center text-sm text-gray-400">
                No projects yet.
              </div>
            ) : (
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {projects.map((project, i) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    index={i}
                    stats={statsMap[project.id]}
                    onClick={() => navigate(`/mission/${project.id}`)}
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ── Pages ── */}
        {pages.length > 0 && (
          <section className="px-6 pb-20 sm:px-12 lg:px-20">
            <div className="mx-auto max-w-5xl">
              <div
                className="mb-8 flex items-center gap-4"
                style={{ animation: "fade-in 0.5s ease-out 250ms both" }}
              >
                <div className="h-px flex-1 bg-gradient-to-r from-gray-200 to-transparent" />
                <h2 className="flex-shrink-0 font-mono text-[12px] tracking-widest text-gray-400 uppercase">
                  Pages
                  <span className="ml-2 text-gray-300">
                    ({pages.length})
                  </span>
                </h2>
                <div className="h-px flex-1 bg-gradient-to-l from-gray-200 to-transparent" />
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {pages.map((page, i) => (
                  <a
                    key={page.slug}
                    href={`/p/${page.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-center gap-3 rounded-xl border border-gray-200/80 bg-white p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
                    style={{
                      animation: `fade-in 0.5s ease-out ${300 + i * 80}ms both`,
                    }}
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

        {/* Footer */}
        <footer className="px-6 pb-8 sm:px-12 lg:px-20">
          <div
            className="mx-auto max-w-5xl"
            style={{ animation: "fade-in 0.5s ease-out 400ms both" }}
          >
            <div className="flex items-center justify-between border-t border-gray-100 pt-6">
              <p className="font-mono text-[11px] text-gray-300">
                Powered by Remi
              </p>
              <p className="font-mono text-[11px] text-gray-200">
                {new Date().getFullYear()}
              </p>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
