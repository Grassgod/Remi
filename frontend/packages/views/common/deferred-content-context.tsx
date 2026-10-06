"use client";
import { createContext, useContext } from "react";

/** Outside an anchored log, previews keep their existing eager behavior. */
export const DeferredContentContext = createContext<boolean | null>(null);
export const useDeferredContent = () => useContext(DeferredContentContext);
