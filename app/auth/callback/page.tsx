"use client";

import { useEffect, useMemo, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";

export default function AuthCallbackPage() {
  const supabase = useMemo(() => createBrowserSupabase(), []);
  const [message, setMessage] = useState("מאמת את הכניסה…");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;

    async function completeSignIn() {
      try {
        const url = new URL(window.location.href);
        const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
        const query = url.searchParams;

        const errorDescription =
          hash.get("error_description") ||
          query.get("error_description") ||
          hash.get("error") ||
          query.get("error");

        if (errorDescription) {
          throw new Error(errorDescription);
        }

        const code = query.get("code");
        const tokenHash = query.get("token_hash");
        const type = query.get("type") || "magiclink";
        const accessToken = hash.get("access_token");
        const refreshToken = hash.get("refresh_token");

        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else if (tokenHash) {
          const { error } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: type as "magiclink" | "recovery" | "email",
          });
          if (error) throw error;
        } else if (accessToken && refreshToken) {
          const { error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (error) throw error;
        } else {
          const { data } = await supabase.auth.getSession();
          if (!data.session) {
            throw new Error("לא נמצא אסימון התחברות בקישור.");
          }
        }

        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        if (!data.session) throw new Error("ההתחברות לא נשמרה.");

        if (!active) return;
        setMessage("הכניסה הצליחה. מעביר למערכת…");
        window.history.replaceState({}, "", "/auth/callback");
        window.location.replace("/");
      } catch (error) {
        console.error("Auth callback failed", error);
        if (!active) return;
        setFailed(true);
        setMessage("הקישור אינו תקף, כבר שומש או שפג תוקפו.");
      }
    }

    void completeSignIn();

    return () => {
      active = false;
    };
  }, [supabase]);

  return (
    <main
      dir="rtl"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#f4f1e9",
        fontFamily: "Arial, sans-serif",
        padding: 24,
      }}
    >
      <section
        style={{
          width: "min(480px, 100%)",
          background: "#fff",
          borderRadius: 24,
          padding: 32,
          boxShadow: "0 18px 60px rgba(18, 59, 55, 0.12)",
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 18,
            display: "grid",
            placeItems: "center",
            margin: "0 auto 18px",
            background: failed ? "#fce8e8" : "#e8f5f3",
            color: failed ? "#a12b2b" : "#0b6b68",
            fontSize: 28,
            fontWeight: 800,
          }}
        >
          {failed ? "!" : "F"}
        </div>
        <h1 style={{ margin: "0 0 12px", color: "#153b37", fontSize: 28 }}>
          Factory Clean OS
        </h1>
        <p style={{ margin: 0, color: "#526b68", lineHeight: 1.7 }}>{message}</p>
        {failed ? (
          <a
            href="/"
            style={{
              display: "inline-block",
              marginTop: 22,
              padding: "12px 20px",
              borderRadius: 12,
              background: "#087b78",
              color: "#fff",
              textDecoration: "none",
              fontWeight: 700,
            }}
          >
            חזרה למסך הכניסה
          </a>
        ) : null}
      </section>
    </main>
  );
}
