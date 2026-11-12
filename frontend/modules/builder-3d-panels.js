window.EFTForge = window.EFTForge || {};

// ============================================================
// 3D BUILDER PANELS
//
// Our panels over the Kitbash! 3D view (builder-3d.js), drawn from the viewer's
// events and driving it through its commands (Kitbash! spec/viewer-api.md):
//   - view buttons: hide slots, sight picture, reset view
//   - sight bar: sight switching, scope modes, zoom, ADS simulation switch
//   - ADS panel: aim state, arm stamina, breath, skills
//   - range panel: target distance, paper target, range world on or off (and the key
//     colour behind the weapon while it is off), aspect ratio
//   - tactical devices: power and mode per light or laser
//   - muzzle smoke and flash (sight picture): fire shots to see them, and how much each makes
// ============================================================

(function () {
    const SLOTS_HIDDEN_KEY = "eftforge_b3d_slots_hidden";
    const TACTICAL_FOLD_KEY = "eftforge_b3d_tactical_collapsed";
    const TACTICAL_POS_KEY = "eftforge_b3d_tactical_pos"; // {orbit: [fx, fy], sight: [fx, fy]}
    const ADS_POS_KEY = "eftforge_b3d_ads_pos";           // {sight: [fx, fy]}
    const RANGE_POS_KEY = "eftforge_b3d_range_pos";       // {sight: [fx, fy]}
    const SMOKE_POS_KEY = "eftforge_b3d_smoke_pos";       // {sight: [fx, fy]}
    const SMOKE_FOLD_KEY = "eftforge_b3d_smoke_collapsed";
    const SMOKE_SHOWN_KEY = "eftforge_b3d_smoke_shown";
    const MUZZLE_SHOW_KEY = "eftforge_b3d_muzzle_show"; // {smoke, flash}: which the viewer draws
    const SMOKE_TAB_KEY = "eftforge_b3d_smoke_tab";       // "smoke" or "flash": the stats shown while both draw
    const SMOKE_BURST = 10; // the viewer's smoke event counts a burst of this many
    const FPS_KEY = "eftforge_b3d_game_fps";             // the game frame rate the overswing follows; 0 follows the display
    const FPS_MIN = 30, FPS_MAX = 360;
    const FIRE_MODES = ["single", "burst", "fullauto"];   // the viewer's fire modes; a weapon has some of them
    const SKILLS_KEY = "eftforge_b3d_skills";             // {weapon, aimDrills, endurance}; Strength is the stats panel's
    const PANEL_MARGIN = 8; // a dragged panel keeps this far inside the view
    const RANGE_PRESETS = [10, 25, 50, 100, 300, 500, 1000];
    // Flat backgrounds for chroma keying while the range world is hidden.
    const KEY_PRESETS = [
        { hex: "#00b140", label: "b3d.key.chromaGreen" },
        { hex: "#0047bb", label: "b3d.key.chromaBlue" },
        { hex: "#00ff00", label: "b3d.key.pureGreen" },
        { hex: "#ff00ff", label: "b3d.key.magenta" },
        { hex: "#000000", label: "b3d.key.black" },
        { hex: "#ffffff", label: "b3d.key.white" },
    ];
    const SKILLS = [
        ["weapon", "b3d.skillWeapon", "b3d.skillWeaponTip"],
        ["aimDrills", "b3d.skillAimDrills", "b3d.skillAimDrillsTip"],
        ["strength", "b3d.skillStrength", "b3d.skillStrengthTip"],
        ["endurance", "b3d.skillEndurance", "b3d.skillEnduranceTip"],
    ];
    const ELITE = 51;

    const _t = (key) => EFTForge.lang.t(key);
    const _f = (key, vars) => EFTForge.lang.tFmt(key, vars);
    const _read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
    const _write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };

    let _root = null, _api = null, _resizeObs = null;

    // The skill levels we keep ourselves, so they survive a viewer on another origin (its own
    // storage is not ours). Strength stays in the stats panel's key, the one level both share.
    function _savedSkills() {
        let saved = {};
        try { saved = JSON.parse(_read(SKILLS_KEY)) || {}; } catch { /* keep the defaults */ }
        const skills = {};
        for (const [key] of SKILLS) {
            const v = Number(saved[key]);
            if (key !== "strength" && Number.isFinite(v)) skills[key] = Math.max(0, Math.min(ELITE, Math.round(v)));
        }
        return skills;
    }
    const _s = {
        mode: "orbit", hasSights: false, slotsHidden: _read(SLOTS_HIDDEN_KEY) === "1",
        fps: Math.min(FPS_MAX, Math.max(0, Math.round(Number(_read(FPS_KEY)) || 0))),
        sight: { mode: "orbit" }, zoom: null, ads: null, range: null, display: null, devices: [],
        tacticalCollapsed: _read(TACTICAL_FOLD_KEY) === "1",
        smoke: null, smokeCollapsed: _read(SMOKE_FOLD_KEY) === "1", smokeHeld: false,
        smokeShown: _read(SMOKE_SHOWN_KEY) === "1", // the sight bar's smoke button; hidden until asked for
        smokeTab: _read(SMOKE_TAB_KEY) === "flash" ? "flash" : "smoke",
        // At least one stays on: a saved state with neither shows both.
        muzzleShow: (() => {
            let s = { smoke: true, flash: true };
            try { s = { ...s, ...JSON.parse(_read(MUZZLE_SHOW_KEY)) }; } catch { /* keep both */ }
            return s.smoke || s.flash ? s : { smoke: true, flash: true };
        })(),
        diagOpen: false, // the viewer's own diagnostics dock (setAdsDiagnosticsPanel)
        diagRect: null,  // where that dock is, in the frame's pixels (adsdiagnosticsrect)
    };

    // Small DOM helper: el("button.b3d-chip", {text, title, onclick, dataset}, children)
    function el(spec, props = {}, children = []) {
        const [tag, ...classes] = spec.split(".");
        const node = document.createElement(tag || "div");
        if (classes.length) node.className = classes.join(" ");
        for (const [k, v] of Object.entries(props)) {
            if (v === undefined || v === null) continue;
            if (k === "text") node.textContent = v;
            else if (k === "tip") node.dataset.tooltip = v;
            else if (k === "dataset") Object.assign(node.dataset, v);
            else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v);
        }
        for (const c of [].concat(children)) if (c) node.append(c);
        return node;
    }

    const _send = (...a) => _api?.send(...a);

    // --------------------------------------------------------- view buttons

    let _viewBtns = null;
    function _buildViewButtons() {
        _viewBtns = el("div.b3d-viewbtns", {}, [
            el("button.b3d-btn", { dataset: { act: "hideui" }, onclick: () => setUiHidden(true) }),
            el("button.b3d-btn", { dataset: { act: "slots" }, onclick: () => _send("setSlotsHidden", !_s.slotsHidden) }),
            el("button.b3d-btn", { dataset: { act: "sight" }, onclick: () => _send(_s.mode === "sight" ? "exitSight" : "enterSight") }),
            el("button.b3d-btn", { dataset: { act: "reset" }, onclick: () => _send("reset") }),
        ]);
        _root.append(_viewBtns);
    }

    function _renderViewButtons() {
        if (!_viewBtns) return;
        const sight = _s.mode === "sight";
        const slots = _viewBtns.querySelector('[data-act="slots"]');
        slots.textContent = `${_t(_s.slotsHidden ? "b3d.showSlots" : "b3d.hideSlots")} (H)`;
        slots.hidden = sight;
        const hideUi = _viewBtns.querySelector('[data-act="hideui"]');
        hideUi.textContent = _t("b3d.hideUi");
        hideUi.hidden = !sight;
        const sightBtn = _viewBtns.querySelector('[data-act="sight"]');
        sightBtn.textContent = sight ? `${_t("b3d.exitSight")} (Esc)` : `${_t("b3d.sight")} (V)`;
        sightBtn.hidden = !sight && !_s.hasSights;
        // The ADS simulation places the eye itself: nothing to reset.
        const reset = _viewBtns.querySelector('[data-act="reset"]');
        reset.textContent = _t("b3d.resetView");
        reset.hidden = !!(sight && _s.ads?.on);
    }

    // --------------------------------------------------------- sight bar

    let _sightBar = null, _fovNote = null;
    function _buildSightBar() {
        const slider = el("input.b3d-zoom-slider", { type: "range", min: "0", max: "1000", step: "1", value: "0" });
        slider.addEventListener("input", () => _send("setSightZoom", Number(slider.value) / 1000));
        _sightBar = el("div.b3d-panel.b3d-sightbar", {}, [
            el("button.b3d-chip.b3d-prev", { text: "<", onclick: () => _send("nextSight", -1) }),
            el("span.b3d-sight-label"),
            el("span.b3d-sight-count"),
            el("button.b3d-chip.b3d-next", { text: ">", onclick: () => _send("nextSight", 1) }),
            el("span.b3d-zoom", {}, [el("span.b3d-zoom-modes"), slider, el("span.b3d-zoom-mag")]),
            el("span.b3d-sight-fov"),
            el("span.b3d-sight-hint"),
            el("button.b3d-chip.b3d-ads-btn", { onclick: () => _send("setAdsSim", !_s.ads?.on) }),
            el("button.b3d-chip.b3d-smoke-btn", { onclick: () => {
                _s.smokeShown = !_s.smokeShown;
                _write(SMOKE_SHOWN_KEY, _s.smokeShown ? "1" : "0");
                if (!_s.smokeShown) _holdSmoke(false);
                _renderSmoke();
            } }),
        ]);
        _fovNote = el("div.b3d-fovnote");
        _root.append(_sightBar, _fovNote);
    }

    function _renderSightBar() {
        if (!_sightBar) return;
        const st = _s.sight;
        const on = st.mode === "sight";
        _sightBar.hidden = !on;
        _fovNote.hidden = !on;
        _fovNote.textContent = _t("b3d.fovNote");
        if (!on) return;
        const many = st.sights.length > 1;
        // Our name for the sight in the user's language, else the viewer's.
        const sightPart = st.sights[st.sightIndex]?.partId;
        _sightBar.querySelector(".b3d-sight-label").textContent =
            (sightPart && EFTForge.builder3d?.partName(sightPart)) || st.label || "";
        _sightBar.querySelector(".b3d-sight-count").textContent = many ? `${st.sightIndex + 1}/${st.sights.length}` : "";
        for (const cls of [".b3d-prev", ".b3d-next"]) {
            const b = _sightBar.querySelector(cls);
            b.style.visibility = many ? "visible" : "hidden";
            b.dataset.tooltip = _t(cls === ".b3d-prev" ? "b3d.prevSight" : "b3d.nextSight");
        }
        _sightBar.querySelector(".b3d-sight-fov").textContent = _f(st.optic ? "b3d.aimFovOptic" : "b3d.aimFov", { fov: st.aimFov });
        // Mode buttons for multi-mode scopes (labelled by power when the powers differ,
        // else by reticle), the lowest and highest power for variable scopes, a slider.
        const modes = _sightBar.querySelector(".b3d-zoom-modes");
        modes.replaceChildren();
        const byZoom = new Set(st.modes.map(m => m.zoom)).size > 1;
        st.modes.forEach((m, i) => {
            const b = el("button.b3d-chip", { onclick: () => _send("selectScopeMode", i) });
            if (m.icon) b.append(el("img.b3d-reticle", { src: m.icon, alt: "" }));
            b.append(byZoom && m.zoom !== null ? `${m.zoom}x` : m.icon ? `${i + 1}` : _f("b3d.modeN", { n: i + 1 }));
            b.classList.toggle("active", i === st.modeIndex);
            modes.append(b);
        });
        (st.zoomEnds || []).forEach((mag, end) => {
            modes.append(el("button.b3d-chip.b3d-zoom-end", {
                text: `${+mag.toFixed(1)}x`, dataset: { end: String(end) },
                onclick: () => _send("setSightZoomEnd", end),
            }));
        });
        const slider = _sightBar.querySelector(".b3d-zoom-slider");
        slider.hidden = !st.variable;
        slider.dataset.tooltip = _t("b3d.zoomTip");
        _sightBar.querySelector(".b3d-zoom").hidden = !(st.showsZoom || st.modes.length);
        _sightBar.querySelector(".b3d-sight-hint").textContent = [
            _t("b3d.hintDrag"), _t("b3d.hintNext"),
            ...(st.modes.length ? [_t("b3d.hintMode")] : st.variable ? [_t("b3d.hintEnds")] : []),
            ...(st.variable ? [_t("b3d.hintWheel")] : []),
        ].join(" · ");
        if (st.zoom) _renderZoom(st.zoom);
        _renderAds();
        _renderSmokeButton();
    }

    function _renderZoom(z) {
        _s.zoom = z;
        if (!_sightBar) return;
        _sightBar.querySelector(".b3d-zoom-mag").textContent = z.magnification ? `${(Math.round(z.magnification * 10) / 10).toFixed(1)}x` : "";
        const slider = _sightBar.querySelector(".b3d-zoom-slider");
        if (z.factor !== null && document.activeElement !== slider) slider.value = String(Math.round(z.factor * 1000));
        for (const b of _sightBar.querySelectorAll(".b3d-zoom-end")) b.classList.toggle("active", z.factor === Number(b.dataset.end));
    }

    // --------------------------------------------------------- ADS panel

    let _adsPanel = null;
    function _pair(labelKey, attr, send, modes = ["toggle", "hold"], value = m => m) {
        return el("div.b3d-ads-row", {}, [
            el("span.b3d-ads-name", { dataset: { label: labelKey } }),
            ...modes.map(m => el("button.b3d-chip", { dataset: { [attr]: m }, onclick: () => _send(send, value(m)) })),
        ]);
    }
    function _poolRow(pool, labelKey, maxTip, drainTip) {
        return el("div.b3d-ads-bar", { dataset: { pool } }, [
            el("span.b3d-ads-name", { dataset: { label: labelKey } }),
            el("div.b3d-track", {}, [el("div.b3d-fill")]),
            el("span.b3d-ads-value"),
            el("button.b3d-chip.b3d-refill", { dataset: { tipKey: maxTip }, onclick: () => _send("refillStamina", pool) }),
            el("button.b3d-chip.b3d-nodrain", { dataset: { tipKey: drainTip },
                onclick: () => _send("setStaminaDrain", pool, _s.ads?.drain?.[pool] === false) }),
        ]);
    }

    function _buildAdsPanel() {
        const skills = el("div.b3d-skills", {}, [el("div.b3d-mini-title", { dataset: { label: "b3d.skills" } })]);
        for (const [key, label, tip] of SKILLS) {
            const input = el("input", { type: "range", min: "0", max: String(ELITE), step: "1", value: "0", dataset: { key, tipKey: tip } });
            input.addEventListener("input", () => {
                /** @type {Record<string, number>} */
                const next = {};
                for (const i of skills.querySelectorAll("input")) next[i.dataset.key] = Number(i.value);
                _send("setSkills", next);
                const kept = { ...next };
                delete kept.strength;
                _write(SKILLS_KEY, JSON.stringify(kept));
                // Strength is also our stats panel's Strength level: keep the two as one.
                if (key === "strength") EFTForge.statsPanel?.setStrengthLevel(next.strength);
            });
            skills.append(el("span.b3d-skill-name", { dataset: { key, label, tipKey: tip } }), input, el("span.b3d-skill-level", { dataset: { key } }));
        }
        _adsPanel = el("div.b3d-panel.b3d-adspanel", {}, [
            el("div.b3d-ads-head", {}, [el("span.b3d-ads-state"), el("span.b3d-ads-keys")]),
            _pair("b3d.aimKey", "aimMode", "setAimMode"),
            _pair("b3d.breathKey", "breathMode", "setBreathMode"),
            _pair("b3d.fireMode", "fireMode", "setFireMode", FIRE_MODES),
            _pair("b3d.mouseLook", "mouseLook", "setMouseLook", ["off", "on"], m => m === "on"),
            el("div.b3d-ads-row.b3d-anims", {}, [
                el("span.b3d-ads-name", { dataset: { label: "b3d.animations" } }),
                // The site's own dropdown (setupCustomSelect) over this hidden select, set up
                // once the panel is in the page. Picking plays; the first option says what plays.
                el("select.b3d-anim-select", { id: "b3d-anim-select", onchange: _onAnimationPicked }),
            ]),
            _sensRow("hip", "b3d.sensHip", "b3d.sensHipTip"),
            _sensRow("aim", "b3d.sensAim", "b3d.sensAimTip"),
            _poolRow("hands", "b3d.armStamina", "b3d.maxArmTip", "b3d.noDrainArmTip"),
            _poolRow("oxygen", "b3d.breath", "b3d.maxBreathTip", "b3d.noDrainBreathTip"),
            el("div.b3d-ads-facts"),
            skills,
            el("button.b3d-chip.b3d-diag-btn", { dataset: { label: "b3d.diagnostics", tipKey: "b3d.diagnosticsTip" },
                onclick: () => _send("setAdsDiagnosticsPanel", !_s.diagOpen, _diagSpace()) }),
        ]);
        _makeDraggable(ADS_DRAG);
        _root.append(_adsPanel);
        setupCustomSelect("b3d-anim-select");
    }

    // A mouse sensitivity setting as the stats panel's Strength level is drawn: a slider
    // and a number box, kept together. The viewer takes the value once it is let go.
    function _sensRow(key, labelKey, tipKey) {
        const slider = el("input", { type: "range", min: "0.1", max: "5", step: "0.01", value: "0.5", dataset: { sensSlider: key } });
        const box = el("input", { type: "number", min: "0.1", max: "5", step: "0.01", value: "0.5", dataset: { sens: key } });
        const send = (v) => {
            const n = Math.min(5, Math.max(0.1, Number(v)));
            if (!Number.isFinite(n)) return;
            slider.value = box.value = String(n);
            _send("setLookSensitivity", { [key]: n });
        };
        slider.addEventListener("input", () => { box.value = slider.value; });
        slider.addEventListener("change", () => send(slider.value));
        box.addEventListener("change", () => send(box.value));
        return el("div.b3d-ads-row.b3d-sens-row", { dataset: { tipKey } }, [
            el("span.b3d-ads-name", { dataset: { label: labelKey } }),
            el("div.strength-input-row", {}, [slider, box]),
        ]);
    }

    function _onAnimationPicked(e) {
        const sel = /** @type {HTMLSelectElement} */ (e.target);
        if (sel.value) _send("playAnimation", sel.value);
        // Back to the first option, which shows what is playing.
        sel.value = "";
        sel.dispatchEvent(new Event("input"));
    }

    // Where the viewer's diagnostics dock sits until the user moves it: top left, between
    // the sight bar and our ADS panel (frame and HUD share the same box).
    function _diagSpace() {
        const top = _sightBar.offsetTop + _sightBar.offsetHeight + 12;
        return { left: 16, top, bottom: _adsPanel.offsetTop - 10 };
    }

    function _renderAds() {
        const st = _s.ads;
        const btn = _sightBar?.querySelector(".b3d-ads-btn");
        if (btn) {
            // The button names what a press switches to, and so does its tooltip.
            btn.hidden = !st?.available;
            btn.textContent = `${_t(st?.on ? "b3d.fixedEye" : "b3d.simAds")} (B)`;
            btn.dataset.tooltip = _t(st?.on ? "b3d.fixedEyeTip" : "b3d.simAdsTip");
            // Repaint the tooltip if it is showing, so a click swaps it under the pointer.
            EFTForge.tooltip?.refresh(btn);
        }
        _renderViewButtons();
        if (!_adsPanel) return;
        const show = !!st?.on && _s.mode === "sight";
        _adsPanel.hidden = !show;
        if (!show) return;
        for (const n of _adsPanel.querySelectorAll("[data-label]")) n.textContent = _t(n.dataset.label);
        for (const n of _adsPanel.querySelectorAll("[data-tip-key]")) n.dataset.tooltip = _t(n.dataset.tipKey);
        _adsPanel.querySelector(".b3d-diag-btn").classList.toggle("active", _s.diagOpen);
        const state = _adsPanel.querySelector(".b3d-ads-state");
        state.textContent = _t(st.aiming ? (st.holdingBreath ? "b3d.adsHolding" : "b3d.adsAiming") : "b3d.adsHip");
        state.classList.toggle("aiming", !!st.aiming);
        _adsPanel.querySelector(".b3d-ads-keys").textContent = _t("b3d.adsKeys");
        for (const b of _adsPanel.querySelectorAll("[data-aim-mode]")) {
            b.textContent = _t(b.dataset.aimMode === "toggle" ? "b3d.toggle" : "b3d.hold");
            b.classList.toggle("active", b.dataset.aimMode === st.aimMode);
        }
        for (const b of _adsPanel.querySelectorAll("[data-breath-mode]")) {
            b.textContent = _t(b.dataset.breathMode === "toggle" ? "b3d.toggle" : "b3d.hold");
            b.classList.toggle("active", b.dataset.breathMode === st.breathMode);
        }
        // Show only the fire modes this weapon has.
        for (const b of _adsPanel.querySelectorAll("[data-fire-mode]")) {
            b.textContent = _t("b3d.fire." + b.dataset.fireMode);
            b.hidden = !st.fireModes?.includes(b.dataset.fireMode);
            b.classList.toggle("active", b.dataset.fireMode === st.fireMode);
        }
        // The animations dropdown: one option per animation the weapon has, after the first,
        // which says what is playing (or asks for a pick). Options change only with the list
        // (the custom select rebuilds then); the first one's text and the language follow here.
        const animSel = /** @type {HTMLSelectElement} */ (_adsPanel.querySelector("#b3d-anim-select"));
        const anims = st.animations || [];
        const key = [_t("b3d.animPick"), ...anims].join(","); // the language too
        const head = st.animation ? `${_t("b3d.animPlaying")}: ${_t("b3d.anim." + st.animation)}` : _t("b3d.animPick");
        if (animSel.dataset.key !== key) {
            animSel.dataset.key = key;
            animSel.replaceChildren(el("option", { value: "", text: head }),
                ...anims.map(n => el("option", { value: n, text: _t("b3d.anim." + n) })));
        } else if (animSel.options[0].textContent !== head) {
            animSel.options[0].textContent = head;
            animSel.value = "";
            animSel.dispatchEvent(new Event("input")); // the custom select redraws its trigger
        }
        /** @type {HTMLElement} */ (_adsPanel.querySelector(".b3d-anims")).hidden = !anims.length;
        _adsPanel.querySelector(".b3d-anims .custom-select-wrapper")?.classList.toggle("b3d-anim-playing", !!st.animation);
        for (const row of /** @type {NodeListOf<HTMLElement>} */ (_adsPanel.querySelectorAll(".b3d-sens-row"))) {
            row.dataset.tooltip = _t(row.dataset.tipKey);
            const box = /** @type {HTMLInputElement} */ (row.querySelector("[data-sens]"));
            const slider = /** @type {HTMLInputElement} */ (row.querySelector("[data-sens-slider]"));
            const v = st.lookSensitivity?.[box.dataset.sens];
            // Leave them alone while they are being used.
            if (v !== undefined && document.activeElement !== box && document.activeElement !== slider) {
                box.value = slider.value = String(v);
            }
        }
        for (const b of _adsPanel.querySelectorAll("[data-mouse-look]")) {
            b.textContent = _t(b.dataset.mouseLook === "on" ? "b3d.on" : "b3d.off");
            b.classList.toggle("active", (b.dataset.mouseLook === "on") === !!st.mouseLook);
            b.dataset.tooltip = _t("b3d.mouseLookTip");
        }
        const pools = {
            hands: [st.handsStamina, Number.isFinite(st.handsStaminaSeconds) && st.aiming
                ? `${Math.floor(st.handsStaminaSeconds)} s` : `${Math.round(st.handsStamina * 100)}%`],
            oxygen: [st.oxygen, `${Math.round(st.oxygen * 100)}%`],
        };
        for (const row of _adsPanel.querySelectorAll(".b3d-ads-bar")) {
            const [v, text] = pools[row.dataset.pool];
            const fill = row.querySelector(".b3d-fill");
            fill.style.width = `${Math.round(v * 100)}%`;
            fill.classList.toggle("low", v < 0.2);
            row.querySelector(".b3d-ads-value").textContent = text;
            row.querySelector(".b3d-refill").textContent = _t("b3d.max");
            const nd = row.querySelector(".b3d-nodrain");
            nd.textContent = _t("b3d.noDrain");
            nd.classList.toggle("active", st.drain?.[row.dataset.pool] === false);
        }
        _adsPanel.querySelector(".b3d-ads-facts").textContent = _f("b3d.facts", {
            ergo: st.totalErgonomics.toFixed(1), speed: st.aimingSpeed.toFixed(2),
            overswing: Math.round(st.overswingStrength * 100), hip: Math.round((st.hipPenalty ?? 1) * 100),
        }) + (st.aimingDevice ? _t("b3d.factsDevice") : "");
        const wc = st.weaponClass ? _t(`b3d.wc.${st.weaponClass}`) : null;
        for (const name of _adsPanel.querySelectorAll(".b3d-skill-name")) {
            if (name.dataset.key === "weapon" && wc && wc !== `b3d.wc.${st.weaponClass}`) name.textContent = wc;
        }
        for (const input of _adsPanel.querySelectorAll(".b3d-skills input")) {
            const v = st.skills?.[input.dataset.key] ?? 0;
            if (document.activeElement !== input) input.value = String(v);
            const lv = _adsPanel.querySelector(`.b3d-skill-level[data-key="${input.dataset.key}"]`);
            lv.textContent = v >= ELITE ? _t("b3d.elite") : String(v);
            lv.classList.toggle("elite", v >= ELITE);
        }
        _place(ADS_DRAG);
    }

    // --------------------------------------------------------- range panel

    let _rangePanel = null;
    // The distance slider is logarithmic so short ranges get room; we snap to a step of
    // a quarter of the distance's order of magnitude (1 m under 10, then 2.5, 25, 250).
    const _toDistance = (v, st) => {
        const d = st.min * Math.pow(st.max / st.min, v / 1000);
        const step = d < 10 ? 1 : Math.pow(10, Math.floor(Math.log10(d))) / 4;
        return Math.min(st.max, Math.max(st.min, Math.round(d / step) * step));
    };
    const _toSlider = (d, st) => Math.round((1000 * Math.log(d / st.min)) / Math.log(st.max / st.min));

    function _buildRangePanel() {
        const slider = el("input.b3d-range-slider", { type: "range", min: "0", max: "1000", step: "1", value: "0" });
        slider.addEventListener("input", () => { if (_s.range) _send("setRange", { distance: _toDistance(Number(slider.value), _s.range) }); });
        const fps = el("input.b3d-fps-slider", { type: "range", min: String(FPS_MIN), max: String(FPS_MAX), step: "1", value: "144" });
        fps.addEventListener("input", () => _setFps(Number(fps.value)));
        _rangePanel = el("div.b3d-panel.b3d-rangepanel", {}, [
            el("div.b3d-panel-head", {}, [el("span.b3d-mini-title", { dataset: { label: "b3d.range" } }), el("span.b3d-range-dist")]),
            slider,
            el("div.b3d-chip-row.b3d-presets"),
            el("div.b3d-chip-row.b3d-targets"),
            // Hiding the world leaves the weapon over our own backdrop instead of the range.
            el("div.b3d-chip-row", {}, [el("button.b3d-chip.b3d-hide-world", {
                dataset: { label: "b3d.hideWorld" }, onclick: () => _send("setRange", { world: _s.range?.world === false }) }),
            // Bullet holes stay until cleared here, or until the viewer's budget pushes the oldest out.
            el("button.b3d-chip.b3d-clear-decals", { dataset: { tipKey: "b3d.clearDecalsTip" }, onclick: () => _send("clearDecals") })]),
            _buildKeyRow(),
            el("div.b3d-panel-head.b3d-display-head", {}, [el("span.b3d-mini-title", { dataset: { label: "b3d.display" } }), el("span.b3d-monitor")]),
            el("div.b3d-chip-row.b3d-ratios"),
            // The game adds the aim-in kick once a frame, so the overswing grows with the frame rate.
            el("div.b3d-panel-head.b3d-display-head", {}, [el("span.b3d-mini-title", { dataset: { label: "b3d.gameFps" } }), el("span.b3d-fps-value")]),
            fps,
            el("div.b3d-chip-row", {}, [el("button.b3d-chip.b3d-fps-auto", { dataset: { label: "b3d.fpsAuto" }, onclick: () => _setFps(0) })]),
        ]);
        _makeDraggable(RANGE_DRAG);
        _root.append(_rangePanel);
    }

    function _setFps(v) {
        _s.fps = v;
        _write(FPS_KEY, String(v));
        _send("setAdsFrameRate", v);
        _renderRange();
    }

    function _buildKeyRow() {
        const custom = el("input.b3d-key-custom", { type: "color", value: "#00b140" });
        custom.addEventListener("input", () => _send("setRange", { keyColor: custom.value }));
        return el("div.b3d-chip-row.b3d-keyrow", {}, [
            el("button.b3d-chip.b3d-key-backdrop", { dataset: { label: "b3d.key.backdrop" },
                onclick: () => _send("setRange", { keyColor: null }) }),
            ...KEY_PRESETS.map(p => el("button.b3d-chip.b3d-key-swatch", { style: `background-color: ${p.hex}`,
                dataset: { key: p.hex, tipKey: p.label }, onclick: () => _send("setRange", { keyColor: p.hex }) })),
            custom,
        ]);
    }

    function _renderRange() {
        if (!_rangePanel) return;
        _rangePanel.hidden = _s.mode !== "sight";
        for (const n of _rangePanel.querySelectorAll("[data-label]")) n.textContent = _t(n.dataset.label);
        const st = _s.range;
        if (st) {
            const presets = _rangePanel.querySelector(".b3d-presets");
            if (!presets.childElementCount) {
                for (const m of RANGE_PRESETS.filter(m => m >= st.min && m <= st.max)) {
                    presets.append(el("button.b3d-chip", { text: String(m), dataset: { distance: String(m) },
                        onclick: () => _send("setRange", { distance: m }) }));
                }
            }
            const targets = _rangePanel.querySelector(".b3d-targets");
            targets.replaceChildren(
                ...st.targets.map(tg => {
                    // A target type we have no name for yet shows the viewer's own id.
                    const label = _t(`b3d.target.${tg}`);
                    return el("button.b3d-chip", { text: label === `b3d.target.${tg}` ? tg : label,
                        dataset: { target: tg }, onclick: () => _send("setRange", { target: tg, visible: true }) });
                }),
                el("button.b3d-chip.b3d-hide-target", { text: _t("b3d.hideTarget"),
                    onclick: () => _send("setRange", { visible: !_s.range?.visible }) }),
            );
            _rangePanel.querySelector(".b3d-range-dist").textContent = `${Math.round(st.distance)} m`;
            const slider = _rangePanel.querySelector(".b3d-range-slider");
            if (document.activeElement !== slider) slider.value = String(_toSlider(st.distance, st));
            for (const b of presets.children) b.classList.toggle("active", Number(b.dataset.distance) === Math.round(st.distance));
            for (const b of targets.querySelectorAll("[data-target]")) b.classList.toggle("active", st.visible && b.dataset.target === st.target);
            targets.querySelector(".b3d-hide-target").classList.toggle("active", !st.visible);
            _rangePanel.querySelector(".b3d-hide-world").classList.toggle("active", st.world === false);
            const clear = /** @type {HTMLButtonElement} */ (_rangePanel.querySelector(".b3d-clear-decals"));
            clear.textContent = `${_t("b3d.clearDecals")} (${st.decals?.count ?? 0})`;
            clear.disabled = !st.decals?.count;
            clear.dataset.tooltip = _t("b3d.clearDecalsTip");
            const keyRow = _rangePanel.querySelector(".b3d-keyrow");
            keyRow.hidden = st.world !== false;
            const key = st.keyColor || null;
            keyRow.querySelector(".b3d-key-backdrop").classList.toggle("active", !key);
            for (const b of keyRow.querySelectorAll(".b3d-key-swatch")) {
                b.classList.toggle("active", b.dataset.key === key);
                b.dataset.tooltip = _t(b.dataset.tipKey);
            }
            const custom = keyRow.querySelector(".b3d-key-custom");
            custom.classList.toggle("active", !!key && !KEY_PRESETS.some(p => p.hex === key));
            custom.title = _t("b3d.key.custom");
            if (key && document.activeElement !== custom) custom.value = key;
        }
        const d = _s.display;
        if (d) {
            _rangePanel.querySelector(".b3d-monitor").textContent = `${d.monitor.width}x${d.monitor.height}`;
            _rangePanel.querySelector(".b3d-ratios").replaceChildren(...d.aspectRatios.map(r => el("button.b3d-chip", {
                text: r, onclick: () => _send("setAspectRatio", r),
            })));
            for (const b of _rangePanel.querySelectorAll(".b3d-ratios button")) b.classList.toggle("active", b.textContent === d.aspectRatio);
        }
        const fps = _rangePanel.querySelector(".b3d-fps-slider");
        _rangePanel.querySelector(".b3d-fps-value").textContent = _s.fps ? `${_s.fps} FPS` : _t("b3d.fpsAuto");
        fps.dataset.tooltip = _t("b3d.fpsTip");
        _rangePanel.querySelector(".b3d-fps-auto").dataset.tooltip = _t("b3d.fpsTip");
        fps.classList.toggle("b3d-fps-off", !_s.fps);
        if (_s.fps && document.activeElement !== fps) fps.value = String(_s.fps);
        _rangePanel.querySelector(".b3d-fps-auto").classList.toggle("active", !_s.fps);
        _place(RANGE_DRAG);
        _place(SMOKE_DRAG);
    }

    // --------------------------------------------------------- tactical devices

    let _tacPanel = null;
    const _emitterName = (m, i) => (m.kinds.length ? m.kinds.map(k => _t(`b3d.em.${k}`)).join(" + ") : _f("b3d.modeN", { n: i + 1 }));
    const _infraredOnly = (m) => {
        const emitters = m.kinds.filter(k => k !== "rangefinder");
        return emitters.length > 0 && emitters.every(k => k.startsWith("ir"));
    };

    // The device's name in our language: the installed item's short name from our build.
    function _deviceName(device) {
        let found = null;
        const walk = (node) => {
            for (const child of Object.values(node?.children || {})) {
                if (found) return;
                if (child.item?.id === device.tpl) { found = child.item; return; }
                walk(child);
            }
        };
        walk(EFTForge.state.buildTree);
        return found?.short_name || found?.name || device.label;
    }

    function _hoverDevice(id) {
        _send("markPart", id || null);
        if (_s.mode === "orbit") _send("highlight", id || null, "#f5c542");
    }

    function _renderTactical() {
        if (!_root) return;
        const devices = _s.devices || [];
        if (!_tacPanel) { _tacPanel = el("div.b3d-panel.b3d-tactical"); _makeDraggable(TACTICAL_DRAG); _root.append(_tacPanel); }
        _tacPanel.hidden = !devices.length;
        _tacPanel.classList.toggle("sight", _s.mode === "sight");
        _tacPanel.classList.toggle("collapsed", _s.tacticalCollapsed);
        _tacPanel.replaceChildren();
        if (!devices.length) return;
        _fillTactical(devices);
        _place(TACTICAL_DRAG);
        _place(SMOKE_DRAG);
    }

    function _fillTactical(devices) {
        const lit = devices.filter(d => d.on).length;
        const fold = el("button.b3d-chip.b3d-fold", {
            text: _s.tacticalCollapsed ? "▾" : "▴", tip: _t(_s.tacticalCollapsed ? "b3d.showDevices" : "b3d.hideDevices"),
            onclick: () => {
                _s.tacticalCollapsed = !_s.tacticalCollapsed;
                _write(TACTICAL_FOLD_KEY, _s.tacticalCollapsed ? "1" : "0");
                _hoverDevice(null);
                _renderTactical();
            },
        });
        const allOff = el("button.b3d-chip", { text: _t("b3d.allOff"),
            onclick: () => { for (const d of devices) if (d.on) _send("setTactical", d.id, { on: false }); } });
        allOff.disabled = !lit;
        _tacPanel.append(el("div.b3d-panel-head", {}, [
            el("span.b3d-mini-title", { text: _t("b3d.tactical") }),
            el(`span.b3d-tac-count${lit ? ".lit" : ""}`, { text: _f("b3d.devicesOn", { on: lit, total: devices.length }) }),
            allOff, fold,
        ]));
        if (_s.tacticalCollapsed) return;
        // Several of one device: number them; hovering a row shows which is which.
        const names = devices.map(_deviceName);
        const total = new Map(), seen = new Map();
        for (const n of names) total.set(n, (total.get(n) || 0) + 1);
        const list = el("div.b3d-tac-list");
        devices.forEach((device, idx) => {
            const name = names[idx];
            const nth = (seen.get(name) || 0) + 1;
            seen.set(name, nth);
            const top = el("div.b3d-tac-top", {}, [
                el("span.b3d-tac-name", { text: total.get(name) > 1 ? `${name} #${nth}` : name }),
            ]);
            if (device.modes.length > 1) {
                // A mode button selects that mode and switches the device on.
                top.append(el("div.b3d-tac-modes", {}, device.modes.map((m, i) => {
                    const b = el("button.b3d-chip", { text: String(i + 1),
                        tip: _emitterName(m, i) + (_infraredOnly(m) ? _t("b3d.irTip") : ""),
                        onclick: () => _send("setTactical", device.id, { mode: i, on: true }) });
                    b.classList.toggle("active", i === device.mode);
                    b.classList.toggle("lit", device.on && i === device.mode);
                    b.classList.toggle("ir", _infraredOnly(m));
                    return b;
                })));
            }
            const power = el("button.b3d-chip.b3d-power", { text: _t(device.on ? "b3d.on" : "b3d.off"),
                "aria-pressed": String(device.on), onclick: () => _send("setTactical", device.id, { on: !device.on }) });
            power.classList.toggle("active", device.on);
            top.append(power);
            const current = device.modes[device.mode];
            const row = el(`div.b3d-tac-device${device.on ? ".powered" : ""}`, {
                onmouseenter: () => _hoverDevice(device.id), onmouseleave: () => _hoverDevice(null),
            }, [top, el("div.b3d-tac-mode", { text: current ? _emitterName(current, device.mode) + (_infraredOnly(current) ? " · IR" : "") : "" })]);
            list.append(row);
        });
        _tacPanel.append(list);
        // The viewer drops shadows and cookies past the GPU's texture limit; say so
        // rather than leave the dimmer beams unexplained.
        if (devices.some(d => d.on && d.limited)) _tacPanel.append(el("div.b3d-tac-note", { text: _t("b3d.lightsLimited") }));
    }

    // --------------------------------------------------------- muzzle smoke

    // Cover in cm²·s: the area of fully opaque smoke it amounts to, times how long it hangs.
    const _cover = (m2s) => { const v = m2s * 1e4; return v < 10 ? v.toFixed(1) : String(Math.round(v)); };
    const _span = ([a, b]) => (a === b ? String(a) : `${a}-${b}`);

    let _smokePanel = null;

    // Paint one of the viewer's smoke maps: white where smoke hung, on the map's own fixed
    // scale so two builds compare at a glance. Side on we mark the bore and the muzzle,
    // from the eye the aim point and the reticle circle the aim stat counts.
    function _smokeMap(map, kind, width, tint = [255, 255, 255]) {
        const cols = map.cols || map.size, rows = map.rows || map.size;
        const height = Math.round(width * rows / cols);
        const cells = document.createElement("canvas");
        cells.width = cols;
        cells.height = rows;
        const cx = cells.getContext("2d"), img = cx.createImageData(cols, rows);
        map.data.forEach((v, i) => img.data.set([...tint, Math.round(255 * Math.sqrt(Math.min(1, v / map.scale)))], i * 4));
        cx.putImageData(img, 0, 0);
        const dpr = window.devicePixelRatio || 1;
        const canvas = el("canvas.b3d-smoke-map", { width: String(width * dpr), height: String(height * dpr),
            style: `width: ${width}px; height: ${height}px` });
        const g = canvas.getContext("2d");
        g.scale(dpr, dpr);
        g.fillStyle = "#0b0b0b";
        g.fillRect(0, 0, width, height);
        g.imageSmoothingEnabled = true;
        g.drawImage(cells, 0, 0, width, height);
        g.strokeStyle = "#f5c542";
        g.lineWidth = 1;
        if (kind === "side") {
            const span = map.ahead[1] - map.ahead[0];
            const x = -map.ahead[0] / span * width, y = map.up[1] / (map.up[1] - map.up[0]) * height;
            g.setLineDash([3, 3]);
            g.beginPath(); g.moveTo(0, y); g.lineTo(width, y); g.stroke();
            g.setLineDash([]);
            g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x, y + 5); g.stroke();
            g.fillStyle = "#777";
            g.font = "10px Bender, Arial, sans-serif";
            // Metres on the smoke's map, quarter metres on the flame's shorter one.
            const step = map.ahead[1] > 2 ? 1 : 0.25;
            for (let m = step; m <= map.ahead[1] + 1e-6; m += step) {
                g.fillText(step < 1 ? `${Math.round(m * 100)} cm` : `${m} m`, x + m / span * width - 10, height - 3);
            }
        } else {
            const r = Math.tan(map.aimRadius * Math.PI / 180) / Math.tan(map.halfAngle * Math.PI / 180) * width / 2;
            g.beginPath(); g.arc(width / 2, height / 2, r, 0, Math.PI * 2); g.stroke();
            g.beginPath();
            g.moveTo(width / 2 - 3, height / 2); g.lineTo(width / 2 + 3, height / 2);
            g.moveTo(width / 2, height / 2 - 3); g.lineTo(width / 2, height / 2 + 3);
            g.stroke();
        }
        return canvas;
    }

    // The sight bar's switch for the panel: lit while it shows, gone for a build with no smoke.
    function _renderSmokeButton() {
        const btn = _sightBar?.querySelector(".b3d-smoke-btn");
        if (!btn) return;
        btn.hidden = !_s.smoke;
        btn.textContent = _t("b3d.smoke");
        btn.dataset.tooltip = _t(_s.smokeShown ? "b3d.hideSmokePanel" : "b3d.showSmokePanel");
        btn.classList.toggle("active", _s.smokeShown);
    }
    function _holdSmoke(on) {
        if (on === _s.smokeHeld) return;
        _s.smokeHeld = on;
        _send("setSmokeFiring", on);
        _smokePanel?.querySelector(".b3d-smoke-hold")?.classList.toggle("active", on);
    }

    function _renderSmoke() {
        if (!_root) return;
        const st = _s.smoke;
        if (!_smokePanel) { _smokePanel = el("div.b3d-panel.b3d-smoke"); _makeDraggable(SMOKE_DRAG); _root.append(_smokePanel); }
        _renderSmokeButton();
        _smokePanel.hidden = !st || _s.mode !== "sight" || !_s.smokeShown;
        _smokePanel.classList.toggle("collapsed", _s.smokeCollapsed);
        _smokePanel.replaceChildren();
        if (_smokePanel.hidden) return;
        const fold = el("button.b3d-chip.b3d-fold", {
            text: _s.smokeCollapsed ? "▾" : "▴", tip: _t(_s.smokeCollapsed ? "b3d.showSmoke" : "b3d.hideSmoke"),
            onclick: () => {
                _s.smokeCollapsed = !_s.smokeCollapsed;
                _write(SMOKE_FOLD_KEY, _s.smokeCollapsed ? "1" : "0");
                _renderSmoke();
            },
        });
        // We hold the trigger only while the button is pressed.
        const hold = el("button.b3d-chip.b3d-smoke-hold", { text: _t("b3d.smokeHold"), tip: _t("b3d.smokeHoldTip") });
        hold.classList.toggle("active", _s.smokeHeld);
        hold.addEventListener("pointerdown", (e) => { hold.setPointerCapture(e.pointerId); _holdSmoke(true); });
        hold.addEventListener("pointerup", () => _holdSmoke(false));
        hold.addEventListener("pointercancel", () => _holdSmoke(false));
        _smokePanel.append(
            el("div.b3d-panel-head", {}, [
                el("span.b3d-mini-title", { text: _t("b3d.smoke") }),
                el("span.b3d-smoke-rpm", { text: `${st.rpm} RPM` }),
                fold,
            ]),
            el("div.b3d-chip-row.b3d-smoke-fire", {}, [
                el("button.b3d-chip", { text: _t("b3d.smokeShot"), tip: _t("b3d.smokeShotTip"),
                    onclick: () => _send("fireSmoke", { shots: 1 }) }),
                el("button.b3d-chip", { text: _f("b3d.smokeBurst", { n: SMOKE_BURST }), tip: _f("b3d.smokeBurstTip", { n: SMOKE_BURST }),
                    onclick: () => _send("fireSmoke", { shots: SMOKE_BURST }) }),
                hold,
                el("button.b3d-chip", { text: _t("b3d.smokeClear"), tip: _t("b3d.smokeClearTip"),
                    onclick: () => _send("clearSmoke") }),
            ]),
            // We let the user look at the smoke or the flash alone; both keep running while hidden.
            el("div.b3d-chip-row.b3d-smoke-show", {}, [
                el("span.b3d-smoke-show-label", { text: _t("b3d.muzzleShow") }),
                ...[["smoke", "b3d.muzzleShowSmoke"], ["flash", "b3d.muzzleShowFlash"]].map(([key, label]) => {
                    const b = el("button.b3d-chip", { text: _t(label), "aria-pressed": String(_s.muzzleShow[key]),
                        onclick: () => {
                            const next = { ..._s.muzzleShow, [key]: !_s.muzzleShow[key] };
                            if (!next.smoke && !next.flash) return; // we keep the last one on
                            _s.muzzleShow = next;
                            _write(MUZZLE_SHOW_KEY, JSON.stringify(_s.muzzleShow));
                            _send("setMuzzleEffects", _s.muzzleShow);
                            _renderSmoke();
                        } });
                    b.classList.toggle("active", _s.muzzleShow[key]);
                    return b;
                }),
            ]),
        );
        if (!_s.smokeCollapsed) {
            const fl = st.flash; // an older viewer sends no flash
            // One section at a time: with both shown we let tabs pick it, otherwise the one that shows.
            const both = _s.muzzleShow.smoke && _s.muzzleShow.flash && !!fl;
            const tab = both ? _s.smokeTab : _s.muzzleShow.smoke || !fl ? "smoke" : "flash";
            if (both) {
                _smokePanel.append(el("div.b3d-chip-row.b3d-smoke-tabs", {}, [["smoke", "b3d.tabSmoke"], ["flash", "b3d.tabFlash"]].map(([key, label]) => {
                    const b = el("button.b3d-chip", { text: _t(label), onclick: () => {
                        _s.smokeTab = key;
                        _write(SMOKE_TAB_KEY, key);
                        _renderSmoke();
                    } });
                    b.classList.toggle("active", tab === key);
                    return b;
                })));
            }
            const rows = el("div.b3d-smoke-rows");
            const row = (key, value, sub) => {
                rows.append(el("div.b3d-smoke-row", {}, [el("span.b3d-smoke-k", { text: key }), el("span.b3d-smoke-v", { text: value })]));
                if (sub) rows.append(el("div.b3d-smoke-sub", { text: sub }));
            };
            const mapPair = (head, pair, sideKey, eyeKey, tint) => {
                rows.append(el("div.b3d-smoke-maps-head", { text: head }));
                rows.append(el("div.b3d-smoke-maps", {}, [
                    el("figure", {}, [_smokeMap(pair.side, "side", 168, tint), el("figcaption", { text: _t(sideKey) })]),
                    el("figure", {}, [_smokeMap(pair.eye, "eye", 96, tint), el("figcaption", { text: _t(eyeKey) })]),
                ]));
            };
            if (tab === "smoke") {
                const one = st.perShot, all = st.cover;
                row(_t("b3d.smokePerShot"), `${_cover(one.total)} cm²·s`,
                    _f("b3d.smokeSplitShot", { m: _cover(one.muzzle), p: _cover(one.port) }));
                row(_f("b3d.smokeBurstTotal", { n: st.shots }), `${_cover(all.total)} cm²·s`,
                    _f("b3d.smokeSplitBurst", { m: _cover(all.muzzle), p: _cover(all.port), t: _cover(all.trail), s: st.duration.toFixed(1) }));
                row(_t("b3d.smokePuffs"), st.puffsPerShot.muzzle.toFixed(1),
                    st.puffs.filter(q => !q.port).map(q => `${_span(q.count)} × ${q.size.toFixed(1)} m, ${+q.lifetime.toFixed(2)} s`).join(" · "));
                if (st.puffsPerShot.port) row(_t("b3d.smokePortPuffs"), st.puffsPerShot.port.toFixed(1));
                if (st.trail) {
                    row(_t("b3d.smokeTrail"), _f("b3d.smokeTrailAfter", { n: st.trail.shotsToStart }),
                        _f("b3d.smokeTrailHangs", { s: st.trail.time.toFixed(1) }));
                } else row(_t("b3d.smokeTrail"), _t("b3d.smokeNone"));
                if (st.droppedPuffs > 0) row(_t("b3d.smokeDropped"), st.droppedPuffs.toFixed(1), _t("b3d.smokeDroppedTip"));
                // Where it goes: an older viewer sends no placement.
                if (st.aim && st.maps) {
                    row(_f("b3d.smokeAim", { deg: st.aim.radius }), _f("b3d.smokeAimPeak", { pct: Math.round(st.aim.peak * 100) }),
                        _f("b3d.smokeAimTotal", { pct: Math.round(st.aim.total * 100) }));
                    row(_t("b3d.smokeWithin"), `${st.medianAhead.toFixed(2)} m`, _t("b3d.smokeWithinSub"));
                    mapPair(_f("b3d.smokeMapsHead", { n: st.shots }), st.maps, "b3d.smokeMapSide", "b3d.smokeMapEye");
                }
                _smokePanel.append(rows, el("div.b3d-smoke-note", { text: _t("b3d.smokeNote") }));
            } else {
                row(_t("b3d.flashPerShot"), fl.jets ? `${(fl.exposure * 1e4).toFixed(2)} cm²·s` : _t("b3d.smokeNone"),
                    fl.jets ? _f("b3d.flashSub", { jets: fl.jets, pct: Math.round(fl.chance * 100), n: fl.quads.toFixed(1),
                        area: Math.round(fl.area * 1e4) }) : "");
                row(_t("b3d.flashSparks"), fl.sparksPerShot.toFixed(1));
                row(_t("b3d.flashHaze"), fl.haze.toFixed(2));
                row(_t("b3d.flashLight"), _t(fl.light ? "b3d.flashLightOn" : "b3d.smokeNone"), fl.light ? _t("b3d.flashLightSub") : "");
                if (fl.maps) {
                    row(_f("b3d.flashAim", { deg: st.aim.radius }), `${(fl.aim * 100).toFixed(3)} %·s`, _t("b3d.flashAimSub"));
                    row(_t("b3d.flashAhead"), `${Math.round(fl.meanAhead * 100)} cm`, _t("b3d.flashAheadSub"));
                    mapPair(_t("b3d.flashMapsHead"), fl.maps, "b3d.flashMapSide", "b3d.flashMapEye", [255, 170, 90]);
                }
                _smokePanel.append(rows, el("div.b3d-smoke-note", { text: _t("b3d.flashNote") }));
            }
        }
        _place(SMOKE_DRAG);
    }

    // Left where the stylesheet has it, the panel goes in the right column: above the range
    // panel and below the tactical devices, scrolling when the room between them runs short.
    function _placeSmokeDefault() {
        const H = _root.clientHeight, st = _smokePanel.style;
        const range = _rangePanel && !_rangePanel.hidden ? _rangePanel : null;
        const tac = _tacPanel && !_tacPanel.hidden ? _tacPanel : null;
        const bottom = range ? H - range.offsetTop + PANEL_MARGIN : 60;
        const top = tac ? tac.offsetTop + tac.offsetHeight + PANEL_MARGIN : 96;
        st.bottom = bottom + "px";
        st.maxHeight = Math.max(80, H - bottom - top) + "px";
    }

    // --------------------------------------------------------- dragged panels

    // The tactical devices, the ADS panel and the range panel drag like the stats dock.
    // Each remembers where it was left (a fraction of the view) under its storage key, by
    // spot: the tactical panel keeps one per view mode, since the sight view gives it a
    // default place of its own. A double-click puts a panel back where the stylesheet has it.
    const TACTICAL_DRAG = { key: TACTICAL_POS_KEY, panel: () => _tacPanel, spot: () => (_s.mode === "sight" ? "sight" : "orbit") };
    const ADS_DRAG = { key: ADS_POS_KEY, panel: () => _adsPanel, spot: () => "sight" };
    const RANGE_DRAG = { key: RANGE_POS_KEY, panel: () => _rangePanel, spot: () => "sight" };
    const SMOKE_DRAG = { key: SMOKE_POS_KEY, panel: () => _smokePanel, spot: () => "sight", place: () => _placeSmokeDefault() };
    // The smoke panel last: its own place depends on the others'.
    const DRAGGED = [TACTICAL_DRAG, ADS_DRAG, RANGE_DRAG, SMOKE_DRAG];

    function _positions(d) {
        if (!d.saved) { try { d.saved = JSON.parse(_read(d.key)) || {}; } catch { d.saved = {}; } }
        return d.saved;
    }
    function _savePosition(d, pos) {
        const all = _positions(d);
        if (pos) all[d.spot()] = pos; else delete all[d.spot()];
        _write(d.key, JSON.stringify(all));
    }

    // Keep a dragged panel wholly inside the view; with no saved spot the stylesheet places it.
    function _place(d) {
        const panel = d.panel();
        if (!panel || !_root || panel.hidden) return;
        const pos = _positions(d)[d.spot()];
        const st = panel.style;
        if (!pos) {
            st.left = st.top = st.right = st.bottom = st.maxHeight = "";
            d.place?.();
            return;
        }
        const W = _root.clientWidth, H = _root.clientHeight;
        if (d.place) st.maxHeight = (H - 2 * PANEL_MARGIN) + "px";
        const w = panel.offsetWidth, h = panel.offsetHeight;
        st.left = Math.max(PANEL_MARGIN, Math.min(W - w - PANEL_MARGIN, pos[0] * W)) + "px";
        st.top = Math.max(PANEL_MARGIN, Math.min(H - h - PANEL_MARGIN, pos[1] * H)) + "px";
        st.right = st.bottom = "auto";
    }
    const _placeAll = () => DRAGGED.forEach(_place);

    // Presses on buttons, sliders and a scrollbar use the panel, not move it.
    function _startsDrag(e) {
        const t = e.target;
        if (!(t instanceof Element) || t.closest("button, input, select, a, [role=button]")) return false;
        if (t.scrollHeight > t.clientHeight && e.offsetX >= t.clientWidth) return false;
        return getComputedStyle(t).cursor !== "pointer";
    }

    let _drag = null;
    function _makeDraggable(d) {
        const panel = d.panel();
        panel.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || !_startsDrag(e)) return;
            _drag = { d, panel, x: e.clientX, y: e.clientY, left: panel.offsetLeft, top: panel.offsetTop, moved: false, id: e.pointerId };
        });
        panel.addEventListener("dblclick", (e) => {
            if (!_startsDrag(e)) return;
            _savePosition(d, null);
            _place(d);
        });
    }

    document.addEventListener("pointermove", (e) => {
        const g = _drag;
        if (!g || e.pointerId !== g.id || g.panel !== g.d.panel()) return;
        const dx = e.clientX - g.x, dy = e.clientY - g.y;
        if (!g.moved) {
            if (Math.hypot(dx, dy) < 4) return; // still a click
            g.moved = true;
            g.panel.setPointerCapture(e.pointerId);
            g.panel.classList.add("moving");
            window.getSelection()?.removeAllRanges();
        }
        _savePosition(g.d, [(g.left + dx) / _root.clientWidth, (g.top + dy) / _root.clientHeight]);
        _place(g.d);
        if (g.d !== SMOKE_DRAG) _place(SMOKE_DRAG);
    });
    const _endDrag = (e) => {
        const g = _drag;
        if (!g || e.pointerId !== g.id) return;
        _drag = null;
        if (g.panel.hasPointerCapture(e.pointerId)) g.panel.releasePointerCapture(e.pointerId);
        g.panel.classList.remove("moving");
        // Remember where the panel stopped, not where the pointer went past an edge.
        if (g.moved && g.panel === g.d.panel() && _root) {
            _savePosition(g.d, [g.panel.offsetLeft / _root.clientWidth, g.panel.offsetTop / _root.clientHeight]);
        }
    };
    document.addEventListener("pointerup", _endDrag);
    document.addEventListener("pointercancel", _endDrag);

    // --------------------------------------------------------- hidden UI

    // The sight picture with nothing of ours over it but the site's nav bar and footer, for
    // recording. A show button waits in the bottom right corner, fading out once the
    // pointer leaves that corner; Esc brings everything back too, rather than leaving the
    // sight picture (the viewer holds Esc for us meanwhile, setEscapeHeld).
    const UNHIDE_FADE_MS = 1800;
    let _uiHidden = false, _unhide = null, _unhideTimer = 0;

    function _buildUnhide() {
        const btn = el("button.b3d-btn.b3d-unhide-btn", { type: "button", onclick: () => setUiHidden(false) });
        _unhide = el("div.b3d-unhide", {}, [btn]);
        _unhide.addEventListener("pointerenter", () => _showUnhide(false));
        _unhide.addEventListener("pointermove", () => _showUnhide(false));
        _unhide.addEventListener("pointerleave", () => _showUnhide(true));
        _root.append(_unhide);
    }

    // Show the button now; fade: fade it out again after a while.
    function _showUnhide(fade) {
        if (!_unhide) return;
        clearTimeout(_unhideTimer);
        _unhide.classList.add("shown");
        if (fade) _unhideTimer = setTimeout(() => _unhide?.classList.remove("shown"), UNHIDE_FADE_MS);
    }

    function setUiHidden(on) {
        on = !!on && _s.mode === "sight";
        if (on === _uiHidden) return;
        _uiHidden = on;
        document.body.classList.toggle("b3d-ui-hidden", on);
        _send("setEscapeHeld", on);
        if (on && _s.diagOpen) _send("setAdsDiagnosticsPanel", false);
        if (_unhide) {
            _unhide.querySelector("button").textContent = `${_t("b3d.showUi")} (Esc)`;
            if (on) _showUnhide(true);
            else { clearTimeout(_unhideTimer); _unhide.classList.remove("shown"); }
        }
    }

    // --------------------------------------------------------- lifecycle

    function _renderAll() {
        _renderViewButtons();
        _renderSightBar();
        _renderAds();
        _renderRange();
        _renderTactical();
        _renderSmoke();
    }

    function mount(root, api) {
        _root = root;
        _api = api;
        _s.mode = "orbit";
        _s.sight = { mode: "orbit" };
        _s.hasSights = false;
        _s.ads = null;
        _s.devices = [];
        _s.smoke = null;
        _s.smokeHeld = false;
        _s.diagOpen = false;
        _s.diagRect = null;
        document.body.classList.remove("b3d-sight");
        _root.classList.add("b3d-waiting");
        _buildViewButtons();
        _buildSightBar();
        _buildAdsPanel();
        _buildRangePanel();
        _buildUnhide();
        _tacPanel = _smokePanel = null;
        _resizeObs = new ResizeObserver(_placeAll);
        _resizeObs.observe(_root);
        _renderAll();
    }

    function unmount() {
        _resizeObs?.disconnect();
        _resizeObs = null;
        document.body.classList.remove("b3d-sight", "b3d-ui-hidden");
        clearTimeout(_unhideTimer);
        _uiHidden = false;
        _unhide = null;
        _root = _api = null;
        _viewBtns = _sightBar = _fovNote = _adsPanel = _rangePanel = _tacPanel = _smokePanel = null;
    }

    async function onReady() {
        if (!_api) return;
        _root.classList.remove("b3d-waiting");
        _send("setSlotsHidden", _s.slotsHidden);
        _send("setSkills", { ..._savedSkills(), strength: EFTForge.state.currentStrengthLevel ?? 10 });
        _send("setMuzzleEffects", _s.muzzleShow);
        _send("setAdsFrameRate", _s.fps);
        try {
            const [range, display, ads, devices] = await Promise.all([
                _api.call("rangeState"), _api.call("displayState"), _api.call("adsState"), _api.call("tacticalState"),
            ]);
            Object.assign(_s, { range, display, ads, devices });
        } catch (err) {
            console.warn("[builder-3d] panel state:", err.message);
        }
        // An older viewer has no smoke: we leave the panel out rather than fail the rest.
        _s.smoke = await _api.call("smokeStats").catch(() => null);
        _renderAll();
    }

    function onEvent(name, data) {
        if (!_root) return;
        switch (name) {
            case "build":
                _s.hasSights = !!data.hasSights;
                _renderViewButtons();
                break;
            case "mode":
                _s.mode = data;
                document.body.classList.toggle("b3d-sight", data === "sight");
                if (data !== "sight") setUiHidden(false);
                if (data === "sight") _hoverDevice(null);
                else _holdSmoke(false);
                _renderAll();
                break;
            case "sight":
                _s.sight = data;
                _renderSightBar();
                break;
            case "zoom": _renderZoom(data); break;
            case "ads": _s.ads = data; _renderAds(); break;
            case "range": _s.range = data; _renderRange(); break;
            case "display": _s.display = data; _renderRange(); break;
            case "tactical": _s.devices = data || []; _renderTactical(); break;
            case "smoke": _s.smoke = data || null; _renderSmoke(); break;
            case "adsdiagnosticspanel": _s.diagOpen = !!data?.open; _renderAds(); break;
            case "adsdiagnosticsrect": _s.diagRect = data || null; break;
            case "slotshidden":
                _s.slotsHidden = !!data.hidden;
                _write(SLOTS_HIDDEN_KEY, _s.slotsHidden ? "1" : "0");
                _renderViewButtons();
                break;
            default: break;
        }
    }

    EFTForge.builder3dPanels = { mount, unmount, onReady, onEvent, render: _renderAll, setUiHidden,
        get uiHidden() { return _uiHidden; },
        diagnosticsRect: () => (_s.diagOpen ? _s.diagRect : null) };
})();
