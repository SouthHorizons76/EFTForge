window.EFTForge = window.EFTForge || {};

/* exported proxyAvatarUrl, isMobileLayout, _formatPrice, setToastStatus -- called from other modules */

window.EFTForge.utils = {};

function proxyAvatarUrl(url) {
    if (!url) return null;
    if (url.startsWith("https://gitee.com/") || url.startsWith("https://raw.giteeusercontent.com/")) {
        const base = (window.EFTForge && EFTForge.config && EFTForge.config.API_BASE) || "";
        return `${base}/proxy-asset?url=${encodeURIComponent(url)}`;
    }
    return url;
}

/* --- Mobile detection --- */

function isMobileLayout() {
    const hasTouch = navigator.maxTouchPoints > 0;
    const hasCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const mobileUA = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
    return (hasTouch && hasCoarsePointer) || (hasTouch && mobileUA);
}

/* --- Cache --- */

// Sized for the build-tabs era: 20 open tabs x ~30 attachments each is already
// ~600 distinct item ids in slotCache, and the drop-oldest-half eviction below
// is blind to what the active build still needs (renderNode reads slotCache
// directly rather than through cacheGet, so live entries never get their LRU
// position refreshed). 300 thrashed constantly once a handful of tabs were open.
const CACHE_MAX = 1200;

// Entry counts, so a set doesn't have to materialize every key just to check
// the size - at CACHE_MAX entries that allocation dominated the cost of warming
// a cache from a batch response.
const _cacheSizes = new WeakMap();

function cacheSet(cache, key, value) {
    let size = _cacheSizes.get(cache);
    if (size === undefined) size = Object.keys(cache).length;
    if (!(key in cache)) size++;

    if (size > CACHE_MAX) {
        // Drop the oldest ~half to avoid thrashing on a full cache
        const keys = Object.keys(cache);
        const drop = Math.floor(CACHE_MAX / 2);
        for (let i = 0; i < drop; i++) delete cache[keys[i]];
        size -= drop;
    }

    cache[key] = value;
    _cacheSizes.set(cache, size);
}

function cacheGet(cache, key) {
    if (!(key in cache)) return undefined;
    const val = cache[key];
    delete cache[key];
    cache[key] = val; // re-insert as newest for LRU ordering
    return val;
}

/* --- Number formatting --- */

function _formatPrice(n) {
    if (n == null) return "";
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0") + "₽";
}

/**
 * Format a stat value: shows as integer when the fractional part is negligible,
 * otherwise rounds to `decimals` decimal places.
 */
function formatStat(val, decimals = 1) {
    return Math.abs(val - Math.round(val)) < 0.001 ? Math.round(val) : val.toFixed(decimals);
}

/* --- String helpers --- */

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
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

const _TOAST_ICONS = {
    success:  '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8.5" stroke="currentColor" stroke-width="1.6"/><path d="M6.5 10l2.5 2.5 4.5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warning:  '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M10 2L18 17H2L10 2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><line x1="10" y1="7.5" x2="10" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.5" r="1.2" fill="currentColor"/></svg>',
    info:     '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8.5" stroke="currentColor" stroke-width="1.6"/><line x1="10" y1="8.5" x2="10" y2="14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="6" r="1.2" fill="currentColor"/></svg>',
    critical: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8.5" stroke="currentColor" stroke-width="1.6"/><line x1="10" y1="6" x2="10" y2="11.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14" r="1.2" fill="currentColor"/></svg>',
    error:    '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8.5" stroke="currentColor" stroke-width="1.6"/><path d="M6.5 6.5l7 7M13.5 6.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    default:  '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8.5" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2 2.5"/></svg>',
};

// Only the 5 admin announcement level colors get specific icons; everything else gets the neutral default
function _toastIcon(color) {
    switch (color.toLowerCase()) {
        case "#4caf50": return _TOAST_ICONS.success;
        case "#f5a623": return _TOAST_ICONS.warning;
        case "#4a90d9": return _TOAST_ICONS.info;
        case "#9b59b6": return _TOAST_ICONS.critical;
        case "#e74c3c": return _TOAST_ICONS.error;
        default:        return _TOAST_ICONS.default;
    }
}

function _hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function _updateBlobColor() {
    const toasts = document.querySelectorAll(".toast.show");
    if (toasts.length > 0) {
        const blobColor = toasts[toasts.length - 1].dataset.blobColor;
        if (blobColor) document.documentElement.style.setProperty("--blob-color", blobColor);
    } else if (EFTForge.state.compareMode || (EFTForge.state.pveMode && EFTForge.state.priceView)) {
        document.documentElement.style.setProperty("--blob-color", "rgba(0, 200, 180, 0.10)");
    } else {
        document.documentElement.style.removeProperty("--blob-color");
    }
}

function _setToastText(el, text) {
    el.textContent = "";
    if (text.endsWith("...")) {
        el.textContent = text.slice(0, -3);
        for (let i = 0; i < 3; i++) {
            const dot = document.createElement("span");
            dot.className = "toast-dot";
            dot.textContent = ".";
            el.appendChild(dot);
        }
    } else {
        el.textContent = text;
    }
}

// Tracks toasts currently on screen, keyed by the caller-chosen "category" string
// passed to replaceToast(). Lets a later call in the same flow (e.g. "prices fetched")
// update the still-open toast from an earlier call ("fetching prices...") in place
// instead of stacking a second toast on top of it.
const _toastByCategory = new Map();
const _toastState = new WeakMap();

const _TOAST_FADE_MS = 180;
const _TOAST_REFILL_MS = 300;   // progress bar refill-then-drain transition
const _TOAST_WIDTH_MS = 300;    // must match the "width" duration in the .toast CSS transition

// Pauses the dismiss countdown and freezes the progress bar at its current width.
// Only acts while the bar is actually draining (not during the replace fade/refill window),
// since remainingMs/drainStartedAt are only meaningful once startDrain has run.
function _pauseToastTimer(state) {
    if (!state.timerId || state.progressEl.style.animationName !== "toast-progress-drain") return;
    clearTimeout(state.timerId);
    state.timerId = null;
    state.remainingMs = Math.max(0, state.remainingMs - (Date.now() - state.drainStartedAt));
    state.progressEl.style.animationPlayState = "paused";
}

function _resumeToastTimer(state) {
    if (state.timerId || state.remainingMs == null || state.progressEl.style.animationName !== "toast-progress-drain") return;
    if (state.remainingMs <= 0) {
        state.dismiss();
        return;
    }
    state.drainStartedAt = Date.now();
    state.timerId = setTimeout(state.dismiss, state.remainingMs);
    state.progressEl.style.animationPlayState = "running";
}

function _swapToastActions(state, actions) {
    if (state.actionsEl) {
        state.actionsEl.remove();
        state.actionsEl = null;
    }
    if (actions && actions.length > 0) {
        const actionsEl = document.createElement("div");
        actionsEl.className = "toast-actions";
        actions.forEach(({ label, onClick }) => {
            const btn = document.createElement("button");
            btn.className = "toast-action-btn";
            btn.textContent = label;
            btn.addEventListener("click", () => {
                state.dismiss();
                onClick();
            });
            actionsEl.appendChild(btn);
        });
        state.contentEl.appendChild(actionsEl);
        state.actionsEl = actionsEl;
    }
}

// (Re)applies title/message/color/actions/duration to an already-built toast and
// (re)starts its dismiss timer and progress bar. Shared by showToast (initial render,
// isReplace = false: content is set immediately) and replaceToast (in-place update of
// an existing toast, isReplace = true: title/message/icon cross-fade and the progress
// bar visibly refills before it starts draining again).
function _applyToastContent(toast, state, title, message, duration, color, actions, isReplace = false) {
    toast.dataset.blobColor = _hexToRgba(color, 0.12);
    toast.style.setProperty("--toast-accent", color); // border/icon color transition off @property --toast-accent

    const newIcon = _toastIcon(color);
    const swapText = () => {
        state.iconColEl.innerHTML = newIcon;
        _setToastText(state.titleEl, title);
        _setToastText(state.bodyEl, message);
        _swapToastActions(state, actions);
    };

    const contentChanged = state.iconColEl.innerHTML !== newIcon || state.titleEl.textContent !== title || state.bodyEl.textContent !== message;
    if (isReplace && contentChanged) {
        // Different title/message can wrap to a different box size (min/max-width in CSS
        // clamps it to 260-320px) - pin the current rendered width first so the swap below
        // can animate to the new size instead of the box snapping to it.
        const oldWidth = toast.getBoundingClientRect().width;
        toast.style.width = oldWidth + "px";

        state.contentEl.classList.add("toast-fade-swap");
        state.iconColEl.classList.add("toast-fade-swap");
        setTimeout(() => {
            swapText();
            toast.style.width = "";
            const newWidth = toast.getBoundingClientRect().width;
            toast.style.width = oldWidth + "px";
            void toast.offsetWidth; // force reflow so the width transition below starts from oldWidth
            toast.style.width = newWidth + "px";

            state.contentEl.classList.remove("toast-fade-swap");
            state.iconColEl.classList.remove("toast-fade-swap");
            setTimeout(() => { toast.style.width = ""; }, _TOAST_WIDTH_MS);
        }, _TOAST_FADE_MS);
    } else {
        swapText();
    }

    if (state.timerId) {
        clearTimeout(state.timerId);
        state.timerId = null;
    }

    const startDrain = () => {
        state.progressEl.style.transition = "none";
        state.progressEl.style.transform = "";
        state.progressEl.style.animationName = "none";
        state.progressEl.style.animationDuration = duration + "ms";
        void state.progressEl.offsetWidth; // force reflow so the drain animation restarts from full
        state.progressEl.style.animationPlayState = "running";
        state.progressEl.style.animationName = "toast-progress-drain";
        state.remainingMs = duration;
        state.drainStartedAt = Date.now();
        state.timerId = setTimeout(state.dismiss, duration);
        if (state.isHovered) _pauseToastTimer(state); // toast is being replaced while the cursor is still over it
    };

    if (duration > 0) {
        state.progressEl.style.display = "";
        if (isReplace) {
            // Freeze the bar at whatever width its old drain animation had reached, then
            // visibly transition it back to full before the new countdown starts.
            const frozenTransform = getComputedStyle(state.progressEl).transform;
            state.progressEl.style.animationName = "none";
            state.progressEl.style.transition = "none";
            state.progressEl.style.transform = frozenTransform;
            void state.progressEl.offsetWidth;
            state.progressEl.style.transition = `transform ${_TOAST_REFILL_MS}ms ease`;
            state.progressEl.style.transform = "scaleX(1)";
            state.timerId = setTimeout(startDrain, _TOAST_REFILL_MS);
        } else {
            startDrain();
        }
    } else {
        state.progressEl.style.transition = "none";
        state.progressEl.style.animationName = "none";
        state.progressEl.style.display = "none";
    }

    if (toast.classList.contains("show")) _updateBlobColor();
}

// actions: optional array of { label, onClick } - if provided, toast stays until an action is clicked
// pass duration = 0 to keep the toast open indefinitely (requires actions to dismiss it)
// category: optional string - used internally by replaceToast() to find this toast again later
function showToast(title, message, duration = 3000, color = "#e74c3c", actions = null, dismissible = true, category = null) {
    const container = document.getElementById("toast-container");

    const toast = document.createElement("div");
    toast.className = "toast";

    const iconColEl = document.createElement("div");
    iconColEl.className = "toast-icon-col";
    toast.appendChild(iconColEl);

    const contentEl = document.createElement("div");
    contentEl.className = "toast-content";

    const titleEl = document.createElement("div");
    titleEl.className = "toast-title";
    contentEl.appendChild(titleEl);

    const bodyEl = document.createElement("div");
    bodyEl.className = "toast-body";
    contentEl.appendChild(bodyEl);

    toast.appendChild(contentEl);

    const progressEl = document.createElement("div");
    progressEl.className = "toast-progress";
    toast.appendChild(progressEl);

    const state = { titleEl, bodyEl, contentEl, iconColEl, progressEl, actionsEl: null, timerId: null, isHovered: false };
    toast.addEventListener("mouseenter", () => {
        state.isHovered = true;
        _pauseToastTimer(state);
    });
    toast.addEventListener("mouseleave", () => {
        state.isHovered = false;
        _resumeToastTimer(state);
    });
    state.dismiss = () => {
        toast.classList.remove("show");
        state.progressEl.style.display = "none";
        if (state.timerId) clearTimeout(state.timerId);
        if (category && _toastByCategory.get(category) === toast) _toastByCategory.delete(category);
        setTimeout(() => {
            if (toast.isConnected) container.removeChild(toast);
            _updateBlobColor();
        }, 250);
    };
    _toastState.set(toast, state);

    if (dismissible) {
        toast.classList.add("dismissible");
        const hint = document.createElement("span");
        hint.className = "toast-dismiss-hint";
        hint.textContent = "×";
        toast.appendChild(hint);
        toast.addEventListener("click", (e) => {
            if (!e.target.closest(".toast-action-btn")) state.dismiss();
        });
    }

    container.appendChild(toast);
    _applyToastContent(toast, state, title, message, duration, color, actions);

    if (category) {
        toast.dataset.toastCategory = category;
        _toastByCategory.set(category, toast);
    }

    setTimeout(() => {
        toast.classList.add("show");
        _updateBlobColor();
    }, 10);

    return toast;
}

// Like showToast, but toasts sharing the same "category" are condensed into one: if a
// toast from a previous replaceToast(category, ...) call is still on screen, its content
// cross-fades in place (title/message/icon fade, accent color and progress bar transition)
// instead of stacking a new toast on top of it. Use this for multi-step flows reported via
// separate toast calls (e.g. "fetching flea prices..." followed by "flea prices updated").
function replaceToast(category, title, message, duration = 3000, color = "#e74c3c", actions = null, dismissible = true) {
    const existing = _toastByCategory.get(category);
    if (existing && existing.isConnected) {
        _applyToastContent(existing, _toastState.get(existing), title, message, duration, color, actions, true);
        return existing;
    }
    return showToast(title, message, duration, color, actions, dismissible, category);
}

function setToastStatus(toastEl, text) {
    const body = toastEl?.querySelector(".toast-body");
    if (body) body.textContent = text;
}

/* --- Modal factory --- */

function _createModalOverlay(id, title, opts = {}) {
    if (document.getElementById(id)) return null;
    const {
        closeId     = `${id}-close`,
        bodyId      = `${id}-body`,
        maxWidth    = "",
        titleExtra  = "",
        tabs        = null,
        onTabSwitch = null,
        closeOnBackdrop = true,
    } = opts;

    const overlay = document.createElement("div");
    overlay.id = id;
    overlay.className = "modal-overlay";

    const winStyle = maxWidth ? ` style="max-width:${maxWidth};"` : "";
    const headerHtml = `
        <div class="modal-header">
            <span class="modal-title">${title}</span>
            ${titleExtra}
            <button class="modal-close-btn" id="${closeId}" aria-label="Close dialog">&#x2715;</button>
        </div>`;

    if (tabs && tabs.length > 0) {
        const tabBtns = tabs.map((tab, i) =>
            `<button class="modal-tab${i === 0 ? " active" : ""}" data-target="${tab.id}">${tab.label}</button>`
        ).join("");
        const tabPanels = tabs.map((tab, i) =>
            `<div class="modal-tab-panel${i === 0 ? " active" : ""}" id="${tab.id}"></div>`
        ).join("");
        overlay.innerHTML = `
            <div class="modal-outer">
                <div class="modal-tab-rail">${tabBtns}</div>
                <div class="modal-window"${winStyle}>
                    ${headerHtml}
                    <div class="modal-body" id="${bodyId}">${tabPanels}</div>
                </div>
            </div>`;
    } else {
        overlay.innerHTML = `
            <div class="modal-window"${winStyle}>
                ${headerHtml}
                <div class="modal-body" id="${bodyId}"></div>
            </div>`;
    }

    document.body.appendChild(overlay);
    document.getElementById(closeId).addEventListener("click", () => overlay.remove());
    if (closeOnBackdrop) {
        let _mdOnBackdrop = false;
        overlay.addEventListener("mousedown", e => { _mdOnBackdrop = e.target === overlay; });
        overlay.addEventListener("click", (e) => { if (e.target === overlay && _mdOnBackdrop) overlay.remove(); });
    }

    if (tabs && tabs.length > 0) {
        overlay.querySelectorAll(".modal-tab").forEach(btn => {
            btn.addEventListener("click", () => {
                const targetId = btn.dataset.target;
                overlay.querySelectorAll(".modal-tab").forEach(b => b.classList.remove("active"));
                overlay.querySelectorAll(".modal-tab-panel").forEach(p => p.classList.remove("active"));
                btn.classList.add("active");
                const panel = document.getElementById(targetId);
                if (panel) {
                    panel.style.animation = "none";
                    panel.offsetHeight;
                    panel.style.animation = "";
                    panel.classList.add("active");
                }
                onTabSwitch?.(targetId);
            });
        });
    }

    return overlay;
}

/* --- Promise timeout --- */

/**
 * Race a promise against a timeout. Rejects with an Error if the promise
 * does not settle within `ms` milliseconds.
 */
function withTimeout(promise, ms = 15000) {
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms)
    );
    return Promise.race([promise, timeout]);
}

/* --- Cursor edge-pan scrolling --- */

// Pans a horizontally-scrollable element toward the cursor when it sits near
// the element's own left/right edge - same idea as Apex Legends' controller
// inventory panning, just driven by mouse position against the element's
// bounding box instead of a stick axis. Speed ramps up the deeper the cursor
// sits inside the edge zone, and panning stops the instant the cursor backs
// off or the element bottoms out, so it never fights a click on content
// that's already on screen. Used on wide attachment-table containers
// (.right-panel, the optimizer's results pane) where dragging the thin
// scrollbar to reach trailing columns is tedious.
function setupEdgePanScroll(el, { zone = 25, maxSpeed = 2 } = {}) {
    let panSpeed = 0;
    let rafId = null;

    function step() {
        // The caller's content can get swapped (innerHTML) or the element itself
        // detached between renders - bail rather than keep panning a dead node.
        // Also doubles as the idle exit once panSpeed settles back to 0, so this
        // isn't polling every frame while nothing is panning.
        if (!document.body.contains(el) || panSpeed === 0) { rafId = null; return; }
        el.scrollLeft += panSpeed;
        rafId = requestAnimationFrame(step);
    }

    function setPanSpeed(next) {
        panSpeed = next;
        if (panSpeed !== 0 && rafId == null) rafId = requestAnimationFrame(step);
    }

    el.addEventListener("mousemove", (e) => {
        const maxScroll = el.scrollWidth - el.clientWidth;
        if (maxScroll <= 1) { setPanSpeed(0); return; }

        const rect = el.getBoundingClientRect();
        const x = e.clientX - rect.left;

        if (x < zone && el.scrollLeft > 0) {
            const depth = Math.max(0, Math.min(1, (zone - x) / zone));
            setPanSpeed(-Math.ceil(depth * maxSpeed));
        } else if (x > rect.width - zone && el.scrollLeft < maxScroll) {
            const depth = Math.max(0, Math.min(1, (x - (rect.width - zone)) / zone));
            setPanSpeed(Math.ceil(depth * maxSpeed));
        } else {
            setPanSpeed(0);
        }
    });

    el.addEventListener("mouseleave", () => setPanSpeed(0));
}

/* --- Marquee / sleep --- */

let _marqueeGeneration = 0;
let _marqueeObservers = [];

function _clearMarqueeTimers() {
    _marqueeGeneration++;
    for (const ro of _marqueeObservers) ro.disconnect();
    _marqueeObservers = [];
}

function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Returns a disposer that tears down ONLY the marquees this call created.
// Callers that re-render frequently (e.g. the build tab strip) must use it
// instead of _clearMarqueeTimers(), which is a page-wide reset: that bumps the
// shared generation counter and so permanently freezes every other module's
// marquees (attachment table rows, stats panel, community cards) until they
// happen to re-render.
function _initMarqueeText(container, { hoverOnly = false, hoverTarget = "tr" } = {}) {
    const scope = { alive: true, observers: [], listeners: [] };

    container.querySelectorAll(".marquee-text").forEach(el => {
        const parent = el.parentElement;
        if (!parent) return;

        let elGen = 0;
        const globalGen = _marqueeGeneration;
        const isStale = () => _marqueeGeneration !== globalGen || !scope.alive;

        function resetEl() {
            elGen++;
            el.style.transition = "none";
            el.style.transform = "translateX(0)";
            el.style.opacity = "1";
        }

        function startMarquee() {
            elGen++;
            const myElGen = elGen;

            requestAnimationFrame(async () => {
                if (isStale()) return;

                // clientWidth includes the parent's padding, but el sits inset by
                // paddingLeft - without correcting for that, padded containers (e.g.
                // .custom-select-option) stop the scroll short of the text's true end.
                const parentStyle = getComputedStyle(parent);
                const horizontalPadding = parseFloat(parentStyle.paddingLeft || 0) + parseFloat(parentStyle.paddingRight || 0);
                const overflow = el.offsetWidth - (parent.clientWidth - horizontalPadding);

                if (overflow <= 2) {
                    // No overflow - reset to natural state
                    el.style.transition = "none";
                    el.style.transform = "translateX(0)";
                    el.style.opacity = "1";
                    return;
                }

                const scrollDuration = Math.max(1200, (overflow / 45) * 1000);

                async function runCycle() {
                    if (isStale() || elGen !== myElGen) return;

                    // Pause while document is not visible to save CPU
                    if (document.hidden) {
                        await _sleep(1000);
                        runCycle();
                        return;
                    }

                    // Snap to start
                    el.style.transition = "none";
                    el.style.transform = "translateX(0)";
                    el.style.opacity = "1";

                    // Phase 1 - pause at start (skipped on hover-triggered cycles)
                    if (!hoverOnly) await _sleep(800);
                    if (isStale() || elGen !== myElGen) return;

                    // Phase 2 - scroll to end
                    el.style.transition = `transform ${scrollDuration}ms linear`;
                    el.style.transform = `translateX(-${overflow}px)`;
                    await _sleep(scrollDuration);
                    if (isStale() || elGen !== myElGen) return;

                    // Phase 3 - pause at end
                    await _sleep(700);
                    if (isStale() || elGen !== myElGen) return;

                    // Phase 4 - fade out
                    el.style.transition = "opacity 0.35s ease";
                    el.style.opacity = "0";
                    await _sleep(400);
                    if (isStale() || elGen !== myElGen) return;

                    // Phase 5 - snap back while invisible
                    el.style.transition = "none";
                    el.style.transform = "translateX(0)";

                    // Phase 6 - fade in (double rAF ensures the transition
                    // applies after the snap)
                    await new Promise(resolve =>
                        requestAnimationFrame(() => requestAnimationFrame(resolve))
                    );
                    if (isStale() || elGen !== myElGen) return;

                    el.style.transition = "opacity 0.35s ease";
                    el.style.opacity = "1";

                    await _sleep(1500);
                    runCycle();
                }

                runCycle();
            });
        }

        if (hoverOnly) {
            // Start scrolling when the row is hovered, reset immediately on leave
            const row = parent.closest(hoverTarget);
            if (row) {
                row.addEventListener("mouseenter", startMarquee);
                row.addEventListener("mouseleave", resetEl);
                scope.listeners.push([row, "mouseenter", startMarquee], [row, "mouseleave", resetEl]);
            }
            // ResizeObserver only resets position - no ambient animation
            const ro = new ResizeObserver(resetEl);
            ro.observe(parent);
            _marqueeObservers.push(ro);
            scope.observers.push(ro);
        } else {
            const ro = new ResizeObserver(startMarquee);
            ro.observe(parent);
            _marqueeObservers.push(ro);
            scope.observers.push(ro);
        }
    });

    return function disposeMarquee() {
        if (!scope.alive) return;
        scope.alive = false;
        for (const ro of scope.observers) {
            ro.disconnect();
            const i = _marqueeObservers.indexOf(ro);
            if (i !== -1) _marqueeObservers.splice(i, 1);
        }
        for (const [el, type, fn] of scope.listeners) el.removeEventListener(type, fn);
        scope.observers = [];
        scope.listeners = [];
    };
}

/* --- Exports --- */

EFTForge.utils.formatStat          = formatStat;
EFTForge.utils.withTimeout         = withTimeout;
EFTForge.utils.cacheSet            = cacheSet;
EFTForge.utils.cacheGet            = cacheGet;
EFTForge.utils.escapeHtml          = escapeHtml;
EFTForge.utils.startPanelLoading   = startPanelLoading;
EFTForge.utils.stopPanelLoading    = stopPanelLoading;
EFTForge.utils.showToast           = showToast;
EFTForge.utils.replaceToast        = replaceToast;
EFTForge.utils.updateBlobColor     = _updateBlobColor;
EFTForge.utils._createModalOverlay = _createModalOverlay;
EFTForge.utils._clearMarqueeTimers = _clearMarqueeTimers;
EFTForge.utils._sleep              = _sleep;
EFTForge.utils._initMarqueeText    = _initMarqueeText;
EFTForge.utils.setupEdgePanScroll  = setupEdgePanScroll;
