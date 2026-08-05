"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { createBrowserSupabase, workerEmailFromPhone } from "@/lib/supabase";

type Role = "admin" | "employee";
type JobStatus = "pending" | "approved" | "completed" | "rejected" | "cancelled";
type JobSource = "regular" | "midrag" | "owner";
type PayMode = "percentage" | "fixed" | "none";
type Consent = "unknown" | "approved" | "declined";
type Tab = "dashboard" | "jobs" | "customers" | "employees" | "payments";

type Profile = {
  id: string;
  role: Role;
  full_name: string;
  phone: string | null;
  active: boolean;
};

type Employee = {
  id: string;
  user_id: string | null;
  name: string;
  phone: string | null;
  regular_rate: number;
  midrag_rate: number;
  active: boolean;
  notes: string | null;
};

type Customer = {
  id: string;
  customer_name: string;
  business_name: string | null;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  address: string | null;
  business_number: string | null;
  marketing_consent: Consent;
  tags: string[];
  notes: string | null;
};

type Job = {
  id: string;
  employee_id: string;
  customer_id: string | null;
  job_date: string;
  service_type: string;
  city: string | null;
  source: JobSource;
  status: JobStatus;
  gross_amount: number;
  direct_expenses: number;
  pay_mode: PayMode;
  use_default_rate: boolean;
  rate_percent: number | null;
  fixed_pay: number;
  employee_pay: number;
  factory_net: number;
  notes: string | null;
  submitted_by: string | null;
  created_at: string;
  employees?: { name: string; regular_rate: number; midrag_rate: number } | null;
  customers?: { customer_name: string; business_name: string | null; phone: string | null } | null;
};

type Payment = {
  id: string;
  employee_id: string;
  amount: number;
  payment_date: string;
  payment_method: string | null;
  notes: string | null;
  employees?: { name: string } | null;
};

type EmployeeSummary = {
  employee_id: string;
  name: string;
  regular_rate: number;
  midrag_rate: number;
  approved_jobs: number;
  gross_total: number;
  earned_total: number;
  paid_total: number;
  balance_due: number;
};

type CustomerSummary = {
  customer_id: string;
  customer_name: string;
  business_name: string | null;
  phone: string | null;
  city: string | null;
  total_jobs: number;
  jobs_this_year: number;
  lifetime_revenue: number;
  average_order: number;
  last_job_date: string | null;
};

type ToastData = { id: number; message: string; tone: "success" | "error" | "info" };

const money = new Intl.NumberFormat("he-IL", {
  style: "currency",
  currency: "ILS",
  maximumFractionDigits: 2,
});

const number = new Intl.NumberFormat("he-IL");
const today = () => new Date().toISOString().slice(0, 10);

const SERVICE_OPTIONS = [
  "ניקוי ספה",
  "ניקוי מזרן",
  "ניקוי כיסאות",
  "ניקוי כורסה",
  "ניקוי שטיח",
  "ניקוי ריפודי רכב",
  "ניקוי חלונות",
  "ניקיון לפני אכלוס",
  "תחזוקה לבית או למשרד",
  "אחר",
];

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: "ממתינה לאישור",
  approved: "מאושרת",
  completed: "הושלמה",
  rejected: "נדחתה",
  cancelled: "בוטלה",
};

const SOURCE_LABELS: Record<JobSource, string> = {
  regular: "עבודה רגילה",
  midrag: "מידרג",
  owner: "עבודת בעלים",
};

function safeNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("he-IL", { dateStyle: "medium" }).format(new Date(`${value}T12:00:00`));
}

function normalizePhone(value: string) {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("972")) digits = `0${digits.slice(3)}`;
  if (!digits.startsWith("0") && digits.length === 9) digits = `0${digits}`;
  return digits;
}

