import { API_BASE } from "./constants";
import type { Dispatch, SetStateAction } from "react";
import type { Notice } from "../types";
import { noteServerRefresh } from "./sessionActivity";

const HOSPITAL_CODE_KEY = "hospai_hospital_code";
const DEFAULT_HOSPITAL_CODE = "hosp-default";

export function getHospitalCode(): string {
  if (typeof window === "undefined") return DEFAULT_HOSPITAL_CODE;
  const storage = window.localStorage as { getItem?: (key: string) => string | null } | undefined;
  if (!storage || typeof storage.getItem !== "function") return DEFAULT_HOSPITAL_CODE;
  const stored = (storage.getItem(HOSPITAL_CODE_KEY) || "").trim().toLowerCase();
  return stored || DEFAULT_HOSPITAL_CODE;
}

export function setHospitalCode(hospitalCode: string): void {
  if (typeof window === "undefined") return;
  const normalized = (hospitalCode || "").trim().toLowerCase() || DEFAULT_HOSPITAL_CODE;
  const storage = window.localStorage as { setItem?: (key: string, value: string) => void } | undefined;
  if (!storage || typeof storage.setItem !== "function") return;
  storage.setItem(HOSPITAL_CODE_KEY, normalized);
}

/**
 * `background: true` marks automatic refreshes (polling). They don't count as
 * user activity, so they don't extend the idle session on the server.
 */
export async function apiFetch<T = any>(path: string, options: RequestInit & { cache?: RequestCache; background?: boolean } = {}): Promise<T> {
  const method = (options.method || "GET").toUpperCase();
  const { headers: optionHeaders, cache: optionCache, background, ...restOptions } = options;
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const baseUrl = (API_BASE || "").replace(/\/+$/, "");
  const targetUrl = baseUrl.endsWith("/api") && cleanPath.startsWith("/api/")
    ? `${baseUrl.slice(0, -4)}${cleanPath}`
    : `${baseUrl}${cleanPath}`;
  const fetchOptions: RequestInit = {
    ...restOptions,
    headers: {
      "Content-Type": "application/json",
      "X-Hospital-Code": getHospitalCode(),
      ...(background ? { "X-Background-Refresh": "1" } : {}),
      ...(optionHeaders || {}),
    },
    credentials: "include",
    cache: optionCache || (method === "GET" ? "no-store" : "default"),
  };

  // Only GET is safe to silently retry -- a write that actually reached the
  // server but lost its response on a flaky connection
  // must never be
  // resubmitted automatically, or it could create a duplicate record.
  let response: Response;
  const sentAt = Date.now();
  try {
    response = await fetch(targetUrl, fetchOptions);
  } catch (networkErr) {
    if (method !== "GET") throw networkErr;
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      response = await fetch(targetUrl, fetchOptions);
    } catch {
      const error = new Error("Could not reach the server. Check your connection and try again.") as Error & { status?: number };
      throw error;
    }
  }

  // The server reset its inactivity timer for this request.
  if (response.headers.get("X-Session-Refreshed") === "1") noteServerRefresh(sentAt);

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && path !== "/api/auth/login" && path !== "/api/auth/session") {
      window.dispatchEvent(new Event("app:unauthorized"));
    }
    
    let message = payload.error || payload.message;
    if (!message && payload.detail) {
      if (typeof payload.detail === "string") {
        message = payload.detail;
      } else if (typeof payload.detail === "object") {
        message = payload.detail.message || payload.detail.error || payload.detail.detail;
      }
    }
    if (payload.fields && typeof payload.fields === "object") {
      const fieldMsgs = Object.values(payload.fields).filter(Boolean);
      if (fieldMsgs.length > 0) {
        message = `${message ? message + ": " : ""}${fieldMsgs.join(" | ")}`;
      }
    }
    if (!message) {
      if (response.status >= 500) {
        message = "Unable to complete request. Please try again later.";
      } else {
        message = "Request failed. Please check your connection.";
      }
    }
    
    const error = new Error(message) as Error & { payload?: any; status?: number };
    error.payload = payload;
    error.status = response.status;
    throw error;
  }

  return response.json();
}

export function reportError(
  setNotice?: Dispatch<SetStateAction<Notice | null>>,
  error?: { status?: number; message?: string },
  fallbackMessage = "Request failed."
): void {
  if (error?.status === 401) return;
  setNotice?.({ type: "error", message: error?.message || fallbackMessage });
}
