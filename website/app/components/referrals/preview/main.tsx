import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "../../../lib/auth";
import "../../../globals.css";
import { ReferralPreview } from "./ReferralPreview";

/* 隔离预览入口：由 website/referral-preview.html 引用，仅开发服务器使用；
   Shell 依赖的 Router / AuthProvider 按生产入口同样方式提供，不做替身。 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ReferralPreview />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
