"use server";

import { revalidatePath } from "next/cache";

import { authorize } from "@/lib/auth/session";
import { toFieldErrors, readString, type FormState } from "@/lib/actions/state";
import type { CreateReservationState } from "@/lib/constants/reservation-state";
import { getRestaurant } from "@/lib/data/restaurant";
import { notifyReservationStatusChange } from "@/lib/notifications/reservation";
import { createClient } from "@/lib/supabase/server";
import { todayDateString } from "@/lib/constants/reservation";
import { availabilityQuerySchema, reservationDraftSchema, adminReservationSchema, type ReservationStatus } from "@/lib/validations/reservation";
import type { Tables } from "@/types/database";

export interface AvailableTable extends Tables<"tables"> {
  available: boolean;
}

export type AvailabilityResult =
  | { ok: true; tables: AvailableTable[]; durationMinutes: number }
  | { ok: false; message: string };

/**
 * Which tables fit the party and are free for the requested slot. This is a
 * convenience for the floor-plan UI only — it is re-checked in full when the
 * booking is actually submitted, because nothing selected here can be trusted
 * to still be true by the time the guest confirms.
 */
export async function getAvailableTablesAction(rawInput: unknown): Promise<AvailabilityResult> {
  const parsed = availabilityQuerySchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, message: "Check your date, time and guest count." };
  }
  const { date, time, guestCount, experienceId } = parsed.data;

  if (date < todayDateString()) {
    return { ok: false, message: "Choose a date that hasn’t passed yet." };
  }

  const restaurant = await getRestaurant();
  if (!restaurant) return { ok: false, message: "We can’t take reservations right now." };

  // Tables and experiences are public-read (see the migrations' *_public_read
  // policies), so this works the same for a signed-out guest browsing the
  // floor plan as for a signed-in one — sign-in is only required to submit.
  const client = await createClient();

  let allowedAreas: string[] = [];
  if (experienceId) {
    const { data: experience, error: expError } = await client
      .from("dining_experiences")
      .select("*")
      .eq("id", experienceId)
      .eq("restaurant_id", restaurant.id)
      .eq("is_active", true)
      .maybeSingle();

    if (expError || !experience) {
      return { ok: false, message: "That experience is no longer available. Choose another or skip this step." };
    }
    if (experience.min_guests && guestCount < experience.min_guests) {
      return { ok: false, message: `This experience needs at least ${experience.min_guests} guests.` };
    }
    if (experience.max_guests && guestCount > experience.max_guests) {
      return { ok: false, message: `This experience seats at most ${experience.max_guests} guests.` };
    }
    allowedAreas = experience.available_areas ?? [];
  }

  let tablesQuery = client
    .from("tables")
    .select("*")
    .eq("restaurant_id", restaurant.id)
    .eq("is_active", true)
    .lte("min_capacity", guestCount)
    .gte("capacity", guestCount);
  if (allowedAreas.length > 0) tablesQuery = tablesQuery.in("area", allowedAreas);

  const [{ data: tables, error: tablesError }, { data: reservedIds, error: rpcError }] = await Promise.all([
    tablesQuery.order("label", { ascending: true }),
    client.rpc("reserved_table_ids", {
      p_restaurant_id: restaurant.id,
      p_date: date,
      p_time: time,
      p_duration_minutes: restaurant.reservation_duration_minutes,
    }),
  ]);

  if (tablesError || rpcError) {
    console.error("[reservation] availability check failed:", tablesError?.message, rpcError?.message);
    return { ok: false, message: "We couldn’t check availability. Please try again." };
  }

  const reservedSet = new Set(reservedIds ?? []);
  const result: AvailableTable[] = (tables ?? []).map((t) => ({ ...t, available: !reservedSet.has(t.id) }));

  return { ok: true, tables: result, durationMinutes: restaurant.reservation_duration_minutes };
}


/** Final booking submission. Every input is re-validated and re-checked
 * against the live database — a submitted draft can never hand back a table,
 * a status, or a total directly. The database’s exclusion constraint is the
 * ultimate guard against a race with another guest booking the same table. */
