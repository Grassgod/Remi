import type { OpenVikingClientContract } from "@multiremi/project-knowledge/types.js";

/** Bound a wait without leaving an abort listener on a long-lived signal. */
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Transport cancellation plus a bounded wait for clients that ignore signals. */
export function deadlineClient(client: OpenVikingClientContract, signal: AbortSignal): OpenVikingClientContract {
  const scoped = client.withSignal?.(signal) ?? client;
  return new Proxy(scoped, {
    get(target, property, receiver) {
      if (property === "withSignal") return (extra: AbortSignal) => deadlineClient(client, AbortSignal.any([signal, extra]));
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        signal.throwIfAborted();
        return abortable(Promise.resolve(value.apply(target, args)), signal);
      };
    },
  });
}
