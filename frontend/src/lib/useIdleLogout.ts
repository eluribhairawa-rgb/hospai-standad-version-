import { useCallback, useEffect, useRef, useState } from "react";
import { getLastActivity, getLastServerRefresh, noteActivity } from "./sessionActivity";

const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "wheel", "touchstart", "scroll"] as const;
const TICK_MS = 1_000;
// Throttle for persisting activity to localStorage on high-frequency events.
const SHARED_WRITE_THROTTLE_MS = 2_000;
const WARNING_LEAD_MS = 2 * 60_000;
const KEEPALIVE_MIN_GAP_MS = 60_000;

export type IdleLogoutState = {
  /** True while the "session about to expire" warning should be shown. */
  warning: boolean;
  /** Whole seconds until automatic logout (only meaningful while `warning`). */
  secondsLeft: number;
  /** Explicitly keep the session alive (the warning's "Continue" button). */
  continueSession: () => void;
};

/**
 * Inactivity timeout. Logs out after `timeoutMs` with no mouse, keyboard,
 * touch or scroll activity in any open tab, showing a warning shortly before.
 *
 * The server enforces the same timeout independently (only user-driven
 * requests slide its expiry; polling is sent as a background refresh). When the
 * user is active without making requests, e.g. filling a long form, a
 * keep-alive tells the server within a minute, so its expiry always lands
 * within [last activity + timeout, last activity + timeout + 1 min] and never
 * before the frontend's own deadline.
 */
export function useIdleLogout(options: {
  enabled: boolean;
  timeoutMs: number;
  onIdle: () => void;
  onKeepAlive: () => Promise<unknown>;
}): IdleLogoutState {
  const { enabled, timeoutMs } = options;
  const onIdleRef = useRef(options.onIdle);
  const onKeepAliveRef = useRef(options.onKeepAlive);
  onIdleRef.current = options.onIdle;
  onKeepAliveRef.current = options.onKeepAlive;

  const [warning, setWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const warningRef = useRef(false);
  const keepAliveInFlight = useRef(false);

  const sendKeepAlive = useCallback(() => {
    if (keepAliveInFlight.current) return;
    keepAliveInFlight.current = true;
    void onKeepAliveRef.current()
      .catch(() => {})
      .finally(() => {
        keepAliveInFlight.current = false;
      });
  }, []);

  const continueSession = useCallback(() => {
    noteActivity(Date.now());
    warningRef.current = false;
    setWarning(false);
    sendKeepAlive();
  }, [sendKeepAlive]);

  useEffect(() => {
    if (!enabled || !(timeoutMs > 0) || typeof window === "undefined") return;

    const warningLeadMs = Math.min(WARNING_LEAD_MS, timeoutMs / 2);
    const keepAliveGapMs = Math.min(KEEPALIVE_MIN_GAP_MS, timeoutMs / 4);
    let lastSharedWrite = 0;
    let fired = false;
    // Logging in / loading the page counts as activity.
    noteActivity(Date.now());

    const markActive = (event: Event) => {
      // Once the warning is up, a stray mouse movement shouldn't silently
      // dismiss it: require a click, key press, touch or scroll.
      if (warningRef.current && event.type === "mousemove") return;
      const now = Date.now();
      const persist = now - lastSharedWrite >= SHARED_WRITE_THROTTLE_MS || warningRef.current;
      if (persist) lastSharedWrite = now;
      noteActivity(now, persist);
    };

    // Ticks rather than a single setTimeout so it survives background-tab
    // timer throttling and laptop sleep, and picks up activity in other tabs.
    const tick = () => {
      if (fired) return;
      const now = Date.now();
      const lastActivity = getLastActivity();
      const remaining = lastActivity + timeoutMs - now;

      if (remaining <= 0) {
        fired = true;
        warningRef.current = false;
        setWarning(false);
        onIdleRef.current();
        return;
      }

      const showWarning = remaining <= warningLeadMs;
      if (showWarning !== warningRef.current) {
        warningRef.current = showWarning;
        setWarning(showWarning);
      }
      if (showWarning) setSecondsLeft(Math.ceil(remaining / 1000));

      // Activity the server hasn't heard about yet: tell it (at most once a minute).
      const lastServerRefresh = getLastServerRefresh();
      if (lastActivity > lastServerRefresh && now - lastServerRefresh >= keepAliveGapMs) {
        sendKeepAlive();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };

    ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, markActive, { passive: true, capture: true }));
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(tick, TICK_MS);

    return () => {
      ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, markActive, { capture: true }));
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
      warningRef.current = false;
      setWarning(false);
    };
  }, [enabled, timeoutMs, sendKeepAlive]);

  return { warning, secondsLeft, continueSession };
}
