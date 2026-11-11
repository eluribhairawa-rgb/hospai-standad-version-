import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";

/**
 * Full-screen waiting-hall TV display for the OP queue.
 * Shows one card per doctor with ONLY the next patient still waiting to be
 * consulted -- never the full queue and never the patient already inside.
 */

type Props = { onClose: () => void };

type DoctorCard = {
  doctor: string;
  department: string;
  next: { token: string; name: string; uhid: string } | null;
  waitingCount: number;
};

const REFRESH_MS = 10_000;
const PAGE_ROTATE_MS = 12_000;
const CARDS_PER_PAGE = 9;
const ACCENTS = ["#2563eb", "#db2777", "#7c3aed", "#059669", "#ea580c", "#0891b2", "#4f46e5", "#be123c", "#0d9488"];

const todayIso = () => new Date().toLocaleDateString("en-CA");

const normStatus = (raw: unknown): "Waiting" | "In Consultation" | "Completed" | "Other" => {
  const s = String(raw || "").trim().toLowerCase();
  if (["in_consultation", "in consultation", "consulting"].includes(s)) return "In Consultation";
  if (["completed", "done", "consulted", "finished"].includes(s)) return "Completed";
  if (["cancelled", "canceled", "no_show", "no-show"].includes(s)) return "Other";
  return "Waiting";
};

const tokenSortKey = (token: string, id: number) => {
  const n = parseInt(String(token).replace(/\D+/g, ""), 10);
  return Number.isFinite(n) ? n : 1e9 + id;
};

const docLabel = (name: string) => (/^dr\.?\s/i.test(name) ? name : `Dr. ${name}`);

export default function OpQueueTvDisplay({ onClose }: Props) {
  const [cards, setCards] = useState<DoctorCard[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [page, setPage] = useState(0);

  // Live data: today's OP appointments, refreshed every few seconds.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await apiFetch<{ appointments?: Array<any> }>(`/api/appointments?date=${todayIso()}`);
        if (cancelled) return;
        const rows = (data?.appointments || []).filter((a) => {
          const vt = String(a.visit_type || "").trim().toLowerCase();
          return vt !== "emergency" && vt !== "ip";
        });
        const byDoctor = new Map<string, { doctor: string; department: string; waiting: Array<{ token: string; name: string; uhid: string; key: number }> }>();
        rows.forEach((a) => {
          const doctor = String(a.doctor_name || "").trim();
          if (!doctor || doctor === "-") return;
          const key = doctor.toLowerCase().replace(/^dr\.?\s*/i, "");
          if (!byDoctor.has(key)) byDoctor.set(key, { doctor, department: String(a.department || "").trim(), waiting: [] });
          const entry = byDoctor.get(key)!;
          if (!entry.department && a.department) entry.department = String(a.department).trim();
          if (normStatus(a.status) === "Waiting") {
            const token = String(a.token_no || a.id);
            entry.waiting.push({
              token,
              name: a.patient_name || a.registered_patient_name || "Patient",
              uhid: String(a.patient_id || a.uhid || "").trim(),
              key: tokenSortKey(token, Number(a.id) || 0),
            });
          }
        });
        const next: DoctorCard[] = Array.from(byDoctor.values())
          .map((d) => {
            d.waiting.sort((x, y) => x.key - y.key);
            return {
              doctor: d.doctor,
              department: d.department,
              next: d.waiting[0] ? { token: d.waiting[0].token, name: d.waiting[0].name, uhid: d.waiting[0].uhid } : null,
              waitingCount: d.waiting.length,
            };
          })
          .sort((a, b) => a.doctor.localeCompare(b.doctor));
        setCards(next);
        setOffline(false);
      } catch {
        if (!cancelled) setOffline(true);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };
    void load();
    const t = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  // Clock
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Rotate pages when there are more doctors than fit on one screen.
  const pageCount = Math.max(1, Math.ceil(cards.length / CARDS_PER_PAGE));
  useEffect(() => {
    if (pageCount <= 1) {
      setPage(0);
      return;
    }
    const t = window.setInterval(() => setPage((p) => (p + 1) % pageCount), PAGE_ROTATE_MS);
    return () => window.clearInterval(t);
  }, [pageCount]);

  // Full screen + Esc to exit
  useEffect(() => {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen().catch(() => undefined);
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => undefined);
    };
  }, [onClose]);

  const visible = useMemo(
    () => cards.slice(page * CARDS_PER_PAGE, page * CARDS_PER_PAGE + CARDS_PER_PAGE),
    [cards, page]
  );
  const n = visible.length;
  const cols = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 2 : 3;
  const rows = Math.max(1, Math.ceil(n / cols));

  const nameSize = (name: string) => {
    const len = name.length;
    if (len <= 14) return "clamp(28px, 3.6vw, 64px)";
    if (len <= 20) return "clamp(24px, 3vw, 54px)";
    if (len <= 28) return "clamp(20px, 2.4vw, 44px)";
    return "clamp(18px, 1.9vw, 36px)";
  };

  return (
    <div className="optv-root" role="dialog" aria-label="OP queue TV display">
      <header className="optv-header">
        <div className="optv-brand">
          <div className="optv-logo">+</div>
          <div>
            <h1>Outpatient Department</h1>
            <p>Please wait for your name to be called</p>
          </div>
        </div>
        <div className="optv-title">Next for Consultation</div>
        <div className="optv-clock">
          <div className="optv-time">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
          <div className="optv-date">
            {now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short", year: "numeric" })}
          </div>
        </div>
        <button type="button" className="optv-close" onClick={onClose} title="Exit TV display (Esc)">
          ✕
        </button>
      </header>

      {loaded && n === 0 ? (
        <main className="optv-empty">No consultations scheduled for today.</main>
      ) : (
        <main
          className="optv-grid"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
        >
          {visible.map((c, i) => {
            const accent = ACCENTS[(page * CARDS_PER_PAGE + i) % ACCENTS.length];
            return (
              <div key={c.doctor} className={`optv-card${c.next ? "" : " is-empty"}`} style={{ ["--c" as any]: accent }}>
                <div className="optv-card-top">
                  <div className="optv-doc-wrap">
                    <div className="optv-doc-lbl">Doctor</div>
                    <div className="optv-doc">{docLabel(c.doctor)}</div>
                    {c.department && c.department !== "-" && <div className="optv-spec">{c.department}</div>}
                  </div>
                </div>
                <div className="optv-card-body">
                  <div className="optv-lbl">Next Patient</div>
                  {c.next ? (
                    <>
                      <div className="optv-token">Token {c.next.token}</div>
                      <div className="optv-name" style={{ fontSize: nameSize(c.next.name) }}>
                        {c.next.name}
                      </div>
                      {c.next.uhid && <div className="optv-uhid">UHID: {c.next.uhid}</div>}
                    </>
                  ) : (
                    <div className="optv-name optv-none">No patients waiting</div>
                  )}
                </div>
                <div className="optv-card-foot">
                  {c.next ? "Please be seated and keep your token ready" : "Walk-ins welcome at Registration"}
                </div>
              </div>
            );
          })}
        </main>
      )}

      <footer className="optv-footer">
        <span>🔔 Please keep your token slip ready</span>
        <span>•</span>
        <span>For assistance, contact the Registration Desk</span>
        {pageCount > 1 && <span className="optv-page">Page {page + 1} / {pageCount}</span>}
        {offline && <span className="optv-page">Reconnecting…</span>}
      </footer>
    </div>
  );
}
