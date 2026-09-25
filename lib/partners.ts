export const SERVICES = {
  ac_cleaning: 'ניקוי מזגן',
  installation: 'התקנת מזגן',
  repair: 'אבחון תקלה',
  dismantling: 'פירוק מזגן',
} as const;
export type Service = keyof typeof SERVICES;
export const STATUS = { pending: 'בקשה חדשה', contacted: 'נוצר קשר', confirmed: 'תואמה עבודה', completed: 'הושלמה', rejected: 'נדחתה', cancelled: 'בוטלה' } as const;
export type RequestStatus = keyof typeof STATUS;
export type Hours = { enabled: boolean; start: number; end: number };
export type Partner = {
  id: string; user_id: string; name: string; phone: string; active: boolean; accepting: boolean;
  cities: string[]; services: Service[]; weekly: Hours[]; durations: Record<Service, number>; buffer_minutes: number;
};
export type ExceptionDay = { partner_id: string; day: string; closed: boolean; start_minute: number | null; end_minute: number | null };
export type Block = { id: string; partner_id: string; day: string; start_minute: number; end_minute: number; note: string };
export type WorkRequest = {
  id: string; partner_id: string; reference: string; service: Service; status: RequestStatus;
  customer_name: string; phone: string; city: string; address: string; notes: string;
  requested_day: string; scheduled_day: string; start_minute: number; duration_minutes: number; buffer_minutes: number;
  contacted_at: string | null; hold_until: string; created_at: string; updated_at: string;
  agreed_price: number | null; customer_paid: boolean; commission_rate: number; commission_settled_at: string | null;
  outcome_note: string | null; source: string; version: number;
};
export type WorkEvent = { id: number; request_id: string; action: string; actor_name: string; details: Record<string, unknown>; created_at: string };
export type PartnerState = { role: 'admin' | 'technician'; name: string; partners: Partner[]; requests: WorkRequest[]; exceptions: ExceptionDay[]; blocks: Block[]; events: WorkEvent[] };
export const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const dateInIsrael = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
export const timeLabel = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const minutes = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
export const addDays = (date: string, n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const formatDay = (date: string) => new Intl.DateTimeFormat('he-IL', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
export const money = (n: number) => new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 2 }).format(n);
export function normalizePhone(value: string) { let v = value.replace(/\D/g, ''); if (v.startsWith('972')) v = '0' + v.slice(3); return v; }
export function validDay(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
