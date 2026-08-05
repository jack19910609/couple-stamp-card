self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function appUrl(path) {
  return new URL(path || "./", self.registration.scope).toString();
}

self.addEventListener("push", (event) => {
  const payload = event.data?.json?.() || {};
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const appIsVisible = windows.some((client) => {
      try {
        return new URL(client.url).origin === self.location.origin && client.visibilityState === "visible";
      } catch {
        return false;
      }
    });
    if (appIsVisible) {
      windows.forEach((client) => client.postMessage({ type: "couple-push-received", payload }));
      return;
    }
    await self.registration.showNotification(payload.title || "愛的集點卡", {
      body: payload.body || "你的伴侶有新的互動",
      icon: new URL("icon-192.png", self.registration.scope).toString(),
      badge: new URL("icon-192.png", self.registration.scope).toString(),
      tag: payload.tag || "couple-interaction",
      renotify: false,
      data: { url: payload.url || appUrl("./"), notificationId: payload.notificationId || null },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = appUrl(event.notification.data?.url || "./");
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => {
      try { return new URL(client.url).origin === new URL(destination).origin; } catch { return false; }
    });
    if (existing) {
      if ("navigate" in existing) await existing.navigate(destination);
      return existing.focus();
    }
    return self.clients.openWindow(destination);
  })());
});
