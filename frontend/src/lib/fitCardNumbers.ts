// Shrinks the font of KPI/stat card values so large numbers always fit inside their card.
const SELECTOR = [
  ".stat-card h3",
  ".billing-kpi-value",
  ".hosp-kpi-value",
  ".hosp-dues-summary-value",
  ".kpi-value",
  ".kpi-cards-row .kpi-value",
  ".pharmacy-kpi-value",
  ".pharmacy-kpi-amount",
  ".pharmacy-overview-stat-value",
  ".stock-summary-count",
  ".diag-stat-card strong",
  ".journey-stat-grid .stat-card h3",
  ".module-stat-grid h3",
  ".module-stat-grid strong",
].join(",");

const MIN_PX = 10;

function fit(el: HTMLElement) {
  el.style.whiteSpace = "nowrap";
  el.style.maxWidth = "100%";
  el.style.minWidth = "0";
  el.style.fontSize = "";
  const base = parseFloat(getComputedStyle(el).fontSize);
  if (!base || el.clientWidth === 0) return;
  let size = base;
  while (el.scrollWidth > el.clientWidth + 0.5 && size > MIN_PX) {
    size -= 1;
    el.style.fontSize = `${size}px`;
  }
}

export function installCardNumberFit() {
  if (typeof window === "undefined") return;
  let queued = false;
  const run = () => {
    queued = false;
    document.querySelectorAll<HTMLElement>(SELECTOR).forEach((el) => {
      el.style.overflow = "hidden";
      el.style.textOverflow = "clip";
      fit(el);
    });
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  };
  new MutationObserver((muts) => {
    // ignore our own style mutations
    if (muts.every((m) => m.type === "attributes")) return;
    schedule();
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener("resize", schedule);
  schedule();
}
