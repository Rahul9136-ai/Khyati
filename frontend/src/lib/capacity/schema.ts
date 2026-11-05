// Input sheet schemas (build prompt §2). Header names are validated exactly,
// after trimming and a case-insensitive compare.

export type ColType = "text" | "number" | "date" | "month" | "pct"

export interface ColDef {
  /** Display/storage name (after renames like SBU → SBU_1). */
  name: string
  /** Header text expected in the file (defaults to `name`). */
  header?: string
  /** For a header that appears more than once: which occurrence (0-based). */
  occurrence?: number
  type: ColType
  /** Optional columns aren't required for the upload to be accepted. */
  optional?: boolean
}

export type SheetId =
  | "userMapping" | "forecast" | "target" | "ramp" | "hiring" | "budgetBuffer"
  | "actualShrinkage" | "actualAttrition" | "budgetAttrition" | "budgetQca"
  | "trainingDays" | "designationType" | "sampling" | "workingDays"

export interface SheetDef {
  id: SheetId
  label: string
  /** Workbook tab names this sheet may be found under (case-insensitive). */
  sheetNames: string[]
  /** 1-based header row in the source file. */
  headerRow: number
  columns: ColDef[]
  /** Forecast only: repeating `Units _ Mon'YY` columns, unpivoted to (Month, Units). */
  monthColumns?: { prefix: RegExp }
  /** Row count in the sample file (Definition of Done §8). */
  expectedRows: number
  note?: string
}

const t = (name: string, extra: Partial<ColDef> = {}): ColDef => ({ name, type: "text", ...extra })
const n = (name: string, extra: Partial<ColDef> = {}): ColDef => ({ name, type: "number", ...extra })
const d = (name: string, extra: Partial<ColDef> = {}): ColDef => ({ name, type: "date", ...extra })
const m = (name: string, extra: Partial<ColDef> = {}): ColDef => ({ name, type: "month", ...extra })
const p = (name: string, extra: Partial<ColDef> = {}): ColDef => ({ name, type: "pct", ...extra })

const TASK_COLS: ColDef[] = [
  t("ProjectID"), t("ProjectName"), t("DeliveryUnit"), t("Customer Name"), t("Vertical"),
  t("ServiceLine"), t("SubFunction"), t("Specialty"), t("BillingType"), t("CustomerLocation"),
  t("Customer FacilityPractice Hospital"), t("TaskNo"), t("CustomerProcess"), t("BillingSoftware"),
  t("EndCustomerName"),
]

export const RAMP_WEEKS = 16
export const SAMPLING_WEEKS = 12

