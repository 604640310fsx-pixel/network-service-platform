import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { HomePage } from "../app/components/home/HomePage";
import { LoginPage } from "../app/components/auth/LoginPage";
import { RegisterPage } from "../app/components/auth/RegisterPage";
import { AuthSessionChecking } from "../app/components/auth/AuthShell";
import { DashboardShell } from "../app/components/DashboardShell";
import { DiagnosisPage } from "../app/components/diagnosis/DiagnosisPage";
import { NotFoundPage } from "../app/components/not-found/NotFoundPage";
import { SubmitRequestPage } from "../app/components/subscribe/SubmitRequestPage";
import { AuthProvider, useAuth } from "../app/lib/auth";
import { sectionKeys, type SectionKey } from "../app/lib/sections";

function isSectionKey(section: string | undefined): section is SectionKey {
  return section !== undefined && sectionKeys.includes(section as SectionKey);
}

function LoginRoute() {
  const { status } = useAuth();

  if (status === "checking") return <AuthSessionChecking />;
  if (status === "authenticated") return <Navigate to="/dashboard" replace />;
  return <LoginPage />;
}

function SectionRoute() {
  const { section } = useParams();
  const { status } = useAuth();

  if (!isSectionKey(section)) return <NotFoundPage />;
  if (section === "subscribe" || section === "monitor" || section === "status") return <DashboardShell />;
  if (status === "checking") return <AuthSessionChecking />;
  if (status === "unauthenticated") return <Navigate to="/login" replace />;
  return <DashboardShell />;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<HomePage />} />
        {/* 静态 Auth 路由必须先于动态 /:section 命中。 */}
        <Route path="/login" element={<LoginRoute />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/diagnosis" element={<DiagnosisPage />} />
        {/* 公开的独立提交页，必须先于动态 /:section，避免两段路径落到兜底重定向。 */}
        <Route path="/subscribe/request" element={<SubmitRequestPage />} />
        <Route path="/:section" element={<SectionRoute />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AuthProvider>
  );
}