function Modal({
  title,
  eyebrow,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`modal-card ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
            <h2 id="modal-title">{title}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="סגירה">
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function StatCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <article className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {note ? <small>{note}</small> : null}
    </article>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <div className="brand-mark">F</div>
      <h1>Factory Clean OS</h1>
      <p>טוען את המערכת…</p>
    </main>
  );
}

function LoginScreen({
  onLoggedIn,
  supabase,
}: {
  onLoggedIn: () => Promise<void>;
  supabase: SupabaseClient;
}) {
  const [mode, setMode] = useState<"admin" | "employee">("admin");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");

    // .toLowerCase() נוסף כדי שהתחברות מנהל לא תיכשל רק בגלל אותיות
    // גדולות/קטנות שהוקלדו אחרת ממה שנשמר בפועל ב-Supabase Auth.
    const loginEmail = mode === "admin" ? email.trim().toLowerCase() : workerEmailFromPhone(phone);
    const { error: loginError } = await supabase.auth.signInWithPassword({
      email: loginEmail,
      password,
    });

    if (loginError) {
      // אבחון זמני לבעיית ההתחברות (למחוק אחרי שהתקלה נפתרת בפועל): מציג
      // בקונסול ועל המסך את הודעת השגיאה האמיתית שחוזרת מ-Supabase, ולא
      // רק את הניסוח הכללי - כדי להבחין בין סיסמה שגויה בפועל לבין בעיית
      // תצורה (URL/מפתח שגויים, בעיית רשת וכו') שנראית למשתמש בדיוק אותו
      // הדבר אחרת.
      console.error("[FactoryCleanOS login] שגיאת signInWithPassword מ-Supabase:", loginError);
      const genericMessage = mode === "employee" ? "מספר הטלפון או הקוד האישי אינם נכונים." : "האימייל או הסיסמה אינם נכונים.";
      setError(`${genericMessage} (פרטי שגיאה זמניים לאבחון: ${loginError.message})`);
      setBusy(false);
      return;
    }

    await onLoggedIn();
    setBusy(false);
  }

  return (
    <main className="login-page">
      <section className="login-copy">
        <div className="brand-lockup">
          <div className="brand-mark">F</div>
          <div>
            <strong>Factory Clean</strong>
            <span>מערכת ניהול העסק</span>
          </div>
        </div>
        <h1>כל העסק במקום אחד.</h1>
        <p>עבודות, לקוחות, עובדים, אחוזים והתחשבנות — בזמן אמת מכל טלפון ומחשב.</p>
        <div className="login-benefits">
          <span>✓ עבודה שעובד שולח מופיעה למנהל מיד</span>
          <span>✓ כל עובד רואה רק את העבודות והשכר שלו</span>
          <span>✓ חישובי שכר ופער לתשלום באופן אוטומטי</span>
        </div>
      </section>

      <section className="login-card">
        <span className="eyebrow">כניסה מאובטחת</span>
        <h2>ברוכים הבאים</h2>
        <div className="segment-control" role="tablist">
          <button type="button" className={mode === "admin" ? "active" : ""} onClick={() => { setMode("admin"); setError(""); }}>
            כניסת מנהל
          </button>
          <button type="button" className={mode === "employee" ? "active" : ""} onClick={() => { setMode("employee"); setError(""); }}>
            כניסת עובד
          </button>
        </div>

        <form onSubmit={submit} className="form-stack">
          {mode === "admin" ? (
            <label>
              <span>אימייל</span>
              <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </label>
          ) : (
            <label>
              <span>מספר טלפון</span>
              <input type="tel" inputMode="tel" autoComplete="tel" placeholder="05X-XXXXXXX" value={phone} onChange={(event) => setPhone(event.target.value)} required />
            </label>
          )}
          <label>
            <span>{mode === "admin" ? "סיסמה" : "קוד אישי בן 4 ספרות"}</span>
            <input
              type="password"
              inputMode={mode === "employee" ? "numeric" : "text"}
              maxLength={mode === "employee" ? 4 : undefined}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button type="submit" className="primary-button large" disabled={busy}>
            {busy ? "נכנס…" : "כניסה למערכת"}
          </button>
        </form>
      </section>
    </main>
  );
}

export default function FactoryCleanOS() {
  const supabase = useMemo(() => createBrowserSupabase(), []);
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [currentEmployee, setCurrentEmployee] = useState<Employee | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [employeeSummaries, setEmployeeSummaries] = useState<EmployeeSummary[]>([]);
  const [customerSummaries, setCustomerSummaries] = useState<CustomerSummary[]>([]);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [busy, setBusy] = useState(false);
  const [jobModal, setJobModal] = useState(false);
  const [customerModal, setCustomerModal] = useState(false);
  const [employeeModal, setEmployeeModal] = useState(false);
  const [paymentModal, setPaymentModal] = useState(false);
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<JobStatus | "all">("all");
  const [period, setPeriod] = useState<"month" | "year" | "all">("month");
  const initialRealtime = useRef(true);

  const isAdmin = profile?.role === "admin";

  const toast = useCallback((message: string, tone: ToastData["tone"] = "success") => {
    const id = Date.now() + Math.random();
    setToasts((items) => [...items, { id, message, tone }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 4200);
  }, []);

  const loadData = useCallback(async () => {
    const { data: authData } = await supabase.auth.getSession();
    const activeSession = authData.session;
    setSession(activeSession);
    if (!activeSession) {
      setProfile(null);
      setCurrentEmployee(null);
      setBooting(false);
      return;
    }

    const userId = activeSession.user.id;
    const { data: profileData, error: profileError } = await supabase
      .from("profiles")
      .select("id, role, full_name, phone, active")
      .eq("id", userId)
      .single();

    if (profileError || !profileData) {
      toast("לא נמצא פרופיל משתמש. בדוק את החיבור ב-Supabase.", "error");
      setBooting(false);
      return;
    }

    const typedProfile = profileData as Profile;
    setProfile(typedProfile);

    const [employeesResult, customersResult, jobsResult, paymentsResult, employeeSummaryResult, customerSummaryResult] = await Promise.all([
      supabase.from("employees").select("id, user_id, name, phone, regular_rate, midrag_rate, active, notes").order("name"),
      supabase.from("customers").select("id, customer_name, business_name, contact_person, phone, email, city, address, business_number, marketing_consent, tags, notes").order("customer_name").limit(3000),
      supabase
        .from("jobs")
        .select("*, employees(name, regular_rate, midrag_rate), customers(customer_name, business_name, phone)")
        .order("created_at", { ascending: false })
        .limit(1000),
      supabase.from("employee_payments").select("*, employees(name)").order("payment_date", { ascending: false }).limit(1000),
      supabase.from("employee_financial_summary").select("*").order("name"),
      supabase.from("customer_activity_summary").select("*").order("lifetime_revenue", { ascending: false }).limit(3000),
    ]);

    const firstError = [employeesResult.error, customersResult.error, jobsResult.error, paymentsResult.error, employeeSummaryResult.error, customerSummaryResult.error].find(Boolean);
    if (firstError) toast(firstError.message, "error");

    const loadedEmployees = (employeesResult.data || []).map((row) => ({
      ...row,
      regular_rate: safeNumber(row.regular_rate),
      midrag_rate: safeNumber(row.midrag_rate),
    })) as Employee[];

    setEmployees(loadedEmployees);
    setCurrentEmployee(loadedEmployees.find((employee) => employee.user_id === userId) || null);
    setCustomers((customersResult.data || []) as Customer[]);
    setJobs((jobsResult.data || []).map((row) => ({
      ...row,
      gross_amount: safeNumber(row.gross_amount),
      direct_expenses: safeNumber(row.direct_expenses),
      rate_percent: row.rate_percent === null ? null : safeNumber(row.rate_percent),
      fixed_pay: safeNumber(row.fixed_pay),
      employee_pay: safeNumber(row.employee_pay),
      factory_net: safeNumber(row.factory_net),
    })) as Job[]);
    setPayments((paymentsResult.data || []).map((row) => ({ ...row, amount: safeNumber(row.amount) })) as Payment[]);
    setEmployeeSummaries((employeeSummaryResult.data || []).map((row) => ({
      ...row,
      regular_rate: safeNumber(row.regular_rate),
      midrag_rate: safeNumber(row.midrag_rate),
      approved_jobs: safeNumber(row.approved_jobs),
      gross_total: safeNumber(row.gross_total),
      earned_total: safeNumber(row.earned_total),
      paid_total: safeNumber(row.paid_total),
      balance_due: safeNumber(row.balance_due),
    })) as EmployeeSummary[]);
    setCustomerSummaries((customerSummaryResult.data || []).map((row) => ({
      ...row,
      total_jobs: safeNumber(row.total_jobs),
      jobs_this_year: safeNumber(row.jobs_this_year),
      lifetime_revenue: safeNumber(row.lifetime_revenue),
      average_order: safeNumber(row.average_order),
    })) as CustomerSummary[]);
    setBooting(false);
  }, [supabase, toast]);

  useEffect(() => {
    void loadData();
    const { data } = supabase.auth.onAuthStateChange(() => {
      window.setTimeout(() => void loadData(), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [loadData, supabase]);

  useEffect(() => {
    if (!session) return;
    const channel = supabase
      .channel("factory-clean-os-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs" }, (payload) => {
        if (!initialRealtime.current && isAdmin && payload.eventType === "INSERT") {
          toast("עבודה חדשה התקבלה מעובד", "info");
        }
        void loadData();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "employee_payments" }, () => void loadData())
      .subscribe(() => {
        initialRealtime.current = false;
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [isAdmin, loadData, session, supabase, toast]);

  const periodJobs = useMemo(() => {
    const now = new Date();
    return jobs.filter((job) => {
      if (period === "all") return true;
      const date = new Date(`${job.job_date}T12:00:00`);
      if (period === "year") return date.getFullYear() === now.getFullYear();
      return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
    });
  }, [jobs, period]);

  const approvedPeriodJobs = periodJobs.filter((job) => job.status === "approved" || job.status === "completed");
  const totals = approvedPeriodJobs.reduce(
    (sum, job) => ({
      jobs: sum.jobs + 1,
      gross: sum.gross + job.gross_amount,
      employeePay: sum.employeePay + job.employee_pay,
      factory: sum.factory + job.factory_net,
    }),
    { jobs: 0, gross: 0, employeePay: 0, factory: 0 },
  );

  const mySummary = currentEmployee ? employeeSummaries.find((item) => item.employee_id === currentEmployee.id) : null;

  const filteredJobs = useMemo(() => {
    const query = search.trim().toLowerCase();
    return jobs.filter((job) => {
      if (statusFilter !== "all" && job.status !== statusFilter) return false;
      if (!query) return true;
      return [job.service_type, job.city, job.employees?.name, job.customers?.customer_name, job.customers?.business_name]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [jobs, search, statusFilter]);

  async function logout() {
    await supabase.auth.signOut();
    setTab("dashboard");
  }

  async function updateJobStatus(jobId: string, status: JobStatus) {
    setBusy(true);
    const { error } = await supabase.from("jobs").update({ status }).eq("id", jobId);
    if (error) toast(error.message, "error");
    else toast(status === "approved" ? "העבודה אושרה ונכנסה לחישובים" : `הסטטוס עודכן ל-${STATUS_LABELS[status]}`);
    await loadData();
    setBusy(false);
  }

  if (booting) return <LoadingScreen />;
  if (!session || !profile) return <LoginScreen onLoggedIn={loadData} supabase={supabase} />;

  const navItems: { id: Tab; label: string; icon: string; adminOnly?: boolean }[] = [
    { id: "dashboard", label: "דשבורד", icon: "⌂" },
    { id: "jobs", label: "עבודות", icon: "▤" },
    { id: "customers", label: "לקוחות", icon: "◎" },
    { id: "employees", label: "עובדים", icon: "♙", adminOnly: true },
    { id: "payments", label: "תשלומים", icon: "₪", adminOnly: true },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup sidebar-brand">
          <div className="brand-mark">F</div>
          <div><strong>Factory Clean</strong><span>OS</span></div>
        </div>
        <nav>
          {navItems.filter((item) => !item.adminOnly || isAdmin).map((item) => (
            <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>
              <span>{item.icon}</span>{item.label}
              {item.id === "jobs" && isAdmin && jobs.some((job) => job.status === "pending") ? (
                <b>{jobs.filter((job) => job.status === "pending").length}</b>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="avatar">{profile.full_name.slice(0, 1) || "א"}</div>
          <div><strong>{profile.full_name}</strong><span>{isAdmin ? "מנהל" : "עובד"}</span></div>
          <button type="button" onClick={logout} aria-label="יציאה">↪</button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div>
            <span className="eyebrow">{isAdmin ? "מרכז השליטה" : "האזור האישי שלי"}</span>
            <h1>{tab === "dashboard" ? `שלום ${profile.full_name.split(" ")[0] || ""}` : navItems.find((item) => item.id === tab)?.label}</h1>
          </div>
          <div className="top-actions">
            {tab === "jobs" || tab === "dashboard" ? <button className="primary-button" onClick={() => setJobModal(true)}>+ הוספת עבודה</button> : null}
            {tab === "customers" ? <button className="primary-button" onClick={() => setCustomerModal(true)}>+ לקוח חדש</button> : null}
            {tab === "employees" && isAdmin ? <button className="primary-button" onClick={() => setEmployeeModal(true)}>+ עובד חדש</button> : null}
            {tab === "payments" && isAdmin ? <button className="primary-button" onClick={() => setPaymentModal(true)}>+ רישום תשלום</button> : null}
          </div>
        </header>

        {tab === "dashboard" ? (
          <Dashboard
            isAdmin={isAdmin}
            period={period}
            setPeriod={setPeriod}
            totals={totals}
            pending={jobs.filter((job) => job.status === "pending")}
            recentJobs={jobs.slice(0, 6)}
            employeeSummaries={employeeSummaries}
            mySummary={mySummary}
            onAddJob={() => setJobModal(true)}
            onApprove={(id) => updateJobStatus(id, "approved")}
            onReject={(id) => updateJobStatus(id, "rejected")}
            busy={busy}
          />
        ) : null}

        {tab === "jobs" ? (
          <JobsView
            jobs={filteredJobs}
            search={search}
            setSearch={setSearch}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            isAdmin={isAdmin}
            onApprove={(id) => updateJobStatus(id, "approved")}
            onComplete={(id) => updateJobStatus(id, "completed")}
            onReject={(id) => updateJobStatus(id, "rejected")}
            busy={busy}
          />
        ) : null}

        {tab === "customers" ? (
          <CustomersView
            customers={customers}
            summaries={customerSummaries}
            isAdmin={isAdmin}
            supabase={supabase}
            userId={session.user.id}
            reload={loadData}
            toast={toast}
          />
        ) : null}

        {tab === "employees" && isAdmin ? (
          <EmployeesView employees={employees} summaries={employeeSummaries} />
        ) : null}

        {tab === "payments" && isAdmin ? <PaymentsView payments={payments} /> : null}
      </main>

      {jobModal ? (
        <JobFormModal
          supabase={supabase}
          profile={profile}
          currentEmployee={currentEmployee}
          employees={employees}
          customers={customers}
          isAdmin={Boolean(isAdmin)}
          onClose={() => setJobModal(false)}
          onSaved={async () => { setJobModal(false); await loadData(); toast(isAdmin ? "העבודה נשמרה" : "העבודה נשלחה לאישור המנהל"); }}
          toast={toast}
        />
      ) : null}

      {customerModal ? (
        <CustomerFormModal
          supabase={supabase}
          userId={session.user.id}
          onClose={() => setCustomerModal(false)}
          onSaved={async () => { setCustomerModal(false); await loadData(); toast("הלקוח נוסף בהצלחה"); }}
          toast={toast}
        />
      ) : null}

      {employeeModal && isAdmin ? (
        <EmployeeFormModal
          session={session}
          onClose={() => setEmployeeModal(false)}
          onSaved={async () => { setEmployeeModal(false); await loadData(); toast("העובד נוצר ויכול להיכנס מהטלפון"); }}
          toast={toast}
        />
      ) : null}

      {paymentModal && isAdmin ? (
        <PaymentFormModal
          supabase={supabase}
          employees={employees.filter((employee) => employee.name !== "יצחק")}
          userId={session.user.id}
          onClose={() => setPaymentModal(false)}
          onSaved={async () => { setPaymentModal(false); await loadData(); toast("התשלום נרשם והיתרה עודכנה"); }}
          toast={toast}
        />
      ) : null}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((item) => <div key={item.id} className={`toast ${item.tone}`}>{item.message}</div>)}
      </div>
    </div>
  );
}

function Dashboard({
  isAdmin,
  period,
  setPeriod,
  totals,
  pending,
  recentJobs,
  employeeSummaries,
  mySummary,
  onAddJob,
  onApprove,
  onReject,
  busy,
}: {
  isAdmin: boolean | undefined;
  period: "month" | "year" | "all";
  setPeriod: (value: "month" | "year" | "all") => void;
  totals: { jobs: number; gross: number; employeePay: number; factory: number };
  pending: Job[];
  recentJobs: Job[];
  employeeSummaries: EmployeeSummary[];
  mySummary: EmployeeSummary | null | undefined;
  onAddJob: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  busy: boolean;
}) {
  if (!isAdmin) {
    return (
      <div className="page-content">
        <section className="hero-panel employee-hero">
          <div>
            <span className="eyebrow">סיכום אישי</span>
            <h2>העבודות והכסף שלך, בשקיפות מלאה.</h2>
            <p>כל עבודה שאושרה נכנסת אוטומטית לחישוב השכר והיתרה.</p>
          </div>
          <button className="primary-button light" onClick={onAddJob}>+ דיווח עבודה חדשה</button>
        </section>
        <section className="stats-grid four">
          <StatCard label="עבודות מאושרות" value={number.format(mySummary?.approved_jobs || 0)} />
          <StatCard label="מחזור עבודות" value={money.format(mySummary?.gross_total || 0)} />
          <StatCard label="הרווחתי" value={money.format(mySummary?.earned_total || 0)} />
          <StatCard label="יתרה שמגיעה לי" value={money.format(mySummary?.balance_due || 0)} note={`שולם עד כה ${money.format(mySummary?.paid_total || 0)}`} />
        </section>
        <section className="section-card">
          <div className="section-title"><div><span className="eyebrow">עבודות אחרונות</span><h2>מה ביצעתי</h2></div></div>
          <JobsTable jobs={recentJobs} isAdmin={false} compact />
        </section>
      </div>
    );
  }

  return (
    <div className="page-content">
      <section className="hero-panel">
        <div>
          <span className="eyebrow">Factory Clean OS</span>
          <h2>תמונת מצב אמיתית של העסק.</h2>
          <p>כל עבודה, כל עובד וכל שקל — מעודכנים בזמן אמת.</p>
        </div>
        <div className="period-switch">
          <button className={period === "month" ? "active" : ""} onClick={() => setPeriod("month")}>החודש</button>
          <button className={period === "year" ? "active" : ""} onClick={() => setPeriod("year")}>השנה</button>
          <button className={period === "all" ? "active" : ""} onClick={() => setPeriod("all")}>הכול</button>
        </div>
      </section>

      <section className="stats-grid four">
        <StatCard label="עבודות מאושרות" value={number.format(totals.jobs)} />
        <StatCard label="מחזור" value={money.format(totals.gross)} />
        <StatCard label="שכר עובדים" value={money.format(totals.employeePay)} />
        <StatCard label="נשאר לפקטורי" value={money.format(totals.factory)} />
      </section>

      {pending.length ? (
        <section className="section-card attention-card">
          <div className="section-title"><div><span className="eyebrow">דורש טיפול</span><h2>{pending.length} עבודות ממתינות לאישור</h2></div></div>
          <div className="approval-list">
            {pending.slice(0, 5).map((job) => (
              <article key={job.id}>
                <div><strong>{job.customers?.customer_name || "לקוח ללא שם"}</strong><span>{job.employees?.name} · {job.service_type} · {money.format(job.gross_amount)}</span></div>
                <div className="row-actions">
                  <button className="small-button success" disabled={busy} onClick={() => onApprove(job.id)}>אישור</button>
                  <button className="small-button danger" disabled={busy} onClick={() => onReject(job.id)}>דחייה</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <div className="dashboard-grid">
        <section className="section-card">
          <div className="section-title"><div><span className="eyebrow">פעילות</span><h2>עבודות אחרונות</h2></div></div>
          <JobsTable jobs={recentJobs} isAdmin compact />
        </section>
        <section className="section-card">
          <div className="section-title"><div><span className="eyebrow">התחשבנות</span><h2>יתרות עובדים</h2></div></div>
          <div className="employee-summary-list">
            {employeeSummaries.filter((item) => item.name !== "יצחק").length ? employeeSummaries.filter((item) => item.name !== "יצחק").map((item) => (
              <article key={item.employee_id}>
                <div><strong>{item.name}</strong><span>{item.approved_jobs} עבודות · {item.regular_rate}% / {item.midrag_rate}%</span></div>
                <div><strong>{money.format(item.balance_due)}</strong><span>יתרה לתשלום</span></div>
              </article>
            )) : <Empty>עדיין אין עובדים עם עבודות מאושרות.</Empty>}
          </div>
        </section>
      </div>
    </div>
  );
}

function JobsView({ jobs, search, setSearch, statusFilter, setStatusFilter, isAdmin, onApprove, onComplete, onReject, busy }: {
  jobs: Job[];
  search: string;
  setSearch: (value: string) => void;
  statusFilter: JobStatus | "all";
  setStatusFilter: (value: JobStatus | "all") => void;
  isAdmin: boolean | undefined;
  onApprove: (id: string) => void;
  onComplete: (id: string) => void;
  onReject: (id: string) => void;
  busy: boolean;
}) {
  return (
    <div className="page-content">
      <section className="toolbar-card">
        <label className="search-field"><span>⌕</span><input placeholder="חיפוש לפי לקוח, עובד, שירות או עיר" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as JobStatus | "all")}>
          <option value="all">כל הסטטוסים</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </section>
      <section className="section-card">
        <JobsTable jobs={jobs} isAdmin={Boolean(isAdmin)} onApprove={onApprove} onComplete={onComplete} onReject={onReject} busy={busy} />
      </section>
    </div>
  );
}

function JobsTable({ jobs, isAdmin, compact = false, onApprove, onComplete, onReject, busy }: {
  jobs: Job[];
  isAdmin: boolean;
  compact?: boolean;
  onApprove?: (id: string) => void;
  onComplete?: (id: string) => void;
  onReject?: (id: string) => void;
  busy?: boolean;
}) {
  if (!jobs.length) return <Empty>עדיין אין עבודות להצגה.</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>תאריך</th>{isAdmin ? <th>עובד</th> : null}<th>לקוח</th><th>שירות</th><th>סכום</th><th>אחוז</th><th>שכר עובד</th>{isAdmin ? <th>פקטורי</th> : null}<th>סטטוס</th>{!compact && isAdmin ? <th></th> : null}</tr></thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>{formatDate(job.job_date)}</td>
              {isAdmin ? <td><strong>{job.employees?.name || "—"}</strong></td> : null}
              <td><strong>{job.customers?.business_name || job.customers?.customer_name || "ללא לקוח"}</strong><small>{job.city || ""}</small></td>
              <td>{job.service_type}<small>{SOURCE_LABELS[job.source]}</small></td>
              <td className="money-cell">{money.format(job.gross_amount)}</td>
              <td>{job.rate_percent ?? 0}%</td>
              <td className="money-cell">{money.format(job.employee_pay)}</td>
              {isAdmin ? <td className="money-cell">{money.format(job.factory_net)}</td> : null}
              <td><span className={`status ${job.status}`}>{STATUS_LABELS[job.status]}</span></td>
              {!compact && isAdmin ? (
                <td>
                  <div className="row-actions nowrap">
                    {job.status === "pending" ? <button className="small-button success" disabled={busy} onClick={() => onApprove?.(job.id)}>אישור</button> : null}
                    {job.status === "approved" ? <button className="small-button" disabled={busy} onClick={() => onComplete?.(job.id)}>הושלמה</button> : null}
                    {job.status === "pending" ? <button className="small-button danger" disabled={busy} onClick={() => onReject?.(job.id)}>דחייה</button> : null}
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CustomersView({ customers, summaries, isAdmin, supabase, userId, reload, toast }: {
  customers: Customer[];
  summaries: CustomerSummary[];
  isAdmin: boolean | undefined;
  supabase: SupabaseClient;
  userId: string;
  reload: () => Promise<void>;
  toast: (message: string, tone?: ToastData["tone"]) => void;
}) {
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const summaryMap = useMemo(() => new Map(summaries.map((item) => [item.customer_id, item])), [summaries]);
  const filtered = customers.filter((customer) => {
    const text = [customer.customer_name, customer.business_name, customer.phone, customer.city, customer.email].filter(Boolean).join(" ").toLowerCase();
    return text.includes(query.toLowerCase());
  });

  async function importCsv(file: File) {
    setImporting(true);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows.length < 2) throw new Error("הקובץ ריק או אינו CSV תקין.");
      const headers = rows[0];
      const index = (name: string) => headers.indexOf(name);
      const phoneIndex = index("phone");
      const nameIndex = index("name");
      if (phoneIndex < 0 || nameIndex < 0) throw new Error("חסרות עמודות name ו-phone בקובץ.");

      const existingPhones = new Set(customers.map((item) => normalizePhone(item.phone || "")).filter(Boolean));
      const payload: Record<string, unknown>[] = [];
      let skipped = 0;
      for (const row of rows.slice(1)) {
        const name = row[nameIndex]?.trim();
        const phone = normalizePhone(row[phoneIndex] || "");
        if (!name) { skipped += 1; continue; }
        if (phone && existingPhones.has(phone)) { skipped += 1; continue; }
        if (phone) existingPhones.add(phone);
        const consentValue = row[index("marketingConsent")] || "unknown";
        payload.push({
          customer_name: name,
          business_name: row[index("customerType")] === "business" ? name : null,
          contact_person: row[index("contactName")] || null,
          phone: phone || null,
          email: row[index("email")] || null,
          address: row[index("address")] || null,
          city: row[index("city")] || null,
          business_number: row[index("businessNumber")] || null,
          marketing_consent: ["approved", "declined"].includes(consentValue) ? consentValue : "unknown",
          tags: (row[index("tags")] || "").split("|").map((item) => item.trim()).filter(Boolean),
          notes: [row[index("notes")], row[index("historicalDocuments")] ? `מסמכים היסטוריים: ${row[index("historicalDocuments")]}` : ""].filter(Boolean).join(" · ") || null,
          created_by: userId,
        });
      }
      for (let i = 0; i < payload.length; i += 100) {
        const { error } = await supabase.from("customers").insert(payload.slice(i, i + 100));
        if (error) throw error;
      }
      await reload();
      toast(`${payload.length} לקוחות יובאו. ${skipped} דולגו כדי למנוע כפילויות.`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "ייבוא הלקוחות נכשל.", "error");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="page-content">
      <section className="toolbar-card">
        <label className="search-field"><span>⌕</span><input placeholder="חיפוש שם, טלפון, עיר או אימייל" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        {isAdmin ? <>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importCsv(file); }} />
          <button className="secondary-button" disabled={importing} onClick={() => fileRef.current?.click()}>{importing ? "מייבא…" : "ייבוא לקוחות מ-CSV"}</button>
        </> : null}
      </section>
      <section className="customer-grid">
        {filtered.length ? filtered.map((customer) => {
          const summary = summaryMap.get(customer.id);
          return (
            <article className="customer-card" key={customer.id}>
              <header><div className="avatar small">{customer.customer_name.slice(0, 1)}</div><div><strong>{customer.business_name || customer.customer_name}</strong><span>{customer.business_name ? customer.contact_person || customer.customer_name : customer.city || "לקוח פרטי"}</span></div></header>
              <dl>
                <div><dt>טלפון</dt><dd>{customer.phone || "—"}</dd></div>
                <div><dt>כתובת</dt><dd>{[customer.address, customer.city].filter(Boolean).join(", ") || "—"}</dd></div>
                <div><dt>הזמנות השנה</dt><dd>{summary?.jobs_this_year || 0}</dd></div>
                <div><dt>הכנסה כוללת</dt><dd>{money.format(summary?.lifetime_revenue || 0)}</dd></div>
                <div><dt>הזמנה אחרונה</dt><dd>{formatDate(summary?.last_job_date)}</dd></div>
                <div><dt>דיוור</dt><dd>{customer.marketing_consent === "approved" ? "מאושר" : customer.marketing_consent === "declined" ? "לא מאושר" : "לא ידוע"}</dd></div>
              </dl>
              {customer.phone ? <a className="whatsapp-link" target="_blank" rel="noreferrer" href={`https://wa.me/972${normalizePhone(customer.phone).slice(1)}`}>פתיחת WhatsApp</a> : null}
            </article>
          );
        }) : <Empty>לא נמצאו לקוחות.</Empty>}
      </section>
    </div>
  );
}

