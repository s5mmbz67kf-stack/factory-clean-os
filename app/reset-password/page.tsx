"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";

type PageState = "checking" | "ready" | "invalid" | "saving" | "success";

export default function ResetPasswordPage() {
  const supabase = useMemo(() => createBrowserSupabase(), []);
  const [pageState, setPageState] = useState<PageState>("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    const finishWithSession = () => {
      if (!active) return;
      setError("");
      setPageState("ready");
    };

    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (session && (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN" || event === "INITIAL_SESSION")) {
        finishWithSession();
      }
    });

    async function initializeRecovery() {
      const searchParams = new URLSearchParams(window.location.search);
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const urlError = searchParams.get("error_description") || hashParams.get("error_description");

      if (urlError) {
        if (!active) return;
        setError(decodeURIComponent(urlError.replace(/\+/g, " ")));
        setPageState("invalid");
        return;
      }

      const code = searchParams.get("code");
      if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
        if (exchangeError) {
          if (!active) return;
          setError("קישור האיפוס אינו תקף או שפג תוקפו. בקש קישור חדש ממסך הכניסה.");
          setPageState("invalid");
          return;
        }
      }

      const { data, error: sessionError } = await supabase.auth.getSession();
      if (!active) return;

      if (sessionError || !data.session) {
        setError("קישור האיפוס אינו תקף או שפג תוקפו. בקש קישור חדש ממסך הכניסה.");
        setPageState("invalid");
        return;
      }

      finishWithSession();
    }

    void initializeRecovery();

    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, [supabase]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("הסיסמה צריכה להכיל לפחות 8 תווים.");
      return;
    }

    if (password !== confirmPassword) {
      setError("שתי הסיסמאות אינן זהות.");
      return;
    }

    setPageState("saving");
    const { error: updateError } = await supabase.auth.updateUser({ password });

    if (updateError) {
      setError(updateError.message || "לא הצלחנו לעדכן את הסיסמה. נסה שוב.");
      setPageState("ready");
      return;
    }

    setPageState("success");
    await supabase.auth.signOut();
    window.setTimeout(() => {
      window.location.assign("/?password-updated=1");
    }, 1400);
  }

  return (
    <main className="login-page reset-password-page">
      <section className="login-copy">
        <div className="brand-lockup">
          <div className="brand-mark">F</div>
          <div>
            <strong>Factory Clean</strong>
            <span>מערכת ניהול העסק</span>
          </div>
        </div>
        <h1>חוזרים לעסק.</h1>
        <p>בחר סיסמה חדשה לחשבון המנהל. לאחר השמירה תחזור למסך הכניסה ותוכל להיכנס מיד.</p>
        <div className="login-benefits">
          <span>✓ לפחות 8 תווים</span>
          <span>✓ מומלץ לשלב אותיות ומספרים</span>
          <span>✓ הסיסמה נשמרת בצורה מאובטחת ב־Supabase</span>
        </div>
      </section>

      <section className="login-card reset-card">
        <span className="eyebrow">אבטחת חשבון</span>
        <h2>הגדרת סיסמה חדשה</h2>

        {pageState === "checking" ? (
          <div className="reset-status" role="status">
            <span className="spinner" aria-hidden="true" />
            <strong>בודק את קישור האיפוס…</strong>
            <p>זה לוקח רק כמה שניות.</p>
          </div>
        ) : null}

        {pageState === "invalid" ? (
          <div className="reset-status">
            <div className="status-icon error">!</div>
            <strong>לא ניתן להשתמש בקישור הזה</strong>
            <p>{error}</p>
            <a className="primary-button large reset-link" href="/">חזרה למסך הכניסה</a>
          </div>
        ) : null}

        {pageState === "success" ? (
          <div className="reset-status" role="status">
            <div className="status-icon success">✓</div>
            <strong>הסיסמה עודכנה בהצלחה</strong>
            <p>מעביר אותך למסך הכניסה…</p>
          </div>
        ) : null}

        {pageState === "ready" || pageState === "saving" ? (
          <form onSubmit={submit} className="form-stack">
            <label>
              <span>סיסמה חדשה</span>
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoFocus
              />
            </label>
            <label>
              <span>אימות סיסמה חדשה</span>
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
              />
            </label>
            {error ? <p className="form-error">{error}</p> : null}
            <button className="primary-button large" disabled={pageState === "saving"}>
              {pageState === "saving" ? "שומר סיסמה…" : "שמירת הסיסמה החדשה"}
            </button>
            <a className="login-back-link" href="/">חזרה למסך הכניסה</a>
          </form>
        ) : null}
      </section>
    </main>
  );
}
