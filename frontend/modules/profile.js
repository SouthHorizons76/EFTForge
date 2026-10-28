window.EFTForge = window.EFTForge || {};

const _PROFILE_KEY = "eftforge_user_profile";
const _AVATAR_MAX_BYTES = 2 * 1024 * 1024;
// Allowlist: Unicode letters, Unicode digits, space, hyphen, underscore, period
const _INVALID_USERNAME_RE = /[^\p{L}\p{N} \-_.]/gu;

function getProfile() {
    try {
        const raw = localStorage.getItem(_PROFILE_KEY);
        if (!raw) return { username: "", avatar_url: "" };
        const p = JSON.parse(raw);
        return { username: p.username || "", avatar_url: p.avatar_url || "" };
    } catch {
        return { username: "", avatar_url: "" };
    }
}

function setProfile(data) {
    localStorage.setItem(_PROFILE_KEY, JSON.stringify({
        username:   (data.username  || "").trim().slice(0, 30),
        avatar_url: data.avatar_url || "",
    }));
}

// Returns username or null (when user is anonymous)
function getDisplayName() {
    return getProfile().username || null;
}

// Returns avatar_url or null
function getAvatarUrl() {
    return getProfile().avatar_url || null;
}

// -------------------------------------------------------
// Avatar crop modal
// -------------------------------------------------------

function _showAvatarCropModal(file, onConfirm, onCancel) {
    const reader = new FileReader();
    reader.onerror = () => onCancel();
    reader.onload  = e => {
        const dataUrl = /** @type {string} */ (e.target.result);
        const img = new Image();
        img.onload  = () => _buildCropModal(img, onConfirm, onCancel);
        img.onerror = () => onCancel();
        img.src = dataUrl;
    };
    reader.readAsDataURL(file);
}