function EmployeesView({ employees, summaries }: { employees: Employee[]; summaries: EmployeeSummary[] }) {
  const map = new Map(summaries.map((item) => [item.employee_id, item]));
  return (
    <div className="page-content employee-cards">
      {employees.map((employee) => {
        const summary = map.get(employee.id);
        return (
          <article className="employee-card" key={employee.id}>
            <header><div className="avatar">{employee.name.slice(0, 1)}</div><div><strong>{employee.name}</strong><span>{employee.phone || (employee.name === "יצחק" ? "בעל העסק" : "לא הוגדר טלפון")}</span></div><span className={`dot ${employee.active ? "online" : ""}`}></span></header>
            <div className="rates"><div><span>רגיל</span><strong>{employee.regular_rate}%</strong></div><div><span>מידרג</span><strong>{employee.midrag_rate}%</strong></div></div>
            <div className="employee-metrics"><div><span>עבודות</span><strong>{summary?.approved_jobs || 0}</strong></div><div><span>הרוויח</span><strong>{money.format(summary?.earned_total || 0)}</strong></div><div><span>שולם</span><strong>{money.format(summary?.paid_total || 0)}</strong></div><div className="highlight"><span>יתרה</span><strong>{money.format(summary?.balance_due || 0)}</strong></div></div>
          </article>
        );
      })}
    </div>
  );
}

