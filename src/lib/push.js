const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY || "";

export function pushSupport() {
  if (typeof window === "undefined") return { supported: false, reason: "unsupported" };
  if (!window.isSecureContext) return { supported: false, reason: "insecure" };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return { supported: false, reason: "unsupported" };
  }
  if (!vapidPublicKey) return { supported: false, reason: "not_configured" };
  return { supported: true, reason: null };
}

export function pushPermission() {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export function base64UrlToUint8Array(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function pushRegistration() {
  const support = pushSupport();
  if (!support.supported) throw new Error(`Push is ${support.reason}`);
  const base = import.meta.env.BASE_URL || "/";
  return navigator.serviceWorker.register(`${base}push-sw.js`, { scope: base });
}

export async function subscribeToPush() {
  const registration = await pushRegistration();
  let permission = pushPermission();
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Push permission was not granted");
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(vapidPublicKey),
  });
  const serialized = subscription.toJSON();
  const p256dh = serialized.keys?.p256dh;
  const auth = serialized.keys?.auth;
  if (!p256dh || !auth) throw new Error("Push subscription keys are missing");
  return { endpoint: subscription.endpoint, p256dh, auth };
}

export async function currentPushSubscription() {
  if (!("serviceWorker" in navigator)) return null;
  const base = new URL(import.meta.env.BASE_URL || "/", window.location.origin).toString();
  const registrations = await navigator.serviceWorker.getRegistrations();
  const registration = registrations.find((item) => item.scope === base);
  return registration ? registration.pushManager.getSubscription() : null;
}

export async function unsubscribeFromPush() {
  const subscription = await currentPushSubscription();
  if (subscription) await subscription.unsubscribe();
  return subscription?.endpoint || null;
}
