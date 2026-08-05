"use client";
import { useState } from "react";

export default function AdminResetPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");
    if (password.length < 10) return setMessage("הסיסמה חייבת להכיל לפחות 10 תווים.");
    if (password !== confirm) return setMessage("הסיסמאות אינן זהות.");
    setLoading(true);
    try {
      const r = await fetch("/api/admin-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "_otPdVP9tgxmnTMLc8WaoWcWMTyNyqyqwidSK66UKKc", password })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "העדכון נכשל.");
      setMessage("הסיסמה עודכנה בהצלחה. אפשר להיכנס למערכת.");
      setPassword("");
      setConfirm("");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "העדכון נכשל.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main dir="rtl" style={{minHeight:"100vh",display:"grid",placeItems:"center",background:"#f5f1e9",padding:24,fontFamily:"Arial,sans-serif"}}>
      <form onSubmit={submit} style={{width:"min(440px,100%)",background:"#fff",borderRadius:24,padding:32,boxShadow:"0 18px 60px rgba(18,59,55,.12)"}}>
        <h1 style={{marginTop:0,color:"#153b37"}}>הגדרת סיסמת מנהל</h1>
        <p style={{color:"#60736f"}}>בחר סיסמה חדשה וקבועה לכניסת המנהל.</p>
        <label>סיסמה חדשה</label>
        <input type="password" value={password} onChange={e=>setPassword(e.target.value)} style={{width:"100%",boxSizing:"border-box",padding:14,borderRadius:12,border:"1px solid #c9d8d5",margin:"6px 0 16px"}} />
        <label>אימות סיסמה</label>
        <input type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} style={{width:"100%",boxSizing:"border-box",padding:14,borderRadius:12,border:"1px solid #c9d8d5",margin:"6px 0 16px"}} />
        <button disabled={loading} style={{width:"100%",padding:14,border:0,borderRadius:12,background:"#087b78",color:"#fff",fontWeight:700}}>
          {loading ? "מעדכן…" : "שמירת הסיסמה החדשה"}
        </button>
        {message && <p style={{marginTop:18}}>{message}</p>}
        <a href="/" style={{display:"inline-block",marginTop:14,color:"#087b78"}}>חזרה למסך הכניסה</a>
      </form>
    </main>
  );
}