function PaymentsView({ payments }: { payments: Payment[] }) {
  return (
    <div className="page-content"><section className="section-card"><div className="table-wrap"><table><thead><tr><th>תאריך</th><th>עובד</th><th>סכום</th><th>אמצעי תשלום</th><th>הערה</th></tr></thead><tbody>
      {payments.map((payment) => <tr key={payment.id}><td>{formatDate(payment.payment_date)}</td><td><strong>{payment.employees?.name || "—"}</strong></td><td className="money-cell">{money.format(payment.amount)}</td><td>{payment.payment_method || "—"}</td><td>{payment.notes || "—"}</td></tr>)}
    </tbody></table>{!payments.length ? <Empty>עדיין לא נרשמו תשלומים לעובדים.</Empty> : null}</div></section></div>
  );
}

function CustomerFields({ values, setValue }: { values: Record<string, string>; setValue: (key: string, value: string) => void }) {
  return (
    <div className="customer-details-panel">
      <div className="panel-title"><div><span className="eyebrow">פרטי לקוח</span><h3>לקוח חדש</h3></div><span>השדות נשמרים בכרטיס הלקוח</span></div>
      <div className="form-grid three">
        <label className="span-2"><span>שם הלקוח / העסק *</span><input value={values.customerName || ""} onChange={(e) => setValue("customerName", e.target.value)} required /></label>
        <label><span>איש קשר</span><input value={values.contactPerson || ""} onChange={(e) => setValue("contactPerson", e.target.value)} /></label>
        <label><span>טלפון *</span><input type="tel" inputMode="tel" value={values.customerPhone || ""} onChange={(e) => setValue("customerPhone", e.target.value)} required /></label>
        <label><span>אימייל</span><input type="email" value={values.customerEmail || ""} onChange={(e) => setValue("customerEmail", e.target.value)} /></label>
        <label><span>מספר עוסק / ח.פ.</span><input value={values.businessNumber || ""} onChange={(e) => setValue("businessNumber", e.target.value)} /></label>
        <label><span>עיר</span><input value={values.customerCity || ""} onChange={(e) => setValue("customerCity", e.target.value)} /></label>
        <label className="span-2"><span>כתובת מלאה</span><input value={values.customerAddress || ""} onChange={(e) => setValue("customerAddress", e.target.value)} /></label>
        <label><span>אישור דיוור</span><select value={values.consent || "unknown"} onChange={(e) => setValue("consent", e.target.value)}><option value="unknown">לא ידוע</option><option value="approved">מאושר</option><option value="declined">לא מאושר</option></select></label>
      </div>
    </div>
  );
}

