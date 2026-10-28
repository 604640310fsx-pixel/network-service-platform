import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../lib/i18n";
import { ReferralLandingPage } from "./ReferralLandingPage";
import "../../globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <ReferralLandingPage />
    </I18nProvider>
  </StrictMode>,
);