export async function createReservationAction(rawInput: unknown): Promise<CreateReservationState> {
  const auth = await authorize("user");
  if (!auth.ok) return { status: "error", message: auth.message };

  const parsed = reservationDraftSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Check your reservation details and try again.",
      fieldErrors: toFieldErrors(parsed.error),
    };
  }
  const draft = parsed.data;

  if (draft.date < todayDateString()) {
    return { status: "error", message: "Choose a date that hasn’t passed yet." };
  }

  const restaurant = await getRestaurant();
  if (!restaurant) return { status: "error", message: "We can’t take reservations right now." };

  const { data: table, error: tableError } = await auth.supabase
    .from("tables")
    .select("*")
    .eq("id", draft.tableId)
    .eq("restaurant_id", restaurant.id)
    .eq("is_active", true)
    .maybeSingle();
  if (tableError || !table) {
    return { status: "error", message: "That table is no longer available. Please choose another." };
  }
  if (draft.guestCount < table.min_capacity || draft.guestCount > table.capacity) {
    return { status: "error", message: "That table doesn’t fit your party size. Please choose another." };
  }

  const { data: reservedIds, error: rpcError } = await auth.supabase.rpc("reserved_table_ids", {
    p_restaurant_id: restaurant.id,
    p_date: draft.date,
    p_time: draft.time,
    p_duration_minutes: restaurant.reservation_duration_minutes,
  });
  if (rpcError) {
    console.error("[reservation] re-check failed:", rpcError.message);
    return { status: "error", message: "We couldn’t confirm availability. Please try again." };
  }
  if ((reservedIds ?? []).includes(draft.tableId)) {
    return { status: "error", message: "That table was just booked by someone else. Please choose another." };
  }

  const { data: inserted, error: insertError } = await auth.supabase
    .from("reservations")
    .insert({
      restaurant_id: restaurant.id,
      customer_id: auth.ctx.user.id,
      table_id: draft.tableId,
      reservation_date: draft.date,
      reservation_time: draft.time,
      duration_minutes: restaurant.reservation_duration_minutes,
      guest_count: draft.guestCount,
      experience_id: draft.experienceId ?? null,
      occasion: draft.occasion ?? null,
      special_request: draft.specialRequest ?? null,
      status: "pending",
    })
    .select("id")
    .single();

  if (insertError) {
    // 23P01 = exclusion-constraint violation (double booking), 23505 = the
    // one-live-reservation-per-slot unique index. Either means someone won the race.
    if (insertError.code === "23P01" || insertError.code === "23505") {
      return { status: "error", message: "That slot was just taken. Please choose another table or time." };
    }
    console.error("[reservation] insert failed:", insertError.message);
    return { status: "error", message: "We couldn’t complete your reservation. Please try again." };
  }

  if (draft.preferences.length > 0) {
    const { error: prefError } = await auth.supabase
      .from("reservation_preferences")
      .insert(draft.preferences.map((preference) => ({ reservation_id: inserted.id, preference })));
    if (prefError) console.error("[reservation] preferences insert failed:", prefError.message);
  }

  revalidatePath("/account/reservations");
  return { status: "success", reservationId: inserted.id };
}

export interface CancelReservationResult {
  ok: boolean;
  message?: string;
}

/** Customers may only cancel their own pending/confirmed reservation — RLS and
 * the `reservations_guard_customer` trigger enforce this even if this check is bypassed. */
export async function cancelReservationAction(reservationId: string): Promise<CancelReservationResult> {
  const auth = await authorize("user");
  if (!auth.ok) return { ok: false, message: auth.message };

  const { data, error } = await auth.supabase
    .from("reservations")
    .update({ status: "cancelled" })
    .eq("id", reservationId)
    .eq("customer_id", auth.ctx.user.id)
    .select("id");

  if (error) {
    console.error("[reservation] cancel failed:", error.message);
    return { ok: false, message: "We couldn’t cancel that reservation. It may no longer be changeable." };
  }
  if (!data || data.length === 0) {
    return { ok: false, message: "That reservation couldn’t be found." };
  }

  revalidatePath("/account/reservations");
  return { ok: true };
}

// ---------------------------------------------------------------------
// Admin editing (staff/admin only — separate from the guest-facing flow above)
// ---------------------------------------------------------------------

export type SimpleActionResult = { ok: true } | { ok: false; message: string };

function revalidateAdminReservationPaths() {
  revalidatePath("/admin/reservations");
  revalidatePath("/admin");
  revalidatePath("/admin/tonight");
  revalidatePath("/account/reservations");
}

function readAdminReservationForm(formData: FormData) {
  return {
    date: readString(formData, "date"),
    time: readString(formData, "time"),
    guestCount: readString(formData, "guestCount"),
    experienceId: readString(formData, "experienceId"),
    tableId: readString(formData, "tableId"),
    occasion: readString(formData, "occasion"),
    preferences: formData.getAll("preferences").filter((v): v is string => typeof v === "string"),
    specialRequest: readString(formData, "specialRequest"),
    status: readString(formData, "status") || "pending",
    contactName: readString(formData, "contactName"),
    contactPhone: readString(formData, "contactPhone"),
    contactEmail: readString(formData, "contactEmail"),
  };
}

