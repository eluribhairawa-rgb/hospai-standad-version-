// Shared (cross-tab) timestamps for the inactivity timeout.
//
// - last activity: the user last clicked, typed, touched or scrolled in any tab.
// - last server refresh: a request that slid the server-side expiry forward
//   was sent at this time (the API marks those responses X-Session-Refreshed).
//
// Comparing the two tells the idle hook whether the server knows about the
// latest activity, so a keep-alive is only sent when it doesn't.

const LAST_ACTIVITY_KEY = "hospai_last_activity";
const LAST_SERVER_REFRESH_KEY = "hospai_last_server_refresh";

let localLastActivity = 0;
let localLastServerRefresh = 0;

function read(key: string): number {
  try {
    return Number(window.localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

function writeIfNewer(key: string, timestamp: number): void {
  try {
    if (timestamp > read(key)) window.localStorage.setItem(key, String(timestamp));
  } catch {
    // Storage unavailable (private mode / blocked): fall back to this tab only.
  }
}

export function getLastActivity(): number {
  return Math.max(localLastActivity, read(LAST_ACTIVITY_KEY));
}

export function noteActivity(timestamp: number, persist = true): void {
  localLastActivity = Math.max(localLastActivity, timestamp);
  if (persist) writeIfNewer(LAST_ACTIVITY_KEY, timestamp);
}

export function getLastServerRefresh(): number {
  return Math.max(localLastServerRefresh, read(LAST_SERVER_REFRESH_KEY));
}

/** `sentAt` is when the request left the browser: a safe lower bound for when the server reset its timer. */
export function noteServerRefresh(sentAt: number): void {
  localLastServerRefresh = Math.max(localLastServerRefresh, sentAt);
  writeIfNewer(LAST_SERVER_REFRESH_KEY, sentAt);
}
