import * as React from "react";
import { cn } from "@/lib/utils";

interface CollapsibleProps extends React.HTMLAttributes<HTMLDivElement> {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
}

interface CollapsibleContextValue {
  open: boolean;
  toggle: () => void;
}

const CollapsibleContext = React.createContext<CollapsibleContextValue>({
  open: false,
  toggle: () => {},
});

function Collapsible({ open: controlledOpen, onOpenChange, defaultOpen = false, className, children, ...props }: CollapsibleProps) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const toggle = React.useCallback(() => {
    if (isControlled) {
      onOpenChange?.(!open);
    } else {
      setInternalOpen(prev => !prev);
    }
  }, [isControlled, open, onOpenChange]);

  return (
    <CollapsibleContext.Provider value={{ open, toggle }}>
      <div className={cn("", className)} {...props}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
}

const CollapsibleTrigger = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className, onClick, ...props }, ref) => {
    const { toggle } = React.useContext(CollapsibleContext);
    return (
      <button
        ref={ref}
        className={cn("", className)}
        onClick={(e) => { toggle(); onClick?.(e); }}
        {...props}
      />
    );
  }
);
CollapsibleTrigger.displayName = "CollapsibleTrigger";

function CollapsibleContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { open } = React.useContext(CollapsibleContext);
  if (!open) return null;
  return (
    <div
      className={cn("", className)}
      style={{ animation: "fade-in 0.2s ease-out" }}
      {...props}
    >
      {children}
    </div>
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
