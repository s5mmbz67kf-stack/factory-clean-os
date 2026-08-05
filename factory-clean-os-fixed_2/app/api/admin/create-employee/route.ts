import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function normalizePhone(phone: string) {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("972")) digits = `0${digits.slice(3)}`;
  if (!digits.startsWith("0") && digits.length === 9) digits = `0${digits}`;
  return digits;
}

function workerEmail(phone: string) {
  return `${normalizePhone(phone)}@workers.factoryclean.co.il`;
}

export async function POST(request: NextRequest) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !publishableKey || !secretKey) {
      return NextResponse.json(
        { error: "חסרים משתני סביבה בצד השרת." },
        { status: 500 },
      );
    }

    const authorization = request.headers.get("authorization");
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : null;

    if (!token) {
      return NextResponse.json({ error: "לא נמצאה התחברות תקפה." }, { status: 401 });
    }

    const userClient = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser(token);
    if (userError || !userData.user) {
      return NextResponse.json({ error: "ההתחברות פגה. יש להיכנס מחדש." }, { status: 401 });
    }

    const adminClient = createClient(url, secretKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    const { data: profile, error: profileError } = await adminClient
      .from("profiles")
      .select("role, active")
      .eq("id", userData.user.id)
      .single();

    if (profileError || !profile || profile.role !== "admin" || !profile.active) {
      return NextResponse.json({ error: "הפעולה מותרת למנהל בלבד." }, { status: 403 });
    }

    const body = await request.json();
    const name = String(body.name || "").trim();
    const phone = normalizePhone(String(body.phone || ""));
    const pin = String(body.pin || "").trim();
    const regularRate = Number(body.regularRate ?? 45);
    const midragRate = Number(body.midragRate ?? 37.5);

    if (name.length < 2) {
      return NextResponse.json({ error: "יש להזין שם עובד." }, { status: 400 });
    }
    if (!/^05\d{8}$/.test(phone)) {
      return NextResponse.json({ error: "מספר הטלפון אינו תקין." }, { status: 400 });
    }
    if (!/^\d{4}$/.test(pin)) {
      return NextResponse.json({ error: "הקוד האישי חייב להכיל 4 ספרות." }, { status: 400 });
    }
    if (
      !Number.isFinite(regularRate) ||
      !Number.isFinite(midragRate) ||
      regularRate < 0 ||
      regularRate > 100 ||
      midragRate < 0 ||
      midragRate > 100
    ) {
      return NextResponse.json({ error: "אחוזי השכר אינם תקינים." }, { status: 400 });
    }

    const email = workerEmail(phone);
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password: pin,
      email_confirm: true,
      user_metadata: { full_name: name, phone },
    });

    if (createError || !created.user) {
      const duplicate = createError?.message.toLowerCase().includes("already") ||
        createError?.message.toLowerCase().includes("registered");
      return NextResponse.json(
        { error: duplicate ? "כבר קיים משתמש עם מספר הטלפון הזה." : createError?.message || "יצירת המשתמש נכשלה." },
        { status: 400 },
      );
    }

    const userId = created.user.id;
    const { error: profileUpdateError } = await adminClient
      .from("profiles")
      .upsert({
        id: userId,
        role: "employee",
        full_name: name,
        phone,
        active: true,
      });

    if (profileUpdateError) {
      await adminClient.auth.admin.deleteUser(userId);
      return NextResponse.json({ error: profileUpdateError.message }, { status: 400 });
    }

    const { data: employee, error: employeeError } = await adminClient
      .from("employees")
      .insert({
        user_id: userId,
        name,
        phone,
        regular_rate: regularRate,
        midrag_rate: midragRate,
        active: true,
      })
      .select("id, name, phone, regular_rate, midrag_rate")
      .single();

    if (employeeError) {
      await adminClient.auth.admin.deleteUser(userId);
      return NextResponse.json({ error: employeeError.message }, { status: 400 });
    }

    return NextResponse.json({ employee });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "אירעה שגיאה לא צפויה." },
      { status: 500 },
    );
  }
}
