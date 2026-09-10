import { useEffect, useRef, useState } from "react";
import { isFramed } from "./login.ts";
import { getConnectorReadiness } from "./readiness.ts";
import {
  READINESS_PROBE_MAX_TOTAL_MS,
  readinessProbeDelayMs,
  readinessProbeExhausted,
} from "./readiness-schedule.ts";
import { CONNECTOR_TOKEN_READY_EVENT } from "./types.ts";

export type ConnectorWaitStatus =
  | "idle"
  | "waiting"
  | "timed_out"
  | "not_embedded";

export const READINESS_PROBE_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    const settle = (value: T | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    promise.then(settle, () => settle(null));
  });
}

async function isConnectorReady(): Promise<boolean> {
  const result = await withTimeout(
    getConnectorReadiness(),
    READINESS_PROBE_TIMEOUT_MS,
  );
  return result?.ready === true;
}

export function useRefetchWhenConnectorReady(
  waiting: boolean,
  refetch: () => unknown,
): ConnectorWaitStatus {
  const refetchRef = useRef(refetch);
  const [timedOut, setTimedOut] = useState(false);
  const [notEmbedded, setNotEmbedded] = useState(false);

  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  useEffect(() => {
    if (!waiting) return;
    if (!isFramed()) {
      setNotEmbedded(true);
      return () => setNotEmbedded(false);
    }
    let cancelled = false;
    let refetching = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const runRefetch = async () => {
      if (refetching) return;
      refetching = true;
      try {
        await refetchRef.current();
      } catch {
        // The query owns its own error state; a failed refetch must not stop
        // the probe loop.
      } finally {
        refetching = false;
      }
    };
    const schedule = () => {
      timer = setTimeout(probe, readinessProbeDelayMs(attempt));
      attempt += 1;
    };
    const probe = async () => {
      if (cancelled || readinessProbeExhausted(startedAt, Date.now())) return;
      const ready = await isConnectorReady();
      if (cancelled) return;
      if (ready) await runRefetch();
      if (!cancelled) schedule();
    };
    const onTokenReady = () => {
      void runRefetch();
    };
    const deadline = setTimeout(() => {
      if (!cancelled) setTimedOut(true);
    }, READINESS_PROBE_MAX_TOTAL_MS);

    window.addEventListener(CONNECTOR_TOKEN_READY_EVENT, onTokenReady);
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(deadline);
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener(CONNECTOR_TOKEN_READY_EVENT, onTokenReady);
      setTimedOut(false);
    };
  }, [waiting]);

  if (!waiting) return "idle";
  if (notEmbedded) return "not_embedded";
  return timedOut ? "timed_out" : "waiting";
}
