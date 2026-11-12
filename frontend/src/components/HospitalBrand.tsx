import type { CSSProperties } from "react";
import { PRINT_BRAND_HEADER_DATA_URI } from "../lib/printBrand";

export type HospitalBrandVariant = "sidebar" | "screen" | "print" | "collapsed" | "header";

export type HospitalBrandProps = {
  variant?: HospitalBrandVariant;
  emblemSize?: number;
  className?: string;
  showSubtitle?: boolean;
  textColor?: string;
  hospitalColor?: string;
  style?: CSSProperties;
  onClick?: () => void;
};

export const HOSPITAL_BRAND_CONFIG = {
  name: "HospAI",
  sub: "",
  emblemSrc: "/logo_emblem.png",
  // Dark-background variant of logo.png: transparent, original icon/"AI" colours, white "Hosp" + tagline.
  sidebarLogoSrc: "/logo_sidebar.png",
  colors: {
    sidebarText: "#ffffff",
    sidebarHospital: "#e11d48", // Highly readable crimson red on navy sidebar
    screenText: "#062f56",      // Dark navy on light backgrounds
    screenHospital: "#dc2626",  // Red on light backgrounds
  },
};

const EMBLEM_SIZE_BY_VARIANT: Record<HospitalBrandVariant, number> = {
  sidebar: 105,
  collapsed: 90,
  print: 90,
  screen: 82,
  header: 82,
};

const VISUALLY_HIDDEN_STYLE: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  border: 0,
};

function BrandEmblem({ size, isSidebar, isPrint }: { size: number, isSidebar: boolean, isPrint: boolean }) {
  // The user's logo asset has proper colors, we should just display it.
  // We can use screen blend mode if we need to drop a black background, 
  // but if the user used make_transparent.py to match the background exactly, 
  // we just render it normally.
  
  // For light backgrounds, if the image has a white background, multiply works well.
  let mixBlendMode = "normal";
  
  if (!isSidebar && !isPrint) {
    // If we are on a white/light screen and the logo has a white background, multiply removes the white.
    // If the logo already has a transparent background, multiply is harmless on white.
    mixBlendMode = "multiply";
  }

  return (
    <img
      src={isPrint ? PRINT_BRAND_HEADER_DATA_URI : isSidebar ? HOSPITAL_BRAND_CONFIG.sidebarLogoSrc : HOSPITAL_BRAND_CONFIG.emblemSrc}
      alt="HospAI emblem"
      style={{ 
        width: isSidebar ? 160 : size * 2.5,
        height: "auto", 
        objectFit: "contain", 
        flexShrink: 0, 
        display: "block",
        mixBlendMode: mixBlendMode as any
      }}
      loading="eager"
      decoding="sync"
    />
  );
}

export default function HospitalBrand({
  variant = "sidebar",
  emblemSize,
  className = "",
  style,
  onClick,
}: HospitalBrandProps) {
  const isSidebar = variant === "sidebar";
  const isPrint = variant === "print";
  const size = emblemSize ?? EMBLEM_SIZE_BY_VARIANT[variant];

  if (variant === "collapsed") {
    return (
      <div
        className={`hospital-brand-container hospital-brand-collapsed ${className}`}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", padding: "8px 0", ...style }}
        onClick={onClick}
        title="HospAI"
        aria-label="HospAI"
      >
        <BrandEmblem size={size} isSidebar={isSidebar} isPrint={isPrint} />
        <span style={VISUALLY_HIDDEN_STYLE}>HospAI</span>
      </div>
    );
  }

  return (
    <div
      className={`hospital-brand-container hospital-brand-${variant} ${className}`}
      style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", minWidth: 0, ...style }}
      onClick={onClick}
    >
      <BrandEmblem size={size} isSidebar={isSidebar} isPrint={isPrint} />
    </div>
  );
}
