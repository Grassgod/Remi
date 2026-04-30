import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { EvalLayout } from "./EvalLayout";

interface EvalCase {
  id: string;
  status: string;
}

interface RunSummary {
  date: string;
  runId: string;
  caseCount: number;
}

interface Job {
  id: string;
  status: string;
  updatedAt: string;
}

const stripAnsi = (s: string) =>
  s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\[[\d;]*m/g, "");

function LogTerminal({
  lines,
  status,
}: {
  lines: string[];
  status: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines.length]);

  const isRunning = status === "running";

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-900 shadow-lg">
      <div className="flex items-center justify-between border-b border-gray-700 px-4 py-2">
        <div className="flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              isRunning
                ? "animate-pulse bg-amber-400"
                : status === "done"
                  ? "bg-emerald-400"
                  : status === "unknown"
                    ? "bg-gray-500"
                    : "bg-red-400"
            }`}
          />
          <span className="font-mono text-[11px] text-gray-400">{status}</span>
        </div>
        <span className="font-mono text-[10px] text-gray-500">
          {lines.length} lines
        </span>
      </div>

      <div className="max-h-[400px] overflow-y-auto p-4">
        {lines.length === 0 && isRunning && (
          <p className="animate-pulse font-mono text-xs text-gray-500">
            Waiting for output...
          </p>
        )}
        {lines.map((line, i) => (
          <div key={i} className="font-mono text-[11px] leading-5 text-gray-300">
            <span className="mr-3 select-none text-gray-600">
              {String(i + 1).padStart(3)}
            </span>
            {stripAnsi(line)}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

export function EvalRun() {
  const [, navigate] = useLocation();
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedType, setSelectedType] = useState("both");
  const [selectedCases, setSelectedCases] = useState<Set<string>>(new Set());

  // Job polling state
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [jobStatus, setJobStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const offsetRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/v1/eval/cases").then((r) => r.json()),
      fetch("/api/v1/eval/runs").then((r) => r.json()),
      fetch("/api/v1/eval/jobs").then((r) => r.json()),
    ])
      .then(([c, r, j]) => {
        const caseList = c.cases || c || [];
        const runList = r.runs || r || [];
        setCases(caseList);
        setRuns(runList);
        setSelectedCases(new Set(caseList.map((x: EvalCase) => x.id)));

        // Resume polling if there's a running job
        const jobList = j.jobs || [];
        const runningJob = jobList.find((job: Job) => job.status === "running");
        if (runningJob) {
          startPolling(runningJob.id);
        }
      })
      .catch(console.error);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startPolling = (jobId: string) => {
    if (timerRef.current) clearInterval(timerRef.current);
    offsetRef.current = 0;
    setLogLines([]);
    setJobStatus("running");
    setActiveJobId(jobId);
    setBusy(true);

    const poll = () => {
      fetch(`/api/v1/eval/job/${jobId}?offset=${offsetRef.current}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.log) {
            const newLines = data.log.split("\n").filter((l: string) => l);
            if (newLines.length > 0) {
              setLogLines((prev) => [...prev, ...newLines]);
            }
          }
          offsetRef.current = data.offset;
          setJobStatus(data.status);

          if (data.status !== "running") {
            if (timerRef.current) clearInterval(timerRef.current);
            timerRef.current = null;
            setBusy(false);
            // Refresh runs
            fetch("/api/v1/eval/runs")
              .then((r) => r.json())
              .then((r) => setRuns(r.runs || r || []))
              .catch(() => {});
          }
        })
        .catch(() => {});
    };

    // Poll immediately, then every second
    poll();
    timerRef.current = setInterval(poll, 1000);
  };

  const execCommand = async (command: string) => {
    try {
      const res = await fetch("/api/v1/eval/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command,
          cases: Array.from(selectedCases),
        }),
      });
      const data = await res.json();
      if (data.jobId) {
        startPolling(data.jobId);
      }
    } catch {
      setJobStatus("failed to start");
    }
  };

  const toggleCase = (id: string) => {
    setSelectedCases((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <EvalLayout>
      <div className="mx-auto max-w-5xl space-y-6">
        {/* Trigger Section */}
        <div className="rounded-xl border border-gray-200/80 bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold text-gray-700">
            Evaluation Pipeline
          </h3>

          {/* Type selector */}
          <div className="mb-4 flex items-center gap-2">
            <span className="text-xs text-gray-500">Type:</span>
            {["clarify", "rfc", "both"].map((t) => (
              <button
                key={t}
                onClick={() => setSelectedType(t)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  selectedType === t
                    ? "bg-gray-800 text-white"
                    : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Case checkboxes */}
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500">Cases:</span>
            {cases.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs transition-colors hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  checked={selectedCases.has(c.id)}
                  onChange={() => toggleCase(c.id)}
                  className="h-3 w-3 rounded"
                />
                <span className="font-mono">{c.id}</span>
              </label>
            ))}
          </div>

          {/* Pipeline steps — correct order */}
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-gray-400 mr-1">Steps:</span>

            <button
              onClick={() => execCommand("clone-repos")}
              disabled={busy}
              className="rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              1. Clone Repos
            </button>
            <span className="text-gray-300">&rarr;</span>

            <button
              onClick={() => execCommand("fetch-mr")}
              disabled={busy}
              className="rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              2. Fetch MR
            </button>
            <span className="text-gray-300">&rarr;</span>

            <button
              onClick={() => execCommand("check")}
              disabled={busy}
              className="rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              3. Check Data
            </button>
            <span className="text-gray-300">&rarr;</span>

            <button
              onClick={() => execCommand("run")}
              disabled={busy || selectedCases.size === 0}
              className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              4. Run Eval
            </button>
          </div>
        </div>

        {/* Log Terminal */}
        {(logLines.length > 0 || busy) && (
          <LogTerminal lines={logLines} status={jobStatus} />
        )}

        {/* Run History */}
        <div className="rounded-xl border border-gray-200/80 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-5 py-3">
            <h3 className="text-sm font-semibold text-gray-700">Run History</h3>
          </div>
          {runs.length === 0 ? (
            <div className="p-8 text-center text-xs text-gray-400">
              No runs yet. Baseline data is available in the Dashboard.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/50">
                  <th className="px-5 py-2.5 text-left font-medium text-gray-500">Date</th>
                  <th className="px-4 py-2.5 text-left font-medium text-gray-500">Run ID</th>
                  <th className="px-4 py-2.5 text-center font-medium text-gray-500">Cases</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    key={`${run.date}-${run.runId}`}
                    onClick={() => navigate(`/eval/run/${run.date}--${run.runId}`)}
                    className="cursor-pointer border-b border-gray-50 transition-colors hover:bg-blue-50/30 last:border-0"
                  >
                    <td className="px-5 py-2.5 font-mono text-gray-700">{run.date}</td>
                    <td className="px-4 py-2.5 font-mono text-gray-500">
                      {run.runId.length > 12 ? run.runId.slice(0, 12) + "..." : run.runId}
                    </td>
                    <td className="px-4 py-2.5 text-center tabular-nums text-gray-600">{run.caseCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </EvalLayout>
  );
}
