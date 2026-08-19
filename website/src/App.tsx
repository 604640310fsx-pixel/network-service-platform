import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { LoginPage } from "../app/components/auth/LoginPage";
import { RegisterPage } from "../app/components/auth/RegisterPage";
import { DashboardShell } from "../app/components/DashboardShell";
import { AuthProvider, useAuth } from "../app/lib/auth";

function LoginRoute() {
  const { status } = useAuth();

  if (status === "checking") return null;
  if (status === "authenticated") return <Navigate to="/dashboard" replace />;
  return <LoginPage />;
}

function SectionRoute() {
  const { section } = useParams();
  const { status } = useAuth();

  if (section === "subscribe") return <DashboardShell />;
  if (status === "checking") return null;
  if (status === "unauthenticated") return <Navigate to="/login" replace />;
  return <DashboardShell />;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        {/* 静态 Auth 路由必须先于动态 /:section 命中。 */}
        <Route path="/login" element={<LoginRoute />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/:section" element={<SectionRoute />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AuthProvider>
  );
}
