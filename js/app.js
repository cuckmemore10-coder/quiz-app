(function () {
  "use strict";

  const PIN_LEN = 4;
  const LS = {
    pinHash: "quiz_pin_hash",
    pinSalt: "quiz_pin_salt",
    pinEnabled: "quiz_pin_enabled",
    bestPersonality: "quiz_best_personality",
    bestKnowledge: "quiz_best_knowledge",
    bestCombined: "quiz_best_combined",
    lastResult: "quiz_last_result"
  };

  const state = {
    pinBuffer: "",
    settingPin: false,
    confirmPin: null,
    order: [],
    index: 0,
    personalityScore: 0,
    knowledgeScore: 0,
    knowledgeAnswered: 0,
    phase: "home", // home | quiz | explain | results | settings
    pendingExplain: null,
    lastResult: null
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 1800);
  }

  async function sha256(str) {
    const data = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function randomSalt() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function hashPin(pin, salt) {
    return sha256(salt + ":" + pin);
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function tierFor(score, tiers) {
    return tiers.find((t) => score >= t.min && score <= t.max) || tiers[tiers.length - 1];
  }

  function showScreen(name) {
    $$(".screen").forEach((el) => el.classList.toggle("active", el.id === "screen-" + name));
    state.phase = name;
  }

  /* ---------- PIN ---------- */
  function pinEnabled() {
    return localStorage.getItem(LS.pinEnabled) === "1" && !!localStorage.getItem(LS.pinHash);
  }

  function updatePinDots(error) {
    $$(".pin-dot").forEach((d, i) => {
      d.classList.toggle("filled", i < state.pinBuffer.length);
      d.classList.toggle("error", !!error);
    });
  }

  function showLock(mode) {
    $("#lock-screen").classList.remove("hidden");
    $("#app").classList.add("hidden");
    state.pinBuffer = "";
    state.settingPin = mode === "set" || mode === "change";
    if (mode !== "confirm") state.confirmPin = null;
    const title = $("#lock-title");
    const sub = $("#lock-sub");
    if (mode === "set") {
      title.textContent = "Create a PIN";
      sub.textContent = "Optional lock for Quiz on this device.";
    } else if (mode === "confirm") {
      title.textContent = "Confirm PIN";
      sub.textContent = "Enter the same PIN again.";
    } else if (mode === "change") {
      title.textContent = "New PIN";
      sub.textContent = "Enter a new 4-digit PIN.";
    } else {
      title.textContent = "Enter PIN";
      sub.textContent = "Quiz is locked.";
    }
    $("#lock-error").textContent = "";
    updatePinDots(false);
  }

  function unlockApp() {
    sessionStorage.setItem("quiz_session_ok", "1");
    $("#lock-screen").classList.add("hidden");
    $("#app").classList.remove("hidden");
    renderHome();
    showScreen("home");
  }

  async function onPinComplete(pin) {
    const errEl = $("#lock-error");
    if (state.settingPin && state.confirmPin === null) {
      state.confirmPin = pin;
      state.pinBuffer = "";
      showLock("confirm");
      state.settingPin = true;
      return;
    }
    if (state.settingPin && state.confirmPin !== null) {
      if (pin !== state.confirmPin) {
        errEl.textContent = "PINs didn’t match. Try again.";
        state.confirmPin = null;
        state.pinBuffer = "";
        updatePinDots(true);
        setTimeout(() => showLock("set"), 450);
        return;
      }
      const salt = randomSalt();
      localStorage.setItem(LS.pinSalt, salt);
      localStorage.setItem(LS.pinHash, await hashPin(pin, salt));
      localStorage.setItem(LS.pinEnabled, "1");
      state.confirmPin = null;
      state.settingPin = false;
      toast("PIN enabled");
      unlockApp();
      syncPinToggle();
      return;
    }
    const salt = localStorage.getItem(LS.pinSalt);
    const expected = localStorage.getItem(LS.pinHash);
    if ((await hashPin(pin, salt)) === expected) {
      unlockApp();
    } else {
      errEl.textContent = "Wrong PIN";
      state.pinBuffer = "";
      updatePinDots(true);
      setTimeout(() => updatePinDots(false), 400);
    }
  }

  function bindPinPad() {
    $$(".pin-key").forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = btn.dataset.key;
        if (k === "del") {
          state.pinBuffer = state.pinBuffer.slice(0, -1);
          updatePinDots(false);
          return;
        }
        if (state.pinBuffer.length >= PIN_LEN) return;
        state.pinBuffer += k;
        updatePinDots(false);
        if (state.pinBuffer.length === PIN_LEN) onPinComplete(state.pinBuffer);
      });
    });
  }

  function syncPinToggle() {
    const on = pinEnabled();
    $("#pin-toggle").classList.toggle("on", on);
    $("#pin-toggle-label").textContent = on ? "On" : "Off";
  }

  /* ---------- Quiz flow ---------- */
  function startQuiz() {
    const p = shuffle(window.QUIZ.personality).map((q) => ({ ...q, kind: "personality" }));
    const k = shuffle(window.QUIZ.knowledge).map((q) => ({ ...q, kind: "knowledge" }));
    // Personality first block, then knowledge — each internally shuffled
    state.order = p.concat(k);
    state.index = 0;
    state.personalityScore = 0;
    state.knowledgeScore = 0;
    state.knowledgeAnswered = 0;
    state.pendingExplain = null;
    showScreen("quiz");
    renderQuestion();
  }

  function renderQuestion() {
    const total = state.order.length;
    const q = state.order[state.index];
    const pct = Math.round((state.index / total) * 100);
    $("#progress-fill").style.width = pct + "%";
    $("#progress-label").textContent =
      q.kind === "personality" ? "How much of a cuckold are you?" : "How much do you know?";
    $("#progress-count").textContent = state.index + 1 + " / " + total;

    const tag = $("#q-tag");
    tag.textContent = q.kind === "personality" ? "Personality" : "Knowledge";
    tag.classList.toggle("know", q.kind === "knowledge");

    $("#q-text").textContent = q.text;
    const box = $("#choices");
    box.innerHTML = "";
    $("#explain-box").classList.add("hidden");
    $("#btn-next").classList.add("hidden");

    const choices = q.kind === "knowledge" ? shuffle(q.choices) : q.choices;
    choices.forEach((c, i) => {
      const btn = document.createElement("button");
      btn.className = "choice";
      btn.type = "button";
      btn.textContent = c.label;
      btn.addEventListener("click", () => onChoose(q, c, btn));
      box.appendChild(btn);
    });
  }

  function onChoose(q, choice, btn) {
    if (state.pendingExplain) return;
    $$("#choices .choice").forEach((b) => (b.disabled = true));

    if (q.kind === "personality") {
      btn.classList.add("selected");
      state.personalityScore += choice.score;
      setTimeout(() => advance(), 280);
      return;
    }

    // Knowledge
    state.knowledgeAnswered += 1;
    const correct = choice.correct === true;
    if (correct) state.knowledgeScore += 1;

    $$("#choices .choice").forEach((b) => {
      const label = b.textContent;
      const match = q.choices.find((x) => x.label === label);
      if (match && match.correct) b.classList.add("correct");
      if (b === btn && !correct) b.classList.add("wrong");
      if (b === btn && correct) b.classList.add("selected");
    });

    const exp = $("#explain-box");
    exp.classList.remove("hidden");
    exp.innerHTML =
      "<strong>" +
      (correct ? "Correct." : "Not quite.") +
      "</strong> " +
      escapeHtml(q.explain);
    state.pendingExplain = true;
    $("#btn-next").classList.remove("hidden");
  }

  function advance() {
    state.pendingExplain = null;
    state.index += 1;
    if (state.index >= state.order.length) {
      finishQuiz();
      return;
    }
    renderQuestion();
  }

  function finishQuiz() {
    const pMax = window.QUIZ.personality.length * 3;
    const kMax = window.QUIZ.knowledge.length;
    const pTier = tierFor(state.personalityScore, window.QUIZ.personalityTiers);
    const kTier = tierFor(state.knowledgeScore, window.QUIZ.knowledgeTiers);
    const combined = state.personalityScore + state.knowledgeScore * 3;
    const cTier = tierFor(combined, window.QUIZ.combinedTiers);

    const result = {
      personalityScore: state.personalityScore,
      personalityMax: pMax,
      knowledgeScore: state.knowledgeScore,
      knowledgeMax: kMax,
      combined,
      pTitle: pTier.title,
      pBlurb: pTier.blurb,
      kTitle: kTier.title,
      kBlurb: kTier.blurb,
      cTitle: cTier.title,
      cBlurb: cTier.blurb,
      at: Date.now()
    };
    state.lastResult = result;
    localStorage.setItem(LS.lastResult, JSON.stringify(result));

    const bestP = Number(localStorage.getItem(LS.bestPersonality) || 0);
    const bestK = Number(localStorage.getItem(LS.bestKnowledge) || 0);
    const bestC = Number(localStorage.getItem(LS.bestCombined) || 0);
    if (result.personalityScore > bestP) localStorage.setItem(LS.bestPersonality, String(result.personalityScore));
    if (result.knowledgeScore > bestK) localStorage.setItem(LS.bestKnowledge, String(result.knowledgeScore));
    if (result.combined > bestC) localStorage.setItem(LS.bestCombined, String(result.combined));

    $("#progress-fill").style.width = "100%";
    renderResults(result);
    showScreen("results");
  }

  function renderResults(r) {
    $("#res-combined-title").textContent = r.cTitle;
    $("#res-combined-blurb").textContent = r.cBlurb;
    $("#res-p-score").textContent = r.personalityScore + " / " + r.personalityMax;
    $("#res-p-title").textContent = r.pTitle;
    $("#res-p-blurb").textContent = r.pBlurb;
    $("#res-k-score").textContent = r.knowledgeScore + " / " + r.knowledgeMax;
    $("#res-k-title").textContent = r.kTitle;
    $("#res-k-blurb").textContent = r.kBlurb;

    const bestP = localStorage.getItem(LS.bestPersonality) || "0";
    const bestK = localStorage.getItem(LS.bestKnowledge) || "0";
    const bestC = localStorage.getItem(LS.bestCombined) || "0";
    $("#res-best").textContent =
      "Best so far — Personality " + bestP + " · Knowledge " + bestK + " · Combined " + bestC;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------- Share image ---------- */
  async function shareResultImage() {
    const r = state.lastResult;
    if (!r) return;
    const canvas = $("#share-canvas");
    const W = 1080;
    const H = 1350;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");

    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#0b0b12");
    g.addColorStop(0.55, "#1a1028");
    g.addColorStop(1, "#0a1a33");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // subtle circles
    ctx.fillStyle = "rgba(10,132,255,0.08)";
    ctx.beginPath();
    ctx.arc(W * 0.85, H * 0.15, 220, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,55,95,0.08)";
    ctx.beginPath();
    ctx.arc(W * 0.15, H * 0.8, 260, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#8e8e93";
    ctx.font = "600 36px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("QUIZ RESULT", W / 2, 120);

    ctx.fillStyle = "#ffffff";
    ctx.font = "800 64px -apple-system, BlinkMacSystemFont, sans-serif";
    wrapFill(ctx, r.cTitle, W / 2, 220, W * 0.82, 72);

    ctx.fillStyle = "#c7c7cc";
    ctx.font = "400 34px -apple-system, BlinkMacSystemFont, sans-serif";
    wrapFill(ctx, r.cBlurb, W / 2, 420, W * 0.78, 44);

    // cards
    roundRect(ctx, 90, 620, W - 180, 200, 28, "rgba(44,44,46,0.9)");
    roundRect(ctx, 90, 850, W - 180, 200, 28, "rgba(44,44,46,0.9)");

    ctx.textAlign = "left";
    ctx.fillStyle = "#8e8e93";
    ctx.font = "600 28px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText("CUCKOLD METER", 130, 680);
    ctx.fillStyle = "#fff";
    ctx.font = "800 48px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(r.pTitle, 130, 750);
    ctx.fillStyle = "#7cc4ff";
    ctx.font = "600 32px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(r.personalityScore + " / " + r.personalityMax, 130, 800);

    ctx.fillStyle = "#8e8e93";
    ctx.font = "600 28px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText("KNOWLEDGE", 130, 910);
    ctx.fillStyle = "#fff";
    ctx.font = "800 48px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(r.kTitle, 130, 980);
    ctx.fillStyle = "#ff9f0a";
    ctx.font = "600 32px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(r.knowledgeScore + " / " + r.knowledgeMax, 130, 1030);

    ctx.textAlign = "center";
    ctx.fillStyle = "#636366";
    ctx.font = "500 28px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText("Adult · Consensual · On-device", W / 2, 1220);
    ctx.fillText("Quiz", W / 2, 1270);

    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) {
      toast("Could not create image");
      return;
    }
    const file = new File([blob], "quiz-result.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "My Quiz result" });
        toast("Shared");
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "quiz-result.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    toast("Saved image");
  }

  function wrapFill(ctx, text, x, y, maxW, lineH) {
    const words = text.split(/\s+/);
    let line = "";
    let yy = y;
    words.forEach((w) => {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, yy);
        line = w;
        yy += lineH;
      } else line = test;
    });
    if (line) ctx.fillText(line, x, yy);
  }

  function roundRect(ctx, x, y, w, h, r, fill) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  /* ---------- Home / settings ---------- */
  function renderHome() {
    const bestP = localStorage.getItem(LS.bestPersonality);
    const bestK = localStorage.getItem(LS.bestKnowledge);
    const el = $("#home-best");
    if (bestP || bestK) {
      el.textContent =
        "Best scores — Personality " +
        (bestP || "—") +
        " · Knowledge " +
        (bestK || "—") +
        " · Combined " +
        (localStorage.getItem(LS.bestCombined) || "—");
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }

  function bindUI() {
    $("#btn-start").addEventListener("click", startQuiz);
    $("#btn-next").addEventListener("click", advance);
    $("#btn-retake").addEventListener("click", startQuiz);
    $("#btn-home").addEventListener("click", () => {
      renderHome();
      showScreen("home");
    });
    $("#btn-share").addEventListener("click", shareResultImage);
    $("#btn-settings").addEventListener("click", () => {
      syncPinToggle();
      showScreen("settings");
    });
    $("#btn-settings-back").addEventListener("click", () => showScreen("home"));

    $("#pin-toggle").addEventListener("click", () => {
      if (pinEnabled()) {
        localStorage.setItem(LS.pinEnabled, "0");
        toast("PIN lock off");
        syncPinToggle();
      } else if (localStorage.getItem(LS.pinHash)) {
        localStorage.setItem(LS.pinEnabled, "1");
        toast("PIN lock on");
        syncPinToggle();
      } else {
        showLock("set");
      }
    });

    $("#btn-change-pin").addEventListener("click", () => showLock("change"));
    $("#btn-lock-now").addEventListener("click", () => {
      if (!pinEnabled()) {
        toast("Enable PIN first");
        return;
      }
      sessionStorage.removeItem("quiz_session_ok");
      showLock("enter");
    });
    $("#btn-clear-scores").addEventListener("click", () => {
      localStorage.removeItem(LS.bestPersonality);
      localStorage.removeItem(LS.bestKnowledge);
      localStorage.removeItem(LS.bestCombined);
      localStorage.removeItem(LS.lastResult);
      renderHome();
      toast("Scores cleared");
    });
  }

  function init() {
    bindPinPad();
    bindUI();
    const countP = window.QUIZ.personality.length;
    const countK = window.QUIZ.knowledge.length;
    $("#q-counts").textContent = countP + " personality + " + countK + " knowledge questions";

    if (pinEnabled() && sessionStorage.getItem("quiz_session_ok") !== "1") {
      showLock("enter");
    } else {
      $("#lock-screen").classList.add("hidden");
      $("#app").classList.remove("hidden");
      renderHome();
      showScreen("home");
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
