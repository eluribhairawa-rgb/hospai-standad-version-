import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Textarea } from "../components/ui";
import { API_BASE } from "../lib/constants";
import { apiFetch, getHospitalCode } from "../lib/api";
import { applyBranding, fitMm, loadBranding, type BrandingConfig } from "../lib/branding";
import type { Notice } from "../types";

type Props = { setNotice: Dispatch<SetStateAction<Notice | null>> };
type Alignment = "left" | "center" | "right";

const PX_PER_MM = 3; // preview scale: 180mm content width -> 540px
const ACCEPT = ".png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml";

export default function BrandingPage({ setNotice }: Props) {
  const [cfg, setCfg] = useState<BrandingConfig | null>(null);
  const [title, setTitle] = useState("");
  const [footerText, setFooterText] = useState("");
  const [alignment, setAlignment] = useState<Alignment>("left");
  const [offsetX, setOffsetX] = useState("0");
  const [offsetY, setOffsetY] = useState("0");
  const [autoFit, setAutoFit] = useState(true);
  const [busy, setBusy] = useState<string>("");
  const [dragging, setDragging] = useState<"logo" | "footer" | "">("");
  const [error, setError] = useState("");
  const logoInput = useRef<HTMLInputElement>(null);
  const footerInput = useRef<HTMLInputElement>(null);

  const hydrate = useCallback((data: BrandingConfig) => {
    setCfg(data);
    setTitle(data.hospital_title || "");
    setFooterText(data.footer_text || "");
    setAlignment(data.logo_alignment || "left");
    setOffsetX(String(data.logo_offset_x_mm ?? 0));
    setOffsetY(String(data.logo_offset_y_mm ?? 0));
    setAutoFit(data.auto_fit_scaling !== false);
  }, []);

  // The settings view omits inline image data; the preview fetches the assets via their URLs.
  const refreshGlobal = useCallback(async () => { await loadBranding(); }, []);

  useEffect(() => {
    apiFetch<BrandingConfig>("/api/branding").then(hydrate).catch((e) => setError(e?.message || "Unable to load branding settings."));
  }, [hydrate]);

  const baseUrl = (API_BASE || "").replace(/\/+$/, "").replace(/\/api$/, "");

  const upload = async (kind: "logo" | "footer", file: File | undefined | null) => {
    if (!file) return;
    setBusy(kind);
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch(`${baseUrl}/api/branding/${kind}`, { method: "POST", body, credentials: "include", headers: { "X-Hospital-Code": getHospitalCode() } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data?.detail === "string" ? data.detail : data?.error || "Upload failed.");
      setCfg(data);
      await refreshGlobal();
      setNotice({ type: "success", message: kind === "logo" ? "Logo uploaded and auto-fitted." : "Footer image uploaded and auto-fitted." });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const removeAsset = async (kind: "logo" | "footer") => {
    setBusy(kind);
    setError("");
    try {
      setCfg(await apiFetch<BrandingConfig>(`/api/branding/${kind}`, { method: "DELETE" }));
      await refreshGlobal();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    setBusy("save");
    setError("");
    try {
      const data = await apiFetch<BrandingConfig>("/api/branding", {
        method: "PUT",
        body: JSON.stringify({
          hospital_title: title,
          footer_text: footerText,
          logo_alignment: alignment,
          logo_offset_x_mm: Number(offsetX) || 0,
          logo_offset_y_mm: Number(offsetY) || 0,
          auto_fit_scaling: autoFit,
        }),
      });
      hydrate(data);
      await refreshGlobal();
      setNotice({ type: "success", message: "Branding saved. New prints and PDFs use it immediately." });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const resetAll = async () => {
    if (!window.confirm("Remove all custom branding and go back to the default HospAI documents?")) return;
    setBusy("reset");
    setError("");
    try {
      await apiFetch("/api/branding/logo", { method: "DELETE" });
      await apiFetch("/api/branding/footer", { method: "DELETE" });
      const data = await apiFetch<BrandingConfig>("/api/branding", {
        method: "PUT",
        body: JSON.stringify({ hospital_title: "", footer_text: "", logo_alignment: "left", logo_offset_x_mm: 0, logo_offset_y_mm: 0, auto_fit_scaling: true }),
      });
      hydrate(data);
      applyBranding(null);
      await refreshGlobal();
      setNotice({ type: "success", message: "Branding reset to HospAI defaults." });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const onDrop = (kind: "logo" | "footer") => (e: React.DragEvent) => {
    e.preventDefault();
    setDragging("");
    void upload(kind, e.dataTransfer.files?.[0]);
  };

  // ---- live preview (A4 content width, header + footer) ----
  const ox = Number(offsetX) || 0;
  const oy = Number(offsetY) || 0;
  const logoBox = cfg?.logo_box_mm || [70, 28];
  const footerBox = cfg?.footer_box_mm || [150, 9];
  const logoSrc = cfg?.logo ? `${baseUrl}${cfg.logo.url}` : "";
  const footerSrc = cfg?.footer ? `${baseUrl}${cfg.footer.url}` : "";
  const [lw, lh] = fitMm(cfg?.logo?.width_px ?? null, cfg?.logo?.height_px ?? null, logoBox[0], logoBox[1], autoFit);
  const [fw, fh] = fitMm(cfg?.footer?.width_px ?? null, cfg?.footer?.height_px ?? null, footerBox[0], footerBox[1], true);
  const showTitle = title.trim() && alignment !== "center";
  const titleEl = <div style={{ font: "800 15pt Arial, sans-serif", color: "#000" }}>{title.trim()}</div>;
  const logoEl = cfg?.logo ? (
    <img src={logoSrc} alt="Logo preview" style={{ width: lw * PX_PER_MM, height: lh * PX_PER_MM, objectFit: "contain", position: "relative", left: ox * PX_PER_MM, top: oy * PX_PER_MM, display: "block" }} />
  ) : null;

  if (!cfg) {
    return <div className="panel"><p className="muted">{error || "Loading branding settings…"}</p></div>;
  }

  const section: React.CSSProperties = { background: "var(--surface, #fff)", border: "1px solid #e2e8f0", borderRadius: 12, padding: 18, marginBottom: 16 };
  const drop = (kind: "logo" | "footer"): React.CSSProperties => ({
    border: `2px dashed ${dragging === kind ? "#2563eb" : "#94a3b8"}`, borderRadius: 10, padding: 16, textAlign: "center", cursor: "pointer",
    background: dragging === kind ? "#eff6ff" : "#f8fafc", color: "#334155", fontSize: 13,
  });

  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(300px, 1fr) minmax(340px, 600px)", alignItems: "start" }}>
      <div>
        {error && <div role="alert" style={{ ...section, borderColor: "#fca5a5", background: "#fef2f2", color: "#991b1b" }}>{error}</div>}

        <section style={section}>
          <h3 style={{ margin: "0 0 10px" }}>Hospital title</h3>
          <label className="muted" htmlFor="branding-title" style={{ fontSize: 12 }}>Printed on documents in place of “HospAI”</label>
          <Input id="branding-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Sunrise Multispeciality Hospital" />
        </section>

        <section style={section}>
          <h3 style={{ margin: "0 0 10px" }}>Header logo</h3>
          <div
            style={drop("logo")}
            onClick={() => logoInput.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging("logo"); }}
            onDragLeave={() => setDragging("")}
            onDrop={onDrop("logo")}
            role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") logoInput.current?.click(); }}
          >
            {busy === "logo" ? "Uploading…" : cfg.logo ? "Drop or click to replace the logo" : "Drop a logo here or click to browse"}
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>PNG, JPG or SVG · up to 5 MB · automatically scaled to fit the header</div>
          </div>
          <input ref={logoInput} type="file" accept={ACCEPT} hidden onChange={(e) => { void upload("logo", e.target.files?.[0]); e.target.value = ""; }} />
          {cfg.logo && <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => removeAsset("logo")} style={{ marginTop: 8 }}>Remove logo</Button>}

          <div style={{ marginTop: 14 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Position</div>
            <div role="group" aria-label="Logo alignment" style={{ display: "flex", gap: 6 }}>
              {(["left", "center", "right"] as Alignment[]).map((a) => (
                <Button key={a} variant={alignment === a ? "primary" : "secondary"} size="sm" aria-pressed={alignment === a} onClick={() => setAlignment(a)}>
                  Top-{a[0].toUpperCase() + a.slice(1)}
                </Button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
              <label style={{ flex: 1, fontSize: 12 }}>X offset (mm)
                <Input type="number" min={-30} max={30} step={0.5} value={offsetX} onChange={(e) => setOffsetX(e.target.value)} />
              </label>
              <label style={{ flex: 1, fontSize: 12 }}>Y offset (mm)
                <Input type="number" min={-30} max={30} step={0.5} value={offsetY} onChange={(e) => setOffsetY(e.target.value)} />
              </label>
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, fontSize: 13 }}>
              <input type="checkbox" checked={autoFit} onChange={(e) => setAutoFit(e.target.checked)} />
              Auto-fit scaling (resize into the header box, aspect ratio preserved)
            </label>
          </div>
        </section>

        <section style={section}>
          <h3 style={{ margin: "0 0 10px" }}>Footer</h3>
          <div
            style={drop("footer")}
            onClick={() => footerInput.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging("footer"); }}
            onDragLeave={() => setDragging("")}
            onDrop={onDrop("footer")}
            role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") footerInput.current?.click(); }}
          >
            {busy === "footer" ? "Uploading…" : cfg.footer ? "Drop or click to replace the footer image" : "Optional footer image (PNG, JPG or SVG)"}
          </div>
          <input ref={footerInput} type="file" accept={ACCEPT} hidden onChange={(e) => { void upload("footer", e.target.files?.[0]); e.target.value = ""; }} />
          {cfg.footer && <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => removeAsset("footer")} style={{ marginTop: 8 }}>Remove footer image</Button>}
          <label htmlFor="branding-footer-text" className="muted" style={{ fontSize: 12, display: "block", marginTop: 12 }}>Footer / disclaimer text</label>
          <Textarea id="branding-footer-text" rows={3} maxLength={500} value={footerText} onChange={(e) => setFooterText(e.target.value)} placeholder="Leave blank for “Thank you for choosing …”" />
        </section>

        <div style={{ display: "flex", gap: 10 }}>
          <Button variant="primary" disabled={!!busy} onClick={save}>{busy === "save" ? "Saving…" : "Save branding"}</Button>
          <Button variant="ghost" disabled={!!busy} onClick={resetAll}>Reset to defaults</Button>
        </div>
      </div>

      <div style={{ position: "sticky", top: 12 }}>
        <section style={section}>
          <h3 style={{ margin: "0 0 10px" }}>Live preview</h3>
          <div style={{ background: "#fff", border: "1px solid #cbd5e1", boxShadow: "0 1px 6px rgba(0,0,0,.12)", padding: 15 * PX_PER_MM / 3, overflow: "hidden" }}>
            <div style={{ width: 180 * PX_PER_MM, maxWidth: "100%", margin: "0 auto" }}>
              <div style={{ minHeight: 32 * PX_PER_MM, display: "flex", alignItems: "flex-start", justifyContent: alignment === "center" || !showTitle || !logoEl ? (alignment === "center" ? "center" : alignment === "right" ? "flex-end" : "flex-start") : "space-between", borderBottom: "2px solid #000", paddingBottom: 4 }}>
                {logoEl ? (
                  alignment === "right" && showTitle ? <>{titleEl}{logoEl}</> : <>{logoEl}{showTitle ? titleEl : null}</>
                ) : title.trim() ? titleEl : (
                  <div className="muted" style={{ fontSize: 12 }}>Default HospAI header (no custom logo or title)</div>
                )}
              </div>
              <div style={{ margin: "14px 0 90px", color: "#94a3b8", fontSize: 11 }}>Document title · patient details · body…</div>
              <div style={{ borderTop: "1.5px solid #000", paddingTop: 4 }}>
                {footerSrc && <img src={footerSrc} alt="Footer preview" style={{ width: fw * PX_PER_MM, height: fh * PX_PER_MM, objectFit: "contain", display: "block", margin: "0 auto 4px" }} />}
                <div style={{ display: "flex", justifyContent: "space-between", font: "italic 7.5pt Arial, sans-serif" }}>
                  <span>{footerText.trim() || `Thank you for choosing ${title.trim() || "HospAI"}.`}</span>
                  <span>Page 1 of 1</span>
                </div>
              </div>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 11, margin: "8px 0 0" }}>Applies to prescriptions, pharmacy bills, discharge summaries, OP/IP prints and exported PDFs. Documents fall back to the default HospAI layout wherever nothing is configured.</p>
        </section>
      </div>
    </div>
  );
}
