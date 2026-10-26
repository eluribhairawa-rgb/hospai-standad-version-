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
      <div className="login-hero" aria-hidden="true">
        {/* Hospital background photo */}
        <div className="login-hero-bg">
          <img
            src={`${LOGO_BASE}hospital_bg.jpg`}
            alt=""
            className="login-hero-bg-img"
            loading="eager"
            decoding="sync"
          />
        </div>

        {/* SVG decorative elements: waves, crosses, circles */}
        <svg className="login-hero-waves" viewBox="0 0 800 900" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
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

        {/* Kalpra Tech logo at top-left */}
        <div className="login-hero-logo">
          <img
            src={`${LOGO_BASE}kalpra_logo.png`}
            alt="Kalpra Tech – Your AI & Gen AI Partner"
            className="login-hero-logo-img"
            loading="eager"
            decoding="sync"
          />
        </div>

        <div className="login-hero-content">
          <h1 className="login-hero-headline">
            Care starts with <span className="login-hero-accent">connection.</span>
          </h1>
          <p className="login-hero-quote">
            Behind every patient record is a person who deserves care, clarity, and compassion.
          </p>
          <div className="login-hero-divider" />
        </div>
        <p className="login-hero-footer">One connected workspace for every step of the patient journey.</p>
      </div>

      <div className="login-panel">
        <div className="login-panel-inner">
          <div className="login-help">
            <span className="login-help-label">Need help?</span>
            <button
              type="button"
              className="link login-help-link"
              onClick={() => setShowAdminNote((value) => !value)}
              aria-expanded={showAdminNote}
            >
              Contact your administrator
            </button>
          </div>
          {showAdminNote && (
            <div className="login-admin-note" role="note">
              Access to HospAI is managed by your hospital's admin team. Reach out to them to get a username set up
              or your password reset.
            </div>
          )}

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
            <p>Access is based on your assigned role.</p>
            <p className="login-footer-brand">HospAI • Connected care, simplified</p>
          </div>
        </div>
      </div>
    </div>
  );
}