function toAdminEchoValues(raw: ReturnType<typeof readAdminReservationForm>): Record<string, string> {
  return {
    date: raw.date,
    time: raw.time,
    guestCount: raw.guestCount,
    experienceId: raw.experienceId,
    tableId: raw.tableId,
    occasion: raw.occasion,
    specialRequest: raw.specialRequest,
    status: raw.status,
    contactName: raw.contactName,
    contactPhone: raw.contactPhone,
    contactEmail: raw.contactEmail,
  };
}

/** Staff/admin edit of any field on a reservation, including status, table,
 * and contact details for walk-ins. Server-side validation runs regardless
 * of what the client sent; the database's own triggers (table fit, double-
 * booking, experience guest limits) are the final word underneath this. */
export async function adminUpdateReservationAction(id: string, _previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("staff");
  if (!auth.ok) return { status: "error", message: auth.message };

  const restaurant = await getRestaurant();
  if (!restaurant) return { status: "error", message: "We can’t find the restaurant record right now." };

  const raw = readAdminReservationForm(formData);
  const parsed = adminReservationSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: "Check the highlighted fields.", fieldErrors: toFieldErrors(parsed.error), values: toAdminEchoValues(raw) };
    
  }

  const { data } = parsed;

  const { data: existing, error: fetchError } = await auth.supabase
    .from("reservations")
    .select("duration_minutes, status, customer_id")
    .eq("id", id)
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();
  if (fetchError || !existing) {
    return { status: "error", message: "That reservation no longer exists.", values: toAdminEchoValues(raw) };
  }

  const { error } = await auth.supabase
    .from("reservations")
    .update({
      reservation_date: data.date,
      reservation_time: data.time,
      guest_count: data.guestCount,
      experience_id: data.experienceId || null,
      table_id: data.tableId || null,
      occasion: data.occasion || null,
      special_request: data.specialRequest,
      status: data.status,
      contact_name: data.contactName,
      contact_phone: data.contactPhone,
      contact_email: data.contactEmail,
    })
    .eq("id", id)
    .eq("restaurant_id", restaurant.id);

  if (error) {
    console.error("[reservation] Admin update failed:", error.message);
    const message =
      error.code === "23P01"
        ? "That table is already booked for this date and time."
        : error.code === "23514"
          ? "That combination isn’t allowed — check the table, guest count and experience match."
          : "We couldn’t save this reservation. Please try again.";
    return { status: "error", message, values: toAdminEchoValues(raw) };
  }

  // Seating preferences are a separate table: replace the set on every save.
  await auth.supabase.from("reservation_preferences").delete().eq("reservation_id", id);
  if (data.preferences.length > 0) {
    await auth.supabase
      .from("reservation_preferences")
      .insert(data.preferences.map((preference) => ({ reservation_id: id, preference })));
  }

  await notifyReservationStatusChange(
    auth.supabase,
    { customer_id: existing.customer_id, reservation_date: data.date, reservation_time: data.time },
    existing.status,
    data.status,
  );

  revalidateAdminReservationPaths();
  revalidatePath("/account/notifications");
  return { status: "success", message: "Reservation updated." };
}

/** Quick status change from the list — no form. Marking a reservation
 * "completed" is what turns it into a verified visit (a database trigger
 * handles that); marking it back off "completed" reverses it. */
export async function adminSetReservationStatusAction(id: string, nextStatus: ReservationStatus): Promise<SimpleActionResult> {
  const auth = await authorize("staff");
  if (!auth.ok) return { ok: false, message: auth.message };

  const restaurant = await getRestaurant();
  if (!restaurant) return { ok: false, message: "We can’t find the restaurant record right now." };

  const { data: before } = await auth.supabase
    .from("reservations")
    .select("status")
    .eq("id", id)
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();

  const { data, error } = await auth.supabase
    .from("reservations")
    .update({ status: nextStatus })
    .eq("id", id)
    .eq("restaurant_id", restaurant.id)
    .select("id, customer_id, reservation_date, reservation_time");

  if (error) {
    console.error("[reservation] Admin status change failed:", error.message);
    return { ok: false, message: "We couldn’t update that reservation." };
  }
  if (!data || data.length === 0) return { ok: false, message: "That reservation no longer exists." };

  await notifyReservationStatusChange(auth.supabase, data[0], before?.status ?? null, nextStatus);

  revalidateAdminReservationPaths();
  revalidatePath("/account/notifications");
  return { ok: true };
}