function JobFormModal({ supabase, profile, currentEmployee, employees, customers, isAdmin, onClose, onSaved, toast }: {
  supabase: SupabaseClient;
  profile: Profile;
  currentEmployee: Employee | null;
  employees: Employee[];
  customers: Customer[];
  isAdmin: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
  toast: (message: string, tone?: ToastData["tone"]) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [newCustomer, setNewCustomer] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({
    employeeId: isAdmin ? employees[0]?.id || "" : currentEmployee?.id || "",
    jobDate: today(),
    customerId: "",
    serviceType: SERVICE_OPTIONS[0],
    city: "",
    source: isAdmin && currentEmployee?.name === "יצחק" ? "owner" : "regular",
    grossAmount: "",
    directExpenses: "0",
    status: isAdmin ? "approved" : "pending",
    payMode: "percentage",
    useDefaultRate: "true",
    ratePercent: "",
    fixedPay: "0",
    notes: "",
    customerName: "",
    contactPerson: "",
    customerPhone: "",
    customerEmail: "",
    businessNumber: "",
    customerCity: "",
    customerAddress: "",
    consent: "unknown",
  });

  const setValue = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const selectedEmployee = employees.find((employee) => employee.id === form.employeeId);
  const calculatedRate = form.source === "owner" || form.payMode === "none" ? 0 : form.payMode === "fixed" ? 0 : form.useDefaultRate === "true" ? (form.source === "midrag" ? selectedEmployee?.midrag_rate || 0 : selectedEmployee?.regular_rate || 0) : safeNumber(form.ratePercent);
  const employeePay = form.payMode === "fixed" ? safeNumber(form.fixedPay) : safeNumber(form.grossAmount) * calculatedRate / 100;
  const factoryNet = safeNumber(form.grossAmount) - safeNumber(form.directExpenses) - employeePay;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.employeeId) return toast("יש לבחור עובד.", "error");
    if (!newCustomer && !form.customerId) return toast("יש לבחור לקוח או ליצור לקוח חדש.", "error");
    setSaving(true);
    try {
      let customerId = form.customerId || null;
      let city = form.city;
      if (newCustomer) {
        const phone = normalizePhone(form.customerPhone);
        if (form.customerName.trim().length < 2 || !/^05\d{8}$/.test(phone)) throw new Error("יש להזין שם ומספר טלפון תקין ללקוח.");
        const { data, error } = await supabase.from("customers").insert({
          customer_name: form.customerName.trim(),
          business_name: form.businessNumber ? form.customerName.trim() : null,
          contact_person: form.contactPerson || null,
          phone,
          email: form.customerEmail || null,
          city: form.customerCity || null,
          address: form.customerAddress || null,
          business_number: form.businessNumber || null,
          marketing_consent: form.consent,
          created_by: profile.id,
        }).select("id").single();
        if (error) throw error;
        customerId = data.id;
        city = city || form.customerCity;
      }

      const source = form.source as JobSource;
      const payMode = source === "owner" ? "none" : form.payMode as PayMode;
      const { error } = await supabase.from("jobs").insert({
        employee_id: form.employeeId,
        customer_id: customerId,
        job_date: form.jobDate,
        service_type: form.serviceType,
        city: city || null,
        source,
        status: isAdmin ? form.status : "pending",
        gross_amount: safeNumber(form.grossAmount),
        direct_expenses: safeNumber(form.directExpenses),
        pay_mode: payMode,
        use_default_rate: form.useDefaultRate === "true",
        rate_percent: form.useDefaultRate === "true" ? null : safeNumber(form.ratePercent),
        fixed_pay: safeNumber(form.fixedPay),
        notes: form.notes || null,
        submitted_by: profile.id,
      });
      if (error) throw error;
      await onSaved();
    } catch (error) {
      toast(error instanceof Error ? error.message : "שמירת העבודה נכשלה.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="הוספת עבודה" eyebrow="עבודה" onClose={onClose} wide>
      <form onSubmit={submit} className="modal-form">
        <div className="form-grid two">
          <label><span>תאריך</span><input type="date" value={form.jobDate} onChange={(e) => setValue("jobDate", e.target.value)} required /></label>
          {isAdmin ? <label><span>עובד</span><select value={form.employeeId} onChange={(e) => setValue("employeeId", e.target.value)} required>{employees.filter((employee) => employee.active).map((employee) => <option key={employee.id} value={employee.id}>{employee.name} — {employee.regular_rate}% / {employee.midrag_rate}%</option>)}</select></label> : <label><span>עובד</span><input value={currentEmployee?.name || profile.full_name} disabled /></label>}
        </div>

        <div className="customer-choice">
          <div className="segment-control inline"><button type="button" className={!newCustomer ? "active" : ""} onClick={() => setNewCustomer(false)}>בחירת לקוח קיים</button><button type="button" className={newCustomer ? "active" : ""} onClick={() => setNewCustomer(true)}>+ לקוח חדש</button></div>
          {!newCustomer ? <label><span>לקוח *</span><select value={form.customerId} onChange={(e) => { setValue("customerId", e.target.value); const selected = customers.find((customer) => customer.id === e.target.value); if (selected?.city) setValue("city", selected.city); }} required><option value="">בחרו לקוח…</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.business_name || customer.customer_name}{customer.phone ? ` · ${customer.phone}` : ""}</option>)}</select></label> : <CustomerFields values={form} setValue={setValue} />}
        </div>

        <div className="form-grid three">
          <label><span>שירות</span><select value={form.serviceType} onChange={(e) => setValue("serviceType", e.target.value)}>{SERVICE_OPTIONS.map((service) => <option key={service}>{service}</option>)}</select></label>
          <label><span>עיר העבודה</span><input placeholder="לדוגמה: רמת גן" value={form.city} onChange={(e) => setValue("city", e.target.value)} /></label>
          <label><span>סוג עבודה</span><select value={form.source} onChange={(e) => setValue("source", e.target.value)}><option value="regular">עבודה רגילה</option><option value="midrag">עבודה דרך מידרג</option>{isAdmin ? <option value="owner">עבודת בעלים — 0% עובד</option> : null}</select></label>
          <label><span>סכום העבודה ₪ *</span><input type="number" min="0" step="0.01" value={form.grossAmount} onChange={(e) => setValue("grossAmount", e.target.value)} required /></label>
          <label><span>הוצאות ישירות ₪</span><input type="number" min="0" step="0.01" value={form.directExpenses} onChange={(e) => setValue("directExpenses", e.target.value)} /></label>
          {isAdmin ? <label><span>סטטוס</span><select value={form.status} onChange={(e) => setValue("status", e.target.value)}><option value="pending">ממתינה לאישור</option><option value="approved">מאושרת</option><option value="completed">הושלמה</option></select></label> : null}
        </div>

        {isAdmin && form.source !== "owner" ? <div className="pay-settings"><div className="panel-title"><div><span className="eyebrow">חישוב עובד</span><h3>לפי מה לחשב?</h3></div></div><div className="form-grid three"><label><span>שיטת תשלום</span><select value={form.payMode} onChange={(e) => setValue("payMode", e.target.value)}><option value="percentage">אחוז</option><option value="fixed">סכום קבוע</option><option value="none">ללא שכר</option></select></label>{form.payMode === "percentage" ? <><label><span>אחוז</span><select value={form.useDefaultRate} onChange={(e) => setValue("useDefaultRate", e.target.value)}><option value="true">האחוז שהוגדר לעובד</option><option value="false">אחוז מיוחד לעבודה</option></select></label>{form.useDefaultRate === "false" ? <label><span>אחוז מיוחד</span><input type="number" min="0" max="100" step="0.1" value={form.ratePercent} onChange={(e) => setValue("ratePercent", e.target.value)} /></label> : null}</> : null}{form.payMode === "fixed" ? <label><span>סכום קבוע לעובד</span><input type="number" min="0" value={form.fixedPay} onChange={(e) => setValue("fixedPay", e.target.value)} /></label> : null}</div></div> : null}

        <label><span>הערות</span><textarea rows={3} placeholder="חומרים, כתמים, מידע חשוב…" value={form.notes} onChange={(e) => setValue("notes", e.target.value)} /></label>

        <div className="calculation-strip">
          <div><span>הכנסה</span><strong>{money.format(safeNumber(form.grossAmount))}</strong></div>
          <div><span>אחוז עובד</span><strong>{calculatedRate}%</strong></div>
          <div><span>שכר עובד</span><strong>{money.format(employeePay)}</strong></div>
          <div><span>נשאר לפקטורי</span><strong>{money.format(factoryNet)}</strong></div>
        </div>
        <footer className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>ביטול</button><button className="primary-button" disabled={saving}>{saving ? "שומר…" : isAdmin ? "שמירת עבודה" : "שליחה לאישור"}</button></footer>
      </form>
    </Modal>
  );
}

