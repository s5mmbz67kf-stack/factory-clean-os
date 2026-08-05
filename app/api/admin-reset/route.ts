import { NextResponse } from "next/server";

const ADMIN_USER_ID = "1bc61cf2-fb11-4854-8b13-6f645510e9da";
const RESET_TOKEN = "_otPdVP9tgxmnTMLc8WaoWcWMTyNyqyqwidSK66UKKc";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const token = String(body?.token || "");
    const password = String(body?.password || "");

    if (token !== RESET_TOKEN) return NextResponse.json({ error: "קישור האיפוס אינו תקף." }, { status: 403 });
    if (password.length < 10) return NextResponse.json({ error: "הסיסמה חייבת להכיל לפחות 10 תווים." }, { status: 400 });

    const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    if (!projectUrl || !secretKey) return NextResponse.json({ error: "חסרה הגדרת Supabase בשרת." }, { status: 500 });

    const response = await fetch(`${projectUrl}/auth/v1/admin/users/${ADMIN_USER_ID}`, {
      method: "PUT",
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ password }),
      cache: "no-store"
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return NextResponse.json({ error: data?.message || data?.msg || "Supabase דחתה את עדכון הסיסמה." }, { status: response.status });
    }
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "אירעה שגיאה בעדכון הסיסמה." }, { status: 500 });
  }
}
