import { Navigate, Route, Routes } from "react-router-dom";
import { LoginPage } from "../app/components/auth/LoginPage";
import { RegisterPage } from "../app/components/auth/RegisterPage";
import { DashboardShell } from "../app/components/DashboardShell";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      {/* 静态 /login 必须先于动态 /:section 命中，否则会被当作未知 section 重定向。 */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/:section" element={<DashboardShell />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
