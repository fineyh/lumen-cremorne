import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";

// /m is the phone app (PWA) for workers, drivers and shop owners; everything else is the Precinct Console.
const isPhone = window.location.pathname === "/m" || window.location.pathname.startsWith("/m/");
const Root = isPhone ? lazy(() => import("./mobile/MobileApp")) : lazy(() => import("./ConsoleRoot"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>,
);

if (isPhone && "serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}
