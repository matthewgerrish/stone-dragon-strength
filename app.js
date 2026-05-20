/* ============ Stone Dragon Strength Training — app.js ============ */
(function () {
  "use strict";

  // -------- Storage --------
  const KEY_TRAINER = "trainerpro_data_v1";
  const KEY_CLIENT  = "trainerpro_client_v1";
  const KEY_SESSION = "trainerpro_session_v1";
  const KEY_COACH_GATE = "trainerpro_coach_gate_v1";

  // Coach-access shared code. Client-side only — gate against casual visitors,
  // not a real security boundary (anyone reading the JS can find it).
  const COACH_GATE_CODE = "SD253";
  function isCoachGateUnlocked() { return sessionStorage.getItem(KEY_COACH_GATE) === "1"; }
  function lockCoachGate() { sessionStorage.removeItem(KEY_COACH_GATE); }
  function unlockCoachGate() { sessionStorage.setItem(KEY_COACH_GATE, "1"); }

  const DEFAULT_TRAINER = { trainer: null, clients: [] };
  const DEFAULT_CLIENT = { program: null, progress: null };

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return structuredClone(fallback);
      return { ...structuredClone(fallback), ...JSON.parse(raw) };
    } catch {
      return structuredClone(fallback);
    }
  }
  function saveTrainer() {
    localStorage.setItem(KEY_TRAINER, JSON.stringify(state.trainerData));
    // Cloud: debounced push of the client we're currently editing.
    if (window.Cloud?.enabled && state.currentClientId) {
      const c = state.trainerData.clients.find((x) => x.id === state.currentClientId);
      if (c) window.Cloud.debounce(`athlete:${c.id}`, () =>
        window.Cloud.upsertAthlete(c, state.trainerData.coachId)
      );
    }
  }
  function saveClient() {
    localStorage.setItem(KEY_CLIENT, JSON.stringify(state.clientData));
    // Cloud: debounced push of athlete progress.
    const athleteId = state.clientData.program?.clientId;
    if (window.Cloud?.enabled && athleteId && state.clientData.progress) {
      window.Cloud.debounce(`progress:${athleteId}`, () =>
        window.Cloud.upsertProgress(athleteId, state.clientData.progress)
      );
    }
  }

  function hashPin(pin) {
    let h = 0; const s = "tp:" + pin;
    for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
    return String(h);
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function makeInviteCode() {
    // Readable code: omits 0, O, 1, I to avoid confusion. Format XXXX-XXXX.
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s.slice(0, 4) + "-" + s.slice(4);
  }
  function normalizeInviteCode(s) {
    return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  }
  function formatInviteInput(raw) {
    const n = normalizeInviteCode(raw);
    return n.length > 4 ? n.slice(0, 4) + "-" + n.slice(4) : n;
  }

  function todayISO() {
    const d = new Date();
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 10);
  }
  function dateISO(d) {
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 10);
  }
  function parseISO(s) { return new Date(s + "T00:00:00"); }

  function encodeData(obj) {
    const json = JSON.stringify(obj);
    return btoa(unescape(encodeURIComponent(json)));
  }
  function decodeData(str) {
    const cleaned = String(str).replace(/\s+/g, "");
    const json = decodeURIComponent(escape(atob(cleaned)));
    return JSON.parse(json);
  }

  // -------- Data factories --------
  function makeClient(name) {
    return {
      id: uid(), name: name || "New Athlete",
      age: "", heightIn: "", weightLb: "",
      goals: "", notes: "",
      weeks: [],
      schedule: {},
      coachPRs: [],
      inviteCode: makeInviteCode(),
      importedProgress: null,
      createdAt: Date.now(),
    };
  }
  function makePR(seed) {
    return {
      id: uid(),
      name: (seed?.name || "").trim(),
      weight: seed?.weight || "",
      reps: seed?.reps || "",
      date: seed?.date || todayISO(),
      notes: seed?.notes || "",
    };
  }
  function makeWeek(index, label, focus, phaseLabel) {
    return {
      id: uid(),
      label: label || `Week ${index + 1}`,
      focus: focus || "",
      phaseLabel: phaseLabel || "",
      days: [makeDay(1), makeDay(2), makeDay(3)],
      diet: {
        notes: "",
        days: [1,2,3,4,5,6,7].map((d) => ({ day: d, calories: "", protein: "" })),
      },
    };
  }
  function makeDay(n, name) {
    return { id: uid(), name: name || `Day ${n}`, exercises: [makeExercise()] };
  }
  function makeExercise(seed) {
    return {
      id: uid(),
      name: seed?.name || "",
      sets: seed?.sets || "",
      currentWeight: "",
      currentReps: seed?.reps || "",
      goalWeight: "",
      goalReps: "",
      notes: seed?.notes || "",
      videoUrl: seed?.videoUrl || "",
    };
  }

  function getYouTubeId(url) {
    if (!url) return null;
    const s = String(url).trim();
    const m = s.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s; // bare ID
    return null;
  }

  // -------- State --------
  const state = {
    trainerData: loadJSON(KEY_TRAINER, DEFAULT_TRAINER),
    clientData:  loadJSON(KEY_CLIENT,  DEFAULT_CLIENT),
    mode: null,
    currentClientId: null,
    currentTab: "profile",
    coachCal: { year: 0, month: 0 },   // 0-indexed month
    athleteCal: { year: 0, month: 0 },
  };

  // ensure existing clients have new fields
  let _trainerDataDirty = false;
  state.trainerData.clients.forEach((c) => {
    if (!c.schedule) c.schedule = {};
    if (!c.coachPRs) c.coachPRs = [];
    if (!c.inviteCode) { c.inviteCode = makeInviteCode(); _trainerDataDirty = true; }
  });
  // Backfill a stable coachId — used as the cloud "coaches" row key.
  if (!state.trainerData.coachId && state.trainerData.trainer) {
    state.trainerData.coachId = uid();
    _trainerDataDirty = true;
  }
  if (_trainerDataDirty) saveTrainer();

  // One-time cloud backfill: if this device has local data that predates cloud sync,
  // push everything once so cross-device login works without requiring an edit first.
  const KEY_CLOUD_BACKFILLED = "trainerpro_cloud_backfilled_v1";
  if (
    window.Cloud?.enabled &&
    state.trainerData.trainer &&
    state.trainerData.coachId &&
    !localStorage.getItem(KEY_CLOUD_BACKFILLED)
  ) {
    (async () => {
      await window.Cloud.upsertCoach(state.trainerData.coachId, state.trainerData.trainer.name);
      for (const c of state.trainerData.clients) {
        await window.Cloud.upsertAthlete(c, state.trainerData.coachId);
      }
      localStorage.setItem(KEY_CLOUD_BACKFILLED, String(Date.now()));
      console.log(`[Cloud] Backfilled coach + ${state.trainerData.clients.length} athletes.`);
    })().catch((e) => console.warn("[Cloud] backfill failed; will retry next boot", e));
  }

  // -------- DOM helpers --------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }

  function playLoginFlash() {
    document.body.classList.add("login-success");
    setTimeout(() => document.body.classList.remove("login-success"), 1100);
  }

  function celebrateElement(el, className = "pr-celebrate", durationMs = 900) {
    if (!el) return;
    el.classList.remove(className);
    void el.offsetWidth; // restart animation
    el.classList.add(className);
    setTimeout(() => el.classList.remove(className), durationMs);
  }

  function toast(msg, ms = 1800) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add("hidden"), ms);
  }
  function flashSaved(el) {
    if (!el) return;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 1500);
  }
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // -------- Login / role flow --------
  function showLoginScreen(panel) {
    show($("#screen-login"));
    hide($("#screen-app"));
    hide($("#screen-client"));
    ["#login-role", "#login-setup", "#login-signin", "#login-client-import", "#login-athlete-setup", "#login-athlete-signin", "#login-coach-gate"]
      .forEach((s) => hide($(s)));
    show($(panel));
  }

  function pickRole(role) {
    if (role === "trainer") {
      // Gate any path to coach UI behind the shared access code.
      if (!isCoachGateUnlocked()) {
        showLoginScreen("#login-coach-gate");
        $("#coach-gate-input").value = "";
        $("#coach-gate-error").classList.add("hidden");
        setTimeout(() => $("#coach-gate-input").focus(), 50);
        return;
      }
      if (state.trainerData.trainer) {
        showLoginScreen("#login-signin");
        $("#login-hello").textContent = `Sign in as ${state.trainerData.trainer.name}.`;
        setTimeout(() => $("#login-pin").focus(), 50);
      } else {
        showLoginScreen("#login-setup");
        setTimeout(() => $("#setup-name").focus(), 50);
      }
    } else {
      // Athlete role: branch on whether a local profile exists
      const profile = state.clientData.profile;
      const program = state.clientData.program;
      if (profile && program) {
        showAthleteSignin();
      } else if (program && !profile) {
        // Migration: program loaded from older version without a profile yet
        showAthleteSetup();
      } else {
        showAthleteImport();
      }
    }
  }

  function showAthleteImport() {
    showLoginScreen("#login-client-import");
    const btnResume = $("#btn-client-resume");
    const heading = $("#login-athlete-heading");
    const sub = $("#login-athlete-sub");
    heading.textContent = "Welcome, athlete";
    sub.innerHTML = `Enter the <strong>invite code</strong> from your coach.`;
    hide(btnResume);
    $("#invite-code-input").value = "";
    $("#client-code").value = "";
    $("#client-import-error").classList.add("hidden");
    setTimeout(() => $("#invite-code-input")?.focus(), 50);
  }

  function showAthleteSetup() {
    showLoginScreen("#login-athlete-setup");
    const program = state.clientData.program;
    const prefillName = state.clientData.profile?.name || program?.client?.name || "";
    $("#athlete-setup-name").value = prefillName;
    $("#athlete-setup-pw").value = "";
    $("#athlete-setup-pw-confirm").value = "";
    $("#athlete-setup-error").classList.add("hidden");
    setTimeout(() => $("#athlete-setup-pw").focus(), 50);
  }

  function showAthleteSignin() {
    showLoginScreen("#login-athlete-signin");
    const profile = state.clientData.profile;
    const heading = $("#athlete-signin-heading");
    const sub = $("#athlete-signin-sub");
    if (profile?.name) {
      const firstName = profile.name.trim().split(/\s+/)[0];
      heading.textContent = `Welcome back, ${firstName}`;
      sub.textContent = "Enter your password to continue training.";
    } else {
      heading.textContent = "Welcome back";
      sub.textContent = "Enter your password to continue training.";
    }
    $("#athlete-signin-pw").value = "";
    $("#athlete-signin-error").classList.add("hidden");
    setTimeout(() => $("#athlete-signin-pw").focus(), 50);
  }

  function setupAthleteProfile() {
    const name = $("#athlete-setup-name").value.trim();
    const pw = $("#athlete-setup-pw").value;
    const conf = $("#athlete-setup-pw-confirm").value;
    const err = $("#athlete-setup-error");
    if (!name) return showErr(err, "Please enter your name.");
    if (pw.length < 4) return showErr(err, "Password must be at least 4 characters.");
    if (pw !== conf) return showErr(err, "Passwords don't match.");
    state.clientData.profile = {
      name,
      pwHash: hashPin(pw),
      createdAt: Date.now(),
    };
    saveClient();
    const athleteId = state.clientData.program?.clientId;
    if (window.Cloud?.enabled && athleteId) {
      window.Cloud.upsertAthleteProfile(athleteId, state.clientData.profile);
    }
    err.classList.add("hidden");
    playLoginFlash();
    enterClientPortal();
    toast(`Profile saved — welcome, ${name.split(/\s+/)[0]}`);
  }

  function athleteSignIn() {
    const pw = $("#athlete-signin-pw").value;
    const err = $("#athlete-signin-error");
    const profile = state.clientData.profile;
    if (!profile) return showAthleteImport();
    if (hashPin(pw) !== profile.pwHash) {
      return showErr(err, "Incorrect password.");
    }
    err.classList.add("hidden");
    playLoginFlash();
    enterClientPortal();
  }

  function forgetAthleteProfile() {
    if (!window.confirm("Forget this athlete account on this device? You'll need a new invite code from your coach to sign back in. Your logs on this device will be cleared.")) return;
    state.clientData = structuredClone(DEFAULT_CLIENT);
    saveClient();
    sessionStorage.removeItem(KEY_SESSION);
    showAthleteImport();
    toast("Account forgotten");
  }

  function useNewInviteCode() {
    // Keep the profile, but allow re-importing with a new invite/access code.
    showAthleteImport();
  }

  // -------- Coach access gate --------
  function submitCoachGate() {
    const entered = ($("#coach-gate-input").value || "").trim();
    const err = $("#coach-gate-error");
    if (entered.toUpperCase() !== COACH_GATE_CODE) {
      return showErr(err, "Incorrect access code.");
    }
    err.classList.add("hidden");
    unlockCoachGate();
    pickRole("trainer"); // re-routes to setup or signin now that the gate is unlocked
  }

  // -------- Coach auth --------
  function setupAccount() {
    const name = $("#setup-name").value.trim();
    const pin = $("#setup-pin").value;
    const confirmPin = $("#setup-pin-confirm").value;
    const err = $("#setup-error");
    if (!name) return showErr(err, "Please enter your name.");
    if (pin.length < 4) return showErr(err, "PIN must be at least 4 characters.");
    if (pin !== confirmPin) return showErr(err, "PINs don't match.");
    state.trainerData.trainer = { name, pinHash: hashPin(pin) };
    if (!state.trainerData.coachId) state.trainerData.coachId = uid();
    saveTrainer();
    if (window.Cloud?.enabled) {
      window.Cloud.upsertCoach(state.trainerData.coachId, name, hashPin(pin));
    }
    err.classList.add("hidden");
    playLoginFlash();
    signIntoTrainer();
  }
  function signIn() {
    const pin = $("#login-pin").value;
    const err = $("#login-error");
    if (!state.trainerData.trainer) return;
    if (hashPin(pin) !== state.trainerData.trainer.pinHash) return showErr(err, "Incorrect PIN.");
    err.classList.add("hidden");
    playLoginFlash();
    signIntoTrainer();
  }
  function signIntoTrainer() {
    state.mode = "trainer";
    sessionStorage.setItem(KEY_SESSION, "trainer");
    hide($("#screen-login"));
    show($("#screen-app"));
    hide($("#screen-client"));
    $("#header-trainer-name").textContent = state.trainerData.trainer.name;
    renderDashboard();
  }
  function signOutTrainer() {
    state.mode = null;
    sessionStorage.removeItem(KEY_SESSION);
    state.currentClientId = null;
    $("#login-pin").value = "";
    pickRole("trainer");
  }
  function resetTrainerAccount() {
    if (!window.confirm("Delete coach account AND all athlete data on this device?")) return;
    state.trainerData = structuredClone(DEFAULT_TRAINER);
    saveTrainer();
    sessionStorage.removeItem(KEY_SESSION);
    lockCoachGate(); // next coach setup must re-enter the access code
    $("#setup-name").value = ""; $("#setup-pin").value = ""; $("#setup-pin-confirm").value = "";
    showLoginScreen("#login-role");
  }
  function showErr(el, msg) { el.textContent = msg; el.classList.remove("hidden"); }

  // -------- Dashboard --------
  function renderDashboard() {
    state.currentClientId = null;
    show($("#view-dashboard"));
    hide($("#view-client"));
    const grid = $("#client-grid");
    const empty = $("#client-empty");
    grid.innerHTML = "";

    if (state.trainerData.clients.length === 0) { show(empty); return; }
    hide(empty);

    const sorted = [...state.trainerData.clients].sort((a, b) => a.name.localeCompare(b.name));
    for (const c of sorted) {
      const weekCount = c.weeks.length;
      const exerciseCount = c.weeks.reduce((n, w) => n + w.days.reduce((m, d) => m + d.exercises.length, 0), 0);
      const totalDays = c.weeks.reduce((n, w) => n + w.days.length, 0);
      const dc = c.importedProgress?.dayCompletions || {};
      const completedDays = c.weeks.reduce((n, w) =>
        n + w.days.filter((d) => (dc[d.id] || []).length > 0).length, 0);
      const pct = totalDays ? Math.round((completedDays * 100) / totalDays) : 0;
      const isComplete = completedDays === totalDays && totalDays > 0;
      const hasSyncedData = c.importedProgress && (
        Object.keys(c.importedProgress.dayCompletions || {}).length > 0 ||
        Object.keys(c.importedProgress.exerciseLogs || {}).length > 0
      );
      const progressBlock = totalDays === 0
        ? `<div class="week-progress-mini no-data">No program yet</div>`
        : !hasSyncedData
          ? `<div class="week-progress-mini no-data">Awaiting first sync</div>`
          : `
            <div class="week-progress-mini${isComplete ? " complete" : ""}">
              <div class="progress-label">
                <span>${completedDays} / ${totalDays} days complete</span>
                <span class="pct">${pct}%</span>
              </div>
              <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
            </div>`;
      const card = document.createElement("div");
      card.className = "client-card";
      card.innerHTML = `
        <h3>${escapeHtml(c.name)}</h3>
        <div class="meta">${c.age ? escapeHtml(c.age) + " yrs" : "Age not set"}${c.weightLb ? " · " + escapeHtml(c.weightLb) + " lb" : ""}</div>
        <div class="stats">
          <div class="stat"><strong>${weekCount}</strong>${weekCount === 1 ? "week" : "weeks"}</div>
          <div class="stat"><strong>${exerciseCount}</strong>${exerciseCount === 1 ? "exercise" : "exercises"}</div>
        </div>
        ${progressBlock}`;
      card.addEventListener("click", () => openClient(c.id));
      grid.appendChild(card);
    }
  }

  function addClientPrompt() {
    openModal({
      title: "Add new athlete",
      body: `
        <label>Athlete name<input type="text" id="new-client-name" placeholder="e.g. Jamie Lee" autofocus /></label>
        <div class="template-info" style="margin-top:0.6em">
          <strong>Tip:</strong> after creating, you can load our science-based <strong>12-week template</strong>
          (Foundation → Hypertrophy → Strength → Peak) from the Program tab, then tailor exercises and weights.
        </div>`,
      actions: [
        { label: "Cancel", className: "btn btn-ghost", onClick: closeModal },
        { label: "Add athlete", className: "btn btn-primary", onClick: () => {
            const name = $("#new-client-name").value.trim();
            if (!name) return;
            const c = makeClient(name);
            state.trainerData.clients.push(c);
            saveTrainer();
            // Immediate push so cross-device login works the moment the coach shares the invite code.
            if (window.Cloud?.enabled && state.trainerData.coachId) {
              window.Cloud.upsertAthlete(c, state.trainerData.coachId);
            }
            closeModal();
            openClient(c.id);
            toast("Athlete added");
          },
        },
      ],
    });
    setTimeout(() => $("#new-client-name")?.focus(), 50);
  }

  // -------- Client detail --------
  function openClient(id) {
    const c = state.trainerData.clients.find((x) => x.id === id);
    if (!c) return renderDashboard();
    if (!c.schedule) c.schedule = {};
    if (!c.coachPRs) c.coachPRs = [];
    state.currentClientId = id;
    hide($("#view-dashboard"));
    show($("#view-client"));
    $("#client-name-display").textContent = c.name;
    $("#client-meta-display").textContent = clientMetaText(c);
    setTab("profile");
    renderProfile();
    renderWeeks();
    renderDiet();
    renderClientLogs();
    renderCoachPRs();
    const now = new Date();
    state.coachCal = { year: now.getFullYear(), month: now.getMonth() };
    renderCoachCalendar();
    // Pull the latest athlete progress from the cloud (non-blocking).
    if (window.Cloud?.enabled) pullProgressFromCloud(c);
  }
  async function pullProgressFromCloud(c) {
    if (!window.Cloud?.enabled) return;
    const cloudProgress = await window.Cloud.getProgress(c.id);
    if (!cloudProgress) return;
    c.importedProgress = { ...cloudProgress, syncedAt: Date.now() };
    localStorage.setItem(KEY_TRAINER, JSON.stringify(state.trainerData));
    if (state.currentClientId === c.id) {
      renderClientLogs();
      renderCoachCalendar();
    }
  }
  function clientMetaText(c) {
    const parts = [];
    if (c.age) parts.push(`${c.age} yrs`);
    if (c.heightIn) parts.push(`${c.heightIn} in`);
    if (c.weightLb) parts.push(`${c.weightLb} lb`);
    return parts.join(" · ") || "Profile incomplete";
  }
  function currentClient() { return state.trainerData.clients.find((x) => x.id === state.currentClientId); }
  function setTab(name) {
    state.currentTab = name;
    $$(".tab[data-tab]").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $$(".tab-panel[data-tab-panel]").forEach((p) => p.classList.toggle("active", p.dataset.tabPanel === name));
  }

  // -------- Profile --------
  function renderProfile() {
    const c = currentClient(); if (!c) return;
    $("#prof-name").value = c.name;
    $("#prof-age").value = c.age;
    $("#prof-height").value = c.heightIn || "";
    $("#prof-weight").value = c.weightLb || "";
    $("#prof-goals").value = c.goals;
    $("#prof-notes").value = c.notes;
    if (!c.inviteCode) { c.inviteCode = makeInviteCode(); saveTrainer(); }
    $("#invite-code-display").textContent = c.inviteCode;
  }
  function regenerateInviteCode() {
    const c = currentClient(); if (!c) return;
    if (!window.confirm("Regenerate this athlete's invite code? Any old code you've sent them will stop working.")) return;
    c.inviteCode = makeInviteCode();
    saveTrainer();
    $("#invite-code-display").textContent = c.inviteCode;
    toast("New code generated");
  }
  async function copyInviteCode() {
    const c = currentClient(); if (!c) return;
    try { await navigator.clipboard.writeText(c.inviteCode); toast("Code copied"); }
    catch { toast("Couldn't copy — code: " + c.inviteCode, 4000); }
  }
  function bindProfileInputs() {
    const map = {
      "#prof-name": "name", "#prof-age": "age",
      "#prof-height": "heightIn", "#prof-weight": "weightLb",
      "#prof-goals": "goals", "#prof-notes": "notes",
    };
    for (const [sel, field] of Object.entries(map)) {
      $(sel).addEventListener("input", () => {
        const c = currentClient(); if (!c) return;
        c[field] = $(sel).value;
        saveTrainer();
        if (field === "name") $("#client-name-display").textContent = c.name || "(unnamed)";
        $("#client-meta-display").textContent = clientMetaText(c);
        flashSaved($("#prof-saved"));
      });
    }
  }
  function deleteClientPrompt() {
    const c = currentClient(); if (!c) return;
    if (!window.confirm(`Delete ${c.name}? Removes the athlete and their entire program from this device and the cloud.`)) return;
    const cloudId = c.id;
    state.trainerData.clients = state.trainerData.clients.filter((x) => x.id !== c.id);
    saveTrainer();
    // Cloud: delete athlete (CASCADE removes athlete_profiles + progress).
    if (window.Cloud?.enabled) window.Cloud.deleteAthlete(cloudId);
    renderDashboard();
    toast("Athlete deleted");
  }

  // -------- Weeks/program --------
  function renderWeeks() {
    const c = currentClient(); if (!c) return;
    const container = $("#weeks-container");
    const empty = $("#weeks-empty");
    container.innerHTML = "";
    if (c.weeks.length === 0) { show(empty); return; }
    hide(empty);
    c.weeks.forEach((week, wIdx) => container.appendChild(renderWeekCard(week, wIdx)));
  }
  function renderWeekCard(week, wIdx) {
    const card = document.createElement("div");
    card.className = "week-card";
    if (week.phaseLabel) card.classList.add("phase-card");
    if (wIdx === 0) card.classList.add("open");
    const exerciseTotal = week.days.reduce((n, d) => n + d.exercises.length, 0);
    const head = document.createElement("div");
    head.className = "week-head";
    head.innerHTML = `
      <div>
        <h4>${week.phaseLabel ? `<span class="phase-badge">${escapeHtml(week.phaseLabel)}</span>` : ""}${escapeHtml(week.label)}</h4>
        <div class="week-info">${week.days.length} day${week.days.length === 1 ? "" : "s"} · ${exerciseTotal} exercise${exerciseTotal === 1 ? "" : "s"}${week.focus ? " · " + escapeHtml(week.focus) : ""}</div>
      </div>
      <div class="week-head-right">
        <button class="btn-delete-mini" data-action="delete-week">Delete</button>
        <span class="week-toggle">▾</span>
      </div>`;
    head.addEventListener("click", (e) => {
      if (e.target.closest('[data-action="delete-week"]')) return;
      card.classList.toggle("open");
    });
    head.querySelector('[data-action="delete-week"]').addEventListener("click", (e) => {
      e.stopPropagation();
      if (!window.confirm(`Delete ${week.label}?`)) return;
      const c = currentClient();
      c.weeks = c.weeks.filter((w) => w.id !== week.id);
      c.weeks.forEach((w, i) => { if (/^Week \d+$/.test(w.label)) w.label = `Week ${i + 1}`; });
      saveTrainer();
      renderWeeks(); renderDiet(); renderCoachCalendar();
    });

    const body = document.createElement("div");
    body.className = "week-body";
    body.innerHTML = `
      <label class="week-focus-input">Week focus / theme
        <input type="text" placeholder="e.g. Hypertrophy block – upper body emphasis" />
      </label>
      <div class="days-container"></div>
      <button class="add-inline-btn" data-action="add-day">+ Add training day</button>`;
    const focusInput = body.querySelector("input");
    focusInput.value = week.focus;
    focusInput.addEventListener("input", () => { week.focus = focusInput.value; saveTrainer(); });

    const daysContainer = body.querySelector(".days-container");
    week.days.forEach((day) => daysContainer.appendChild(renderDayCard(week, day)));
    body.querySelector('[data-action="add-day"]').addEventListener("click", () => {
      week.days.push(makeDay(week.days.length + 1));
      saveTrainer(); renderWeeks();
    });
    card.appendChild(head); card.appendChild(body);
    return card;
  }
  function renderDayCard(week, day) {
    const card = document.createElement("div");
    card.className = "day-card";
    const head = document.createElement("div");
    head.className = "day-head";
    head.innerHTML = `
      <div class="day-head-left"><input type="text" class="day-name-input" /></div>
      <div class="day-head-right"><button class="btn-delete-mini" data-action="delete-day">Delete day</button></div>`;
    const nameInput = head.querySelector(".day-name-input");
    nameInput.value = day.name;
    nameInput.addEventListener("input", () => { day.name = nameInput.value; saveTrainer(); });
    head.querySelector('[data-action="delete-day"]').addEventListener("click", () => {
      if (!window.confirm(`Delete ${day.name}?`)) return;
      week.days = week.days.filter((d) => d.id !== day.id);
      saveTrainer(); renderWeeks();
    });
    const list = document.createElement("div");
    list.className = "exercises-list";
    day.exercises.forEach((ex) => list.appendChild(renderExerciseCard(day, ex)));
    const addBtn = document.createElement("button");
    addBtn.className = "add-inline-btn";
    addBtn.style.marginTop = "0.6em";
    addBtn.textContent = "+ Add exercise";
    addBtn.addEventListener("click", () => {
      day.exercises.push(makeExercise());
      saveTrainer(); renderWeeks();
    });
    card.appendChild(head); card.appendChild(list); card.appendChild(addBtn);
    return card;
  }
  function renderExerciseCard(day, ex) {
    const card = document.createElement("div");
    card.className = "exercise-card";
    card.innerHTML = `
      <div class="exercise-head">
        <input type="text" class="exercise-name-input" placeholder="Exercise name (e.g. Back Squat)" />
        <button class="btn-delete-mini" data-action="delete-ex">Delete</button>
      </div>
      <div class="exercise-stats-row">
        <fieldset class="stat-block">
          <legend>Sets</legend>
          <div class="stat-inputs"><input type="number" min="0" placeholder="0" data-field="sets" /></div>
        </fieldset>
        <fieldset class="stat-block">
          <legend>Current top set</legend>
          <div class="stat-inputs">
            <input type="number" min="0" step="0.5" placeholder="lb" data-field="currentWeight" />
            <span class="x">×</span>
            <input type="number" min="0" placeholder="reps" data-field="currentReps" />
          </div>
        </fieldset>
        <fieldset class="stat-block">
          <legend>Goal</legend>
          <div class="stat-inputs">
            <input type="number" min="0" step="0.5" placeholder="lb" data-field="goalWeight" />
            <span class="x">×</span>
            <input type="number" min="0" placeholder="reps" data-field="goalReps" />
          </div>
        </fieldset>
      </div>
      <div class="exercise-notes">
        <label>Detailed instructions (technique, tempo, rest, cues, progression)
          <textarea placeholder="e.g. 3-1-1 tempo, 2 min rest, RPE 8 on top set, +5 lb when all reps clean"></textarea>
        </label>
      </div>
      <div class="exercise-video">
        <label>▶ Demo video (YouTube link)
          <input type="text" class="video-url-input" placeholder="https://youtu.be/... or https://youtube.com/watch?v=..." />
        </label>
        <div class="video-status"></div>
      </div>`;
    const nameInput = card.querySelector(".exercise-name-input");
    nameInput.value = ex.name;
    nameInput.addEventListener("input", () => { ex.name = nameInput.value; saveTrainer(); });
    card.querySelectorAll("input[data-field]").forEach((inp) => {
      inp.value = ex[inp.dataset.field];
      inp.addEventListener("input", () => { ex[inp.dataset.field] = inp.value; saveTrainer(); });
    });
    const notes = card.querySelector("textarea");
    notes.value = ex.notes;
    notes.addEventListener("input", () => { ex.notes = notes.value; saveTrainer(); });
    const videoInput = card.querySelector(".video-url-input");
    const videoStatus = card.querySelector(".video-status");
    function updateVideoStatus() {
      const id = getYouTubeId(ex.videoUrl);
      if (id) {
        videoStatus.innerHTML = `<a href="https://youtu.be/${id}" target="_blank" rel="noopener" class="btn btn-sm btn-ghost video-preview-btn">▶ Preview demo</a>`;
      } else if (ex.videoUrl) {
        videoStatus.innerHTML = `<span class="video-warn">⚠ Couldn't parse YouTube ID — athlete will see a plain link</span>`;
      } else {
        videoStatus.innerHTML = "";
      }
    }
    videoInput.value = ex.videoUrl || "";
    updateVideoStatus();
    videoInput.addEventListener("input", () => {
      ex.videoUrl = videoInput.value;
      saveTrainer();
      updateVideoStatus();
    });
    card.querySelector('[data-action="delete-ex"]').addEventListener("click", () => {
      if (!window.confirm("Delete this exercise?")) return;
      day.exercises = day.exercises.filter((e) => e.id !== ex.id);
      saveTrainer(); renderWeeks();
    });
    return card;
  }
  function addWeek() {
    const c = currentClient(); if (!c) return;
    c.weeks.push(makeWeek(c.weeks.length));
    saveTrainer();
    renderWeeks(); renderDiet(); renderCoachCalendar();
    toast("Week added");
  }

  // -------- 12-week template (generic phased periodization) --------
  function loadTemplate() {
    const c = currentClient(); if (!c) return;
    if (c.weeks.length > 0) {
      if (!window.confirm("This will replace the existing program with the 12-week template. Continue?")) return;
    }
    c.weeks = buildTemplateWeeks();
    saveTrainer();
    renderWeeks(); renderDiet(); renderCoachCalendar();
    toast("12-week template loaded");
  }

  function buildTemplateWeeks() {
    // Four phases × 3 weeks. Standard periodization model:
    // Foundation → Hypertrophy → Maximal Strength → Peak (Power).
    // Exercise selections are common compound + accessory movements
    // any strength coach would prescribe. Coach should personalize weights.
    const phases = [
      {
        label: "Foundation",
        focus: "Anatomical adaptation, movement quality, base volume",
        scheme: { setsCompound: "3", repsCompound: "10", setsAccessory: "3", repsAccessory: "12" },
        cue: "Moderate loads (~65% 1RM). Focus on form, tempo, and full ROM. Build base work capacity.",
      },
      {
        label: "Hypertrophy",
        focus: "Drive muscle growth with higher volume",
        scheme: { setsCompound: "4", repsCompound: "8", setsAccessory: "3", repsAccessory: "12" },
        cue: "~70–75% 1RM. Push every set to within 1–2 reps of failure (RPE 8). 60–90 sec rest on accessories.",
      },
      {
        label: "Strength",
        focus: "Build maximal strength with heavier loads",
        scheme: { setsCompound: "5", repsCompound: "5", setsAccessory: "3", repsAccessory: "8" },
        cue: "~80–87% 1RM. Long rest (2–3 min) on compounds. Add 5 lb week-to-week when all reps clean.",
      },
      {
        label: "Peak",
        focus: "Intensify, test top sets, then deload final week",
        scheme: { setsCompound: "5", repsCompound: "3", setsAccessory: "3", repsAccessory: "6" },
        cue: "~88–92% 1RM. Top single allowed in week 11. Week 12 = deload at 60% for recovery.",
      },
    ];

    // 4 training days, body-part split — universal pattern in strength coaching
    const dayTemplates = [
      {
        name: "Day 1 — Lower Body (Squat focus)",
        exercises: [
          { name: "Back Squat", role: "compound" },
          { name: "Romanian Deadlift", role: "compound" },
          { name: "Walking Lunges", role: "accessory" },
          { name: "Leg Curl", role: "accessory" },
          { name: "Standing Calf Raise", role: "accessory" },
        ],
      },
      {
        name: "Day 2 — Upper Push (Chest / Shoulders / Triceps)",
        exercises: [
          { name: "Bench Press", role: "compound" },
          { name: "Overhead Press", role: "compound" },
          { name: "Incline Dumbbell Press", role: "accessory" },
          { name: "Lateral Raise", role: "accessory" },
          { name: "Triceps Pressdown", role: "accessory" },
        ],
      },
      {
        name: "Day 3 — Lower Body (Deadlift focus)",
        exercises: [
          { name: "Deadlift", role: "compound" },
          { name: "Front Squat", role: "compound" },
          { name: "Bulgarian Split Squat", role: "accessory" },
          { name: "Hip Thrust", role: "accessory" },
          { name: "Hanging Knee Raise", role: "accessory" },
        ],
      },
      {
        name: "Day 4 — Upper Pull (Back / Biceps)",
        exercises: [
          { name: "Pull-up (or Lat Pulldown)", role: "compound" },
          { name: "Barbell Row", role: "compound" },
          { name: "Seated Cable Row", role: "accessory" },
          { name: "Face Pull", role: "accessory" },
          { name: "Barbell Curl", role: "accessory" },
        ],
      },
    ];

    const weeks = [];
    let weekIdx = 0;
    phases.forEach((phase) => {
      for (let pw = 1; pw <= 3; pw++) {
        const week = {
          id: uid(),
          label: `Week ${weekIdx + 1}`,
          focus: phase.focus + (pw === 3 ? " (intensification)" : pw === 1 ? " (intro)" : ""),
          phaseLabel: phase.label,
          days: dayTemplates.map((dt, di) => ({
            id: uid(),
            name: dt.name,
            exercises: dt.exercises.map((e) => {
              const isCompound = e.role === "compound";
              return {
                id: uid(),
                name: e.name,
                sets: isCompound ? phase.scheme.setsCompound : phase.scheme.setsAccessory,
                currentWeight: "",
                currentReps: isCompound ? phase.scheme.repsCompound : phase.scheme.repsAccessory,
                goalWeight: "",
                goalReps: "",
                notes: isCompound
                  ? `${phase.label} phase. ${phase.cue}`
                  : "Controlled tempo, full ROM. Pair with main lift; 60–90 sec rest.",
              };
            }),
          })),
          diet: {
            notes: phase.label === "Hypertrophy"
              ? "Slight surplus (~+250 kcal) to support growth. Protein 0.9–1.0 g per lb bodyweight."
              : phase.label === "Strength"
              ? "Maintenance to small surplus. Eat enough carbs around training to fuel heavy sessions."
              : phase.label === "Peak"
              ? "Maintenance. Prioritize sleep, hydration, recovery."
              : "Eat at maintenance. Protein 0.8 g per lb bodyweight minimum.",
            days: [1,2,3,4,5,6,7].map((d) => ({ day: d, calories: "", protein: "" })),
          },
        };
        weeks.push(week);
        weekIdx++;
      }
    });
    return weeks;
  }

  // -------- Diet --------
  const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  function renderDiet() {
    const c = currentClient(); if (!c) return;
    const container = $("#diet-container");
    const empty = $("#diet-empty");
    container.innerHTML = "";
    if (c.weeks.length === 0) { show(empty); return; }
    hide(empty);
    c.weeks.forEach((week, idx) => container.appendChild(renderDietWeekCard(week, idx)));
  }
  function renderDietWeekCard(week, wIdx) {
    const card = document.createElement("div");
    card.className = "week-card";
    if (wIdx === 0) card.classList.add("open");
    const totals = computeWeekTotals(week);
    const head = document.createElement("div");
    head.className = "week-head";
    head.innerHTML = `
      <div>
        <h4>${week.phaseLabel ? `<span class="phase-badge">${escapeHtml(week.phaseLabel)}</span>` : ""}${escapeHtml(week.label)} — nutrition</h4>
        <div class="week-info">Avg ${totals.avgCalories || "—"} kcal/day · ${totals.avgProtein || "—"}g protein/day</div>
      </div>
      <div class="week-head-right"><span class="week-toggle">▾</span></div>`;
    head.addEventListener("click", () => card.classList.toggle("open"));
    const body = document.createElement("div");
    body.className = "diet-week-body";
    body.innerHTML = `
      <div class="diet-days"></div>
      <div class="diet-notes">
        <label>Nutrition notes for this week
          <textarea placeholder="Meal timing, supplements, hydration…"></textarea>
        </label>
      </div>
      <div class="diet-week-totals">
        <div><span class="total-label">Weekly avg calories:</span><strong>${totals.avgCalories || "—"}</strong></div>
        <div><span class="total-label">Weekly avg protein:</span><strong>${totals.avgProtein ? totals.avgProtein + "g" : "—"}</strong></div>
      </div>`;
    const daysGrid = body.querySelector(".diet-days");
    week.diet.days.forEach((d, i) => {
      const dCard = document.createElement("div");
      dCard.className = "diet-day-card";
      dCard.innerHTML = `
        <h5>${DAY_LABELS[i] || "Day " + (i + 1)}</h5>
        <div class="diet-inputs">
          <label>Calories<input type="number" min="0" placeholder="kcal" data-field="calories" /></label>
          <label>Protein (g)<input type="number" min="0" placeholder="g" data-field="protein" /></label>
        </div>`;
      const calInp = dCard.querySelector('[data-field="calories"]');
      const protInp = dCard.querySelector('[data-field="protein"]');
      calInp.value = d.calories; protInp.value = d.protein;
      const updateTotals = () => {
        const t = computeWeekTotals(week);
        body.querySelector(".diet-week-totals").innerHTML = `
          <div><span class="total-label">Weekly avg calories:</span><strong>${t.avgCalories || "—"}</strong></div>
          <div><span class="total-label">Weekly avg protein:</span><strong>${t.avgProtein ? t.avgProtein + "g" : "—"}</strong></div>`;
        head.querySelector(".week-info").textContent =
          `Avg ${t.avgCalories || "—"} kcal/day · ${t.avgProtein || "—"}g protein/day`;
      };
      calInp.addEventListener("input", () => { d.calories = calInp.value; saveTrainer(); updateTotals(); });
      protInp.addEventListener("input", () => { d.protein = protInp.value; saveTrainer(); updateTotals(); });
      daysGrid.appendChild(dCard);
    });
    const notes = body.querySelector("textarea");
    notes.value = week.diet.notes;
    notes.addEventListener("input", () => { week.diet.notes = notes.value; saveTrainer(); });
    card.appendChild(head); card.appendChild(body);
    return card;
  }
  function computeWeekTotals(week) {
    const cv = week.diet.days.map((d) => Number(d.calories)).filter((n) => !isNaN(n) && n > 0);
    const pv = week.diet.days.map((d) => Number(d.protein)).filter((n) => !isNaN(n) && n > 0);
    const avg = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
    return { avgCalories: avg(cv), avgProtein: avg(pv) };
  }

  // -------- Calendar shared helpers --------
  function findWeekDay(c, weekId, dayId) {
    const w = c.weeks.find((x) => x.id === weekId);
    if (!w) return null;
    const d = w.days.find((x) => x.id === dayId);
    if (!d) return null;
    return { week: w, day: d };
  }

  // Status for an athlete (uses progress logs) - returns: 'done' | 'partial' | 'missed' | 'scheduled' | 'rest' | null
  function dayStatusForCoach(c, dateISOStr) {
    const sched = c.schedule?.[dateISOStr];
    if (!sched) return null;
    if (sched.rest) return "rest";
    const wd = findWeekDay(c, sched.weekId, sched.dayId);
    if (!wd) return "scheduled";

    const logs = c.importedProgress?.exerciseLogs || {};
    const totalEx = wd.day.exercises.length;
    let doneEx = 0;
    wd.day.exercises.forEach((ex) => {
      const exLogs = logs[ex.id] || [];
      if (exLogs.some((l) => l.date === dateISOStr)) doneEx++;
    });
    if (doneEx >= totalEx && totalEx > 0) return "done";
    if (doneEx > 0) return "partial";
    if (dateISOStr < todayISO()) return "missed";
    return "scheduled";
  }

  function dayStatusForAthlete(program, progress, dateISOStr) {
    const sched = program.client.schedule?.[dateISOStr];
    if (!sched) return null;
    if (sched.rest) return "rest";
    const wd = findWeekDay(program.client, sched.weekId, sched.dayId);
    if (!wd) return "scheduled";
    const logs = progress?.exerciseLogs || {};
    const totalEx = wd.day.exercises.length;
    let doneEx = 0;
    wd.day.exercises.forEach((ex) => {
      const exLogs = logs[ex.id] || [];
      if (exLogs.some((l) => l.date === dateISOStr)) doneEx++;
    });
    if (doneEx >= totalEx && totalEx > 0) return "done";
    if (doneEx > 0) return "partial";
    if (dateISOStr < todayISO()) return "missed";
    return "scheduled";
  }

  function dayLabel(c, sched) {
    if (!sched) return "";
    if (sched.rest) return "Rest";
    const wd = findWeekDay(c, sched.weekId, sched.dayId);
    if (!wd) return "—";
    return `${wd.week.label} · ${wd.day.name.split(" — ")[0] || wd.day.name}`;
  }

  function buildMonthGrid(year, month) {
    const first = new Date(year, month, 1);
    const startDow = first.getDay(); // 0=Sun
    const cells = [];
    // 6 weeks max, 42 cells
    const gridStart = new Date(year, month, 1 - startDow);
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      cells.push(d);
    }
    return cells;
  }

  const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const DOW_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

  // -------- Coach calendar --------
  function renderCoachCalendar() {
    const c = currentClient(); if (!c) return;
    const { year, month } = state.coachCal;
    $("#cal-title").textContent = `${MONTH_NAMES[month]} ${year}`;
    const grid = $("#cal-grid");
    grid.innerHTML = "";
    DOW_LABELS.forEach((d) => {
      const el = document.createElement("div");
      el.className = "cal-dow";
      el.textContent = d;
      grid.appendChild(el);
    });
    const cells = buildMonthGrid(year, month);
    const today = todayISO();
    cells.forEach((d) => {
      const iso = dateISO(d);
      const inMonth = d.getMonth() === month;
      const cell = document.createElement("div");
      cell.className = "cal-day";
      if (!inMonth) cell.classList.add("outside");
      if (iso === today) cell.classList.add("today");
      const status = dayStatusForCoach(c, iso);
      if (status) cell.classList.add(status);
      const sched = c.schedule[iso];
      cell.innerHTML = `
        <div class="cal-date-num">${d.getDate()}</div>
        ${sched ? `<div class="cal-day-label">${escapeHtml(dayLabel(c, sched))}</div>` : ""}
        ${status === "done" ? `<div class="cal-day-status">✓ Done</div>` : ""}
        ${status === "partial" ? `<div class="cal-day-status">◐ In progress</div>` : ""}
        ${status === "missed" ? `<div class="cal-day-status">✗ Missed</div>` : ""}
        ${status === "rest" ? `<div class="cal-day-status">Rest</div>` : ""}
      `;
      if (inMonth && sched && !sched.rest) {
        const videos = getDayVideos(c, sched);
        if (videos.length) attachDayVideoButton(cell, videos, dayLabel(c, sched));
      }
      if (inMonth) cell.addEventListener("click", () => openScheduleModal(iso));
      grid.appendChild(cell);
    });
  }

  function attachDayVideoButton(cell, videos, dayLabelStr) {
    const btn = document.createElement("button");
    btn.className = "cal-day-video";
    btn.type = "button";
    btn.innerHTML = `▶ ${videos.length}`;
    btn.title = `${videos.length} demo${videos.length === 1 ? "" : "s"} available`;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDayVideoPicker(videos, dayLabelStr);
    });
    cell.appendChild(btn);
  }

  function openScheduleModal(iso) {
    const c = currentClient(); if (!c) return;
    const existing = c.schedule[iso] || {};
    const weekOpts = c.weeks.map((w) =>
      `<option value="${w.id}" ${existing.weekId === w.id ? "selected" : ""}>${escapeHtml((w.phaseLabel ? "[" + w.phaseLabel + "] " : "") + w.label)}</option>`
    ).join("");
    openModal({
      title: `Schedule for ${iso}`,
      body: `
        <div class="sched-options">
          <label>Type
            <select id="sched-type">
              <option value="workout" ${existing.weekId ? "selected" : ""}>Workout day</option>
              <option value="rest" ${existing.rest ? "selected" : ""}>Rest day</option>
              <option value="clear" ${!existing.weekId && !existing.rest ? "selected" : ""}>(Unscheduled)</option>
            </select>
          </label>
          <div id="sched-workout-fields" ${existing.rest ? 'class="hidden"' : ""}>
            <label>Week
              <select id="sched-week">${weekOpts || '<option value="">(no weeks yet — add a week first)</option>'}</select>
            </label>
            <label>Day
              <select id="sched-day"></select>
            </label>
          </div>
        </div>`,
      actions: [
        { label: "Cancel", className: "btn btn-ghost", onClick: closeModal },
        ...(c.schedule[iso] ? [{
          label: "Clear", className: "btn btn-danger", onClick: () => {
            delete c.schedule[iso];
            saveTrainer(); renderCoachCalendar(); closeModal();
            toast("Cleared");
          },
        }] : []),
        { label: "Save", className: "btn btn-primary", onClick: () => {
            const type = $("#sched-type").value;
            if (type === "clear") {
              delete c.schedule[iso];
            } else if (type === "rest") {
              c.schedule[iso] = { rest: true };
            } else {
              const weekId = $("#sched-week").value;
              const dayId = $("#sched-day").value;
              if (!weekId || !dayId) { toast("Pick a week & day"); return; }
              c.schedule[iso] = { weekId, dayId };
            }
            saveTrainer(); renderCoachCalendar(); closeModal();
            toast("Schedule saved");
          },
        },
      ],
    });

    const typeSel = $("#sched-type");
    const wfields = $("#sched-workout-fields");
    const weekSel = $("#sched-week");
    const daySel = $("#sched-day");
    function rebuildDays() {
      const w = c.weeks.find((x) => x.id === weekSel.value);
      daySel.innerHTML = w ? w.days.map((d) =>
        `<option value="${d.id}" ${existing.dayId === d.id ? "selected" : ""}>${escapeHtml(d.name)}</option>`
      ).join("") : "";
    }
    rebuildDays();
    typeSel.addEventListener("change", () => {
      if (typeSel.value === "workout") wfields.classList.remove("hidden");
      else wfields.classList.add("hidden");
    });
    weekSel?.addEventListener("change", rebuildDays);
  }

  // -------- Client logs view --------
  function renderClientLogs() {
    const c = currentClient(); if (!c) return;
    const container = $("#logs-container");
    const empty = $("#logs-empty");
    container.innerHTML = "";
    const p = c.importedProgress;
    if (!p || (!p.bodyweightLog?.length && !Object.keys(p.exerciseLogs || {}).length && !p.feedback && !Object.keys(p.dayCompletions || {}).length)) {
      show(empty); return;
    }
    hide(empty);

    // Day completion summary per week
    if (p.dayCompletions && Object.keys(p.dayCompletions).length) {
      const summary = document.createElement("div");
      summary.className = "log-week-card";
      summary.innerHTML = `<h4>Day completions</h4>`;
      let anyRendered = false;
      c.weeks.forEach((w) => {
        const totalDays = w.days.length;
        const completedDays = w.days.filter((d) => (p.dayCompletions[d.id] || []).length > 0).length;
        if (completedDays === 0) return;
        anyRendered = true;
        const pct = totalDays ? Math.round((completedDays * 100) / totalDays) : 0;
        const row = document.createElement("div");
        row.className = "log-week-row";
        row.innerHTML = `
          <div class="log-week-row-label">
            ${w.phaseLabel ? `<span class="phase-badge">${escapeHtml(w.phaseLabel)}</span>` : ""}
            <strong>${escapeHtml(w.label)}</strong>
            <span class="muted">— ${completedDays}/${totalDays} days</span>
          </div>
          <div class="week-progress-track" style="flex:1; max-width: 240px"><div class="week-progress-fill" style="width:${pct}%"></div></div>
          <div class="week-progress-pct">${pct}%</div>`;
        summary.appendChild(row);
      });
      if (anyRendered) container.appendChild(summary);
    }
    if (p.feedback) {
      const fb = document.createElement("div");
      fb.className = "client-feedback-block";
      fb.innerHTML = `
        <div class="feedback-label">Note from ${escapeHtml(c.name)}${p.syncedAt ? " · synced " + new Date(p.syncedAt).toLocaleString() : ""}</div>
        ${escapeHtml(p.feedback)}`;
      container.appendChild(fb);
    }
    if (p.bodyweightLog?.length) {
      const bwCard = document.createElement("div");
      bwCard.className = "log-week-card";
      bwCard.innerHTML = `<h4>Body weight</h4>`;
      const sorted = [...p.bodyweightLog].sort((a, b) => b.date.localeCompare(a.date));
      const list = document.createElement("div");
      list.className = "log-table";
      list.innerHTML = `<div class="lh">Date</div><div class="lh">Weight</div><div></div><div></div>`;
      sorted.forEach((b) => {
        list.insertAdjacentHTML("beforeend",
          `<div class="date">${escapeHtml(b.date)}</div><div>${escapeHtml(b.weightLb)} lb</div><div></div><div></div>`);
      });
      bwCard.appendChild(list);
      container.appendChild(bwCard);
    }
    if (p.exerciseLogs && Object.keys(p.exerciseLogs).length) {
      c.weeks.forEach((w) => {
        const exsWithLogs = [];
        w.days.forEach((d) => {
          d.exercises.forEach((ex) => {
            const logs = p.exerciseLogs[ex.id];
            if (logs?.length) exsWithLogs.push({ day: d, ex, logs });
          });
        });
        if (!exsWithLogs.length) return;
        const wCard = document.createElement("div");
        wCard.className = "log-week-card";
        wCard.innerHTML = `<h4>${w.phaseLabel ? `<span class="phase-badge">${escapeHtml(w.phaseLabel)}</span>` : ""}${escapeHtml(w.label)}${w.focus ? " — " + escapeHtml(w.focus) : ""}</h4>`;
        exsWithLogs.forEach(({ day, ex, logs }) => {
          const sec = document.createElement("div");
          sec.className = "log-exercise";
          const rows = [...logs].sort((a, b) => b.date.localeCompare(a.date)).map((l) => `
            <div class="date">${escapeHtml(l.date)}</div>
            <div>${escapeHtml(l.weight || "—")}</div>
            <div>${escapeHtml(l.reps || "—")}</div>
            <div>${escapeHtml(l.sets || "—")}</div>
            ${l.notes ? `<div style="grid-column: 1 / -1; color: var(--text-soft); font-size: 0.85rem; padding-bottom: 0.3em;">${escapeHtml(l.notes)}</div>` : ""}
          `).join("");
          sec.innerHTML = `
            <h5>${escapeHtml(ex.name || "(unnamed)")} <span class="muted">— ${escapeHtml(day.name)}</span></h5>
            <div class="log-table">
              <div class="lh">Date</div><div class="lh">Weight</div><div class="lh">Reps</div><div class="lh">Sets</div>
              ${rows}
            </div>`;
          wCard.appendChild(sec);
        });
        container.appendChild(wCard);
      });
    }
  }

  // -------- Personal Records --------
  function groupPRs(prs) {
    // Group by lowercase name, retain original-case display name from first entry
    const groups = new Map();
    prs.forEach((p) => {
      if (!p.name) return;
      const k = p.name.trim().toLowerCase();
      if (!groups.has(k)) groups.set(k, { displayName: p.name.trim(), entries: [] });
      groups.get(k).entries.push(p);
    });
    return Array.from(groups.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  function prSortKey(p) {
    const w = Number(p.weight);
    return isNaN(w) ? -1 : w;
  }
  function renderPRGroup(group) {
    const sorted = [...group.entries].sort((a, b) => prSortKey(b) - prSortKey(a));
    const best = sorted[0];
    const card = document.createElement("div");
    card.className = "pr-exercise-group";
    const head = document.createElement("div");
    head.className = "pr-exercise-header";
    head.innerHTML = `
      <h4 class="pr-exercise-name">${escapeHtml(group.displayName)}</h4>
      ${best && best.weight ? `<span class="pr-best"><span class="pr-best-label">PR</span>${escapeHtml(best.weight)} lb × ${escapeHtml(best.reps || "?")}</span>` : ""}
    `;
    card.appendChild(head);
    sorted.forEach((p, idx) => {
      const row = document.createElement("div");
      row.className = "pr-row" + (idx === 0 && best.weight ? " is-best" : "");
      row.innerHTML = `
        <div><span class="pr-weight">${escapeHtml(p.weight || "—")} lb</span> <span class="pr-reps">× ${escapeHtml(p.reps || "—")} reps</span></div>
        <div class="pr-date">${escapeHtml(p.date || "")}</div>
        <span class="pr-author ${p._author || "coach"}">${(p._author || "coach")}</span>
        <button class="pr-delete" data-id="${p.id}" data-author="${p._author || ""}" title="Delete">×</button>
        ${p.notes ? `<div class="pr-notes">${escapeHtml(p.notes)}</div>` : ""}
      `;
      card.appendChild(row);
    });
    return card;
  }

  function renderCoachPRs() {
    const c = currentClient(); if (!c) return;
    const container = $("#coach-pr-container");
    const empty = $("#coach-pr-empty");
    container.innerHTML = "";
    if (!c.coachPRs) c.coachPRs = [];
    const coachOwn = c.coachPRs.map((p) => ({ ...p, _author: "coach" }));
    const athleteImported = (c.importedProgress?.personalRecords || []).map((p) => ({ ...p, _author: "athlete" }));
    const all = coachOwn.concat(athleteImported);
    if (!all.length) { show(empty); return; }
    hide(empty);
    groupPRs(all).forEach((group) => container.appendChild(renderPRGroup(group)));
    container.querySelectorAll(".pr-delete").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const author = btn.dataset.author;
        if (author === "athlete") {
          toast("Athlete-logged PRs can't be deleted by coach");
          return;
        }
        if (!window.confirm("Delete this PR entry?")) return;
        c.coachPRs = c.coachPRs.filter((p) => p.id !== id);
        saveTrainer();
        renderCoachPRs();
      });
    });
  }

  function renderAthletePRs() {
    const container = $("#athlete-pr-container");
    const empty = $("#athlete-pr-empty");
    container.innerHTML = "";
    const prog = state.clientData.program; if (!prog) return;
    const athleteOwn = (state.clientData.progress.personalRecords || []).map((p) => ({ ...p, _author: "athlete" }));
    const coachShared = (prog.client.coachPRs || []).map((p) => ({ ...p, _author: "coach" }));
    const all = athleteOwn.concat(coachShared);
    if (!all.length) { show(empty); return; }
    hide(empty);
    groupPRs(all).forEach((group) => container.appendChild(renderPRGroup(group)));
    container.querySelectorAll(".pr-delete").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const author = btn.dataset.author;
        if (author === "coach") {
          toast("Coach-shared PRs can't be deleted here");
          return;
        }
        if (!window.confirm("Delete this PR entry?")) return;
        state.clientData.progress.personalRecords =
          state.clientData.progress.personalRecords.filter((p) => p.id !== id);
        saveClient();
        renderAthletePRs();
      });
    });
  }

  function suggestExerciseNames(side) {
    // Return alphabetical, deduplicated names from the program's exercises
    let weeks = [];
    if (side === "coach") {
      const c = currentClient();
      weeks = c?.weeks || [];
    } else {
      weeks = state.clientData?.program?.client?.weeks || [];
    }
    const names = new Set();
    weeks.forEach((w) => w.days.forEach((d) => d.exercises.forEach((e) => {
      if (e.name) names.add(e.name.trim());
    })));
    return Array.from(names).sort();
  }

  function openAddPRModal(side) {
    const suggestions = suggestExerciseNames(side);
    const datalistOpts = suggestions.map((n) => `<option value="${escapeHtml(n)}">`).join("");
    openModal({
      title: "Add a PR",
      body: `
        <label>Exercise
          <input type="text" id="pr-name" list="pr-name-list" placeholder="e.g. Back Squat" autofocus />
          <datalist id="pr-name-list">${datalistOpts}</datalist>
        </label>
        <div class="grid-2">
          <label>Weight (lb)
            <input type="number" id="pr-weight" min="0" step="0.5" placeholder="lb" />
          </label>
          <label>Reps
            <input type="number" id="pr-reps" min="0" placeholder="reps" />
          </label>
        </div>
        <label>Date
          <input type="date" id="pr-date" />
        </label>
        <label>Notes (optional)
          <input type="text" id="pr-notes" placeholder="e.g. clean reps, no spotter" />
        </label>
        <p id="pr-error" class="error hidden"></p>`,
      actions: [
        { label: "Cancel", className: "btn btn-ghost", onClick: closeModal },
        { label: "Save PR", className: "btn btn-primary", onClick: () => {
            const err = $("#pr-error");
            const name = $("#pr-name").value.trim();
            const weight = $("#pr-weight").value.trim();
            const reps = $("#pr-reps").value.trim();
            const date = $("#pr-date").value || todayISO();
            const notes = $("#pr-notes").value.trim();
            if (!name) { showErr(err, "Exercise name is required."); return; }
            if (!weight && !reps) { showErr(err, "Enter at least a weight or reps."); return; }
            const pr = makePR({ name, weight, reps, date, notes });
            if (side === "coach") {
              const c = currentClient();
              if (!c.coachPRs) c.coachPRs = [];
              c.coachPRs.push(pr);
              saveTrainer();
              closeModal();
              renderCoachPRs();
              const grp = $("#coach-pr-container .pr-exercise-group");
              if (grp) celebrateElement(grp);
            } else {
              if (!state.clientData.progress.personalRecords) state.clientData.progress.personalRecords = [];
              state.clientData.progress.personalRecords.push(pr);
              saveClient();
              closeModal();
              renderAthletePRs();
              const grp = $("#athlete-pr-container .pr-exercise-group");
              if (grp) celebrateElement(grp);
            }
            toast("PR saved 🏆");
          },
        },
      ],
    });
    setTimeout(() => {
      $("#pr-date").value = todayISO();
      $("#pr-name")?.focus();
    }, 50);
  }

  // -------- Share / import --------
  function shareClient() {
    const c = currentClient(); if (!c) return;
    const payload = {
      kind: "tp-program", v: 2,
      clientId: c.id,
      trainerName: state.trainerData.trainer?.name || "",
      sharedAt: Date.now(),
      client: {
        id: c.id, name: c.name, age: c.age, heightIn: c.heightIn, weightLb: c.weightLb,
        goals: c.goals, weeks: c.weeks, schedule: c.schedule || {},
        coachPRs: c.coachPRs || [],
        inviteCode: c.inviteCode || "",
      },
    };
    const code = encodeData(payload);
    openModal({
      title: "Access code for " + c.name,
      body: `
        <p>Send this code to <strong>${escapeHtml(c.name)}</strong>. They paste it into the Athlete Portal on their own device.</p>
        <textarea class="code-textarea" id="share-code-output" readonly>${escapeHtml(code)}</textarea>
        <div class="code-actions">
          <button class="btn btn-primary" id="btn-copy-share">Copy code</button>
        </div>
        <p class="muted" style="margin-top:0.8em">Re-share any time you update the program or schedule. The athlete's logs are preserved on re-import.</p>`,
      actions: [{ label: "Close", className: "btn btn-ghost", onClick: closeModal }],
    });
    $("#btn-copy-share").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(code); toast("Code copied"); }
      catch { $("#share-code-output").select(); document.execCommand("copy"); toast("Code copied"); }
    });
  }

  function importProgressPrompt() {
    openModal({
      title: "Import athlete progress",
      body: `
        <p>Paste the progress code your athlete sent you.</p>
        <textarea class="code-textarea" id="import-code-input" placeholder="Paste long string here..."></textarea>
        <p id="import-progress-error" class="error hidden"></p>`,
      actions: [
        { label: "Cancel", className: "btn btn-ghost", onClick: closeModal },
        { label: "Import", className: "btn btn-primary", onClick: () => {
            const err = $("#import-progress-error");
            try {
              const obj = decodeData($("#import-code-input").value);
              if (obj.kind !== "tp-progress") throw new Error("Wrong code type — this looks like a program code, not a progress code.");
              const c = state.trainerData.clients.find((x) => x.id === obj.clientId);
              if (!c) throw new Error("This code belongs to a different athlete (id not found here).");
              c.importedProgress = { ...obj.progress, syncedAt: Date.now() };
              saveTrainer();
              closeModal();
              setTab("logs");
              renderClientLogs();
              renderCoachCalendar();
              renderCoachPRs();
              toast("Progress imported");
            } catch (e) {
              err.textContent = "Couldn't import: " + (e.message || "invalid code");
              err.classList.remove("hidden");
            }
          },
        },
      ],
    });
    setTimeout(() => $("#import-code-input")?.focus(), 50);
  }

  // -------- Athlete mode: invite-code login --------
  function loginWithInviteCode() {
    const raw = $("#invite-code-input").value;
    const code = normalizeInviteCode(raw);
    const err = $("#client-import-error");
    err.classList.add("hidden");
    if (code.length !== 8) {
      err.textContent = "Invite codes are 8 characters (like XXXX-XXXX).";
      err.classList.remove("hidden");
      return;
    }
    const formatted = code.slice(0, 4) + "-" + code.slice(4);

    // 1. Look for a matching client in trainer data on THIS browser
    const trainerData = loadJSON(KEY_TRAINER, DEFAULT_TRAINER);
    let match = trainerData.clients.find((c) => c.inviteCode === formatted);
    let trainerName = trainerData.trainer?.name || "";

    // 2. Look for a previously imported program with this invite code
    if (!match) {
      const cd = loadJSON(KEY_CLIENT, DEFAULT_CLIENT);
      if (cd.program?.client?.inviteCode === formatted) {
        // Resume existing imported program
        state.clientData = cd;
        ensureProgressShape(state.clientData.progress || (state.clientData.progress = emptyProgress()));
        if (state.clientData.profile) {
          playLoginFlash();
          enterClientPortal();
          toast("Welcome back");
        } else {
          showAthleteSetup();
        }
        return;
      }
    }

    if (!match) {
      // 3. Cloud lookup — works cross-device.
      if (window.Cloud?.enabled) {
        loginViaCloud(formatted, err);
        return;
      }
      err.textContent = "Code not recognized on this device. If you're on a new device, paste the long access code below.";
      err.classList.remove("hidden");
      return;
    }

    // Build a program payload from the matched client (live, no base64 needed for same-device)
    const program = {
      kind: "tp-program", v: 2,
      clientId: match.id,
      trainerName,
      sharedAt: Date.now(),
      client: {
        id: match.id, name: match.name, age: match.age, heightIn: match.heightIn, weightLb: match.weightLb,
        goals: match.goals, weeks: match.weeks, schedule: match.schedule || {},
        coachPRs: match.coachPRs || [], inviteCode: match.inviteCode,
      },
    };
    // Preserve progress if same client id has been loaded before
    const prev = state.clientData.program?.clientId === program.clientId ? state.clientData.progress : null;
    state.clientData.program = program;
    state.clientData.progress = prev || emptyProgress();
    ensureProgressShape(state.clientData.progress);
    saveClient();
    if (state.clientData.profile) {
      playLoginFlash();
      enterClientPortal();
      toast(`Loaded ${match.name}'s program`);
    } else {
      showAthleteSetup();
    }
  }

  // -------- Athlete mode: invite-code login via cloud --------
  async function loginViaCloud(formatted, err) {
    err.textContent = "Looking up code…";
    err.classList.remove("hidden");
    const athlete = await window.Cloud.getAthleteByInviteCode(formatted);
    if (!athlete) {
      err.textContent = "Code not recognized. Double-check with your coach, or paste a long access code below.";
      return;
    }
    const program = {
      kind: "tp-program", v: 2,
      clientId: athlete.id,
      trainerName: "",
      sharedAt: Date.now(),
      client: {
        id: athlete.id, name: athlete.name, age: athlete.age, heightIn: athlete.heightIn, weightLb: athlete.weightLb,
        goals: athlete.goals, weeks: athlete.weeks, schedule: athlete.schedule || {},
        coachPRs: athlete.coachPRs || [], inviteCode: athlete.inviteCode,
      },
    };
    const prev = state.clientData.program?.clientId === program.clientId ? state.clientData.progress : null;
    state.clientData.program = program;
    state.clientData.progress = prev || emptyProgress();
    ensureProgressShape(state.clientData.progress);
    // Only pull from cloud if this is a fresh device for this athlete.
    // Same-device returns: trust the local progress (avoid clobbering newer local writes).
    if (!prev) {
      const cloudProgress = await window.Cloud.getProgress(athlete.id);
      if (cloudProgress) {
        state.clientData.progress = cloudProgress;
        ensureProgressShape(state.clientData.progress);
      }
    }
    saveClient();
    err.classList.add("hidden");
    if (state.clientData.profile) {
      playLoginFlash();
      enterClientPortal();
      toast(`Loaded ${athlete.name}'s program from cloud`);
    } else {
      showAthleteSetup();
    }
  }

  // -------- Athlete mode: import program (long code) --------
  function importClientCode() {
    const err = $("#client-import-error");
    err.classList.add("hidden");
    try {
      const obj = decodeData($("#client-code").value);
      if (obj.kind !== "tp-program") throw new Error("This doesn't look like a Stone Dragon program code.");
      if (!obj.client || !obj.clientId) throw new Error("Code is missing client data.");
      const prev = state.clientData.program?.clientId === obj.clientId ? state.clientData.progress : null;
      // Ensure schedule field exists for v1 codes
      if (!obj.client.schedule) obj.client.schedule = {};
      state.clientData.program = obj;
      state.clientData.progress = prev || emptyProgress();
      saveClient();
      if (state.clientData.profile) {
        playLoginFlash();
        enterClientPortal();
        toast("Program loaded");
      } else {
        showAthleteSetup();
      }
    } catch (e) {
      err.textContent = "Couldn't load: " + (e.message || "invalid code");
      err.classList.remove("hidden");
    }
  }
  function emptyProgress() { return { exerciseLogs: {}, bodyweightLog: [], feedback: "", dayCompletions: {}, personalRecords: [] }; }
  function ensureProgressShape(p) {
    if (!p.exerciseLogs) p.exerciseLogs = {};
    if (!p.bodyweightLog) p.bodyweightLog = [];
    if (p.feedback == null) p.feedback = "";
    if (!p.dayCompletions) p.dayCompletions = {};
    if (!p.personalRecords) p.personalRecords = [];
    return p;
  }
  function isDayChecked(dayId) {
    const dc = state.clientData?.progress?.dayCompletions;
    return !!(dc && dc[dayId] && dc[dayId].length > 0);
  }
  function toggleDayComplete(dayId) {
    ensureProgressShape(state.clientData.progress);
    const dc = state.clientData.progress.dayCompletions;
    if (isDayChecked(dayId)) dc[dayId] = [];
    else dc[dayId] = [todayISO()];
    saveClient();
    renderClientWorkouts();
  }
  function resumeClient() {
    if (!state.clientData.program) return;
    if (!state.clientData.progress) state.clientData.progress = emptyProgress();
    if (!state.clientData.program.client.schedule) state.clientData.program.client.schedule = {};
    enterClientPortal();
  }
  function enterClientPortal() {
    state.mode = "client";
    sessionStorage.setItem(KEY_SESSION, "client");
    hide($("#screen-login"));
    hide($("#screen-app"));
    show($("#screen-client"));
    if (!state.clientData.progress) state.clientData.progress = emptyProgress();
    ensureProgressShape(state.clientData.progress);
    const prog = state.clientData.program;
    const code = prog.client.inviteCode;
    $("#client-portal-name").innerHTML = `${escapeHtml(prog.client.name)}${code ? ` <span class="athlete-invite-chip"><span class="label">Code</span>${escapeHtml(code)}</span>` : ""}`;
    $("#client-trainer-credit").textContent = prog.trainerName ? `Programmed by ${prog.trainerName}` : "";
    setClientTab("calendar");
    const now = new Date();
    state.athleteCal = { year: now.getFullYear(), month: now.getMonth() };
    renderAthleteCalendar();
    renderClientWorkouts();
    renderClientDiet();
    renderClientProgress();
    renderAthletePRs();
  }
  function exitClient() {
    state.mode = null;
    sessionStorage.removeItem(KEY_SESSION);
    pickRole("client");
  }
  function setClientTab(name) {
    $$(".tab[data-ctab]").forEach((t) => t.classList.toggle("active", t.dataset.ctab === name));
    $$(".tab-panel[data-ctab-panel]").forEach((p) => p.classList.toggle("active", p.dataset.ctabPanel === name));
  }

  // -------- Athlete calendar --------
  function renderAthleteCalendar() {
    const prog = state.clientData.program; if (!prog) return;
    const { year, month } = state.athleteCal;
    $("#ccal-title").textContent = `${MONTH_NAMES[month]} ${year}`;
    const grid = $("#ccal-grid");
    grid.innerHTML = "";
    DOW_LABELS.forEach((d) => {
      const el = document.createElement("div");
      el.className = "cal-dow";
      el.textContent = d;
      grid.appendChild(el);
    });
    const cells = buildMonthGrid(year, month);
    const today = todayISO();
    cells.forEach((d) => {
      const iso = dateISO(d);
      const inMonth = d.getMonth() === month;
      const cell = document.createElement("div");
      cell.className = "cal-day";
      if (!inMonth) cell.classList.add("outside");
      if (iso === today) cell.classList.add("today");
      const status = dayStatusForAthlete(prog, state.clientData.progress, iso);
      if (status) cell.classList.add(status);
      const sched = prog.client.schedule?.[iso];
      cell.innerHTML = `
        <div class="cal-date-num">${d.getDate()}</div>
        ${sched ? `<div class="cal-day-label">${escapeHtml(dayLabel(prog.client, sched))}</div>` : ""}
        ${status === "done" ? `<div class="cal-day-status">✓ Done</div>` : ""}
        ${status === "partial" ? `<div class="cal-day-status">◐ In progress</div>` : ""}
        ${status === "missed" ? `<div class="cal-day-status">✗ Missed</div>` : ""}
        ${status === "rest" ? `<div class="cal-day-status">Rest</div>` : ""}
        ${status === "scheduled" ? `<div class="cal-day-status">Up next</div>` : ""}
      `;
      if (inMonth && sched && !sched.rest) {
        const videos = getDayVideos(prog.client, sched);
        if (videos.length) attachDayVideoButton(cell, videos, dayLabel(prog.client, sched));
        cell.addEventListener("click", () => jumpToWorkout(sched, iso));
      }
      grid.appendChild(cell);
    });
  }
  function jumpToWorkout(sched, iso) {
    state.__jumpTo = { weekId: sched.weekId, dayId: sched.dayId, date: iso };
    setClientTab("workouts");
    renderClientWorkouts();
    setTimeout(() => {
      const target = document.querySelector(`.client-exercise-card[data-week="${sched.weekId}"]`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  // -------- Athlete workouts --------
  function renderClientWorkouts() {
    const container = $("#client-weeks-container");
    container.innerHTML = "";
    const prog = state.clientData.program;
    if (!prog?.client?.weeks?.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-emoji">📋</div><h3>No weeks yet</h3><p>Your coach hasn't added any weeks to your program yet.</p></div>`;
      return;
    }
    const jumpTo = state.__jumpTo;
    state.__jumpTo = null;
    prog.client.weeks.forEach((week, wIdx) => {
      const expand = jumpTo ? jumpTo.weekId === week.id : wIdx === 0;
      container.appendChild(renderClientWeek(week, wIdx, expand, jumpTo));
    });
  }
  function renderClientWeek(week, wIdx, expand, jumpTo) {
    const card = document.createElement("div");
    card.className = "week-card";
    if (week.phaseLabel) card.classList.add("phase-card");
    if (expand) card.classList.add("open");
    const totalDays = week.days.length;
    const completedDays = week.days.filter((d) => isDayChecked(d.id)).length;
    const pct = totalDays ? Math.round((completedDays * 100) / totalDays) : 0;
    const weekComplete = completedDays === totalDays && totalDays > 0;
    const head = document.createElement("div");
    head.className = "week-head";
    head.innerHTML = `
      <div>
        <h4>${week.phaseLabel ? `<span class="phase-badge">${escapeHtml(week.phaseLabel)}</span>` : ""}${escapeHtml(week.label)}${week.focus ? " — " + escapeHtml(week.focus) : ""}</h4>
        <div class="week-info">${completedDays} / ${totalDays} day${totalDays === 1 ? "" : "s"} complete${weekComplete ? " · ✓ Week done" : ""}</div>
      </div>
      <div class="week-head-right"><span class="week-toggle">▾</span></div>`;
    head.addEventListener("click", () => card.classList.toggle("open"));
    const body = document.createElement("div");
    body.className = "week-body";
    const progress = document.createElement("div");
    progress.className = "week-progress" + (weekComplete ? " complete" : "");
    progress.innerHTML = `
      <div class="week-progress-label">${weekComplete ? "Week complete ✓" : `${completedDays} / ${totalDays} days`}</div>
      <div class="week-progress-track"><div class="week-progress-fill" style="width:${pct}%"></div></div>
      <div class="week-progress-pct">${pct}%</div>`;
    body.appendChild(progress);
    week.days.forEach((day) => body.appendChild(renderClientDay(week, day, jumpTo)));
    card.appendChild(head); card.appendChild(body);
    return card;
  }
  function hasAnyLog(ex) {
    const logs = state.clientData.progress?.exerciseLogs?.[ex.id];
    return logs && logs.length > 0;
  }
  function renderClientDay(week, day, jumpTo) {
    const card = document.createElement("div");
    card.className = "client-day-card";
    const totalEx = day.exercises.length;
    const doneEx = day.exercises.filter((ex) => hasAnyLog(ex)).length;
    const checked = isDayChecked(day.id);
    if (checked) card.classList.add("day-checked");
    card.innerHTML = `
      <div class="client-day-head">
        <div class="day-head-left-flex">
          <button class="day-check-toggle ${checked ? "checked" : ""}" data-action="toggle-day" type="button" aria-label="Mark day complete">${checked ? "✓" : ""}</button>
          <h4>${escapeHtml(day.name)}</h4>
        </div>
        <div class="day-head-stats">
          ${checked ? `<span class="day-complete-badge">Done ✓</span>` : ""}
          ${doneEx > 0
            ? `<span class="muted">${doneEx} / ${totalEx} logged</span>`
            : ""}
        </div>
      </div>`;
    card.querySelector('[data-action="toggle-day"]').addEventListener("click", () => {
      toggleDayComplete(day.id);
      toast(checked ? "Unchecked" : "Day complete ✓");
    });
    day.exercises.forEach((ex) => card.appendChild(renderClientExercise(week, day, ex, jumpTo)));
    return card;
  }
  function renderClientExercise(week, day, ex, jumpTo) {
    const card = document.createElement("div");
    card.className = "client-exercise-card";
    card.dataset.week = week.id;
    card.dataset.day = day.id;
    const logs = state.clientData.progress?.exerciseLogs?.[ex.id] || [];
    const isDone = logs.length > 0;
    if (isDone) card.classList.add("done");
    const prescription = [];
    if (ex.sets) prescription.push(`<span class="px">Sets <strong>${escapeHtml(ex.sets)}</strong></span>`);
    if (ex.currentReps && !ex.currentWeight) {
      prescription.push(`<span class="px">Target reps: <strong>${escapeHtml(ex.currentReps)}</strong></span>`);
    } else if (ex.currentWeight || ex.currentReps) {
      prescription.push(`<span class="px">Current top: <strong>${escapeHtml(ex.currentWeight || "?")}×${escapeHtml(ex.currentReps || "?")}</strong></span>`);
    }
    if (ex.goalWeight || ex.goalReps) {
      prescription.push(`<span class="px">Goal: <strong>${escapeHtml(ex.goalWeight || "?")}×${escapeHtml(ex.goalReps || "?")}</strong></span>`);
    }
    const presetDate = jumpTo?.dayId === day.id ? jumpTo.date : todayISO();
    const ytId = getYouTubeId(ex.videoUrl);
    const videoBtn = ytId
      ? `<button class="btn btn-sm video-btn" data-action="watch-demo" data-yt="${escapeHtml(ytId)}" data-name="${escapeHtml(ex.name || "Exercise")}">▶ Watch demo</button>`
      : (ex.videoUrl ? `<a href="${escapeHtml(ex.videoUrl)}" target="_blank" rel="noopener" class="btn btn-sm video-btn">▶ Open demo link</a>` : "");
    card.innerHTML = `
      <h5>${escapeHtml(ex.name || "(unnamed exercise)")}${isDone ? ' <span class="done-check">✓</span>' : ""}</h5>
      <div class="prescription">${prescription.join("") || '<span class="muted">No prescription yet.</span>'}</div>
      ${videoBtn ? `<div class="client-video-row">${videoBtn}</div>` : ""}
      ${ex.notes ? `<div class="client-instructions">${escapeHtml(ex.notes)}</div>` : ""}
      <div class="client-log-form">
        <div class="client-log-form-title">Log this session</div>
        <div class="client-log-row">
          <label>Date<input type="date" data-field="date" /></label>
          <label>Weight (lb)<input type="number" step="0.5" min="0" placeholder="lb" data-field="weight" /></label>
          <label>Reps<input type="number" min="0" placeholder="reps" data-field="reps" /></label>
        </div>
        <div class="client-log-row">
          <label>Sets done<input type="number" min="0" placeholder="sets" data-field="sets" /></label>
          <label style="grid-column: 2 / span 2;">Notes
            <input type="text" placeholder="How it felt, anything to note…" data-field="notes" />
          </label>
        </div>
        <div class="client-log-actions">
          <button class="btn btn-sm btn-primary" data-action="log">Save log</button>
        </div>
      </div>
      ${logs.length ? `<details class="client-log-history">
        <summary>Previous logs (${logs.length})</summary>
        <div class="client-log-history-list"></div>
      </details>` : ""}`;
    card.querySelector('[data-field="date"]').value = presetDate;
    if (logs.length) {
      const histList = card.querySelector(".client-log-history-list");
      [...logs].sort((a, b) => b.date.localeCompare(a.date)).forEach((l) => {
        const row = document.createElement("div");
        row.className = "client-log-history-item";
        row.innerHTML = `
          <span class="date">${escapeHtml(l.date)}</span>
          <span>${escapeHtml(l.weight || "—")} lb × ${escapeHtml(l.reps || "—")} × ${escapeHtml(l.sets || "—")} sets${l.notes ? " · " + escapeHtml(l.notes) : ""}</span>
          <button class="delete-bw" data-log-id="${l.id}" title="Delete">×</button>`;
        row.querySelector(".delete-bw").addEventListener("click", () => {
          if (!window.confirm("Delete this log entry?")) return;
          state.clientData.progress.exerciseLogs[ex.id] =
            state.clientData.progress.exerciseLogs[ex.id].filter((x) => x.id !== l.id);
          saveClient();
          renderClientWorkouts();
          renderAthleteCalendar();
        });
        histList.appendChild(row);
      });
    }
    card.querySelector('[data-action="log"]').addEventListener("click", () => {
      const date = card.querySelector('[data-field="date"]').value || todayISO();
      const entry = {
        id: uid(), date,
        weight: card.querySelector('[data-field="weight"]').value,
        reps: card.querySelector('[data-field="reps"]').value,
        sets: card.querySelector('[data-field="sets"]').value,
        notes: card.querySelector('[data-field="notes"]').value,
      };
      if (!entry.weight && !entry.reps && !entry.sets && !entry.notes) {
        toast("Enter at least one value"); return;
      }
      if (!state.clientData.progress.exerciseLogs[ex.id]) state.clientData.progress.exerciseLogs[ex.id] = [];
      state.clientData.progress.exerciseLogs[ex.id].push(entry);
      saveClient();
      toast("Logged ✓");
      renderClientWorkouts();
      renderAthleteCalendar();
    });
    const watchBtn = card.querySelector('[data-action="watch-demo"]');
    if (watchBtn) {
      watchBtn.addEventListener("click", () => {
        openVideoModal(watchBtn.dataset.yt, watchBtn.dataset.name);
      });
    }
    return card;
  }

  function getDayVideos(client, sched) {
    if (!sched || sched.rest) return [];
    const wd = findWeekDay(client, sched.weekId, sched.dayId);
    if (!wd) return [];
    return wd.day.exercises
      .map((ex) => ({ id: ex.id, name: ex.name || "(unnamed)", ytId: getYouTubeId(ex.videoUrl) }))
      .filter((x) => x.ytId);
  }

  function openDayVideoPicker(videos, dayLabelStr) {
    if (videos.length === 1) {
      openVideoModal(videos[0].ytId, videos[0].name);
      return;
    }
    const list = videos.map((v) =>
      `<button class="video-pick-btn" data-yt="${escapeHtml(v.ytId)}" data-name="${escapeHtml(v.name)}"><span class="video-pick-icon">▶</span>${escapeHtml(v.name)}</button>`
    ).join("");
    openModal({
      title: `Demos — ${dayLabelStr}`,
      body: `<p class="muted" style="margin-top:-0.4em">Pick an exercise to watch.</p><div class="video-pick-list">${list}</div>`,
      actions: [{ label: "Close", className: "btn btn-ghost", onClick: closeModal }],
    });
    document.querySelectorAll(".video-pick-btn").forEach((b) => {
      b.addEventListener("click", () => {
        openVideoModal(b.dataset.yt, b.dataset.name);
      });
    });
  }

  function openVideoModal(ytId, name) {
    openModal({
      title: name ? `Demo — ${name}` : "Exercise demo",
      body: `
        <div class="video-frame-wrap">
          <iframe class="video-frame"
            src="https://www.youtube.com/embed/${encodeURIComponent(ytId)}?rel=0&autoplay=1"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen
            referrerpolicy="strict-origin-when-cross-origin"></iframe>
        </div>
        <p class="muted" style="margin-top:0.7em">
          <a href="https://youtu.be/${encodeURIComponent(ytId)}" target="_blank" rel="noopener">Open on YouTube ↗</a>
        </p>`,
      actions: [{ label: "Close", className: "btn btn-ghost", onClick: () => {
        // Stop the video by clearing iframe before closing
        const f = document.querySelector(".video-frame");
        if (f) f.src = "about:blank";
        closeModal();
      }}],
    });
  }

  // -------- Athlete diet --------
  function renderClientDiet() {
    const container = $("#client-diet-container");
    container.innerHTML = "";
    const prog = state.clientData.program;
    if (!prog?.client?.weeks?.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-emoji">🥩</div><h3>No nutrition plan yet</h3><p>Your coach hasn't set nutrition targets yet.</p></div>`;
      return;
    }
    prog.client.weeks.forEach((week, idx) => {
      const card = document.createElement("div");
      card.className = "week-card";
      if (week.phaseLabel) card.classList.add("phase-card");
      if (idx === 0) card.classList.add("open");
      const totals = computeWeekTotals(week);
      const head = document.createElement("div");
      head.className = "week-head";
      head.innerHTML = `
        <div>
          <h4>${week.phaseLabel ? `<span class="phase-badge">${escapeHtml(week.phaseLabel)}</span>` : ""}${escapeHtml(week.label)}</h4>
          <div class="week-info">Avg ${totals.avgCalories || "—"} kcal · ${totals.avgProtein || "—"}g protein /day</div>
        </div>
        <div class="week-head-right"><span class="week-toggle">▾</span></div>`;
      head.addEventListener("click", () => card.classList.toggle("open"));
      const body = document.createElement("div");
      body.className = "diet-week-body";
      const list = document.createElement("div");
      list.style.display = "flex"; list.style.flexDirection = "column"; list.style.gap = "0.4em";
      week.diet.days.forEach((d, i) => {
        const row = document.createElement("div");
        row.className = "client-diet-day";
        row.innerHTML = `
          <span class="day-name">${DAY_LABELS[i] || "Day " + (i + 1)}</span>
          <span class="target">Calories: <strong>${escapeHtml(d.calories || "—")}</strong></span>
          <span class="target">Protein: <strong>${escapeHtml(d.protein ? d.protein + "g" : "—")}</strong></span>`;
        list.appendChild(row);
      });
      body.appendChild(list);
      if (week.diet.notes) {
        const notes = document.createElement("div");
        notes.className = "client-instructions";
        notes.style.marginTop = "0.8em";
        notes.textContent = week.diet.notes;
        body.appendChild(notes);
      }
      card.appendChild(head); card.appendChild(body);
      container.appendChild(card);
    });
  }

  // -------- Athlete progress (bodyweight + feedback + send) --------
  function renderClientProgress() {
    $("#bw-date").value = todayISO();
    $("#bw-weight").value = "";
    $("#client-feedback").value = state.clientData.progress.feedback || "";
    renderBwHistory();
  }
  function renderBwHistory() {
    const wrap = $("#bw-history");
    wrap.innerHTML = "";
    const log = state.clientData.progress.bodyweightLog || [];
    if (!log.length) { wrap.innerHTML = `<p class="muted">No weight entries yet.</p>`; return; }
    [...log].sort((a, b) => b.date.localeCompare(a.date)).forEach((b) => {
      const row = document.createElement("div");
      row.className = "bw-entry";
      row.innerHTML = `
        <span><span class="date">${escapeHtml(b.date)}</span> — <strong>${escapeHtml(b.weightLb)} lb</strong></span>
        <button class="delete-bw" data-id="${b.id}" title="Delete">×</button>`;
      row.querySelector(".delete-bw").addEventListener("click", () => {
        if (!window.confirm("Delete this entry?")) return;
        state.clientData.progress.bodyweightLog =
          state.clientData.progress.bodyweightLog.filter((x) => x.id !== b.id);
        saveClient();
        renderBwHistory();
      });
      wrap.appendChild(row);
    });
  }
  function logBodyweight() {
    const date = $("#bw-date").value || todayISO();
    const w = $("#bw-weight").value;
    if (!w) { toast("Enter a weight"); return; }
    state.clientData.progress.bodyweightLog.push({ id: uid(), date, weightLb: w });
    saveClient();
    $("#bw-weight").value = "";
    renderBwHistory();
    toast("Weight logged ✓");
  }
  function sendProgress() {
    const prog = state.clientData.program;
    const payload = {
      kind: "tp-progress", v: 2,
      clientId: prog.clientId,
      clientName: prog.client.name,
      sentAt: Date.now(),
      progress: {
        exerciseLogs: state.clientData.progress.exerciseLogs || {},
        bodyweightLog: state.clientData.progress.bodyweightLog || [],
        feedback: state.clientData.progress.feedback || "",
        dayCompletions: state.clientData.progress.dayCompletions || {},
        personalRecords: state.clientData.progress.personalRecords || [],
      },
    };
    const code = encodeData(payload);
    openModal({
      title: "Send progress to your coach",
      body: `
        <p>Copy this code and send it to your coach (text, email, anywhere).</p>
        <textarea class="code-textarea" id="send-code-output" readonly>${escapeHtml(code)}</textarea>
        <div class="code-actions">
          <button class="btn btn-primary" id="btn-copy-send">Copy code</button>
        </div>`,
      actions: [{ label: "Close", className: "btn btn-ghost", onClick: closeModal }],
    });
    $("#btn-copy-send").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(code); toast("Code copied"); }
      catch { $("#send-code-output").select(); document.execCommand("copy"); toast("Code copied"); }
    });
  }
  function reloadClientCode() {
    if (!window.confirm("Load a new access code? Your existing logs will be preserved if it's the same athlete.")) return;
    showLoginScreen("#login-client-import");
    setTimeout(() => $("#client-code").focus(), 50);
  }

  // -------- Modal --------
  function openModal({ title, body, actions = [] }) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = body;
    const foot = $("#modal-foot");
    foot.innerHTML = "";
    for (const a of actions) {
      const btn = document.createElement("button");
      btn.className = a.className || "btn";
      btn.textContent = a.label;
      btn.addEventListener("click", a.onClick);
      foot.appendChild(btn);
    }
    show($("#modal"));
  }
  function closeModal() { hide($("#modal")); }

  function editClient() { setTab("profile"); $("#prof-name").focus(); }

  // -------- Init --------
  function init() {
    $$("#login-role [data-role], .role-btn[data-role]").forEach((b) => b.addEventListener("click", () => pickRole(b.dataset.role)));
    $$(".back-to-role").forEach((b) => b.addEventListener("click", () => showLoginScreen("#login-role")));

    $("#btn-setup").addEventListener("click", setupAccount);
    $("#btn-signin").addEventListener("click", signIn);
    $("#btn-reset").addEventListener("click", resetTrainerAccount);
    $("#login-pin").addEventListener("keydown", (e) => { if (e.key === "Enter") signIn(); });
    $("#setup-pin-confirm").addEventListener("keydown", (e) => { if (e.key === "Enter") setupAccount(); });

    // Coach access gate
    $("#btn-coach-gate").addEventListener("click", submitCoachGate);
    $("#coach-gate-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submitCoachGate(); });

    $("#btn-import-code").addEventListener("click", importClientCode);
    $("#btn-invite-login").addEventListener("click", loginWithInviteCode);
    $("#btn-client-resume").addEventListener("click", resumeClient);
    $("#invite-code-input").addEventListener("input", (e) => {
      e.target.value = formatInviteInput(e.target.value);
    });
    $("#invite-code-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") loginWithInviteCode();
    });

    // Athlete profile setup / sign-in
    $("#btn-athlete-setup").addEventListener("click", setupAthleteProfile);
    $("#athlete-setup-pw-confirm").addEventListener("keydown", (e) => {
      if (e.key === "Enter") setupAthleteProfile();
    });
    $("#btn-athlete-signin").addEventListener("click", athleteSignIn);
    $("#athlete-signin-pw").addEventListener("keydown", (e) => {
      if (e.key === "Enter") athleteSignIn();
    });
    $("#btn-athlete-use-new-code").addEventListener("click", useNewInviteCode);
    $("#btn-athlete-forget").addEventListener("click", forgetAthleteProfile);

    $("#btn-logout").addEventListener("click", signOutTrainer);
    $("#btn-add-client").addEventListener("click", addClientPrompt);
    $("#btn-back").addEventListener("click", renderDashboard);
    $("#btn-edit-client").addEventListener("click", editClient);
    $("#btn-delete-client").addEventListener("click", deleteClientPrompt);
    $("#btn-add-week").addEventListener("click", addWeek);
    $("#btn-add-week-empty").addEventListener("click", addWeek);
    $("#btn-load-template").addEventListener("click", loadTemplate);
    $("#btn-load-template-empty").addEventListener("click", loadTemplate);
    $("#btn-share-client").addEventListener("click", shareClient);
    $("#btn-import-progress").addEventListener("click", importProgressPrompt);
    $("#btn-import-progress-empty").addEventListener("click", importProgressPrompt);
    $("#btn-coach-add-pr").addEventListener("click", () => openAddPRModal("coach"));
    $("#btn-athlete-add-pr").addEventListener("click", () => openAddPRModal("athlete"));
    $("#btn-regen-invite").addEventListener("click", regenerateInviteCode);
    $("#btn-copy-invite").addEventListener("click", copyInviteCode);

    // Calendar (coach)
    $("#cal-prev").addEventListener("click", () => { stepCoachMonth(-1); });
    $("#cal-next").addEventListener("click", () => { stepCoachMonth(1); });
    $("#cal-today").addEventListener("click", () => {
      const now = new Date();
      state.coachCal = { year: now.getFullYear(), month: now.getMonth() };
      renderCoachCalendar();
    });
    // Calendar (athlete)
    $("#ccal-prev").addEventListener("click", () => { stepAthleteMonth(-1); });
    $("#ccal-next").addEventListener("click", () => { stepAthleteMonth(1); });
    $("#ccal-today").addEventListener("click", () => {
      const now = new Date();
      state.athleteCal = { year: now.getFullYear(), month: now.getMonth() };
      renderAthleteCalendar();
    });

    $$(".tab[data-tab]").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));
    $$(".tab[data-ctab]").forEach((t) => t.addEventListener("click", () => setClientTab(t.dataset.ctab)));

    $("#btn-client-logout").addEventListener("click", exitClient);
    $("#btn-client-reload").addEventListener("click", reloadClientCode);
    $("#btn-client-send").addEventListener("click", sendProgress);
    $("#btn-log-bw").addEventListener("click", logBodyweight);
    $("#client-feedback").addEventListener("input", () => {
      state.clientData.progress.feedback = $("#client-feedback").value;
      saveClient();
    });

    document.querySelectorAll("#modal [data-close]").forEach((el) =>
      el.addEventListener("click", closeModal)
    );

    bindProfileInputs();

    const sess = sessionStorage.getItem(KEY_SESSION);
    if (sess === "trainer" && state.trainerData.trainer) signIntoTrainer();
    else if (sess === "client" && state.clientData.program) enterClientPortal();
    else showLoginScreen("#login-role");
  }

  function stepCoachMonth(delta) {
    let { year, month } = state.coachCal;
    month += delta;
    if (month < 0) { month = 11; year--; }
    if (month > 11) { month = 0; year++; }
    state.coachCal = { year, month };
    renderCoachCalendar();
  }
  function stepAthleteMonth(delta) {
    let { year, month } = state.athleteCal;
    month += delta;
    if (month < 0) { month = 11; year--; }
    if (month > 11) { month = 0; year++; }
    state.athleteCal = { year, month };
    renderAthleteCalendar();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
