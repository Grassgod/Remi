import { Check, X, Loader2, Circle } from "lucide-react";
import type { InitStep } from "../../api/types";
import { cn } from "@/lib/utils";

interface InitStepperProps {
  steps: InitStep[];
}

export function InitStepper({ steps }: InitStepperProps) {
  return (
    <div className="space-y-0">
      {steps.map((step, i) => (
        <div key={step.name} className="flex gap-3">
          {/* Vertical line + icon column */}
          <div className="flex flex-col items-center">
            <StepIcon status={step.status} />
            {i < steps.length - 1 && (
              <div
                className={cn(
                  "w-[2px] flex-1 min-h-[24px]",
                  step.status === "done" ? "bg-emerald-500" : "bg-border",
                )}
              />
            )}
          </div>

          {/* Content */}
          <div className="pb-5 pt-0.5 min-w-0 flex-1">
            <div
              className={cn(
                "text-xs font-medium",
                step.status === "done" && "text-emerald-500",
                step.status === "running" && "text-amber-400",
                step.status === "error" && "text-red-400",
                step.status === "pending" && "text-muted-foreground",
              )}
            >
              {step.label}
            </div>
            {step.result && step.status === "done" && (
              <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                {step.result}
              </div>
            )}
            {step.error && step.status === "error" && (
              <div className="mt-0.5 text-[10px] text-red-400 break-all">
                {step.error}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function StepIcon({ status }: { status: InitStep["status"] }) {
  const base = "h-5 w-5 rounded-full flex items-center justify-center shrink-0";

  switch (status) {
    case "done":
      return (
        <div className={cn(base, "bg-emerald-500/20")}>
          <Check className="h-3 w-3 text-emerald-500" />
        </div>
      );
    case "running":
      return (
        <div className={cn(base, "bg-amber-400/20")}>
          <Loader2 className="h-3 w-3 text-amber-400 animate-spin" />
        </div>
      );
    case "error":
      return (
        <div className={cn(base, "bg-red-400/20")}>
          <X className="h-3 w-3 text-red-400" />
        </div>
      );
    default:
      return (
        <div className={cn(base, "bg-transparent")}>
          <Circle className="h-3 w-3 text-muted-foreground/40" />
        </div>
      );
  }
}
