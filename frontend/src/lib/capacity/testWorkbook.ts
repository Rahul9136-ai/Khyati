// Test helper: a tiny workbook with every input sheet, to exercise joins without the real file.
import * as XLSX from "xlsx"

/** A tiny workbook with every sheet, to exercise joins without the real file. */
export function miniWorkbook(): ArrayBuffer {
  const wb = XLSX.utils.book_new()
  const add = (name: string, aoa: unknown[][]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  const task15 = ["P1", "PN", "DU", "PROJECT X", "V", "Coding", "SF", "Spec", "Transaction based - Hourly TAT", "NA", "NA"]
  add("User Mapping", [["Actual HC"], ["Emp Id", "DOJ", "Date of Production", "Emp Name", "Job Name", "Customer Name", "Service Line", "4C",
    "Service Line Classification", "Employee Category", "SBU", "BU ", "Division", "Department", "Sub-Department", "Specialty", "Country",
    "Legal Entity", "Business Unit", "Location", "City", "Employment Type", "Employment Status", "New Joinee Confirmation Status",
    "Probation Confirmation Date", "User Status"],
  ...Array.from({ length: 10 }, (_, i) => [i + 1, "2020-01-01", "2020-02-01", `A${i}`, "CODER", "PROJECT X", "CODING", "", "", "02. Production",
    "", "", "", "", "", "Spec", "IN", "", "", "Chennai-I", "CHENNAI", "Employee", "ACTIVE", "", "", "PRODUCTION"]),
  [11, "2020-01-01", "2020-02-01", "Q", "QCA CODER", "PROJECT X", "Coding", "", "", "02. QA", "", "", "", "", "", "Spec", "IN", "", "",
    "Chennai-I", "Chennai", "Employee", "ACTIVE", "", "", "QA-SUPPORT"]])
  add("Forecast details", [["REQUIRED HC"], ["Customer Name", "SERVICE_LINE", "SPECIALTY", "SUB_FUNCTION", "BILL_TYPE", "PROJECT_NUMBER (New)",
    "TASK_NUMBER (New)", "Geo", "Location", "Units _ Sep'26", "Units _ Oct'26"],
  ["PROJECT X", "Coding", "Spec", "SF", "Transaction based - Hourly TAT", "P1", "T1", "India", "Chennai", 2100, 0],
  ["PROJECT X", "Coding", "Spec", "SF", "Transaction based - Hourly TAT", "P1", "T-MISSING", "India", "Chennai", 0, 500]])
  add("Target Details", [[], [...task15.slice(0, 11), "TaskNo", "CustomerProcess", "BillingSoftware", "EndCustomerName", "Peak Target Prod",
    "Peak Week -Lateral", "Peak Week - Training", "Peak Target QCA", "Peak Week -QCA"].map((h, i) => i < 11 ? ["ProjectID", "ProjectName",
    "DeliveryUnit", "Customer Name", "Vertical", "ServiceLine", "SubFunction", "Specialty", "BillingType", "CustomerLocation",
    "Customer FacilityPractice Hospital"][i] : h), [...task15, "T1", "NA", "EPIC", "E", 10, 4, 8, 50, 6]])
  add("Ramp Grid", [["ProjectID", "ProjectName", "DeliveryUnit", "Customer Name", "Vertical", "ServiceLine", "SubFunction", "Specialty", "BillingType",
    "CustomerLocation", "Customer FacilityPractice Hospital", "TaskNo", "CustomerProcess", "BillingSoftware", "EndCustomerName", "User Type",
    ...Array.from({ length: 16 }, (_, i) => `Week ${i + 1} %`)], [...task15, "T1", "NA", "EPIC", "E", "Trainee", ...Array(16).fill(100)]])
  add("Hiring (RR)", [["S.No", "Type", "RR Number", "PS RR Number", "Opening", "Entity", "Vertical", "SL-As Per EM", "4C", "Location", "Geo", "SBU",
    "Requested date", "Requested month", "Designation", "Grade", "Specialty", "Employee Matrix-Specialty", "Due to deliver", "Due to delivery month",
    "TAT Status", "BRD Status", "Category", "Type of hiring", "Customer Name", "Sub-Project", "Approved Status", "Status", "New Department", "SBU",
    "BU", "Division", "Original cat"],
  [1, "Laterals", "-", "RR1", 2, "", "", "CODING", "", "CHENNAI", "", "", "", "", "CODER", "", "", "", "", "Sep'26", "", "", "", "", "PROJECT X", "", "Apprvoed", "OPEN", "", "", "", "", ""],
  [2, "Trainee", "-", "RR2", 1, "", "", "Coding", "", "CHENNAI", "", "", "", "", "QCA CODER", "", "", "", "", "Sep'26", "", "", "", "", "PROJECT X", "", "Approved", "OPEN", "", "", "", "", ""],
  [3, "Trainee", "-", "RR3", 1, "", "", "Coding", "", "CHENNAI", "", "", "", "", "CODER", "", "", "", "", "May'26", "", "", "", "", "PROJECT X", "", "Approved", "OPEN", "", "", "", "", ""]])
  add("Budgeted Buffer", [["Finacial Year", "Country", "Customer Name", "SL", "Location", "Department", "Month", "Base FTE", "Required FTE", "Buffer HC",
    "Buffer %", "Shrinkage", "Prod Buffer", "Glidepath+Complexity+Review", "Growth Buffer", "Shrinkage %", "Prod Buffer %", "Glide Buffer %", "Growth Buffer %"],
  ["CY 26", "IND", "PROJECT X", "Coding", "Chennai", "D", "Sep'26", 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0, 0.05, 0]])
  add("Actual Shrinkage", [["DU", "Country", "Customer Name", "Service Line", "Location", "M1", "M2", "M3", "Last 3 month cum trend - %"],
    ["D", "IND", "PROJECT X", "Coding", "Chennai", 0, 0, 0, 0.08]])
  add("Actual Attrition", [["Country", "Desg", "Customer Name", "Vertical", "Location", "M1", "M2", "M3", "Last 3 month cum trend - %"],
    ["IND", "Prod", "PROJECT X", "Coding", "Chennai", 0, 0, 0, 0.1]])
  add("Budgeted Attrition", [["Year", "KPI", "Country", "Customer Name", "SL", "Location", "Department", "Month", "Denominator", "Numerator", ""],
    ["CY 26", "Attrition", "IND", "PROJECT X", "Coding", "Chennai", "D", "Sep'26", 100, 5]])
  add("Budgeted QCA_%", [["Year", "KPI", "Country", "Customer Name", "SL", "Deparment", "Month", "Denominator", "Numerator"],
    ["CY26", "QCA", "IND", "PROJECT X", "Coding", "D", "Sep'26", 100, 10]])
  add("Training Days", [["Customer Name", "Vertical", "Lateral", "Trainee", "QCA"], ["PROJECT X", "Coding", 1, 7, 1]])
  add("Designation Type", [["DU", "Designation", "Designation"], ["D", "CODER", "Lateral"], ["D", "QCA CODER", "QCA"]])
  add("SAMPLING GRID", [["User Type", "Customer Name", "Service Line", "Specialty", ...Array.from({ length: 12 }, (_, i) => `Week-${i + 1}`), "BAU"],
    ["Lateral", "PROJECT X", "Coding", "Spec", ...Array(12).fill(1), 0.15]])
  add("W.days", [["Month", "Days"], ["Sep'26", 21], ["Oct'26", 22]])
  return XLSX.write(wb, { type: "array", bookType: "xlsx" })
}

