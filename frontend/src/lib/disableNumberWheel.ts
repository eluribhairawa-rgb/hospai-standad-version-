/**
 * Globally stop the mouse wheel / trackpad scroll from changing the value of
 * number inputs (all modules). Blurring the focused field lets the page scroll
 * normally instead of incrementing/decrementing the value.
 */
export function installDisableNumberWheel(): void {
  document.addEventListener(
    "wheel",
    (event) => {
      const el = event.target;
      if (el instanceof HTMLInputElement && el.type === "number" && document.activeElement === el) {
        el.blur();
      }
    },
    { capture: true, passive: true }
  );
  // Arrow Up/Down keys are left untouched; only wheel scrolling is disabled.
}
