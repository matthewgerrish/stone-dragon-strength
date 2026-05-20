/* ============ Stone Dragon — Supabase cloud sync ============
 *
 * Additive: localStorage stays the source of truth on each device.
 * Coach edits → debounced push of that athlete row.
 * Athlete logs progress → debounced push of progress row.
 * Athlete signs in cross-device → invite-code lookup hits the cloud.
 * Coach opens an athlete → pulls latest progress on demand.
 *
 * All failures degrade silently (warn-and-continue). Offline still works.
 */
(function () {
  "use strict";

  const cfg = window.STONE_DRAGON_CONFIG;
  if (!cfg?.SUPABASE_URL || !cfg?.SUPABASE_ANON_KEY) {
    console.warn("[Cloud] No config; running in local-only mode.");
    window.Cloud = { enabled: false };
    return;
  }
  if (!window.supabase) {
    console.error("[Cloud] Supabase JS not loaded.");
    window.Cloud = { enabled: false };
    return;
  }
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

  // -------- Row <-> in-memory shape conversion --------
  function athleteToRow(c, coachId) {
    return {
      id: c.id,
      coach_id: coachId || null,
      name: c.name || "",
      invite_code: c.inviteCode || c.id,
      age: c.age || null,
      height_in: c.heightIn || null,
      weight_lb: c.weightLb || null,
      goals: c.goals || null,
      notes: c.notes || null,
      weeks: c.weeks || [],
      schedule: c.schedule || {},
      coach_prs: c.coachPRs || [],
      updated_at: new Date().toISOString(),
    };
  }
  function rowToAthlete(r) {
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      inviteCode: r.invite_code,
      age: r.age || "",
      heightIn: r.height_in || "",
      weightLb: r.weight_lb || "",
      goals: r.goals || "",
      notes: r.notes || "",
      weeks: r.weeks || [],
      schedule: r.schedule || {},
      coachPRs: r.coach_prs || [],
      _coachId: r.coach_id || null,
    };
  }
  function progressToRow(p, athleteId) {
    return {
      athlete_id: athleteId,
      exercise_logs: p.exerciseLogs || {},
      bodyweight_log: p.bodyweightLog || [],
      day_completions: p.dayCompletions || {},
      personal_records: p.personalRecords || [],
      feedback: p.feedback || "",
      synced_at: new Date().toISOString(),
    };
  }
  function rowToProgress(r) {
    if (!r) return null;
    return {
      exerciseLogs: r.exercise_logs || {},
      bodyweightLog: r.bodyweight_log || [],
      dayCompletions: r.day_completions || {},
      personalRecords: r.personal_records || [],
      feedback: r.feedback || "",
      syncedAt: r.synced_at,
    };
  }

  async function upsertCoach(coachId, name, pinHash) {
    if (!coachId) return false;
    try {
      const { error } = await sb
        .from("coaches")
        .upsert({ id: coachId, name: name || "", pin_hash: pinHash || "" });
      if (error) console.warn("[Cloud] upsertCoach error", error.message);
      return !error;
    } catch (e) { console.warn("[Cloud] upsertCoach", e); return false; }
  }

  async function upsertAthlete(athlete, coachId) {
    try {
      const { error } = await sb.from("athletes").upsert(athleteToRow(athlete, coachId));
      if (error) console.warn("[Cloud] upsertAthlete error", error.message);
      return !error;
    } catch (e) { console.warn("[Cloud] upsertAthlete", e); return false; }
  }

  async function getAthleteByInviteCode(code) {
    try {
      const { data, error } = await sb
        .from("athletes")
        .select("*")
        .eq("invite_code", code)
        .maybeSingle();
      if (error) { console.warn("[Cloud] getAthleteByInviteCode", error.message); return null; }
      return rowToAthlete(data);
    } catch (e) { console.warn(e); return null; }
  }

  async function getAthleteById(id) {
    try {
      const { data, error } = await sb.from("athletes").select("*").eq("id", id).maybeSingle();
      if (error) return null;
      return rowToAthlete(data);
    } catch (e) { return null; }
  }

  async function upsertProgress(athleteId, progress) {
    if (!athleteId) return false;
    try {
      const { error } = await sb.from("progress").upsert(progressToRow(progress, athleteId));
      if (error) console.warn("[Cloud] upsertProgress error", error.message);
      return !error;
    } catch (e) { console.warn("[Cloud] upsertProgress", e); return false; }
  }

  async function getProgress(athleteId) {
    if (!athleteId) return null;
    try {
      const { data, error } = await sb
        .from("progress")
        .select("*")
        .eq("athlete_id", athleteId)
        .maybeSingle();
      if (error) { console.warn("[Cloud] getProgress", error.message); return null; }
      return rowToProgress(data);
    } catch (e) { return null; }
  }

  async function upsertAthleteProfile(athleteId, profile) {
    if (!athleteId || !profile) return false;
    try {
      const { error } = await sb.from("athlete_profiles").upsert({
        athlete_id: athleteId,
        display_name: profile.name || "",
        pw_hash: profile.pwHash || "",
      });
      if (error) console.warn("[Cloud] upsertAthleteProfile", error.message);
      return !error;
    } catch (e) { console.warn(e); return false; }
  }

  // Debounce helper used by callers
  const _debounceTimers = new Map();
  function debounce(key, fn, ms = 1500) {
    const prev = _debounceTimers.get(key);
    if (prev) clearTimeout(prev);
    _debounceTimers.set(key, setTimeout(() => {
      _debounceTimers.delete(key);
      Promise.resolve(fn()).catch((e) => console.warn("[Cloud] debounced call failed", e));
    }, ms));
  }

  window.Cloud = {
    enabled: true,
    sb,
    upsertCoach,
    upsertAthlete,
    getAthleteByInviteCode,
    getAthleteById,
    upsertProgress,
    getProgress,
    upsertAthleteProfile,
    debounce,
  };
  console.log("[Cloud] ready");
})();
