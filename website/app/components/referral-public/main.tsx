import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReferralLandingPage } from "./ReferralLandingPage";
import "../../globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ReferralLandingPage />
  </StrictMode>,
);
