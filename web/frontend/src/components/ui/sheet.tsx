import * as React from "react";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

function Sheet({ open, onOpenChange, children }: SheetProps) {
  React.useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
        style={{ animation: "fade-in 0.15s ease-out" }}
      />
      {children}
    </>
  );
}

interface SheetContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: "left" | "right" | "top" | "bottom";
  onClose?: () => void;
}

const SheetContent = React.forwardRef<HTMLDivElement, SheetContentProps>(
  ({ className, side = "right", onClose, children, ...props }, ref) => {
    const sideClasses = {
      right: "inset-y-0 right-0 h-full w-3/4 max-w-sm border-l",
      left: "inset-y-0 left-0 h-full w-3/4 max-w-sm border-r",
      top: "inset-x-0 top-0 w-full border-b",
      bottom: "inset-x-0 bottom-0 w-full border-t",
    };

    return (
      <div
        ref={ref}
        className={cn(
          "fixed z-50 bg-card shadow-lg",
          sideClasses[side],
          className
        )}
        style={{ animation: side === "right" ? "slide-in-right 0.2s ease-out" : side === "bottom" ? "sheet-up 0.2s ease-out" : "fade-in 0.2s ease-out" }}
        {...props}
      >
        {onClose && (
          <button
            className="absolute right-4 top-4 rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {children}
      </div>
    );
  }
);
SheetContent.displayName = "SheetContent";

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-2 p-6 pb-0", className)} {...props} />
);

const SheetTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-lg font-semibold text-foreground", className)} {...props} />
  )
);
SheetTitle.displayName = "SheetTitle";

const SheetDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  )
);
SheetDescription.displayName = "SheetDescription";

export { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription };
