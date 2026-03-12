window.EFTForge = window.EFTForge || {};

window.EFTForge.utils = {};

/* --- Cache --- */

const CACHE_MAX = 300;

function cacheSet(cache, key, value) {
    if (Object.keys(cache).length >= CACHE_MAX) {
        // Drop the oldest ~half to avoid thrashing on a full cache
        const keys = Object.keys(cache);
        for (let i = 0; i < Math.floor(CACHE_MAX / 2); i++) delete cache[keys[i]];
    }
    cache[key] = value;
}

/* --- String helpers --- */

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/* --- Panel loading overlay --- */

function startPanelLoading(panelEl, delayMs = 0) {
    const state = { overlay: null, timer: null };
    const show = () => {
        const overlay = document.createElement("div");
        overlay.className = "panel-loading-overlay";
        panelEl.appendChild(overlay);
        state.overlay = overlay;
    };
    if (delayMs > 0) {
        state.timer = setTimeout(show, delayMs);
    } else {
        show();
    }
    return state;
}

function stopPanelLoading(state) {
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    if (state.overlay && state.overlay.isConnected) state.overlay.remove();
}

/* --- Toast notifications --- */

function showToast(title, message, duration = 3000, color = "#f44336") {
    const container = document.getElementById("toast-container");

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.style.borderLeftColor = color;

    toast.innerHTML = `
        <div class="toast-title" style="color:${color}">${title}</div>
        <div class="toast-body">${message}</div>
    `;

    container.appendChild(toast);

    // Trigger animation
    setTimeout(() => {
        toast.classList.add("show");
    }, 10);

    // Auto remove
    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => {
            container.removeChild(toast);
        }, 250);
    }, duration);
}

/* --- Modal factory --- */

function _createModalOverlay(id, title, opts = {}) {
    if (document.getElementById(id)) return null;
    const {
        closeId    = `${id}-close`,
        bodyId     = `${id}-body`,
        maxWidth   = "",
        titleExtra = "",
    } = opts;

    const overlay = document.createElement("div");
    overlay.id = id;
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
        <div class="modal-window"${maxWidth ? ` style="max-width:${maxWidth};"` : ""}>
            <div class="modal-header">
                <span class="modal-title">${title}</span>
                ${titleExtra}
                <button class="modal-close-btn" id="${closeId}" aria-label="Close dialog">&#x2715;</button>
            </div>
            <div class="modal-body" id="${bodyId}"></div>
        </div>
    `;

    document.body.appendChild(overlay);
    document.getElementById(closeId).addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    return overlay;
}

/* --- Marquee / sleep --- */

let _marqueeGeneration = 0;

function _clearMarqueeTimers() {
    _marqueeGeneration++;
}

function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function _initMarqueeText(container) {
    container.querySelectorAll(".marquee-text").forEach(el => {
        const parent = el.parentElement;
        if (!parent) return;

        // Measure after layout so offsetWidth is accurate
        requestAnimationFrame(async () => {
            const overflow = el.offsetWidth - parent.clientWidth;
            if (overflow <= 2) return;

            const scrollDuration = Math.max(1200, (overflow / 45) * 1000);
            const gen = _marqueeGeneration;

            async function runCycle() {
                if (_marqueeGeneration !== gen) return;

                // Snap to start
                el.style.transition = "none";
                el.style.transform = "translateX(0)";
                el.style.opacity = "1";

                // Phase 1 — pause at start
                await _sleep(800);
                if (_marqueeGeneration !== gen) return;

                // Phase 2 — scroll to end
                el.style.transition = `transform ${scrollDuration}ms linear`;
                el.style.transform = `translateX(-${overflow}px)`;
                await _sleep(scrollDuration);
                if (_marqueeGeneration !== gen) return;

                // Phase 3 — pause at end
                await _sleep(700);
                if (_marqueeGeneration !== gen) return;

                // Phase 4 — fade out
                el.style.transition = "opacity 0.35s ease";
                el.style.opacity = "0";
                await _sleep(400);
                if (_marqueeGeneration !== gen) return;

                // Phase 5 — snap back while invisible
                el.style.transition = "none";
                el.style.transform = "translateX(0)";

                // Phase 6 — fade in (double rAF ensures the transition
                // applies after the snap)
                await new Promise(resolve =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve))
                );
                if (_marqueeGeneration !== gen) return;

                el.style.transition = "opacity 0.35s ease";
                el.style.opacity = "1";

                await _sleep(1500);
                runCycle();
            }

            runCycle();
        });
    });
}

/* --- Exports --- */

EFTForge.utils.cacheSet            = cacheSet;
EFTForge.utils.escapeHtml          = escapeHtml;
EFTForge.utils.startPanelLoading   = startPanelLoading;
EFTForge.utils.stopPanelLoading    = stopPanelLoading;
EFTForge.utils.showToast           = showToast;
EFTForge.utils._createModalOverlay = _createModalOverlay;
EFTForge.utils._clearMarqueeTimers = _clearMarqueeTimers;
EFTForge.utils._sleep              = _sleep;
EFTForge.utils._initMarqueeText    = _initMarqueeText;
