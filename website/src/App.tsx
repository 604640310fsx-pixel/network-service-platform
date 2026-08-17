import { Navigate, Route, Routes } from "react-router-dom";
import { DashboardShell } from "../app/components/DashboardShell";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/:section" element={<DashboardShell />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