function CustomerFormModal({ supabase, userId, onClose, onSaved, toast }: { supabase: SupabaseClient; userId: string; onClose: () => void; onSaved: () => Promise<void>; toast: (message: string, tone?: ToastData["tone"]) => void }) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({ customerName: "", contactPerson: "", customerPhone: "", customerEmail: "", businessNumber: "", customerCity: "", customerAddress: "", consent: "unknown", notes: "" });
  const setValue = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    const phone = normalizePhone(form.customerPhone);
    if (!/^05\d{8}$/.test(phone)) return toast("מספר הטלפון אינו תקין.", "error");
    setSaving(true);
    const { error } = await supabase.from("customers").insert({ customer_name: form.customerName.trim(), business_name: form.businessNumber ? form.customerName.trim() : null, contact_person: form.contactPerson || null, phone, email: form.customerEmail || null, business_number: form.businessNumber || null, city: form.customerCity || null, address: form.customerAddress || null, marketing_consent: form.consent, notes: form.notes || null, created_by: userId });
    setSaving(false);
    if (error) return toast(error.message, "error");
    await onSaved();
  }
  return <Modal title="הוספת לקוח" eyebrow="לקוחות" onClose={onClose} wide><form onSubmit={submit} className="modal-form"><CustomerFields values={form} setValue={setValue} /><label><span>הערות</span><textarea rows={3} value={form.notes} onChange={(e) => setValue("notes", e.target.value)} /></label><footer className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>ביטול</button><button className="primary-button" disabled={saving}>{saving ? "שומר…" : "שמירת לקוח"}</button></footer></form></Modal>;
}