function _buildCropModal(img, onConfirm, onCancel) {
    if (document.getElementById("avatar-crop-overlay")) return;

    const t = EFTForge.lang.t;

    const CANVAS_SIZE = Math.min(320, window.innerWidth - 56);
    const CIRCLE_R    = Math.floor(CANVAS_SIZE * 0.42);
    const MIN_SCALE   = Math.max((CIRCLE_R * 2) / img.naturalWidth, (CIRCLE_R * 2) / img.naturalHeight);

    let scale = MIN_SCALE;
    let ox = CANVAS_SIZE / 2 - (img.naturalWidth  * scale) / 2;
    let oy = CANVAS_SIZE / 2 - (img.naturalHeight * scale) / 2;

    const overlay = _createModalOverlay("avatar-crop-overlay", t("profile.cropTitle"), {
        maxWidth: `min(${CANVAS_SIZE + 40}px, 95vw)`,
    });
    if (!overlay) { onCancel(); return; }
    overlay.style.zIndex = "1100";

    const body = document.getElementById("avatar-crop-overlay-body");
    body.innerHTML = `
        <div style="position:relative;width:${CANVAS_SIZE}px;height:${CANVAS_SIZE}px;
                    overflow:hidden;cursor:grab;touch-action:none;border-radius:4px;align-self:center;">
            <canvas id="avatar-crop-canvas" width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" style="display:block;"></canvas>
            <div style="
                position:absolute;
                width:${CIRCLE_R * 2}px;height:${CIRCLE_R * 2}px;border-radius:50%;
                top:50%;left:50%;transform:translate(-50%,-50%);
                box-shadow:0 0 0 2000px rgba(0,0,0,0.6);
                border:2px solid rgba(255,255,255,0.22);
                pointer-events:none;
            "></div>
        </div>
        <div style="font-size:11px;color:#666;text-align:center;">${escapeHtml(t("profile.cropHint"))}</div>
        <div class="modal-row" style="justify-content:flex-end;">
            <button id="avatar-crop-cancel"  class="modal-btn">${escapeHtml(t("profile.cancel"))}</button>
            <button id="avatar-crop-confirm" class="modal-btn primary">${escapeHtml(t("profile.cropConfirm"))}</button>
        </div>
    `;

    const canvas = /** @type {HTMLCanvasElement | null} */ (document.getElementById("avatar-crop-canvas"));
    const ctx    = canvas.getContext("2d");

    function draw() {
        ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
        ctx.drawImage(img, ox, oy, img.naturalWidth * scale, img.naturalHeight * scale);
    }

    function clamp() {
        const iw = img.naturalWidth  * scale;
        const ih = img.naturalHeight * scale;
        const cx = CANVAS_SIZE / 2;
        const cy = CANVAS_SIZE / 2;
        ox = Math.min(cx - CIRCLE_R, Math.max(cx + CIRCLE_R - iw, ox));
        oy = Math.min(cy - CIRCLE_R, Math.max(cy + CIRCLE_R - ih, oy));
    }

    draw();

    // --- pan ---
    let dragging = false, lastX = 0, lastY = 0;

    canvas.addEventListener("mousedown", e => {
        dragging = true;
        lastX = e.clientX; lastY = e.clientY;
        canvas.style.cursor = "grabbing";
    });

    function onMouseMove(e) {
        if (!dragging) return;
        ox += e.clientX - lastX;
        oy += e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        clamp(); draw();
    }
    function onMouseUp() {
        dragging = false;
        canvas.style.cursor = "grab";
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup",   onMouseUp);

    // --- scroll zoom ---
    canvas.addEventListener("wheel", e => {
        e.preventDefault();
        const factor   = e.deltaY < 0 ? 1.08 : 1 / 1.08;
        const newScale = Math.max(MIN_SCALE, Math.min(scale * factor, MIN_SCALE * 10));
        const cx = CANVAS_SIZE / 2, cy = CANVAS_SIZE / 2;
        ox = cx - (cx - ox) * (newScale / scale);
        oy = cy - (cy - oy) * (newScale / scale);
        scale = newScale;
        clamp(); draw();
    }, { passive: false });

    // --- pinch zoom + touch pan ---
    let lastTouches = [];

    canvas.addEventListener("touchstart", e => {
        e.preventDefault();
        lastTouches = [...e.touches];
    }, { passive: false });

    canvas.addEventListener("touchmove", e => {
        e.preventDefault();
        const touches = [...e.touches];
        if (touches.length === 1 && lastTouches.length >= 1) {
            ox += touches[0].clientX - lastTouches[0].clientX;
            oy += touches[0].clientY - lastTouches[0].clientY;
        } else if (touches.length === 2 && lastTouches.length === 2) {
            const prevDist = Math.hypot(
                lastTouches[0].clientX - lastTouches[1].clientX,
                lastTouches[0].clientY - lastTouches[1].clientY,
            );
            const newDist = Math.hypot(
                touches[0].clientX - touches[1].clientX,
                touches[0].clientY - touches[1].clientY,
            );
            const factor   = newDist / prevDist;
            const newScale = Math.max(MIN_SCALE, Math.min(scale * factor, MIN_SCALE * 10));
            const cx = CANVAS_SIZE / 2, cy = CANVAS_SIZE / 2;
            ox = cx - (cx - ox) * (newScale / scale);
            oy = cy - (cy - oy) * (newScale / scale);
            scale = newScale;
        }
        lastTouches = touches;
        clamp(); draw();
    }, { passive: false });

    canvas.addEventListener("touchend", e => { lastTouches = [...e.touches]; }, { passive: false });

    function cleanup() {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup",   onMouseUp);
        overlay.remove();
    }

    // Factory wires X-btn and backdrop to overlay.remove() - extend both to also cleanup
    document.getElementById("avatar-crop-overlay-close").addEventListener("click", () => { cleanup(); onCancel(); });
    let _mdOnBackdrop = false;
    overlay.addEventListener("mousedown", e => { _mdOnBackdrop = e.target === overlay; });
    overlay.addEventListener("click", e => { if (e.target === overlay && _mdOnBackdrop) { cleanup(); onCancel(); } });

    document.getElementById("avatar-crop-cancel").addEventListener("click", () => {
        cleanup();
        onCancel();
    });

    document.getElementById("avatar-crop-confirm").addEventListener("click", () => {
        const diameter = CIRCLE_R * 2;
        const srcX    = (CANVAS_SIZE / 2 - CIRCLE_R - ox) / scale;
        const srcY    = (CANVAS_SIZE / 2 - CIRCLE_R - oy) / scale;
        const srcSize = diameter / scale;

        const out  = document.createElement("canvas");
        out.width  = diameter;
        out.height = diameter;
        out.getContext("2d").drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, diameter, diameter);

        out.toBlob(blob => {
            cleanup();
            onConfirm(new File([blob], "avatar.jpg", { type: "image/jpeg" }));
        }, "image/jpeg", 0.92);
    });
}

