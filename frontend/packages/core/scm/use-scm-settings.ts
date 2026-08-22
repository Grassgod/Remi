import { useMemo } from "react";
import { useCurrentWorkspace } from "../paths";
import { deriveScmSettings, type ScmSettings } from "./settings";

export function useScmSettings(): ScmSettings {
  const workspace = useCurrentWorkspace();
  return useMemo(() => deriveScmSettings(workspace), [workspace]);
}
