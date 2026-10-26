type RazorpaySuccessResponse = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

type RazorpayCheckoutOptions = {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  notes?: Record<string, string>;
  theme?: {
    color?: string;
  };
};

const RAZORPAY_CHECKOUT_URL = "https://checkout.razorpay.com/v1/checkout.js";

let loadPromise: Promise<void> | null = null;

export async function ensureRazorpayLoaded(): Promise<void> {
  if (typeof window === "undefined") {
    throw new Error("Razorpay checkout is only available in browser runtime.");
  }
  if (typeof window.Razorpay === "function") return;
  if (!loadPromise) {
    loadPromise = new Promise<void>((resolve, reject) => {
      const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_CHECKOUT_URL}"]`);
      if (existingScript) {
        existingScript.addEventListener("load", () => resolve(), { once: true });
        existingScript.addEventListener("error", () => reject(new Error("Failed to load Razorpay checkout script.")), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = RAZORPAY_CHECKOUT_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load Razorpay checkout script."));
      document.body.appendChild(script);
    });
  }
  await loadPromise;
}

export async function openRazorpayCheckout(options: RazorpayCheckoutOptions): Promise<RazorpaySuccessResponse> {
  await ensureRazorpayLoaded();
  return new Promise<RazorpaySuccessResponse>((resolve, reject) => {
    if (typeof window.Razorpay !== "function") {
      reject(new Error("Razorpay checkout is unavailable."));
      return;
    }

    const checkout = new window.Razorpay({
      ...options,
      handler: (response: RazorpaySuccessResponse) => resolve(response),
      modal: {
        ondismiss: () => reject(new Error("Razorpay checkout was closed.")),
      },
    });

    checkout.open();
  });
}