function EmployeeFormModal({ session, onClose, onSaved, toast }: { session: Session; onClose: () => void; onSaved: () => Promise<void>; toast: (message: string, tone?: ToastData["tone"]) => void }) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", pin: "", regularRate: "45", midragRate: "37.5" });
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch("/api/admin/create-employee", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(form) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "יצירת העובד נכשלה.");
      await onSaved();
    } catch (error) { toast(error instanceof Error ? error.message : "יצירת העובד נכשלה.", "error"); }
    finally { setSaving(false); }
  }
  return <Modal title="עובד חדש" eyebrow="גישה אישית" onClose={onClose}><form onSubmit={submit} className="modal-form"><p className="helper-text">העובד ייכנס למערכת עם מספר הטלפון והקוד האישי. הקוד לא מוצג שוב לאחר השמירה.</p><div className="form-grid two"><label className="span-2"><span>שם מלא *</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label><label><span>טלפון *</span><input type="tel" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required /></label><label><span>קוד אישי — 4 ספרות *</span><input type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, "") })} required /></label><label><span>אחוז עבודה רגילה</span><input type="number" min="0" max="100" step="0.1" value={form.regularRate} onChange={(e) => setForm({ ...form, regularRate: e.target.value })} /></label><label><span>אחוז עבודה דרך מידרג</span><input type="number" min="0" max="100" step="0.1" value={form.midragRate} onChange={(e) => setForm({ ...form, midragRate: e.target.value })} /></label></div><footer className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>ביטול</button><button className="primary-button" disabled={saving}>{saving ? "יוצר גישה…" : "יצירת עובד וגישה"}</button></footer></form></Modal>;
}

