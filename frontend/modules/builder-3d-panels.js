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
//   - muzzle smoke and flash (sight picture): what to show of them, and how much each shot makes
//   - recoil overview (sight picture): where each shot of the string being fired landed, and its statistics
// ============================================================

(function () {
    const SLOTS_HIDDEN_KEY = "eftforge_b3d_slots_hidden";
    const TACTICAL_FOLD_KEY = "eftforge_b3d_tactical_collapsed";
    const TACTICAL_POS_KEY = "eftforge_b3d_tactical_pos"; // {orbit: [fx, fy], sight: [fx, fy]}
    const ADS_POS_KEY = "eftforge_b3d_ads_pos";           // {sight: [fx, fy]}
    const RANGE_POS_KEY = "eftforge_b3d_range_pos";       // {sight: [fx, fy]}
    const SMOKE_POS_KEY = "eftforge_b3d_smoke_pos";       // {sight: [fx, fy]}
    const OVERVIEW_POS_KEY = "eftforge_b3d_overview_pos"; // {sight: [fx, fy]}
    const BINDINGS_KEY = "eftforge_b3d_key_bindings";     // {action: binding}: the range's key bindings
    const FOV_KEY = "eftforge_b3d_fov";                   // the game's FOV setting, 50 to 75
    const ADS_DEFAULT_KEY = "eftforge_b3d_ads_default";   // "0": the sight picture starts on the fixed eye; else in the ADS simulation
    const OVERVIEW_KEY = "eftforge_b3d_overview";         // {on, pause}: the recoil overview, and the pause that ends a string, seconds
    const OVERVIEW_PAUSES = [0.5, 1, 3];
    const OVERVIEW_PLOT = 240;                            // the plot's side, CSS pixels
    const OVERVIEW_COLOR = "#ff3df2";                     // the plot's impacts
    const SMOKE_SHOWN_KEY = "eftforge_b3d_smoke_shown";
    const MUZZLE_SHOW_KEY = "eftforge_b3d_muzzle_show"; // {smoke, flash}: which the viewer draws
    const SMOKE_TAB_KEY = "eftforge_b3d_smoke_tab";       // "smoke" or "flash": the stats shown while both draw
    const FPS_KEY = "eftforge_b3d_game_fps";             // the game frame rate the overswing follows; 0 follows the display
    const FPS_MIN = 30, FPS_MAX = 360;
    const FIRE_MODES = ["single", "burst", "fullauto"];   // the viewer's fire modes; a weapon has some of them
    const STANCES = ["stand", "crouch", "prone"];         // the viewer's stances: recoil, sway, arm stamina and eye height follow them
    const SKILLS_KEY = "eftforge_b3d_skills";             // {weaponSkills: {skill id: level}, aimDrills, endurance}; Strength is the stats panel's
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
    // storage is not ours). Strength stays in the stats panel's key, the one level both share,
    // and the weapon skill is the current weapon's own, which the stats panel picks.
    function _savedSkills() {
        let saved = {};
        try { saved = JSON.parse(_read(SKILLS_KEY)) || {}; } catch { /* keep the defaults */ }
        const skills = {};
        for (const [key] of SKILLS) {
            const v = Number(saved[key]);
            if (key !== "strength" && key !== "weapon" && Number.isFinite(v)) skills[key] = Math.max(0, Math.min(ELITE, Math.round(v)));
        }
        return { ...skills, ...EFTForge.statsPanel?.skillLevels() };
    }
    const _s = {
        mode: "orbit", hasSights: false, slotsHidden: _read(SLOTS_HIDDEN_KEY) === "1",
        fps: Math.min(FPS_MAX, Math.max(0, Math.round(Number(_read(FPS_KEY)) || 0))),
        sight: { mode: "orbit" }, zoom: null, ads: null, range: null, display: null, devices: [],
        tacticalCollapsed: _read(TACTICAL_FOLD_KEY) === "1",
        smoke: null, smokeCollapsed: false, // the stats fold away for a while, but open again with the panel
        smokeShown: _read(SMOKE_SHOWN_KEY) === "1", // the sight bar's smoke button; hidden until asked for
        smokeTab: _read(SMOKE_TAB_KEY) === "flash" ? "flash" : "smoke",
        // At least one stays on: a saved state with neither shows both.
        muzzleShow: (() => {
            let s = { smoke: true, flash: true };
            try { s = { ...s, ...JSON.parse(_read(MUZZLE_SHOW_KEY)) }; } catch { /* keep both */ }
            return s;
        })(),
        overview: null, // the viewer's recoil overview state; null with an older viewer
        keyBinds: null, // the viewer's key bindings ({action: binding}); null with an older viewer
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
            // The range's settings modal, while the ADS simulation runs.
            el("button.b3d-btn", { dataset: { act: "settings" }, onclick: () => _openSettings() }),
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
        const settings = /** @type {HTMLElement} */ (_viewBtns.querySelector('[data-act="settings"]'));
        settings.textContent = _t("b3d.settings");
        settings.dataset.tooltip = _t("b3d.settingsTip");
        settings.hidden = !(sight && _s.ads?.on);
        const hideUi = _viewBtns.querySelector('[data-act="hideui"]');
        hideUi.textContent = _t("b3d.hideUi");
        hideUi.hidden = !sight;
        const sightBtn = _viewBtns.querySelector('[data-act="sight"]');
        sightBtn.textContent = sight ? `${_t("b3d.exitSight")} (Esc)` : _withKey(_t("b3d.sight"), "range");
        sightBtn.hidden = !sight && !_s.hasSights;
        // The ADS simulation places the eye itself: nothing to reset.
        const reset = _viewBtns.querySelector('[data-act="reset"]');
        reset.textContent = _t("b3d.resetView");
        reset.hidden = !!(sight && _s.ads?.on);
    }

    // --------------------------------------------------------- sight bar

    let _sightBar = null;
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
            el("button.b3d-chip.b3d-ads-btn", { onclick: () => _send("setAdsSim", !_s.ads?.on) }),
            el("button.b3d-chip.b3d-smoke-btn", { onclick: () => {
                _s.smokeShown = !_s.smokeShown;
                _write(SMOKE_SHOWN_KEY, _s.smokeShown ? "1" : "0");
                if (_s.smokeShown) _s.smokeCollapsed = false;
                _renderSmoke();
            } }),
            el("button.b3d-chip.b3d-overview-btn", { onclick: () => _setOverview({ on: !_s.overview?.on }) }),
        ]);
        _root.append(_sightBar);
    }

    function _renderSightBar() {
        if (!_sightBar) return;
        const st = _s.sight;
        const on = st.mode === "sight";
        _sightBar.hidden = !on;
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
        if (st.zoom) _renderZoom(st.zoom);
        _renderAds();
        _renderSmokeButton();
        _renderOverviewButton();
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
        const skills = el("div.b3d-skills");
        for (const [key, label, tip] of SKILLS) {
            const input = el("input", { type: "range", min: "0", max: String(ELITE), step: "1", value: "0", dataset: { key, tipKey: tip } });
            input.addEventListener("input", () => {
                /** @type {Record<string, number>} */
                const next = {};
                for (const i of skills.querySelectorAll("input")) next[i.dataset.key] = Number(i.value);
                _send("setSkills", next);
                // The stats panel keeps them (the weapon level under this weapon's own skill), and
                // its skill sliders and skilled stats follow.
                EFTForge.statsPanel?.saveSkillLevels(next);
                EFTForge.statsPanel?.onSkillsChanged();
                // Strength is also our stats panel's Strength level: keep the two as one.
                if (key === "strength") EFTForge.statsPanel?.setStrengthLevel(next.strength);
            });
            skills.append(el("span.b3d-skill-name", { dataset: { key, label, tipKey: tip } }), input, el("span.b3d-skill-level", { dataset: { key } }));
        }
        // The panel keeps what changes while shooting; the rest is in the settings modal.
        _adsPanel = el("div.b3d-panel.b3d-adspanel", {}, [
            el("div.b3d-ads-head", {}, [el("span.b3d-ads-state")]),
            _pair("b3d.stance", "stance", "setStance", STANCES),
            _pair("b3d.fireMode", "fireMode", "setFireMode", FIRE_MODES),
            // Off, the weapon holds what its magazine takes and has to be reloaded (R).
            el("div.b3d-ads-row.b3d-ammo-row", {}, [
                el("span.b3d-ads-name", { dataset: { label: "b3d.infiniteAmmo" } }),
                ...["off", "on"].map(m => el("button.b3d-chip", { dataset: { infiniteAmmo: m }, onclick: () => _send("setInfiniteAmmo", m === "on") })),
                el("span.b3d-ammo-count"),
            ]),
            el("div.b3d-ads-row.b3d-anims", {}, [
                el("span.b3d-ads-name", { dataset: { label: "b3d.animations" } }),
                // The site's own dropdown (setupCustomSelect) over this hidden select, set up
                // once the panel is in the page. Picking plays; the first option says what plays.
                el("select.b3d-anim-select", { id: "b3d-anim-select", onchange: _onAnimationPicked }),
            ]),
            _poolRow("hands", "b3d.armStamina", "b3d.maxArmTip", "b3d.noDrainArmTip"),
            _poolRow("oxygen", "b3d.breath", "b3d.maxBreathTip", "b3d.noDrainBreathTip"),
            el("div.b3d-ads-facts"), // also in the settings modal, beside the skills that change it
        ]);
        const section = (labelKey, children) => el("div.modal-section", {}, [
            el("div.modal-label", { dataset: { label: labelKey } }), ...children]);
        _settings = el("div.modal-overlay.b3d-settings", { hidden: "" }, [
            el("div.modal-window", { role: "dialog", "aria-modal": "true", "aria-labelledby": "b3d-settings-title" }, [
                el("div.modal-header", {}, [
                    el("span.modal-title", { id: "b3d-settings-title", dataset: { label: "b3d.settingsTitle" } }),
                    el("button.modal-close-btn", { type: "button", text: "\u2715", onclick: () => _closeSettings() }),
                ]),
                // Two columns: the controls and their key bindings, then everything else.
                el("div.modal-body", {}, [el("div.b3d-settings-col", {}, [
                    section("b3d.setControls", [
                        _pair("b3d.aimKey", "aimMode", "setAimMode"),
                        _pair("b3d.breathKey", "breathMode", "setBreathMode"),
                        _sensRow("hip", "b3d.sensHip", "b3d.sensHipTip"),
                        _sensRow("aim", "b3d.sensAim", "b3d.sensAimTip"),
                        _sensRow("optic", "b3d.sensOptic", "b3d.sensOpticTip", 1),
                    ]),
                    _buildBindings(),
                ]), el("div.b3d-settings-col", {}, [
                    el("div.modal-section.b3d-display-section", {}, [
                        el("div.modal-label", { dataset: { label: "b3d.setDisplay" } }),
                        _fovRow(),
                        el("div.b3d-ads-row.b3d-ratio-row", {}, [
                            el("span.b3d-ads-name", { dataset: { label: "b3d.display" } }),
                            el("div.b3d-chip-row.b3d-ratios"),
                            el("span.b3d-monitor"),
                        ]),
                        _fpsRow(),
                    ]),
                    el("div.modal-section.b3d-sound-section", {}, [
                        el("div.modal-label", { dataset: { label: "b3d.sound" } }),
                        el("div.b3d-ads-row.b3d-sound-row", {}, [
                            ...["off", "on"].map(m => el("button.b3d-chip", { dataset: { sound: m }, onclick: () => _send("setSound", { on: m === "on" }) })),
                            _volumeSlider(),
                            el("span.b3d-volume-pct"),
                        ]),
                    ]),
                    section("b3d.skills", [skills]),
                    section("b3d.setHandling", [el("div.b3d-ads-facts")]),
                    section("b3d.diagnostics", [
                        el("button.b3d-chip.b3d-diag-btn", { dataset: { label: "b3d.diagnostics", tipKey: "b3d.diagnosticsTip" },
                            onclick: () => {
                                // The dock opens in the view, which the modal would cover.
                                _send("setAdsDiagnosticsPanel", !_s.diagOpen, _diagSpace());
                                _closeSettings();
                            } }),
                    ]),
                ])]),
            ]),
        ]);
        _settings.addEventListener("click", (e) => { if (e.target === _settings) _closeSettings(); });
        _makeDraggable(ADS_DRAG);
        _root.append(_adsPanel);
        document.body.append(_settings);
        setupCustomSelect("b3d-anim-select");
    }

    // --------------------------------------------------------- key bindings

    // The range's inputs, rebindable in the settings modal. The viewer keeps the rules
    // (Kitbash! viewer/bindings.js, TarkTetris's own): a binding is one input, or a held key
    // and a second input joined by "+" ("KeyT+KeyB", "Control+MouseButton2"), keys as
    // KeyboardEvent.code with left and right modifiers as one. We keep our own copy, so it
    // survives a viewer on another origin, and send it with every new frame.
    const BIND_ACTIONS = ["fire", "aim", "holdBreath", "reload", "crouch", "prone", "range", "scopeMode", "adsSim",
        "tactical", "tacticalMode"];
    const BIND_MODIFIERS = { ControlLeft: "Control", ControlRight: "Control", AltLeft: "Alt", AltRight: "Alt",
        ShiftLeft: "Shift", ShiftRight: "Shift" };
    const keyCode = (code) => BIND_MODIFIERS[code] ?? code;
    const _mouseCode = (button) => (Number.isSafeInteger(button) && button >= 0 ? `MouseButton${button}` : null);

    const BIND_PUNCTUATION = { Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
        Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", IntlBackslash: "\\" };
    const BIND_NUMPAD = { Add: "+", Subtract: "-", Multiply: "*", Divide: "/", Decimal: ".", Enter: "Enter", Equal: "=" };
    const BIND_LABELS = { Control: "Ctrl", Alt: "Alt", Shift: "Shift", ArrowUp: "Up", ArrowDown: "Down",
        PageUp: "PgUp", PageDown: "PgDn", CapsLock: "Caps", ContextMenu: "Menu", Backspace: "Backspace" };

    function _inputLabel(code) {
        if (code.startsWith("MouseButton")) {
            const n = Number(code.slice(11));
            return n <= 2 ? _t(["b3d.key.lmb", "b3d.key.mmb", "b3d.key.rmb"][n]) : _f("b3d.key.mouse", { n: n + 1 });
        }
        if (code === "Space") return _t("b3d.key.space");
        if (code.startsWith("Key")) return code.slice(3);
        if (code.startsWith("Digit")) return code.slice(5);
        if (code.startsWith("Numpad")) return `Num ${BIND_NUMPAD[code.slice(6)] ?? code.slice(6)}`;
        return BIND_PUNCTUATION[code] ?? BIND_LABELS[code] ?? code;
    }
    // What a binding reads as: "R", "Alt", "Shift + LMB"; null (unbound) as nothing.
    function keyLabel(binding) { return binding ? binding.split("+").map(_inputLabel).join(" + ") : ""; }

    function _savedBindings() {
        try { return JSON.parse(_read(BINDINGS_KEY)) || null; } catch { return null; }
    }

    // Every input some binding uses, the held key of a pair too: the builder forwards these
    // to the viewer while our page has the keys.
    function boundCodes() {
        const set = new Set();
        for (const b of Object.values(_s.keyBinds || {})) for (const part of (b || "").split("+")) if (part) set.add(part);
        return set;
    }

    let _waiting = null; // the action waiting for its new input
    let _pending = null; // a key pressed while waiting: bound alone on its release, or the held one of a pair
    const _bindHeld = []; // the keys held while waiting, oldest first (modifiers merged)

    function _heldOthers(e, code) {
        for (const [m, down] of [["Control", e.ctrlKey], ["Alt", e.altKey], ["Shift", e.shiftKey]]) {
            const i = _bindHeld.indexOf(m);
            if (!down && i >= 0) _bindHeld.splice(i, 1);
            else if (down && i < 0) _bindHeld.push(m);
        }
        return _bindHeld.filter(k => k !== code).reverse();
    }

    function _startBinding(action) {
        _waiting = action;
        _pending = null;
        _bindHeld.length = 0;
        _moved = false;
        _bindHint(null);
        _renderBindings();
    }

    function _stopBinding() {
        _waiting = _pending = null;
        _bindHeld.length = 0;
        _renderBindings();
    }

    let _moved = false; // the hint says a binding moved, until the next one starts
    function _bindHint(key, vars) {
        const hint = _settings?.querySelector(".b3d-bind-hint");
        if (!hint) return;
        _moved = key === "b3d.bindMoved";
        hint.textContent = key ? _f(key, vars || {}) : _t("b3d.bindHint");
        hint.classList.toggle("bad", key === "b3d.bindReserved");
        hint.classList.toggle("moved", _moved);
    }

    async function _bind(code) {
        const action = _waiting;
        _pending = null;
        if (!action || !code) return;
        const res = await _api?.call("setKeyBinding", action, code).catch(() => null);
        if (!res) return;
        if (!res.ok) {
            // Still waiting: the user can press another input.
            _bindHint("b3d.bindReserved");
            return;
        }
        _s.keyBinds = res.bindings;
        _write(BINDINGS_KEY, JSON.stringify(res.bindings));
        _boundAt = performance.now();
        _stopBinding();
        // The input came from another action: say so under the list until the next binding.
        if (res.unbound) {
            _bindHint("b3d.bindMoved", { key: keyLabel(code), from: _t("b3d.bind." + res.unbound), to: _t("b3d.bind." + action) });
        }
        _renderBindKeys();
    }

    async function _resetBindings() {
        const res = await _api?.call("setKeyBindings", null).catch(() => null);
        if (!res) return;
        _s.keyBinds = res.bindings;
        _write(BINDINGS_KEY, JSON.stringify(res.bindings));
        _stopBinding();
        _renderBindKeys();
    }

    // While waiting, the next input is the binding: a key alone binds on its release (so it
    // can still become the held key of a pair), a second input while one is held binds the
    // pair, a mouse button binds at once. Esc cancels. All of it before anything else hears it.
    window.addEventListener("keydown", (e) => {
        if (!_waiting) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.code === "Escape") { _stopBinding(); return; }
        const code = keyCode(e.code);
        if (e.repeat || e.metaKey || code === _pending) return;
        const [first] = _heldOthers(e, code);
        if (!_bindHeld.includes(code)) _bindHeld.push(code);
        if (first) _bind(`${first}+${code}`);
        else _pending = code;
    }, true);
    window.addEventListener("keyup", (e) => {
        if (!_waiting) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const code = keyCode(e.code);
        const i = _bindHeld.indexOf(code);
        if (i >= 0) _bindHeld.splice(i, 1);
        if (_pending === code) _bind(code);
    }, true);
    window.addEventListener("mousedown", (e) => {
        if (!_waiting || e.metaKey) return;
        const code = _mouseCode(e.button);
        const [first] = _heldOthers(e, code);
        // A plain click on a control (another binding, the close button) is a click: it
        // gives up waiting instead of binding the button. Anywhere else it binds.
        const target = /** @type {Element} */ (e.target);
        if (!first && (e.button === 0 || e.button === 2) && target.closest?.("button, input, select, a")) {
            _stopBinding();
            return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        _bind(first ? `${first}+${code}` : code);
    }, true);
    // The press that bound a button must not also click what is under it.
    for (const type of ["mouseup", "click", "auxclick", "contextmenu"]) {
        window.addEventListener(type, (e) => {
            if (!_waiting && !_justBound(e)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
        }, true);
    }
    let _boundAt = 0;
    function _justBound(e) { return e.timeStamp - _boundAt < 400; }
    window.addEventListener("blur", () => { if (_waiting) _stopBinding(); });

    function _buildBindings() {
        return el("div.modal-section.b3d-bind-section", {}, [
            el("div.modal-label", { dataset: { label: "b3d.bindings" } }),
            el("div.b3d-bind-list", {}, BIND_ACTIONS.map(action => el("div.b3d-ads-row.b3d-bind-row", {}, [
                el("span.b3d-ads-name", { dataset: { label: "b3d.bind." + action } }),
                el("button.b3d-chip.b3d-bind-key", { type: "button", dataset: { bind: action }, onclick: () => {
                    if (_waiting === action) _stopBinding(); else _startBinding(action);
                } }),
            ]))),
            el("div.b3d-bind-hint"),
            el("button.b3d-chip.b3d-bind-reset", { type: "button", dataset: { label: "b3d.bindReset" }, onclick: () => _resetBindings() }),
        ]);
    }

    function _renderBindings() {
        const sec = _settings?.querySelector(".b3d-bind-section");
        if (!sec) return;
        /** @type {HTMLElement} */ (sec).hidden = !_s.keyBinds;
        for (const b of /** @type {NodeListOf<HTMLElement>} */ (sec.querySelectorAll("[data-bind]"))) {
            const waiting = _waiting === b.dataset.bind;
            const bound = _s.keyBinds?.[b.dataset.bind];
            b.textContent = waiting ? _t("b3d.bindPrompt") : bound ? keyLabel(bound) : _t("b3d.bindNone");
            b.classList.toggle("active", waiting);
            b.classList.toggle("unbound", !bound && !waiting);
        }
        if (!_waiting && !_moved) _bindHint(null);
    }

    // The keys our buttons name, which follow the bindings.
    function _renderBindKeys() {
        _renderViewButtons();
        _renderAds();
        _renderBindings();
    }

    // A button's text with its key after it, while that key is bound.
    function _withKey(text, action) {
        const b = _s.keyBinds?.[action];
        return b ? `${text} (${keyLabel(b)})` : text;
    }

    // --------------------------------------------------------- settings modal

    let _settings = null;

    // Esc closes the modal, before the builder's own Esc (which would leave the range).
    function _settingsKey(e) {
        if (e.key !== "Escape" || _waiting) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        _closeSettings();
    }

    function _openSettings() {
        if (!_settings || !_settings.hidden) return;
        _settings.hidden = false;
        window.addEventListener("keydown", _settingsKey, true);
        _renderAds();
        _renderDisplay();
        _renderBindings();
    }

    function _closeSettings() {
        if (!_settings || _settings.hidden) return;
        if (_waiting) _stopBinding();
        _settings.hidden = true;
        window.removeEventListener("keydown", _settingsKey, true);
    }

    // A mouse sensitivity setting as the stats panel's Strength level is drawn: a slider
    // and a number box, kept together. The viewer takes the value once it is let go.
    // min: the game's lowest (the smooth zoom sensitivity starts at 1).
    function _sensRow(key, labelKey, tipKey, min = 0.1) {
        const slider = el("input", { type: "range", min: String(min), max: "5", step: "0.01", value: String(Math.max(min, 0.5)), dataset: { sensSlider: key } });
        const box = el("input", { type: "number", min: String(min), max: "5", step: "0.01", value: String(Math.max(min, 0.5)), dataset: { sens: key } });
        const send = (v) => {
            const n = Math.min(5, Math.max(min, Number(v)));
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

    // The game's FOV setting, as the stats panel's Strength level is drawn: a slider and a
    // number box, whole degrees. The viewer takes it once it is let go.
    function _fovRow() {
        const slider = el("input", { type: "range", min: "50", max: "75", step: "1", value: "50", dataset: { fovSlider: "" } });
        const box = el("input", { type: "number", min: "50", max: "75", step: "1", value: "50", dataset: { fov: "" } });
        const send = (v) => {
            const n = Math.round(Math.min(75, Math.max(50, Number(v))));
            if (!Number.isFinite(n)) return;
            slider.value = box.value = String(n);
            _write(FOV_KEY, String(n));
            _send("setFieldOfView", n);
        };
        slider.addEventListener("input", () => { box.value = slider.value; });
        slider.addEventListener("change", () => send(slider.value));
        box.addEventListener("change", () => send(box.value));
        return el("div.b3d-ads-row.b3d-sens-row.b3d-fov-row", { dataset: { tipKey: "b3d.fovTip" } }, [
            el("span.b3d-ads-name", { dataset: { label: "b3d.fov" } }),
            el("div.strength-input-row", {}, [slider, box]),
        ]);
    }

    // The sound's volume, sent as it is dragged, its percentage following it.
    function _volumeSlider() {
        const slider = el("input.b3d-volume", { type: "range", min: "0", max: "1", step: "0.01", value: "0.5" });
        slider.addEventListener("input", () => {
            _send("setSound", { volume: Number(slider.value) });
            _showVolume(slider);
        });
        return slider;
    }
    function _showVolume(slider) {
        const pct = /** @type {HTMLElement | null} */ (slider.parentElement?.querySelector(".b3d-volume-pct"));
        if (pct) pct.textContent = `${Math.round(Number(slider.value) * 100)}%`;
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
            btn.textContent = _withKey(_t(st?.on ? "b3d.fixedEye" : "b3d.simAds"), "adsSim");
            btn.dataset.tooltip = _t(st?.on ? "b3d.fixedEyeTip" : "b3d.simAdsTip");
            // Repaint the tooltip if it is showing, so a click swaps it under the pointer.
            EFTForge.tooltip?.refresh(btn);
        }
        _renderViewButtons();
        if (!_adsPanel) return;
        const show = !!st?.on && _s.mode === "sight";
        _adsPanel.hidden = !show;
        if (!show) { _closeSettings(); return; }
        // The panel and the settings modal, drawn as one.
        const $ = (sel) => _adsPanel.querySelector(sel) || _settings.querySelector(sel);
        const $$ = (sel) => /** @type {HTMLElement[]} */ ([..._adsPanel.querySelectorAll(sel), ..._settings.querySelectorAll(sel)]);
        for (const n of $$("[data-label]")) n.textContent = _t(n.dataset.label);
        for (const n of $$("[data-tip-key]")) n.dataset.tooltip = _t(n.dataset.tipKey);
        $(".b3d-diag-btn").classList.toggle("active", _s.diagOpen);
        const state = _adsPanel.querySelector(".b3d-ads-state");
        state.textContent = _t(st.aiming ? (st.holdingBreath ? "b3d.adsHolding" : "b3d.adsAiming") : "b3d.adsHip");
        state.classList.toggle("aiming", !!st.aiming);
        for (const b of $$("[data-aim-mode]")) {
            b.textContent = _t(b.dataset.aimMode === "toggle" ? "b3d.toggle" : "b3d.hold");
            b.classList.toggle("active", b.dataset.aimMode === st.aimMode);
        }
        for (const b of $$("[data-breath-mode]")) {
            b.textContent = _t(b.dataset.breathMode === "toggle" ? "b3d.toggle" : "b3d.hold");
            b.classList.toggle("active", b.dataset.breathMode === st.breathMode);
        }
        // An older viewer has no stances: we hide the row until it reports one.
        for (const b of /** @type {NodeListOf<HTMLElement>} */ (_adsPanel.querySelectorAll("[data-stance]"))) {
            b.textContent = _t("b3d.stance." + b.dataset.stance);
            b.classList.toggle("active", b.dataset.stance === st.stance);
            b.dataset.tooltip = _t("b3d.stanceTip");
            /** @type {HTMLElement} */ (b.parentElement).hidden = !st.stance;
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
        // The FOV row shares their look but not their setting (it is drawn below).
        for (const row of $$(".b3d-sens-row:not(.b3d-fov-row)")) {
            row.dataset.tooltip = _t(row.dataset.tipKey);
            const box = /** @type {HTMLInputElement} */ (row.querySelector("[data-sens]"));
            const slider = /** @type {HTMLInputElement} */ (row.querySelector("[data-sens-slider]"));
            const v = st.lookSensitivity?.[box.dataset.sens];
            // Leave them alone while they are being used.
            if (v !== undefined && document.activeElement !== box && document.activeElement !== slider) {
                box.value = slider.value = String(v);
            }
        }
        for (const b of /** @type {NodeListOf<HTMLElement>} */ (_adsPanel.querySelectorAll("[data-infinite-ammo]"))) {
            b.textContent = _t(b.dataset.infiniteAmmo === "on" ? "b3d.on" : "b3d.off");
            b.classList.toggle("active", (b.dataset.infiniteAmmo === "on") === !!st.ammo?.infinite);
            b.dataset.tooltip = _t("b3d.infiniteAmmoTip");
        }
        // The rounds left: in the magazine, plus those chambered.
        const count = /** @type {HTMLElement} */ (_adsPanel.querySelector(".b3d-ammo-count"));
        const am = st.ammo;
        count.hidden = !am?.counting;
        if (am?.counting) {
            count.textContent = am.chambers ? `${am.mag}+${am.chamber} / ${am.capacity}` : `${am.mag} / ${am.capacity}`;
            count.classList.toggle("empty", am.mag + am.chamber === 0);
            count.dataset.tooltip = _t("b3d.ammoCountTip");
        }
        /** @type {HTMLElement} */ ($(".b3d-sound-section")).hidden = !st.sound;
        for (const b of $$("[data-sound]")) {
            b.textContent = _t(b.dataset.sound === "on" ? "b3d.on" : "b3d.off");
            b.classList.toggle("active", (b.dataset.sound === "on") === !!st.sound?.on);
            b.dataset.tooltip = _t(st.sound?.available === false ? "b3d.soundNoneTip" : "b3d.soundTip");
        }
        const vol = /** @type {HTMLInputElement} */ ($(".b3d-volume"));
        vol.disabled = !st.sound?.on;
        if (st.sound && document.activeElement !== vol) vol.value = String(st.sound.volume);
        _showVolume(vol);
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
        const facts = _f("b3d.facts", {
            ergo: st.totalErgonomics.toFixed(1), speed: st.aimingSpeed.toFixed(2),
            overswing: Math.round(st.overswingStrength * 100), hip: Math.round((st.hipPenalty ?? 1) * 100),
        }) + (st.aimingDevice ? _t("b3d.factsDevice") : "");
        for (const n of $$(".b3d-ads-facts")) n.textContent = facts;
        // The weapon skill's name: the stats panel's, from the weapon's item class as the game picks
        // it (assault carbines level Assault Rifles), else the viewer's weapon class.
        const wcKey = st.weaponClass ? `b3d.wc.${st.weaponClass}` : null;
        const wc = EFTForge.statsPanel?.weaponSkillName() || (wcKey && _t(wcKey) !== wcKey ? _t(wcKey) : null);
        for (const name of $$(".b3d-skill-name")) {
            if (name.dataset.key === "weapon" && wc) name.textContent = wc;
        }
        for (const input of /** @type {HTMLInputElement[]} */ ($$(".b3d-skills input"))) {
            const v = st.skills?.[input.dataset.key] ?? 0;
            if (document.activeElement !== input) input.value = String(v);
            const lv = $(`.b3d-skill-level[data-key="${input.dataset.key}"]`);
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
        ]);
        _makeDraggable(RANGE_DRAG);
        _root.append(_rangePanel);
    }

    function _setFps(v) {
        _s.fps = v;
        _write(FPS_KEY, String(v));
        _send("setAdsFrameRate", v);
        _renderDisplay();
    }

    // The game frame rate the aim-in kick follows: the game adds it once a frame, so the
    // overswing grows with the frame rate. Match Display follows ours.
    function _fpsRow() {
        const fps = el("input.b3d-fps-slider", { type: "range", min: String(FPS_MIN), max: String(FPS_MAX), step: "1", value: "144" });
        fps.addEventListener("input", () => _setFps(Number(fps.value)));
        return el("div.b3d-ads-row.b3d-fps-row", {}, [
            el("span.b3d-ads-name", { dataset: { label: "b3d.gameFps" } }),
            fps,
            el("span.b3d-fps-value"),
            el("button.b3d-chip.b3d-fps-auto", { dataset: { label: "b3d.fpsAuto" }, onclick: () => _setFps(0) }),
        ]);
    }

    // The settings modal's Display section: the FOV, the aspect ratio and the game FPS.
    function _renderDisplay() {
        if (!_settings) return;
        const sec = _settings.querySelector(".b3d-display-section");
        for (const n of /** @type {NodeListOf<HTMLElement>} */ (sec.querySelectorAll("[data-label]"))) n.textContent = _t(n.dataset.label);
        const d = _s.display;
        // An older viewer has no FOV setting: its row stays hidden.
        const fovRow = /** @type {HTMLElement} */ (sec.querySelector(".b3d-fov-row"));
        fovRow.hidden = d?.fov === undefined;
        if (d?.fov !== undefined) {
            fovRow.dataset.tooltip = _t("b3d.fovTip");
            const fb = /** @type {HTMLInputElement} */ (fovRow.querySelector("[data-fov]"));
            const fs = /** @type {HTMLInputElement} */ (fovRow.querySelector("[data-fov-slider]"));
            if (document.activeElement !== fb && document.activeElement !== fs) fb.value = fs.value = String(d.fov);
        }
        const ratioRow = /** @type {HTMLElement} */ (sec.querySelector(".b3d-ratio-row"));
        ratioRow.hidden = !d;
        if (d) {
            ratioRow.querySelector(".b3d-monitor").textContent = `${d.monitor.width}x${d.monitor.height}`;
            ratioRow.querySelector(".b3d-ratios").replaceChildren(...d.aspectRatios.map(r => el("button.b3d-chip", {
                text: r, onclick: () => _send("setAspectRatio", r),
            })));
            for (const b of ratioRow.querySelectorAll(".b3d-ratios button")) b.classList.toggle("active", b.textContent === d.aspectRatio);
        }
        const fps = /** @type {HTMLInputElement} */ (sec.querySelector(".b3d-fps-slider"));
        sec.querySelector(".b3d-fps-value").textContent = _s.fps ? `${_s.fps} FPS` : _t("b3d.fpsAuto");
        /** @type {HTMLElement} */ (sec.querySelector(".b3d-fps-row")).dataset.tooltip = _t("b3d.fpsTip");
        fps.classList.toggle("b3d-fps-off", !_s.fps);
        if (_s.fps && document.activeElement !== fps) fps.value = String(_s.fps);
        sec.querySelector(".b3d-fps-auto").classList.toggle("active", !_s.fps);
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
        _renderDisplay();
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
        // Shots only come from the ADS simulation, so the smoke and flash are its business.
        btn.hidden = !_s.smoke || !_s.ads?.on;
        btn.textContent = _t("b3d.smoke");
        btn.dataset.tooltip = _t(_s.smokeShown ? "b3d.hideSmokePanel" : "b3d.showSmokePanel");
        btn.classList.toggle("active", _s.smokeShown);
    }

    function _renderSmoke() {
        if (!_root) return;
        const st = _s.smoke;
        if (!_smokePanel) { _smokePanel = el("div.b3d-panel.b3d-smoke"); _makeDraggable(SMOKE_DRAG); _root.append(_smokePanel); }
        _renderSmokeButton();
        _smokePanel.hidden = !st || _s.mode !== "sight" || !_s.smokeShown || !_s.ads?.on;
        _smokePanel.classList.toggle("collapsed", _s.smokeCollapsed);
        _smokePanel.replaceChildren();
        if (_smokePanel.hidden) return;
        const fold = el("button.b3d-chip.b3d-fold", {
            text: _s.smokeCollapsed ? "▾" : "▴", tip: _t(_s.smokeCollapsed ? "b3d.showSmoke" : "b3d.hideSmoke"),
            onclick: () => {
                _s.smokeCollapsed = !_s.smokeCollapsed;
                _renderSmoke();
            },
        });
        _smokePanel.append(
            el("div.b3d-panel-head", {}, [
                el("span.b3d-mini-title", { text: _t("b3d.smoke") }),
                el("span.b3d-smoke-rpm", { text: `${st.rpm} RPM` }),
                fold,
            ]),
            // Shots come from the ADS simulation's trigger; here we only clear what they left.
            el("div.b3d-chip-row.b3d-smoke-fire", {}, [
                el("button.b3d-chip", { text: _t("b3d.smokeClear"), tip: _t("b3d.smokeClearTip"),
                    onclick: () => _send("clearSmoke") }),
            ]),
            // We let the user look at the smoke or the flash alone, or at neither (real shooting
            // without the effects); both keep running while hidden.
            el("div.b3d-chip-row.b3d-smoke-show", {}, [
                el("span.b3d-smoke-show-label", { text: _t("b3d.muzzleShow") }),
                ...[["smoke", "b3d.muzzleShowSmoke"], ["flash", "b3d.muzzleShowFlash"]].map(([key, label]) => {
                    const b = el("button.b3d-chip", { text: _t(label), "aria-pressed": String(_s.muzzleShow[key]),
                        onclick: () => {
                            const next = { ..._s.muzzleShow, [key]: !_s.muzzleShow[key] };
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
        // With neither drawn there is nothing to show stats for.
        if (!_s.smokeCollapsed && (_s.muzzleShow.smoke || _s.muzzleShow.flash)) {
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

    // --------------------------------------------------------- recoil overview

    // The viewer keeps the shots of the string being fired, and clears the range's bullet
    // holes with each new string; we plot them and work out the statistics. Our own copy of the switch and the pause
    // goes to the viewer with every new frame, since its storage is not ours.
    let _overviewPanel = null;

    function _savedOverview() {
        let saved = {};
        try { saved = JSON.parse(_read(OVERVIEW_KEY)) || {}; } catch { /* keep the defaults */ }
        return { on: saved.on === true, pause: OVERVIEW_PAUSES.includes(saved.pause) ? saved.pause : OVERVIEW_PAUSES[0] };
    }

    function _setOverview(change) {
        const next = { ..._savedOverview(), ...change };
        _write(OVERVIEW_KEY, JSON.stringify(next));
        _send("setRecoilOverview", next);
    }

    function _renderOverviewButton() {
        const btn = /** @type {HTMLElement | null} */ (_sightBar?.querySelector(".b3d-overview-btn"));
        if (!btn) return;
        btn.hidden = !_s.overview || !_s.ads?.on;
        btn.textContent = _t("b3d.overview");
        btn.dataset.tooltip = _t(_s.overview?.on ? "b3d.hideOverview" : "b3d.showOverview");
        btn.classList.toggle("active", !!_s.overview?.on);
    }

    // Centimetres up to a metre, metres past it.
    const _len = (m) => (Math.abs(m) < 1 ? `${(m * 100).toFixed(1)} cm` : `${m.toFixed(2)} m`);

    // What the string's shots say: how many landed on the paper, how far apart the furthest
    // two are, how far they sit from their own center on average, the box they fill and
    // where that center is from the aiming point. Lengths in metres on the target's plane.
    function _overviewStats(st) {
        const shots = st.shots, n = shots.length;
        if (!n) return null;
        const cx = shots.reduce((a, s) => a + s.x, 0) / n, cy = shots.reduce((a, s) => a + s.y, 0) / n;
        let spread = 0;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) spread = Math.max(spread, Math.hypot(shots[i].x - shots[j].x, shots[i].y - shots[j].y));
        }
        const xs = shots.map(s => s.x), ys = shots.map(s => s.y);
        return {
            n, cx, cy, spread,
            onPaper: shots.filter(s => s.surface === "soft").length,
            seconds: shots[n - 1].t / 1000,
            moa: Math.atan2(spread, st.distance) * 180 / Math.PI * 60,
            meanRadius: shots.reduce((a, s) => a + Math.hypot(s.x - cx, s.y - cy), 0) / n,
            width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
        };
    }

    // The plot: the target's plane seen from the firing line, scaled to hold the string and
    // the aiming point, with the paper and its rings drawn to that scale wherever they fall.
    function _drawOverview(canvas, st, stats) {
        const S = OVERVIEW_PLOT, dpr = Math.min(3, window.devicePixelRatio || 1);
        if (canvas.width !== S * dpr) canvas.width = canvas.height = S * dpr;
        const g = canvas.getContext("2d");
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.fillStyle = "#101010";
        g.fillRect(0, 0, S, S);
        const xs = [0, ...st.shots.map(s => s.x)], ys = [0, ...st.shots.map(s => s.y)];
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        // At least 4 mrad across, so a tight group is not blown up to fill the plot.
        const span = Math.max(Math.max(x1 - x0, y1 - y0) * 1.25, st.distance * 0.004);
        const k = S / span, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        const X = (x) => S / 2 + (x - mx) * k, Y = (y) => S / 2 - (y - my) * k;
        const tg = st.target;
        if (tg) {
            // The board hangs with its aiming point on ours.
            g.fillStyle = "rgba(233, 226, 207, 0.1)";
            g.fillRect(X(-tg.width / 2), Y(tg.height / 2 - tg.aimY), tg.width * k, tg.height * k);
            g.strokeStyle = "#4a4a4a";
            g.lineWidth = 1;
            for (const [rx, ry] of tg.rings || []) {
                g.beginPath();
                g.ellipse(X(0), Y(0), rx * k, ry * k, 0, 0, Math.PI * 2);
                g.stroke();
            }
        }
        // The aiming point.
        g.strokeStyle = "#777";
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(X(0), 0); g.lineTo(X(0), S);
        g.moveTo(0, Y(0)); g.lineTo(S, Y(0));
        g.stroke();
        // The shots in firing order, then each one: filled on the paper, hollow off it.
        g.strokeStyle = "rgba(255, 61, 242, 0.35)";
        g.beginPath();
        st.shots.forEach((s, i) => (i ? g.lineTo(X(s.x), Y(s.y)) : g.moveTo(X(s.x), Y(s.y))));
        g.stroke();
        g.fillStyle = g.strokeStyle = OVERVIEW_COLOR;
        g.lineWidth = 1.5;
        for (const s of st.shots) {
            g.beginPath();
            g.arc(X(s.x), Y(s.y), 3, 0, Math.PI * 2);
            if (s.surface === "soft" || !tg) g.fill(); else g.stroke();
        }
        if (stats) {
            // The first shot, where the string started.
            g.strokeStyle = "#fff";
            g.beginPath();
            g.arc(X(st.shots[0].x), Y(st.shots[0].y), 5.5, 0, Math.PI * 2);
            g.stroke();
            // The group's center.
            g.strokeStyle = "#f5c542";
            g.beginPath();
            g.moveTo(X(stats.cx) - 6, Y(stats.cy)); g.lineTo(X(stats.cx) + 6, Y(stats.cy));
            g.moveTo(X(stats.cx), Y(stats.cy) - 6); g.lineTo(X(stats.cx), Y(stats.cy) + 6);
            g.stroke();
        }
        // A scale bar: the longest round length that fits a third of the plot.
        const pow = 10 ** Math.floor(Math.log10(span / 3)), bar = [5, 2, 1].map(m => m * pow).find(m => m <= span / 3);
        g.strokeStyle = g.fillStyle = "#aaa";
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(8, S - 12); g.lineTo(8, S - 8); g.lineTo(8 + bar * k, S - 8); g.lineTo(8 + bar * k, S - 12);
        g.stroke();
        g.font = "10px Bender, Arial, sans-serif";
        g.fillText(bar < 0.01 ? `${+(bar * 1000).toPrecision(1)} mm` : bar < 1 ? `${+(bar * 100).toPrecision(1)} cm` : `${+bar.toPrecision(1)} m`, 8, S - 16);
    }

    function _buildOverviewPanel() {
        _overviewPanel = el("div.b3d-panel.b3d-overview", {}, [
            el("div.b3d-panel-head", {}, [el("span.b3d-mini-title"), el("span.b3d-overview-dist")]),
            el("canvas.b3d-overview-plot"),
            el("div.b3d-overview-empty"),
            el("div.b3d-smoke-rows"),
            el("div.b3d-chip-row.b3d-overview-pause", {}, [
                el("span.b3d-smoke-show-label"),
                ...OVERVIEW_PAUSES.map(p => el("button.b3d-chip", { text: `${p} s`, dataset: { pause: String(p) }, onclick: () => _setOverview({ pause: p }) })),
            ]),
            el("div.b3d-smoke-note"),
        ]);
        _makeDraggable(OVERVIEW_DRAG);
        _root.append(_overviewPanel);
    }

    function _renderOverview() {
        if (!_root) return;
        if (!_overviewPanel) _buildOverviewPanel();
        _renderOverviewButton();
        const st = _s.overview;
        _overviewPanel.hidden = !st?.on || _s.mode !== "sight" || !_s.ads?.on;
        if (_overviewPanel.hidden) return;
        const stats = _overviewStats(st);
        _overviewPanel.querySelector(".b3d-mini-title").textContent = _t("b3d.overview");
        _overviewPanel.querySelector(".b3d-overview-dist").textContent = `${Math.round(st.distance)} m`;
        _drawOverview(/** @type {HTMLCanvasElement} */ (_overviewPanel.querySelector(".b3d-overview-plot")), st, stats);
        const empty = /** @type {HTMLElement} */ (_overviewPanel.querySelector(".b3d-overview-empty"));
        empty.hidden = !!stats;
        empty.textContent = _t("b3d.ovEmpty");
        const rows = /** @type {HTMLElement} */ (_overviewPanel.querySelector(".b3d-smoke-rows"));
        rows.hidden = !stats;
        rows.replaceChildren();
        if (stats) {
            const row = (key, value) => rows.append(el("div.b3d-smoke-row", {}, [
                el("span.b3d-smoke-k", { text: _t(key) }), el("span.b3d-smoke-v", { text: value })]));
            const arrow = (v, plus, minus) => `${v >= 0 ? plus : minus} ${_len(Math.abs(v))}`;
            row("b3d.ovShots", stats.n > 1 ? `${stats.n} · ${stats.seconds.toFixed(2)} s` : "1");
            if (st.target) row("b3d.ovOnPaper", `${stats.onPaper} / ${stats.n} (${Math.round(stats.onPaper / stats.n * 100)}%)`);
            row("b3d.ovSpread", stats.n > 1 ? `${_len(stats.spread)} · ${stats.moa.toFixed(1)} MOA` : "-");
            row("b3d.ovMeanRadius", stats.n > 1 ? _len(stats.meanRadius) : "-");
            row("b3d.ovSize", stats.n > 1 ? `${_len(stats.height)} × ${_len(stats.width)}` : "-");
            row("b3d.ovCenter", `${arrow(stats.cy, "↑", "↓")} · ${arrow(stats.cx, "→", "←")}`);
        }
        const pause = /** @type {HTMLElement} */ (_overviewPanel.querySelector(".b3d-overview-pause"));
        pause.querySelector("span").textContent = _t("b3d.ovPause");
        pause.dataset.tooltip = _t("b3d.ovPauseTip");
        for (const b of /** @type {NodeListOf<HTMLElement>} */ (pause.querySelectorAll("[data-pause]"))) {
            b.classList.toggle("active", Number(b.dataset.pause) === st.pause);
        }
        _overviewPanel.querySelector(".b3d-smoke-note").textContent = _t("b3d.ovNote");
        _place(OVERVIEW_DRAG);
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
    const OVERVIEW_DRAG = { key: OVERVIEW_POS_KEY, panel: () => _overviewPanel, spot: () => "sight" };
    // The smoke panel last: its own place depends on the others'.
    const DRAGGED = [TACTICAL_DRAG, ADS_DRAG, RANGE_DRAG, OVERVIEW_DRAG, SMOKE_DRAG];

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

    // --------------------------------------------------------- stacking

    // The floating windows (our panels and the stats dock) share one stack: a press on one
    // brings it to the front, where it stays until another is pressed. The viewer's own
    // diagnostics dock is drawn inside the frame, so it stays under all of them.
    const FLOATING = ".b3d-panel, #b3d-stats-dock";
    const STACK_BASE = 10; // over the windows nobody has pressed yet, under the top left controls
    let _stack = []; // the pressed windows, the last pressed last
    document.addEventListener("pointerdown", (e) => {
        if (!_root || !(e.target instanceof Element)) return;
        const win = /** @type {HTMLElement | null} */ (e.target.closest(FLOATING));
        if (!win || _stack[_stack.length - 1] === win) return;
        _stack = _stack.filter(w => w !== win && w.isConnected);
        _stack.push(win);
        _stack.forEach((w, i) => { w.style.zIndex = String(STACK_BASE + i); });
    }, true);

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
        _renderOverview();
    }

    function mount(root, api) {
        _root = root;
        _api = api;
        _stack = [];
        _s.mode = "orbit";
        _s.sight = { mode: "orbit" };
        _s.hasSights = false;
        _s.ads = null;
        _s.devices = [];
        _s.smoke = null;
        _s.overview = null;
        _s.diagOpen = false;
        _s.diagRect = null;
        document.body.classList.remove("b3d-sight");
        _root.classList.add("b3d-waiting");
        _buildViewButtons();
        _buildSightBar();
        _buildAdsPanel();
        _buildRangePanel();
        _buildUnhide();
        _tacPanel = _smokePanel = _overviewPanel = null;
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
        _closeSettings();
        _settings?.remove();
        _settings = null;
        _viewBtns = _sightBar = _adsPanel = _rangePanel = _tacPanel = _smokePanel = _overviewPanel = null;
    }

    async function onReady() {
        if (!_api) return;
        _root.classList.remove("b3d-waiting");
        _send("setSlotsHidden", _s.slotsHidden);
        _send("setSkills", { ..._savedSkills(), strength: EFTForge.state.currentStrengthLevel ?? 10 });
        _send("setMuzzleEffects", _s.muzzleShow);
        _send("setAdsDefault", _read(ADS_DEFAULT_KEY) !== "0");
        _send("setMouseLook", true); // always on: there is no switch for it any more
        // Our own copy of the FOV setting, which the viewer's storage may not keep.
        if (_read(FOV_KEY)) _send("setFieldOfView", Number(_read(FOV_KEY)));
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
        // Nor a recoil overview: its button stays hidden then.
        _s.overview = await _api.call("setRecoilOverview", _savedOverview()).catch(() => null);
        // Nor key bindings: the section stays hidden and the buttons name no key.
        _s.keyBinds = (await _api.call("setKeyBindings", _savedBindings()).catch(() => null))?.bindings || null;
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
                _renderAll();
                break;
            case "sight":
                _s.sight = data;
                _renderSightBar();
                break;
            case "zoom": _renderZoom(data); break;
            case "ads": {
                // The smoke and the overview only show in the simulation.
                const was = _s.ads?.on;
                _s.ads = data;
                _renderAds();
                if (was !== data?.on) { _renderSmoke(); _renderOverview(); }
                // Our own copy of how the sight picture starts, set by the user's switch.
                if (typeof data?.byDefault === "boolean") _write(ADS_DEFAULT_KEY, data.byDefault ? "1" : "0");
                break;
            }
            case "range": _s.range = data; _renderRange(); break;
            case "display": _s.display = data; _renderRange(); break;
            case "tactical": _s.devices = data || []; _renderTactical(); break;
            case "smoke": _s.smoke = data || null; _renderSmoke(); break;
            case "recoiloverview": _s.overview = data || null; _renderOverview(); break;
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

    EFTForge.builder3dPanels = { mount, unmount, onReady, onEvent, render: _renderAll, setUiHidden, keyCode, boundCodes,
        get uiHidden() { return _uiHidden; },
        diagnosticsRect: () => (_s.diagOpen ? _s.diagRect : null) };
})();
