"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";

// דף זה מטפל בקישור שמגיע מהמייל של "Send password recovery" ב-Supabase
// Dashboard (Authentication → Users → המשתמש → Reset password). הקישור ההוא
// מפנה בדיוק לכתובת הזו (/reset-password) - בלי הדף הזה, המייל היה מגיע
// ל"עמוד לא נמצא". Supabase מעביר את פרטי ההתחברות הזמניים דרך ה-URL עצמו,
// והלקוח (createBrowserSupabase) קולט אותם אוטומטית ברגע שהדף נטען.

type Status = "checking" | "ready" | "invalid";

export default function ResetPasswordPage() {
  const supabase = useMemo(() => createBrowserSupabase(), []);
  const [status, setStatus] = useState<Status>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // אם הקישור פג תוקף או כבר נעשה בו שימוש, Supabase מחזיר שגיאה בתוך
    // ה-hash של ה-URL עצמו (למשל #error=access_denied&error_description=...).
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const hashError = hashParams.get("error_description");
    if (hashError) {
      setError(hashError);
      setStatus("invalid");
      return;
    }

    let settled = false;

    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" && !settled) {
        settled = true;
        setStatus("ready");
      }
    });

    // רשת ביטחון: אם האירוע כבר קרה לפני שהתחלנו להאזין, נבדוק אם יש כבר
    // session תקף (זה מה שהאירוע PASSWORD_RECOVERY בעצם יוצר).
    supabase.auth.getSession().then(({ data }) => {
      if (settled) return;
      if (data.session) {
        settled = true;
        setStatus("ready");
      } else {
        window.setTimeout(() => {
          if (!settled) setStatus("invalid");
        }, 2500);
      }
    });

    return () => listener.subscription.unsubscribe();
  }, [supabase]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");

    if (password.length < 6) {
      setError("הסיסמה חייבת להכיל לפחות 6 תווים.");
      return;
    }
    if (password !== confirm) {
      setError("הסיסמאות שהוקלדו אינן זהות.");
      return;
    }

    setBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }
    setDone(true);
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="login-card" style={{ margin: 0 }}>
        <div className="brand-lockup" style={{ marginBottom: 22 }}>
          <div className="brand-mark">F</div>
          <div>
            <strong>Factory Clean OS</strong>
            <span>איפוס סיסמה</span>
          </div>
        </div>

        {status === "checking" && !error ? <p className="helper-text">בודק את הקישור...</p> : null}

        {status === "invalid" ? (
          <>
            <h2>הקישור אינו תקף</h2>
            <p className="form-error">{error || "הקישור פג תוקף או כבר נעשה בו שימוש."}</p>
            <p className="helper-text">
              יש לבקש קישור חדש: Supabase Dashboard ← Authentication ← Users ← המשתמש ← Reset password ← Send password recovery.
            </p>
          </>
        ) : null}

        {status === "ready" && !done ? (
          <>
            <h2>קביעת סיסמה חדשה</h2>
            <form className="form-stack" onSubmit={submit}>
              <label>
                <span>סיסמה חדשה</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={6}
                  autoFocus
                />
              </label>
              <label>
                <span>אימות סיסמה</span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  required
                  minLength={6}
                />
              </label>
              {error ? <p className="form-error">{error}</p> : null}
              <button type="submit" className="primary-button large" disabled={busy}>
                {busy ? "שומר..." : "שמירת סיסמה חדשה"}
              </button>
            </form>
          </>
        ) : null}

        {done ? (
          <>
            <h2>הסיסמה עודכנה בהצלחה</h2>
            <p className="helper-text">אפשר להיכנס למערכת עכשיו עם הסיסמה החדשה.</p>
            <a
              className="primary-button large"
              style={{ display: "block", textAlign: "center", textDecoration: "none", marginTop: 16 }}
              href="/"
            >
              כניסה למערכת
            </a>
          </>
        ) : null}
      </div>
    </div>
  );
}