// -------------------------------------------------------
// Profile modal
// -------------------------------------------------------

function showProfileModal() {
    if (blockedInBeta()) return;
    const t = EFTForge.lang.t;
    const overlay = _createModalOverlay("profile-modal-overlay", t("profile.title"), { maxWidth: "500px" });
    if (!overlay) return;

    if (!localStorage.getItem("eftforge_profile_seen")) {
        localStorage.setItem("eftforge_profile_seen", "1");
        const profileBtn = document.getElementById("profile-nav-btn");
        if (profileBtn) profileBtn.dataset.badge = "";
    }

    const profile = getProfile();
    const defaultAvatar = "./assets/images/tarkovcitizen.jpg";
    const avatarSrc = proxyAvatarUrl(profile.avatar_url) || defaultAvatar;

    const body = document.getElementById("profile-modal-overlay-body");
    body.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;">
            <div id="profile-avatar-wrap" style="position:relative;cursor:pointer;">
                <img id="profile-avatar-preview"
                     src="${escapeHtml(avatarSrc)}"
                     onerror="this.src='${defaultAvatar}'"
                     style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:2px solid #444;background:#2a2a2a;display:block;" />
                <div style="
                    position:absolute;inset:0;border-radius:50%;
                    background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;
                    opacity:0;transition:opacity 0.2s;font-size:11px;color:#fff;text-align:center;line-height:1.2;
                " class="avatar-hover-hint">${escapeHtml(t("profile.changeAvatar"))}</div>
                <input id="profile-avatar-input" type="file" accept="image/jpeg,image/png,image/webp" style="display:none;" />
            </div>
            <div id="profile-avatar-username" style="font-size:18px;color:#f5c542;text-align:center;font-weight:700;">${escapeHtml(profile.username)}</div>
            <div id="profile-avatar-status" style="font-size:11px;color:#888;text-align:center;display:none;"></div>
        </div>

        <hr class="modal-divider">

        <div class="modal-section" style="gap:6px;">
            <label style="font-size:12px;color:#aaa;">${escapeHtml(t("profile.username"))}</label>
            <input id="profile-username-input"
                   type="text"
                   maxlength="30"
                   placeholder="${escapeHtml(t("profile.usernamePlaceholder"))}"
                   value="${escapeHtml(profile.username)}"
                   style="background:#111;border:1px solid #444;border-radius:4px;
                          color:#eee;padding:7px 10px;font-size:13px;font-family:inherit;
                          outline:none;width:100%;box-sizing:border-box;" />
            <div id="profile-username-hint" style="font-size:11px;color:#666;">${escapeHtml(t("profile.usernameHint"))}</div>
        </div>

        <hr class="modal-divider">

        <div class="modal-section" style="gap:8px;">
            <div class="modal-label">${escapeHtml(t("profile.accountSection"))}</div>
            <div style="display:flex;align-items:flex-start;gap:8px;">
                <span style="font-size:12px;color:#777;padding-top:5px;white-space:nowrap;">${escapeHtml(t("profile.accountId"))}</span>
                <div id="profile-uuid-area" style="margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:5px;min-width:0;"></div>
            </div>
        </div>

        <hr class="modal-divider">

        <div class="modal-row">
            <button id="profile-transfer-open-btn" class="modal-btn" style="font-size:11px;margin-right:auto;">${escapeHtml(t("profile.restoreDevice"))}</button>
            <button id="profile-modal-close" class="modal-btn" style="min-width:70px;">${escapeHtml(t("profile.cancel"))}</button>
            <button id="profile-modal-save"  class="modal-btn primary" style="min-width:70px;">${escapeHtml(t("profile.save"))}</button>
        </div>
    `;

    const avatarWrap        = body.querySelector("#profile-avatar-wrap");
    const avatarInput       = /** @type {HTMLInputElement | null} */ (body.querySelector("#profile-avatar-input"));
    const avatarPreview     = /** @type {HTMLImageElement | null} */ (body.querySelector("#profile-avatar-preview"));
    const avatarHint        = /** @type {HTMLElement | null} */ (body.querySelector(".avatar-hover-hint"));
    const avatarStatus      = /** @type {HTMLElement | null} */ (body.querySelector("#profile-avatar-status"));
    const avatarUsername    = body.querySelector("#profile-avatar-username");
    const usernameInput     = /** @type {HTMLInputElement | null} */ (body.querySelector("#profile-username-input"));
    const usernameHint      = /** @type {HTMLElement | null} */ (body.querySelector("#profile-username-hint"));
    const saveBtn       = /** @type {HTMLButtonElement | null} */ (body.querySelector("#profile-modal-save"));
    const closeBtn      = body.querySelector("#profile-modal-close");

    let pendingAvatarUrl  = profile.avatar_url || "";
    let pendingAvatarFile = null;

    avatarWrap.addEventListener("mouseenter", () => { avatarHint.style.opacity = "1"; });
    avatarWrap.addEventListener("mouseleave", () => { avatarHint.style.opacity = "0"; });
    avatarWrap.addEventListener("click", () => avatarInput.click());

    avatarInput.addEventListener("change", () => {
        const file = avatarInput.files[0];
        if (!file) return;

        if (file.size > _AVATAR_MAX_BYTES) {
            avatarStatus.textContent = t("profile.avatarTooLarge");
            avatarStatus.style.color = "#c0392b";
            avatarStatus.style.display = "";
            return;
        }

        _showAvatarCropModal(
            file,
            croppedFile => {
                pendingAvatarFile = croppedFile;
                avatarStatus.textContent = t("profile.avatarSelected");
                avatarStatus.style.color = "#888";
                avatarStatus.style.display = "";
                const reader = new FileReader();
                reader.onload = e => { avatarPreview.src = /** @type {string} */ (e.target.result); };
                reader.readAsDataURL(croppedFile);
            },
            () => { avatarInput.value = ""; },
        );
    });

    let _hintResetTimer = null;
    usernameInput.addEventListener("input", () => {
        const before = usernameInput.value;
        const after  = before.replace(_INVALID_USERNAME_RE, "");
        if (after !== before) {
            const pos = usernameInput.selectionStart - (before.length - after.length);
            usernameInput.value = after;
            usernameInput.setSelectionRange(pos, pos);
            usernameHint.textContent = t("profile.usernameInvalidChars");
            usernameHint.style.color = "#c0392b";
            clearTimeout(_hintResetTimer);
            _hintResetTimer = setTimeout(() => {
                usernameHint.textContent = t("profile.usernameHint");
                usernameHint.style.color = "#666";
            }, 2000);
        }
        avatarUsername.textContent = usernameInput.value;
    });

    closeBtn.addEventListener("click", _closeProfileModal);

    saveBtn.addEventListener("click", async () => {
        const newName = usernameInput.value.trim().slice(0, 30);

        const nameChanged   = newName !== (profile.username || "");
        const avatarChanged = pendingAvatarFile !== null || (!newName && !!(profile.avatar_url));
        const hasChanges    = nameChanged || avatarChanged;

        // going fully anonymous - clear avatar too
        if (!newName) {
            pendingAvatarUrl  = "";
            pendingAvatarFile = null;
        }
        if (!hasChanges) {
            _closeProfileModal();
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = t("profile.saving");

        if (pendingAvatarFile) {
            avatarStatus.textContent = t("profile.avatarUploading");
            avatarStatus.style.color = "#f5c542";
            avatarStatus.style.display = "";
            try {
                const result = await EFTForge.api.uploadAvatar(pendingAvatarFile);
                pendingAvatarUrl  = result.avatar_url;
                pendingAvatarFile = null;
            } catch (err) {
                avatarStatus.textContent = err.message || t("profile.avatarError");
                avatarStatus.style.color = "#c0392b";
                avatarStatus.style.display = "";
                avatarPreview.src = proxyAvatarUrl(profile.avatar_url) || "./assets/images/tarkovcitizen.jpg";
                pendingAvatarUrl  = profile.avatar_url || "";
                pendingAvatarFile = null;
                saveBtn.disabled  = false;
                saveBtn.textContent = t("profile.save");
                return;
            }
        }

        try {
            await EFTForge.api.updateUserProfile(newName, pendingAvatarUrl);
        } catch (err) {
            const msg = err.message || "";
            const isRateLimit = msg.toLowerCase().includes("wait") || msg.includes("429");
            if (isRateLimit) {
                avatarStatus.textContent = t("profile.profileRateLimit");
                avatarStatus.style.color = "#c0392b";
                avatarStatus.style.display = "";
                saveBtn.disabled = false;
                saveBtn.textContent = t("profile.save");
                return;
            }
            // other server errors are best-effort - don't block local save
            console.warn("profile update server error:", msg);
        }

        setProfile({ username: newName, avatar_url: pendingAvatarUrl });
        _updateProfileBtn();
        _closeProfileModal();
        if (hasChanges && typeof showToast === "function") {
            showToast(t("profile.savedTitle"), t("profile.savedMsg"), 2500, "#4CAF50");
        }
    });

    // UUID reveal (3-state)
    function _renderUuidArea(state) {
        const area = body.querySelector("#profile-uuid-area");
        if (!area) return;
        if (state === 0) {
            area.innerHTML = `<button id="uuid-reveal-btn" class="modal-btn" style="font-size:11px;padding:2px 10px;">${escapeHtml(t("profile.revealId"))}</button>`;
            area.querySelector("#uuid-reveal-btn").addEventListener("click", () => _renderUuidArea(1));
        } else if (state === 1) {
            area.innerHTML = `
                <div style="font-size:11px;color:#f5c542;text-align:right;max-width:340px;line-height:1.4;">${escapeHtml(t("profile.revealWarning"))}</div>
                <div style="display:flex;gap:4px;">
                    <button id="uuid-yes-btn" class="modal-btn" style="font-size:11px;padding:2px 8px;">${escapeHtml(t("profile.revealConfirm"))}</button>
                    <button id="uuid-no-btn"  class="modal-btn" style="font-size:11px;padding:2px 8px;">${escapeHtml(t("profile.cancel"))}</button>
                </div>`;
            area.querySelector("#uuid-yes-btn").addEventListener("click", () => _renderUuidArea(2));
            area.querySelector("#uuid-no-btn").addEventListener("click",  () => _renderUuidArea(0));
        } else {
            const uuid = localStorage.getItem("eftforge_client_id") || "";
            area.innerHTML = `
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
                    <span style="font-size:11px;color:#ccc;background:#111;padding:3px 7px;border-radius:3px;letter-spacing:0.5px;word-break:break-all;font-family:Bender,Arial,sans-serif;">${escapeHtml(uuid)}</span>
                    <button id="uuid-copy-btn" class="modal-btn" style="font-size:11px;padding:2px 8px;flex-shrink:0;">${escapeHtml(t("profile.copyId"))}</button>
                    <button id="uuid-hide-btn" class="modal-btn" style="font-size:11px;padding:2px 8px;flex-shrink:0;">${escapeHtml(t("profile.hideId"))}</button>
                </div>`;
            area.querySelector("#uuid-copy-btn").addEventListener("click", () => {
                navigator.clipboard.writeText(uuid).then(() => {
                    const btn = area.querySelector("#uuid-copy-btn");
                    if (!btn) return;
                    btn.textContent = t("profile.copied");
                    setTimeout(() => { if (btn) btn.textContent = t("profile.copyId"); }, 2000);
                }).catch(() => {});
            });
            area.querySelector("#uuid-hide-btn").addEventListener("click", () => _renderUuidArea(0));
        }
    }
    _renderUuidArea(0);

    body.querySelector("#profile-transfer-open-btn").addEventListener("click", () => {
        _showTransferModal();
    });

    setTimeout(() => usernameInput.focus(), 50);
}

function _showTransferModal() {
    const t = EFTForge.lang.t;
    const overlay = _createModalOverlay("profile-transfer-overlay", t("profile.transferTitle"), { maxWidth: "460px" });
    if (!overlay) return;
    overlay.style.zIndex = "1050";

    const body = document.getElementById("profile-transfer-overlay-body");
    body.innerHTML = `
        <div id="tr-step-1" style="display:flex;flex-direction:column;gap:10px;">
            <label style="font-size:12px;color:#aaa;">${escapeHtml(t("profile.transferLabel"))}</label>
            <input id="tr-uuid-input" type="text" spellcheck="false" autocomplete="off"
                   placeholder="${escapeHtml(t("profile.transferPlaceholder") || "xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx")}"
                   style="background:#111;border:1px solid #444;border-radius:4px;color:#eee;
                          padding:7px 10px;font-size:12px;font-family:inherit;outline:none;
                          width:100%;box-sizing:border-box;" />
            <div id="tr-input-error" style="font-size:11px;color:#c0392b;min-height:14px;"></div>
            <div class="modal-row" style="justify-content:flex-end;">
                <button id="tr-cancel-btn" class="modal-btn">${escapeHtml(t("profile.cancel"))}</button>
                <button id="tr-preview-btn" class="modal-btn primary">${escapeHtml(t("profile.transferPreview"))}</button>
            </div>
        </div>

        <div id="tr-step-2" style="display:none;flex-direction:column;gap:10px;">
            <div id="tr-will" style="display:flex;flex-direction:column;gap:4px;">
                <div style="font-size:11px;color:#4CAF50;font-weight:700;">${escapeHtml(t("profile.transferWillTitle"))}</div>
                <div id="tr-will-body" style="font-size:12px;color:#ccc;padding-left:8px;line-height:1.7;"></div>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;">
                <div style="font-size:11px;color:#c0392b;font-weight:700;">${escapeHtml(t("profile.transferWontTitle"))}</div>
                <div style="font-size:12px;color:#777;padding-left:8px;line-height:1.7;">
                    ${escapeHtml(t("profile.transferWont1"))}<br>
                    ${escapeHtml(t("profile.transferWont2"))}
                </div>
            </div>
            <div style="font-size:11px;color:#f5c542;background:rgba(245,197,66,0.07);border:1px solid rgba(245,197,66,0.2);border-radius:4px;padding:8px 10px;line-height:1.5;">
                ${escapeHtml(t("profile.transferAlert"))}
            </div>
            <div class="modal-row" style="justify-content:flex-end;">
                <button id="tr-back-btn" class="modal-btn">${escapeHtml(t("profile.transferBack"))}</button>
                <button id="tr-confirm-btn" class="modal-btn primary">${escapeHtml(t("profile.transferConfirm"))}</button>
            </div>
        </div>
    `;

    const step1      = /** @type {HTMLElement | null} */ (body.querySelector("#tr-step-1"));
    const step2      = /** @type {HTMLElement | null} */ (body.querySelector("#tr-step-2"));
    const uuidInput  = /** @type {HTMLInputElement | null} */ (body.querySelector("#tr-uuid-input"));
    const inputError = body.querySelector("#tr-input-error");
    const willBody   = body.querySelector("#tr-will-body");

    let _previewData = null;

    body.querySelector("#tr-cancel-btn").addEventListener("click", () => overlay.remove());
    body.querySelector("#tr-back-btn").addEventListener("click", () => {
        step2.style.display = "none";
        step1.style.display = "flex";
        inputError.textContent = "";
        _previewData = null;
    });

    body.querySelector("#tr-preview-btn").addEventListener("click", async () => {
        const val = uuidInput.value.trim();
        if (!val) { inputError.textContent = t("profile.transferNoData"); return; }

        const previewBtn = /** @type {HTMLButtonElement | null} */ (body.querySelector("#tr-preview-btn"));
        previewBtn.disabled = true;
        previewBtn.textContent = t("profile.transferPreviewing");
        inputError.textContent = "";

        try {
            _previewData = await EFTForge.api.transferPreview(val);
        } catch (err) {
            const rawMsg = err.message || "";
            if (rawMsg.toLowerCase().includes("current") || rawMsg.toLowerCase().includes("yourself")) {
                inputError.textContent = t("profile.transferSelf");
            } else {
                inputError.textContent = t("profile.transferError");
            }
            previewBtn.disabled = false;
            previewBtn.textContent = t("profile.transferPreview");
            return;
        }

        if (_previewData.old_builds === 0 && _previewData.old_comments === 0) {
            inputError.textContent = t("profile.transferNoData");
            previewBtn.disabled = false;
            previewBtn.textContent = t("profile.transferPreview");
            return;
        }

        willBody.innerHTML =
            `${_previewData.old_builds} ${t("profile.transferBuilds")}, ` +
            `${_previewData.old_comments} ${t("profile.transferComments")} ` +
            `<span style="color:#666;">(${t("profile.transferFromOld")})</span><br>` +
            `${_previewData.cur_builds} ${t("profile.transferBuilds")}, ` +
            `${_previewData.cur_comments} ${t("profile.transferComments")} ` +
            `<span style="color:#666;">(${t("profile.transferUnaffected")})</span>`;

        step1.style.display = "none";
        step2.style.display = "flex";
        previewBtn.disabled = false;
        previewBtn.textContent = t("profile.transferPreview");
    });

    body.querySelector("#tr-confirm-btn").addEventListener("click", async () => {
        const confirmBtn = /** @type {HTMLButtonElement | null} */ (body.querySelector("#tr-confirm-btn"));
        const backBtn    = /** @type {HTMLButtonElement | null} */ (body.querySelector("#tr-back-btn"));
        confirmBtn.disabled = true;
        backBtn.disabled    = true;
        confirmBtn.textContent = t("profile.transferring");

        try {
            const result = await EFTForge.api.transferAccount(uuidInput.value.trim());
            overlay.remove();
            if (typeof showToast === "function") {
                const total = result.transferred_builds + result.transferred_comments;
                showToast(
                    t("profile.transferDoneTitle"),
                    `${total} ${t("profile.transferDoneMsg")}`,
                    4000,
                    "#4CAF50",
                );
            }
        } catch (err) {
            confirmBtn.disabled    = false;
            backBtn.disabled       = false;
            confirmBtn.textContent = t("profile.transferConfirm");
            const errEl = body.querySelector("#tr-will");
            if (errEl) {
                const msg = document.createElement("div");
                msg.style.cssText = "font-size:11px;color:#c0392b;margin-top:4px;";
                msg.textContent = t("profile.transferFailed");
                errEl.appendChild(msg);
            }
        }
    });
}

function _closeProfileModal() {
    const el = document.getElementById("profile-modal-overlay");
    if (el) el.remove();
}

function _updateProfileBtn() {
    const btn = document.getElementById("profile-nav-btn");
    if (!btn) return;
    const profile = getProfile();
    const img = /** @type {HTMLImageElement | null} */ (btn.querySelector(".profile-nav-avatar"));
    if (img) {
        img.src = proxyAvatarUrl(profile.avatar_url) || "./assets/images/tarkovcitizen.jpg";
    }
    const label = btn.querySelector(".profile-nav-label");
    if (label) {
        const t = EFTForge.lang.t;
        const name = profile.username || t("modal.anonymousAuthor");
        label.innerHTML = `<span class="profile-nav-label-text">${escapeHtml(name)}</span>`;
    }
}

function _setupProfileMarquee() {
    const btn = document.getElementById("profile-nav-btn");
    if (!btn) return;
    const label = btn.querySelector(".profile-nav-label");
    if (!label) return;

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let gen = 0;

    btn.addEventListener("mouseenter", async () => {
        const myGen = ++gen;
        const inner = /** @type {HTMLElement | null} */ (label.querySelector(".profile-nav-label-text"));
        if (!inner) return;

        await new Promise(r => requestAnimationFrame(r));
        if (gen !== myGen) return;

        const overflow = inner.offsetWidth - label.clientWidth;
        if (overflow <= 2) return;

        const duration = Math.max(1200, (overflow / 45) * 1000);

        async function runCycle() {
            if (gen !== myGen) return;

            if (document.hidden) {
                await sleep(1000);
                runCycle();
                return;
            }

            inner.style.transition = "none";
            inner.style.transform = "translateX(0)";
            inner.style.opacity = "1";

            inner.style.transition = `transform ${duration}ms linear`;
            inner.style.transform = `translateX(-${overflow}px)`;
            await sleep(duration);
            if (gen !== myGen) return;

            await sleep(700);
            if (gen !== myGen) return;

            inner.style.transition = "opacity 0.35s ease";
            inner.style.opacity = "0";
            await sleep(400);
            if (gen !== myGen) return;

            inner.style.transition = "none";
            inner.style.transform = "translateX(0)";

            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            if (gen !== myGen) return;

            inner.style.transition = "opacity 0.35s ease";
            inner.style.opacity = "1";
            await sleep(1500);

            runCycle();
        }

        runCycle();
    });

    btn.addEventListener("mouseleave", () => {
        gen++;
        const inner = /** @type {HTMLElement | null} */ (label.querySelector(".profile-nav-label-text"));
        if (!inner) return;
        inner.style.transition = "none";
        inner.style.transform = "translateX(0)";
        inner.style.opacity = "1";
    });
}

EFTForge.profile = { getProfile, setProfile, getDisplayName, getAvatarUrl, showProfileModal, updateBtn: _updateProfileBtn };

// Initialize the nav button immediately - scripts run after the DOM at end of body
_updateProfileBtn();
_setupProfileMarquee();
