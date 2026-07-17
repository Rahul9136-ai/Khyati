import { Route, Routes } from "react-router-dom"

import { AutomationRunner } from "@/components/automation-runner"
import { AuthGate } from "@/components/auth-gate"
import { AppShell } from "@/components/layout/app-shell"
import { RoleGuard } from "@/components/role-guard"
import { Adherence } from "@/pages/Adherence"
import { Audit } from "@/pages/Audit"
import { Automation } from "@/pages/Automation"
import { Autonomy } from "@/pages/Autonomy"
import { Capacity } from "@/pages/Capacity"
import { Copilot } from "@/pages/Copilot"
import { Dashboard } from "@/pages/Dashboard"
import { Employees } from "@/pages/Employees"
import { Erlang } from "@/pages/Erlang"
import { Forecasting } from "@/pages/Forecasting"
import { Help } from "@/pages/Help"
import { Intraday } from "@/pages/Intraday"
import { Pto } from "@/pages/Pto"
import { Reports } from "@/pages/Reports"
import { Rta } from "@/pages/Rta"
import { Scenarios } from "@/pages/Scenarios"
import { Scheduling } from "@/pages/Scheduling"
import { Settings } from "@/pages/Settings"
import { ShiftPatterns } from "@/pages/ShiftPatterns"
import { Skills } from "@/pages/Skills"
import { Swaps } from "@/pages/Swaps"

export default function App() {
  return (
    <AuthGate>
      <AutomationRunner />
      <AppShell>
        <Routes>
        <Route path="/" element={<RoleGuard module="dashboard"><Dashboard /></RoleGuard>} />
        <Route path="/forecasting" element={<RoleGuard module="forecasting"><Forecasting /></RoleGuard>} />
        <Route path="/capacity" element={<RoleGuard module="capacity"><Capacity /></RoleGuard>} />
        <Route path="/erlang" element={<RoleGuard module="erlang"><Erlang /></RoleGuard>} />
        <Route path="/scenarios" element={<RoleGuard module="scenarios"><Scenarios /></RoleGuard>} />
        <Route path="/scheduling" element={<RoleGuard module="scheduling"><Scheduling /></RoleGuard>} />
        <Route path="/shift-patterns" element={<RoleGuard module="shiftPatterns"><ShiftPatterns /></RoleGuard>} />
        <Route path="/swaps" element={<RoleGuard module="swaps"><Swaps /></RoleGuard>} />
        <Route path="/intraday" element={<RoleGuard module="intraday"><Intraday /></RoleGuard>} />
        <Route path="/rta" element={<RoleGuard module="realtime"><Rta /></RoleGuard>} />
        <Route path="/adherence" element={<RoleGuard module="adherence"><Adherence /></RoleGuard>} />
        <Route path="/automation" element={<RoleGuard module="automation"><Automation /></RoleGuard>} />
        <Route path="/autonomy" element={<RoleGuard module="automation"><Autonomy /></RoleGuard>} />
        <Route path="/help" element={<RoleGuard module="help"><Help /></RoleGuard>} />
        <Route path="/employees" element={<RoleGuard module="employees"><Employees /></RoleGuard>} />
        <Route path="/skills" element={<RoleGuard module="skills"><Skills /></RoleGuard>} />
        <Route path="/pto" element={<RoleGuard module="pto"><Pto /></RoleGuard>} />
        <Route path="/reports" element={<RoleGuard module="reports"><Reports /></RoleGuard>} />
        <Route path="/copilot" element={<RoleGuard module="copilot"><Copilot /></RoleGuard>} />
        <Route path="/audit" element={<RoleGuard module="audit"><Audit /></RoleGuard>} />
        <Route path="/settings" element={<RoleGuard module="settings"><Settings /></RoleGuard>} />
        </Routes>
      </AppShell>
    </AuthGate>
  )
}
