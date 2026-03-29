import { PIPELINE_STEPS, STEP_LABELS } from "./mission-constants";

interface PipelineProgressProps {
  currentStep: string;
}

export function PipelineProgress({ currentStep }: PipelineProgressProps) {
  const currentIndex = PIPELINE_STEPS.indexOf(currentStep as any);

  return (
    <div className="flex items-center gap-0">
      {PIPELINE_STEPS.map((step, i) => {
        const isCompleted = i < currentIndex;
        const isCurrent = i === currentIndex;

        return (
          <div key={step} className="flex items-center">
            <div className="flex flex-col items-center">
              <div className="relative">
                <div
                  className={`h-3 w-3 rounded-full border-2 ${
                    isCompleted
                      ? "border-emerald-500 bg-emerald-500"
                      : isCurrent
                        ? "border-amber-400 bg-amber-400/20"
                        : "border-border bg-transparent"
                  }`}
                />
                {isCurrent && (
                  <div className="absolute inset-0 animate-ping rounded-full bg-amber-400/30" />
                )}
              </div>
              <span
                className={`mt-1.5 text-[9px] font-medium ${
                  isCompleted
                    ? "text-emerald-500"
                    : isCurrent
                      ? "text-amber-400"
                      : "text-muted-foreground"
                }`}
              >
                {STEP_LABELS[step]}
              </span>
            </div>

            {i < PIPELINE_STEPS.length - 1 && (
              <div
                className={`mx-1 h-[2px] w-8 sm:w-12 ${
                  i < currentIndex ? "bg-emerald-500" : "bg-border"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
