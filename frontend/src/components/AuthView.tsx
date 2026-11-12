import { useState, useRef } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Button, Input } from "./ui";
import BrandLogo from "./BrandLogo";

type Props = {
  onLogin: (username: string, password: string) => Promise<void>;
};

const LOGO_BASE = import.meta.env.BASE_URL || "./";

export default function AuthView({ onLogin }: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdminNote, setShowAdminNote] = useState(false);

  const doSubmitForm = () => {
    if (formRef.current) {
      if (typeof formRef.current.requestSubmit === "function") {
        formRef.current.requestSubmit();
      } else {
        formRef.current.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      }
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const form = event.currentTarget;
    const username = ((form.elements.namedItem("username") as HTMLInputElement)?.value || "").trim();
    const password = (form.elements.namedItem("password") as HTMLInputElement)?.value || "";
    if (!username) {
      setError("Please enter your username.");
      document.getElementById("login-username")?.focus();
      return;
    }
    if (!password) {
      setError("Please enter your password.");
      document.getElementById("login-password")?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onLogin(username, password);
    } catch {
      // Generic on purpose -- never reveal which field was wrong.
      setError("Invalid credentials");
    } finally {
      setSubmitting(false);
    }
  };

  const trackCapsLock = (event: KeyboardEvent<HTMLInputElement>) => {
    if (typeof event.getModifierState === "function") {
      setCapsLockOn(event.getModifierState("CapsLock"));
    }
  };

  return (
    <div className="login-page">
      <div className="login-hero">
        {/* Hospital background photo */}
        <div className="login-hero-bg" aria-hidden="true">
          <img
            src={`${LOGO_BASE}hospital_bg.jpg`}
            alt=""
            className="login-hero-bg-img"
            loading="eager"
            decoding="sync"
          />
        </div>

        {/* SVG decorative elements: waves, crosses, circles */}
        <svg className="login-hero-waves" aria-hidden="true" viewBox="0 0 800 900" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
          {/* Flowing wave curves */}
          <path d="M0 320 C 200 260, 400 400, 600 330 S 860 280, 800 420 L 800 900 L 0 900 Z" fill="#1a5276" opacity="0.10" />
          <path d="M-30 500 C 160 440, 350 580, 580 500 S 790 440, 860 580" stroke="#4db8d1" strokeWidth="1.5" fill="none" opacity="0.18" />
          <path d="M-60 560 C 170 500, 380 640, 610 560 S 820 500, 890 640" stroke="#3a9dbf" strokeWidth="1" fill="none" opacity="0.12" />
          <path d="M-40 620 C 180 570, 390 700, 620 620 S 830 570, 900 700" stroke="#5cc8e0" strokeWidth="1" fill="none" opacity="0.08" />

          {/* Subtle glow circles */}
          <circle cx="640" cy="140" r="120" fill="#4db8d1" opacity="0.04" />
          <circle cx="100" cy="780" r="160" fill="#3a9dbf" opacity="0.05" />

          {/* Medical cross - top right */}
          <g transform="translate(560, 80)" opacity="0.18">
            <rect x="-20" y="-50" width="40" height="100" rx="6" fill="#4db8d1" />
            <rect x="-50" y="-20" width="100" height="40" rx="6" fill="#4db8d1" />
          </g>

          {/* Medical cross - small scattered */}
          <g transform="translate(320, 100)" opacity="0.22">
            <rect x="-6" y="-16" width="12" height="32" rx="3" fill="#5eead4" />
            <rect x="-16" y="-6" width="32" height="12" rx="3" fill="#5eead4" />
          </g>

          {/* Small cross bottom-left */}
          <g transform="translate(120, 720)" opacity="0.15">
            <rect x="-8" y="-22" width="16" height="44" rx="4" fill="#4db8d1" />
            <rect x="-22" y="-8" width="44" height="16" rx="4" fill="#4db8d1" />
          </g>

          {/* Tiny cross accent */}
          <g transform="translate(240, 650)" opacity="0.12">
            <rect x="-4" y="-12" width="8" height="24" rx="2" fill="#5eead4" />
            <rect x="-12" y="-4" width="24" height="8" rx="2" fill="#5eead4" />
          </g>
        </svg>

        <div className="login-hero-inner">
          {/* Kalpra Tech logo: top-left, on the same left edge as the text below */}
          <div className="login-hero-logo">
            <img
              src={`${LOGO_BASE}kalpra_logo.png`}
              alt="Kalpra Tech – Your AI & Gen AI Partner"
              className="login-hero-logo-img"
              loading="eager"
              decoding="sync"
            />
          </div>

          <div className="login-hero-main">
            <span className="login-hero-eyebrow">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9z" />
                <path d="M19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9z" opacity="0.7" />
              </svg>
              AI-Driven Healthcare Optimization
            </span>
            <h1 className="login-hero-headline">
              Smarter care, <span className="login-hero-accent">connected.</span>
            </h1>
            <p className="login-hero-quote">
              One workspace for every step of the patient journey, with AI that drafts, reads and reaches out.
            </p>

            <p className="login-ai-heading">AI that assists your team</p>
            <ul className="login-ai-grid">
              <li className="login-ai-card">
                <span className="login-ai-icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="8" y1="13" x2="16" y2="13" />
                    <line x1="8" y1="17" x2="14" y2="17" />
                  </svg>
                </span>
                <span className="login-ai-text">
                  <strong>AI Discharge Summaries</strong>
                </span>
              </li>
              <li className="login-ai-card">
                <span className="login-ai-icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 3h6" />
                    <path d="M10 3v6.5L4.5 19a1.5 1.5 0 0 0 1.3 2.25h12.4A1.5 1.5 0 0 0 19.5 19L14 9.5V3" />
                    <path d="M7.5 15h9" />
                  </svg>
                </span>
                <span className="login-ai-text">
                  <strong>Lab Report Reading</strong>
                </span>
              </li>
              <li className="login-ai-card">
                <span className="login-ai-icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z" />
                  </svg>
                </span>
                <span className="login-ai-text">
                  <strong>Patient Reach AI</strong>
                </span>
              </li>
              <li className="login-ai-card">
                <span className="login-ai-icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7V5a2 2 0 0 1 2-2h2" />
                    <path d="M17 3h2a2 2 0 0 1 2 2v2" />
                    <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
                    <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
                    <line x1="7" y1="12" x2="17" y2="12" />
                  </svg>
                </span>
                <span className="login-ai-text">
                  <strong>Document Scanning</strong>
                </span>
              </li>
            </ul>
          </div>

          <p className="login-hero-footer">Every AI draft is reviewed by your clinical team.</p>
        </div>
      </div>

      <div className="login-panel">
        <div className="login-panel-inner">
          <div className="login-brand">
            <BrandLogo />
          </div>

          <h2 className="login-title">Welcome to HospAI</h2>
          <p className="login-subtitle">Sign in to your hospital workspace.</p>

          <form ref={formRef} className="login-form" onSubmit={handleSubmit} noValidate>
            <label className="ui-label" htmlFor="login-username">
              Username
              <Input
                id="login-username"
                name="username"
                placeholder="username"
                autoFocus
                required
                autoComplete="username"
                onKeyDown={(e) => {
                  trackCapsLock(e);
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const passInput = document.getElementById("login-password") as HTMLInputElement | null;
                    if (passInput && passInput.value.trim().length > 0) {
                      doSubmitForm();
                    } else {
                      passInput?.focus();
                    }
                  }
                }}
              />
            </label>
            <label className="ui-label" htmlFor="login-password">
              Password
              <div className="login-password-wrap">
                <Input
                  id="login-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••"
                  required
                  autoComplete="current-password"
                  onKeyUp={trackCapsLock}
                  onKeyDown={(e) => {
                    trackCapsLock(e);
                    if (e.key === "Enter") {
                      e.preventDefault();
                      doSubmitForm();
                    }
                  }}
                  style={{ paddingRight: "44px" }}
                />
                <button
                  type="button"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="login-password-toggle"
                  onClick={() => setShowPassword((value) => !value)}
                >
                  {showPassword ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.89 1 12a19.9 19.9 0 0 1 5.06-7.06" />
                      <path d="M10.58 10.58A2 2 0 0 0 12 14a2 2 0 0 0 1.42-.58" />
                      <path d="M9.9 4.24A10.7 10.7 0 0 1 12 4c5 0 9.27 3.11 11 8a19.8 19.8 0 0 1-2.16 3.19" />
                      <line x1="2" y1="2" x2="22" y2="22" />
                    </svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
              {capsLockOn && (
                <span className="login-capslock-hint" role="alert">
                  Caps Lock is on
                </span>
              )}
            </label>

            {error && (
              <div className="login-error" role="alert">
                {error}
              </div>
            )}

            <Button type="submit" variant="primary" className="login-submit" disabled={submitting}>
              {submitting ? "Signing in..." : <>Sign in <span aria-hidden="true">→</span></>}
            </Button>
          </form>

          <div className="login-footer">
            <p className="login-help">
              <span className="login-help-label">Need help?</span>
              <button
                type="button"
                className="link login-help-link"
                onClick={() => setShowAdminNote((value) => !value)}
                aria-expanded={showAdminNote}
              >
                Contact your administrator
              </button>
            </p>
            {showAdminNote && (
              <div className="login-admin-note" role="note">
                Access to HospAI is managed by your hospital's admin team. Reach out to them to get a username set up
                or your password reset.
              </div>
            )}
            <p>Access is based on your assigned role.</p>
            <p className="login-footer-brand">HospAI • Connected care, simplified</p>
            {/* Narrow screens hide the left panel, so the Kalpra Tech logo moves here. */}
            <img className="login-footer-kalpra" src={`${LOGO_BASE}kalpra_logo.png`} alt="Kalpra Tech" loading="lazy" />
          </div>
        </div>
      </div>
    </div>
  );
}