function PaymentFormModal({ supabase, employees, userId, onClose, onSaved, toast }: { supabase: SupabaseClient; employees: Employee[]; userId: string; onClose: () => void; onSaved: () => Promise<void>; toast: (message: string, tone?: ToastData["tone"]) => void }) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ employeeId: employees[0]?.id || "", amount: "", paymentDate: today(), paymentMethod: "העברה בנקאית", notes: "" });
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    const { error } = await supabase.from("employee_payments").insert({ employee_id: form.employeeId, amount: safeNumber(form.amount), payment_date: form.paymentDate, payment_method: form.paymentMethod, notes: form.notes || null, created_by: userId });
    setSaving(false);
    if (error) return toast(error.message, "error");
    await onSaved();
  }
  return <Modal title="רישום תשלום לעובד" eyebrow="התחשבנות" onClose={onClose}><form onSubmit={submit} className="modal-form"><div className="form-grid two"><label className="span-2"><span>עובד</span><select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} required>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label><label><span>סכום ששולם ₪</span><input type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></label><label><span>תאריך</span><input type="date" value={form.paymentDate} onChange={(e) => setForm({ ...form, paymentDate: e.target.value })} required /></label><label className="span-2"><span>אמצעי תשלום</span><select value={form.paymentMethod} onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}><option>העברה בנקאית</option><option>ביט</option><option>מזומן</option><option>צ׳ק</option><option>אחר</option></select></label><label className="span-2"><span>הערה</span><textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label></div><footer className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>ביטול</button><button className="primary-button" disabled={saving}>{saving ? "שומר…" : "שמירת תשלום"}</button></footer></form></Modal>;
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  const normalized = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === '"') {
      if (quoted && normalized[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value); value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && normalized[i + 1] === "\n") i += 1;
      row.push(value); value = "";
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else value += char;
  }
  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}