export const SHEETS: SheetDef[] = [
  {
    id: "userMapping", label: "User Mapping", sheetNames: ["User Mapping"], headerRow: 2, expectedRows: 2688,
    note: "Actual HC roster. Joins on City (not Location).",
    columns: [
      t("Emp Id"), d("DOJ"), d("Date of Production"), t("Emp Name"), t("Job Name"), t("Customer Name"),
      t("Service Line"), t("4C"), t("Service Line Classification"), t("Employee Category"), t("SBU"),
      t("BU"), t("Division"), t("Department"), t("Sub-Department"), t("Specialty"), t("Country"),
      t("Legal Entity"), t("Business Unit"), t("Location"), t("City"), t("Employment Type"),
      t("Employment Status"), t("New Joinee Confirmation Status"), d("Probation Confirmation Date"),
      t("User Status"),
    ],
  },
  {
    id: "forecast", label: "Forecast Details", sheetNames: ["Forecast details", "Forecast Details"], headerRow: 2,
    expectedRows: 605, note: "Required volume / FTE by month. The 12 month columns are unpivoted to (Month, Units).",
    columns: [
      t("Customer Name"), t("SERVICE_LINE"), t("SPECIALTY"), t("SUB_FUNCTION"), t("BILL_TYPE"),
      t("PROJECT_NUMBER (New)"), t("TASK_NUMBER (New)"), t("Geo"), t("Location"),
    ],
    monthColumns: { prefix: /^units\s*_\s*/i },
  },
  {
    id: "target", label: "Target Details", sheetNames: ["Target Details"], headerRow: 2, expectedRows: 607,
    note: "Peak productivity targets. TaskNo is unique and is the join key.",
    columns: [
      ...TASK_COLS, n("Peak Target Prod"), n("Peak Week -Lateral"), n("Peak Week - Training"),
      n("Peak Target QCA"), n("Peak Week -QCA"),
    ],
  },
  {
    id: "ramp", label: "Ramp Grid", sheetNames: ["Ramp Grid"], headerRow: 1, expectedRows: 1821,
    note: "Weekly ramp % by user type. Whole percentages (10 = 10%).",
    columns: [...TASK_COLS, t("User Type"), ...Array.from({ length: RAMP_WEEKS }, (_, i) => n(`Week ${i + 1} %`))],
  },
  {
    id: "hiring", label: "Hiring (RR)", sheetNames: ["Hiring (RR)", "Hiring"], headerRow: 1, expectedRows: 478,
    note: "Open requisitions = additions. SBU appears twice → SBU_1 / SBU_2. S.No is a running number.",
    columns: [
      n("S.No"), t("Type"), t("RR Number"), t("PS RR Number"), n("Opening"), t("Entity"), t("Vertical"),
      t("SL-As Per EM"), t("4C"), t("Location"), t("Geo"), t("SBU_1", { header: "SBU", occurrence: 0 }),
      d("Requested date"), m("Requested month"), t("Designation"), t("Grade"), t("Specialty"),
      t("Employee Matrix-Specialty"), d("Due to deliver"), m("Due to delivery month"), t("TAT Status"),
      t("BRD Status"), t("Category"), t("Type of hiring"), t("Customer Name"), t("Sub-Project"),
      t("Approved Status"), t("Status"), t("New Department"), t("SBU_2", { header: "SBU", occurrence: 1 }),
      t("BU"), t("Division"), t("Original cat"),
    ],
  },
  {
    id: "budgetBuffer", label: "Budgeted Buffer", sheetNames: ["Budgeted Buffer"], headerRow: 1, expectedRows: 770,
    note: "% columns are decimals (0.08 = 8%).",
    columns: [
      t("Finacial Year"), t("Country"), t("Customer Name"), t("SL"), t("Location"), t("Department"), m("Month"),
      n("Base FTE"), n("Required FTE"), n("Buffer HC"), p("Buffer %"), n("Shrinkage"), n("Prod Buffer"),
      n("Glidepath+Complexity+Review"), n("Growth Buffer"), p("Shrinkage %"), p("Prod Buffer %"),
      p("Glide Buffer %"), p("Growth Buffer %"),
    ],
  },
  {
    id: "actualShrinkage", label: "Actual Shrinkage", sheetNames: ["Actual Shrinkage"], headerRow: 1, expectedRows: 84,
    note: "\"Last 3 month cum trend - %\" is the actual %.",
    columns: [t("DU"), t("Country"), t("Customer Name"), t("Service Line"), t("Location"), p("M1"), p("M2"), p("M3"),
      p("Last 3 month cum trend - %")],
  },
  {
    id: "actualAttrition", label: "Actual Attrition", sheetNames: ["Actual Attrition"], headerRow: 1, expectedRows: 144,
    note: "Desg = Prod / QCA. Vertical = Service Line. \"Last 3 month cum trend - %\" is the actual %.",
    columns: [t("Country"), t("Desg"), t("Customer Name"), t("Vertical"), t("Location"), p("M1"), p("M2"), p("M3"),
      p("Last 3 month cum trend - %")],
  },
  {
    id: "budgetAttrition", label: "Budgeted Attrition", sheetNames: ["Budgeted Attrition"], headerRow: 1, expectedRows: 770,
    note: "Attrition % = Numerator ÷ Denominator (source col K, blank header).",
    columns: [t("Year"), t("KPI"), t("Country"), t("Customer Name"), t("SL"), t("Location"), t("Department"),
      m("Month"), n("Denominator"), n("Numerator")],
  },
  {
    id: "budgetQca", label: "Budgeted QCA %", sheetNames: ["Budgeted QCA_%", "Budgeted QCA %", "Budgeted QCA"], headerRow: 1,
    expectedRows: 310, note: "No Location column — applies to every location. QCA % = Numerator ÷ Denominator.",
    columns: [t("Year"), t("KPI"), t("Country"), t("Customer Name"), t("SL"), t("Deparment"), m("Month"),
      n("Denominator"), n("Numerator")],
  },
  {
    id: "trainingDays", label: "Training Days", sheetNames: ["Training Days"], headerRow: 1, expectedRows: 32,
    note: "Training days per user type.",
    columns: [t("Customer Name"), t("Vertical"), n("Lateral"), n("Trainee"), n("QCA")],
  },
  {
    id: "designationType", label: "Designation Type", sheetNames: ["Designation Type"], headerRow: 1, expectedRows: 64,
    note: "The 2nd Designation column is the User Type (Lateral / Trainee / QCA).",
    columns: [t("DU"), t("Designation", { occurrence: 0 }), t("User Type", { header: "Designation", occurrence: 1 })],
  },
  {
    id: "sampling", label: "Sampling Grid", sheetNames: ["SAMPLING GRID", "Sampling Grid"], headerRow: 1, expectedRows: 180,
    note: "Decimals (1 = 100% audited). Week-1…Week-12 for ramp users, BAU otherwise.",
    columns: [t("User Type"), t("Customer Name"), t("Service Line"), t("Specialty"),
      ...Array.from({ length: SAMPLING_WEEKS }, (_, i) => p(`Week-${i + 1}`)), p("BAU")],
  },
  {
    id: "workingDays", label: "Working Days", sheetNames: ["W.days", "Working Days"], headerRow: 1, expectedRows: 12,
    columns: [m("Month"), n("Days")],
  },
]

export const SHEET_BY_ID = Object.fromEntries(SHEETS.map((s) => [s.id, s])) as Record<SheetId, SheetDef>

export function headerKey(h: unknown): string {
  return h == null ? "" : String(h).trim().replace(/\s+/g, " ").toLowerCase()
}
