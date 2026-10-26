import { useState } from "react";

const LOGO_BASE = import.meta.env.BASE_URL || "./";
const LOGO_QUERY = "?v=hospai-uploaded-logo-20260622";
const LOGO_PATHS = [
  `${LOGO_BASE}logo.png${LOGO_QUERY}`,
  `${LOGO_BASE}logo-icon.svg${LOGO_QUERY}`,
];

type BrandLogoProps = {
  className?: string;
};

export default function BrandLogo({ className = "brand-logo-img" }: BrandLogoProps) {
  const [logoIndex, setLogoIndex] = useState(0);
  const [showSvgFallback, setShowSvgFallback] = useState(false);

  if (showSvgFallback) {
    return (
      <span className="brand-logo-fallback" aria-label="HospAI logo" role="img">
        <svg viewBox="0 0 64 64" focusable="false" aria-hidden="true">
          <rect x="6" y="6" width="52" height="52" rx="14" fill="none" />
          <rect x="10" y="10" width="44" height="44" rx="10" fill="#0f4f7a" />
          <path d="M22 17v30M42 17v30" stroke="#ffffff" strokeWidth="5.5" strokeLinecap="round" />
          <path d="M22 32h7l4-7 4 14 3-7h2" stroke="#8ee6d2" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="25" y="25" width="14" height="14" rx="2" fill="#c92835" />
          <path d="M32 21v22M21 32h22" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" />
        </svg>
      </span>
    );
  }

  return (
    <img
      className={className}
      src={LOGO_PATHS[logoIndex]}
      alt="HospAI logo"
      loading="eager"
      decoding="sync"
      onError={() => {
        if (logoIndex < LOGO_PATHS.length - 1) {
          setLogoIndex((current) => current + 1);
          return;
        }
        setShowSvgFallback(true);
      }}
    />
  );
}
