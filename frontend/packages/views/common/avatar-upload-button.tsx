"use client";

import {
  useRef,
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Camera, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multiremi/core/api";
import { useFileUpload } from "@multiremi/core/hooks/use-file-upload";
import { cn } from "@multiremi/ui/lib/utils";

/**
 * The "click the avatar to replace it" affordance: the rendered avatar wrapped
 * in a button, a hover Camera/Loader overlay, and the hidden file input that
 * drives it. Five surfaces (create-agent picker, agent inspector, squad
 * inspector, account settings, workspace settings) each had their own copy of
 * this markup plus the same `useFileUpload` → toast dance; this is the one
 * implementation.
 *
 * The avatar itself stays the caller's business — pass it as `children`
 * (or as a function of the busy flag, when the placeholder doubles as the
 * progress indicator). Everything the surfaces genuinely differ on is a prop:
 * the button's size/shape (`className`), the accepted MIME types, the aria
 * label and the toast copy.
 */
export function AvatarUploadButton({
  children,
  onUploaded,
  errorMessage,
  successMessage,
  invalidTypeMessage,
  ariaLabel,
  accept = "image/*",
  className,
  style,
  busy = false,
  disabled = false,
  showOverlay = true,
  overlayIconClassName = "h-4 w-4",
  renderAfter,
}: {
  /** The rendered avatar. Given the busy flag when passed as a function. */
  children: ReactNode | ((busy: boolean) => ReactNode);
  /** Persist the uploaded file's URL. Awaited before the success toast. */
  onUploaded: (url: string) => void | Promise<unknown>;
  /** Fallback toast text when the thrown value is not an Error. */
  errorMessage: string;
  /** Omit for surfaces that show the new avatar instead of announcing it. */
  successMessage?: string;
  /** When set, non-image files are rejected client-side with this message. */
  invalidTypeMessage?: string;
  ariaLabel?: string;
  accept?: string;
  /** Size / shape / background — the only visual difference between sites. */
  className?: string;
  style?: CSSProperties;
  /** An outer pending signal (e.g. the mutation that saves the URL). */
  busy?: boolean;
  /** Locks the button for viewers without permission to change the avatar. */
  disabled?: boolean;
  /** Off where the caller already renders its own affordance underneath. */
  showOverlay?: boolean;
  overlayIconClassName?: string;
  /**
   * Rendered as a sibling of the button — for controls that must sit outside
   * its `overflow-hidden` box (the create-agent picker's corner "clear"
   * button). Given the busy flag so they can hide mid-upload.
   */
  renderAfter?: (busy: boolean) => ReactNode;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { upload, uploading } = useFileUpload(api);
  const isBusy = uploading || busy;

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // allow re-selecting the same file
    if (invalidTypeMessage && !file.type.startsWith("image/")) {
      toast.error(invalidTypeMessage);
      return;
    }
    try {
      const result = await upload(file);
      if (!result) return;
      await onUploaded(result.link);
      if (successMessage) toast.success(successMessage);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : errorMessage);
    }
  };

  return (
    <>
      <button
        type="button"
        className={cn(
          "group relative shrink-0 overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className
        )}
        style={style}
        onClick={() => fileInputRef.current?.click()}
        disabled={isBusy || disabled}
        aria-label={ariaLabel}
      >
        {typeof children === "function" ? children(isBusy) : children}
        {showOverlay && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
            {isBusy ? (
              <Loader2
                className={cn(overlayIconClassName, "animate-spin text-white")}
              />
            ) : (
              <Camera className={cn(overlayIconClassName, "text-white")} />
            )}
          </div>
        )}
      </button>
      {renderAfter?.(isBusy)}
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={handleFile}
      />
    </>
  );
}
