import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import { useBranding } from "../lib/branding";

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

const SOUND_KEY = "hospai_tv_sound_on";
const readSoundPref = () => {
  try {
    return localStorage.getItem(SOUND_KEY) === "1";
  } catch {
    return false;
  }
};

/** Short two-tone "ding-dong" before each announcement. */
function playChime() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [880, 660].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.45;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.35, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.45);
    });
    window.setTimeout(() => void ctx.close().catch(() => undefined), 1500);
  } catch {
    // audio not available -- the spoken call still runs
  }
}

/** Speak text with an English (India) voice when the browser has one. */
function speak(text: string) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  const voice = voices.find((v) => v.lang === "en-IN") || voices.find((v) => v.lang.startsWith("en"));
  if (voice) u.voice = voice;
  u.lang = voice?.lang || "en-IN";
  u.rate = 0.9;
  window.speechSynthesis.speak(u);
}

const callText = (card: DoctorCard) =>
  card.next ? `Token ${card.next.token}. ${card.next.name}. Please proceed to ${docLabel(card.doctor)}.` : "";

export default function OpQueueTvDisplay({ onClose }: Props) {
  const branding = useBranding();
  const [cards, setCards] = useState<DoctorCard[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [page, setPage] = useState(0);
  const [soundOn, setSoundOn] = useState(readSoundPref);
  const [calling, setCalling] = useState<string | null>(null);
  const soundRef = useRef(soundOn);
  const lastTokenRef = useRef<Map<string, string | null> | null>(null);
  const callTimerRef = useRef<number | undefined>(undefined);

  const announce = (card: DoctorCard) => {
    if (!card.next) return;
    setCalling(card.doctor);
    window.clearTimeout(callTimerRef.current);
    callTimerRef.current = window.setTimeout(() => setCalling(null), 9000);
    playChime();
    // Said twice, like a hospital PA, after the chime.
    window.setTimeout(() => {
      speak(callText(card));
      speak(callText(card));
    }, 950);
  };

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    soundRef.current = next;
    try {
      localStorage.setItem(SOUND_KEY, next ? "1" : "0");
    } catch {
      // preference just isn't remembered
    }
    if (next) {
      // This click also unlocks audio in the browser for later automatic calls.
      playChime();
      window.setTimeout(() => speak("Patient announcements on."), 950);
    } else if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  };

  // Load voices early (some browsers fill the list asynchronously); stop speaking on exit.
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.getVoices();
    return () => {
      window.speechSynthesis.cancel();
      window.clearTimeout(callTimerRef.current);
    };
  }, []);

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

        // Announce doctors whose next patient changed since the last refresh
        // (never on the first load, so opening the screen doesn't read everyone out).
        const prev = lastTokenRef.current;
        const current = new Map(next.map((c) => [c.doctor, c.next?.token ?? null]));
        if (prev && soundRef.current) {
          next.forEach((c) => {
            if (c.next && prev.get(c.doctor) !== c.next.token) announce(c);
          });
        }
        lastTokenRef.current = current;
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

  // Size the name from the card's own box (container units) so it always fits on one line.
  const nameSize = (name: string) => {
    const len = Math.max(6, name.length);
    const byWidth = Math.min(12, 150 / len); // ~0.6em per glyph across ~90% of the card width
    return `min(${byWidth.toFixed(2)}cqw, 22cqh)`;
  };

  return (
    <div className="optv-root" role="dialog" aria-label="OP queue TV display">
      <header className="optv-header">
        <div className="optv-brand">
          {branding?.logo?.data_uri ? (
            <img className="optv-logo-img" src={branding.logo.data_uri} alt={branding.hospital_title || "Hospital logo"} />
          ) : (
            <div className="optv-logo">+</div>
          )}
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
        <button
          type="button"
          className={`optv-sound${soundOn ? " is-on" : ""}`}
          onClick={toggleSound}
          aria-pressed={soundOn}
          title={soundOn ? "Announcements on: click to mute" : "Announcements off: click to call out the next patient"}
        >
          {soundOn ? (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
              <line x1="23" y1="9" x2="17" y2="15" />
              <line x1="17" y1="9" x2="23" y2="15" />
            </svg>
          )}
          <span>{soundOn ? "Sound On" : "Sound Off"}</span>
        </button>
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
              <div key={c.doctor} className={`optv-card${c.next ? "" : " is-empty"}${calling === c.doctor ? " is-calling" : ""}`} style={{ ["--c" as any]: accent }}>
                <div className="optv-card-top">
                  {c.next && (
                    <button type="button" className="optv-recall" onClick={() => announce(c)} title={`Call ${c.next.name} again`} aria-label={`Call ${c.next.name} again`}>
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
                        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      </svg>
                    </button>
                  )}
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
      <div className="optv-marquee" aria-label="Powered by HospAI">
        <div className="optv-marquee-track">
          {[0, 1].map((half) => (
            <div className="optv-marquee-half" key={half} aria-hidden={half === 1}>
              {Array.from({ length: 4 }).map((_, i) => <span key={i}>Powered by HospAI<em>✦</em></span>)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
