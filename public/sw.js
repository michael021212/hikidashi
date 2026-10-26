// プッシュはペイロードなしで届くので、件数はここで取得して通知を組み立てる

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let body = "";
      try {
        const res = await fetch("/api/stats", { credentials: "same-origin" });
        if (res.ok) {
          const { due } = await res.json();
          body = `${due}問`;
        }
      } catch {}
      await self.registration.showNotification("復習の時間です", {
        body,
        tag: "review",
        renotify: true,
        icon: "/icon-192.png",
        data: { url: "/#/review" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          return client.navigate(url);
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
