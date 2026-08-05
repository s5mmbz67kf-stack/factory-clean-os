"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";

type PageState = "checking" | "link-ready" | "otp-ready" | "saving" | "success";

export default function ResetPasswordPage() {
  const supabase = useMemo(() => createBrowserSupabase(), []);
  const [pageState, setPageState] = useState<PageState>("checking");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  const isOtpFlow = pageState === "otp-ready";

  useEffect(() => {
    let active = true;

    const finishWithSession = () => {
      if (!active) return;
      setError("");
      setPageState("link-ready");
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
        setError("הקישור אינו תקף. אפשר להשתמש בקוד האימות שקיבלת במייל.");
        setPageState("otp-ready");
        return;
      }

      const code = searchParams.get("code");
      if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
        if (!exchangeError) {
          finishWithSession();
          return;
        }
      }

      const { data, error: sessionError } = await supabase.auth.getSession();
      if (!active) return;

      if (!sessionError && data.session) {
        finishWithSession();
        return;
      }

      // Some Supabase recovery emails contain a one-time code instead of a link.
      setPageState("otp-ready");
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

    if (isOtpFlow) {
      const cleanEmail = email.trim();
      const cleanToken = token.replace(/\s/g, "");

      if (!cleanEmail) {
        setError("הכנס את כתובת האימייל של המנהל.");
        return;
      }

      if (!/^\d{6,8}$/.test(cleanToken)) {
        setError("הכנס את קוד האימות שקיבלת במייל.");
        return;
      }

      setPageState("saving");
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email: cleanEmail,
        token: cleanToken,
        type: "recovery",
      });

      if (verifyError) {
        setError("קוד האימות שגוי או שפג תוקפו. בקש קוד חדש ונסה שוב.");
        setPageState("otp-ready");
        return;
      }
    } else {
      setPageState("saving");
    }

    const { error: updateError } = await supabase.auth.updateUser({ password });

    if (updateError) {
      setError(updateError.message || "לא הצלחנו לעדכן את הסיסמה. נסה שוב.");
      setPageState(isOtpFlow ? "otp-ready" : "link-ready");
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
        <p>אמת את החשבון ובחר סיסמה חדשה. לאחר השמירה תחזור למסך הכניסה.</p>
        <div className="login-benefits">
          <span>✓ אפשר להשתמש בקישור או בקוד שקיבלת במייל</span>
          <span>✓ הסיסמה החדשה צריכה להכיל לפחות 8 תווים</span>
          <span>✓ הקוד הוא חד־פעמי ואינו הסיסמה הקבועה</span>
        </div>
      </section>

      <section className="login-card reset-card">
        <span className="eyebrow">אבטחת חשבון</span>
        <h2>הגדרת סיסמה חדשה</h2>

        {pageState === "checking" ? (
          <div className="reset-status" role="status">
            <span className="spinner" aria-hidden="true" />
            <strong>בודק את פרטי האיפוס…</strong>
            <p>זה לוקח רק כמה שניות.</p>
          </div>
        ) : null}

        {pageState === "success" ? (
          <div className="reset-status" role="status">
            <div className="status-icon success">✓</div>
            <strong>הסיסמה עודכנה בהצלחה</strong>
            <p>מעביר אותך למסך הכניסה…</p>
          </div>
        ) : null}

        {pageState === "link-ready" || pageState === "otp-ready" || pageState === "saving" ? (
          <form onSubmit={submit} className="form-stack">
            {isOtpFlow ? (
              <>
                <label>
                  <span>אימייל מנהל</span>
                  <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    autoFocus
                  />
                </label>
                <label>
                  <span>קוד אימות מהמייל</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="לדוגמה: 123456"
                    value={token}
                    onChange={(event) => setToken(event.target.value.replace(/\D/g, ""))}
                    minLength={6}
                    maxLength={8}
                    required
                  />
                </label>
              </>
            ) : null}

            <label>
              <span>סיסמה חדשה</span>
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoFocus={!isOtpFlow}
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
              {pageState === "saving" ? "מאמת ושומר…" : "שמירת הסיסמה החדשה"}
            </button>
            <a className="login-back-link" href="/">חזרה למסך הכניסה</a>
          </form>
        ) : null}
      </section>
    </main>
  );
}
