window.EFTForge = window.EFTForge || {};

/* exported blockedInBeta, proxyAvatarUrl, isMobileLayout, _formatPrice, setToastStatus, setupCustomScrollbar, setupCustomSelect -- called from other modules */

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

// Escape a short name for a .slot-shortname and wrap its Chinese runs, so they get the outline
// Bender Outline draws for everything else (.sn-cjk in styles.css).
function shortNameHtml(str) {
    return escapeHtml(str).replace(/[⺀-￿\u{10000}-\u{10FFFF}]+/gu, (run) => `<span class="sn-cjk">${run}</span>`);
}

/* --- Panel loading overlay --- */

function startPanelLoading(panelEl, delayMs = 0) {
    const state = { overlay: null, timer: null, release: null };
    const show = () => {
        // The 3D view spans the left panel and has its own loading veil: use that.
        if (panelEl?.classList.contains("left-panel") && EFTForge.builder3d?.isActive()) {
            state.release = EFTForge.builder3d.holdLoading();
            return;
        }
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
    if (state.release) state.release();
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
    const toasts = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".toast.show"));
    if (toasts.length > 0) {
        const blobColor = toasts[toasts.length - 1].dataset.blobColor;
        if (blobColor) document.documentElement.style.setProperty("--blob-color", blobColor);
    } else if (EFTForge.state.compareMode) {
        document.documentElement.style.setProperty("--blob-color", "rgba(0, 200, 180, 0.10)");
    } else if (EFTForge.state.priceView && EFTForge.state.priceMode !== "pvp") {
        const hex = EFTForge.state.priceMode === "pve" ? "#38759F" : "#288662";
        document.documentElement.style.setProperty("--blob-color", _hexToRgba(hex, 0.10));
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

// The beta reads the live community but never writes to it: every vote, publish, comment
// or profile change asks us first, and we turn it away with a note instead
function blockedInBeta() {
    if (!EFTForge.config.COMMUNITY_READ_ONLY) return false;
    const { t } = EFTForge.lang;
    showToast(t("toast.betaReadOnlyTitle"), t("toast.betaReadOnly"), 3000);
    return true;
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
            if (!/** @type {Element} */ (e.target).closest(".toast-action-btn")) state.dismiss();
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
        /** @type {NodeListOf<HTMLElement>} */ (overlay.querySelectorAll(".modal-tab")).forEach(btn => {
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

/* --- Overlays beside a scroller --- */

// Screen px per CSS px of n, so zoomed or scaled panels (the 3D stats dock) line up
function _overlayScale(n) {
    return n && n.offsetWidth ? n.getBoundingClientRect().width / n.offsetWidth : 1;
}

// el's padding box, in an overlay's own CSS px and containing block coordinates. The
// custom scrollbar's rails and the scroll fades both sit beside their scroller like this.
function _overlayFrame(el, overlay) {
    const host = overlay.offsetParent;
    if (!host) return null;
    const er = el.getBoundingClientRect();
    const sR = _overlayScale(overlay.parentElement);
    let ox, oy;
    if (host === document.body && getComputedStyle(host).position === "static") {
        ox = -window.scrollX;
        oy = -window.scrollY;
    } else {
        const hr = host.getBoundingClientRect();
        const sH = _overlayScale(host);
        ox = hr.left + (host.clientLeft - host.scrollLeft) * sH;
        oy = hr.top + (host.clientTop - host.scrollTop) * sH;
    }
    const k = _overlayScale(el) / sR;
    return {
        scale: sR,
        left: (er.left - ox) / sR + el.clientLeft * k,
        top: (er.top - oy) / sR + el.clientTop * k,
        width: el.clientWidth * k,
        height: el.clientHeight * k,
    };
}

/* --- Scroll fades --- */

// Darken each edge a table can still scroll toward, the way the build tab bar does: a strip
// on either side that fades in with how much is left to scroll that way. Like the custom
// scrollbar's rails, the strips sit beside the scroller rather than in it, so they stay on
// its edges while it scrolls. Returns { update, dispose }.
const _SCROLL_FADE_DISTANCE = 40;

function setupScrollFades(el) {
    if (!el || !el.parentNode) return null;
    if (el._scrollFades) return el._scrollFades;
    const strips = ["left", "right"].map(side => {
        const strip = document.createElement("div");
        strip.className = `scroll-fade scroll-fade-${side}`;
        strip.setAttribute("aria-hidden", "true");
        strip.hidden = true;
        return strip;
    });
    const abort = new AbortController();
    let rafId = null;

    function schedule() {
        if (rafId == null) rafId = requestAnimationFrame(update);
    }

    function update() {
        rafId = null;
        if (!el.isConnected) { dispose(); return; }
        const cs = getComputedStyle(el);
        const max = el.scrollWidth - el.clientWidth;
        const on = max > 1 && (cs.overflowX === "auto" || cs.overflowX === "scroll") && el.getClientRects().length > 0;
        strips.forEach(s => {
            if (on && s.parentNode !== el.parentNode) el.after(s);
            s.hidden = !on;
        });
        if (!on) return;
        const frame = _overlayFrame(el, strips[0]);
        if (!frame) return;
        // One layer above a host that stacks itself (the phone's results drawer)
        const hostZ = parseInt(cs.zIndex, 10);
        const reach = [el.scrollLeft, max - el.scrollLeft];
        strips.forEach((s, i) => {
            const st = s.style;
            st.zIndex = isNaN(hostZ) ? "" : String(hostZ + 1);
            st.top = frame.top + "px";
            st.height = frame.height + "px";
            st.left = (i === 0 ? frame.left : frame.left + frame.width - s.offsetWidth) + "px";
            st.opacity = String(Math.max(0, Math.min(1, reach[i] / _SCROLL_FADE_DISTANCE)));
        });
    }

    el.addEventListener("scroll", schedule, { signal: abort.signal, passive: true });
    // A drawer sliding in moves the scroller without resizing it
    el.addEventListener("transitionend", schedule, { signal: abort.signal });
    window.addEventListener("resize", schedule, { signal: abort.signal, passive: true });
    // The table growing or shrinking changes how far it scrolls, and the parent changing
    // size is what moves the scroller within it
    const ro = new ResizeObserver(schedule);
    function observe() {
        ro.disconnect();
        ro.observe(el);
        if (el.parentElement) ro.observe(el.parentElement);
        for (const child of el.children) ro.observe(child);
    }
    const mo = new MutationObserver(() => { observe(); schedule(); });
    mo.observe(el, { childList: true });
    observe();
    schedule();

    function dispose() {
        abort.abort();
        ro.disconnect();
        mo.disconnect();
        if (rafId != null) cancelAnimationFrame(rafId);
        strips.forEach(s => s.remove());
        delete el._scrollFades;
    }

    el._scrollFades = { update: schedule, dispose };
    return el._scrollFades;
}

// Give every table that can scroll sideways its edge fades, whether it's in the static
// markup or built later. A table scrolls with its nearest ancestor that scrolls sideways
// (a table wrapper, or the right panel itself for the ammo table), so that's where they go.
(function initScrollFades() {
    const pending = new Set();
    let rafId = null;
    function attach(table) {
        for (let n = table.parentElement; n && n !== document.body; n = n.parentElement) {
            const x = getComputedStyle(n).overflowX;
            if (x === "auto" || x === "scroll") {
                setupScrollFades(n);
                return;
            }
        }
    }
    function flush() {
        rafId = null;
        pending.forEach(root => {
            if (!root.isConnected) return;
            if (root.tagName === "TABLE") attach(root);
            root.querySelectorAll("table").forEach(attach);
        });
        pending.clear();
    }
    new MutationObserver(records => {
        records.forEach(r => r.addedNodes.forEach(n => { if (n instanceof Element) pending.add(n); }));
        if (pending.size && rafId == null) rafId = requestAnimationFrame(flush);
    }).observe(document.body, { childList: true, subtree: true });
    pending.add(document.body);
    rafId = requestAnimationFrame(flush);
})();

/* --- Custom scrollbar --- */

const _CS_AXES = {
    y: { pos: "scrollTop",  size: "scrollHeight", view: "clientHeight", client: "clientY", delta: "deltaY" },
    x: { pos: "scrollLeft", size: "scrollWidth",  view: "clientWidth",  client: "clientX", delta: "deltaX" },
};

// Swap an element's native scrollbar for our own overlay one: a slim rail that fades
// in while the pointer is over the element or it's scrolling, widens on hover, and
// supports thumb dragging, click-to-jump on the track, and wheel over the rail. The
// element stays the real scroller, so keyboard/wheel/touch scrolling and every scroll
// listener already on it keep working untouched. We mount the rail as a sibling, not a
// child, otherwise it would scroll away with the content. axis is "y", "x" or "both".
// Returns { update, dispose }, or null on touch devices, where the OS already draws
// transient overlay scrollbars and the native styling stays in place.
function setupCustomScrollbar(el, { axis = "y", inset = 2, minThumb = 24 } = {}) {
    if (!el || !el.parentNode) return null;
    if (el._customScrollbar) return el._customScrollbar;
    if (window.matchMedia?.("(pointer: coarse)").matches) return null;
    _csInstallPressGuard();

    const abort = new AbortController();
    const { signal } = abort;
    const bars = (axis === "both" ? ["y", "x"] : [axis]).map(a => {
        const rail = document.createElement("div");
        rail.className = `cs-rail cs-rail-${a}`;
        rail.setAttribute("aria-hidden", "true");
        rail.hidden = true;
        const thumb = document.createElement("div");
        thumb.className = "cs-thumb";
        rail.appendChild(thumb);
        return { a, k: _CS_AXES[a], rail, thumb, thick: 0, scale: 1, trackLen: 0, thumbLen: 0 };
    });

    el.classList.add("cs-host");
    // Sit one layer above hosts that stack themselves (dropdown lists, popovers)
    const hostZ = parseInt(getComputedStyle(el).zIndex, 10);
    if (!isNaN(hostZ)) bars.forEach(b => { b.rail.style.zIndex = String(hostZ + 1); });

    let rafId = null;
    // Auto-attach happens on pointerover, after the host's own pointerenter has passed
    let hoverEl = el.matches(":hover");
    let hoverRail = false;
    let scrolling = false;
    let scrollIdleTimer = null;
    let drag = null;

    function schedule() {
        if (rafId == null) rafId = requestAnimationFrame(update);
    }

    function syncVisible() {
        const on = hoverEl || hoverRail || scrolling || !!drag;
        bars.forEach(b => b.rail.classList.toggle("cs-visible", on));
    }

    // Show the rail for a moment, same as a scroll would
    function flash() {
        scrolling = true;
        syncVisible();
        clearTimeout(scrollIdleTimer);
        scrollIdleTimer = setTimeout(() => { scrolling = false; syncVisible(); }, 800);
    }

    function hostFrame(rail) {
        return _overlayFrame(el, rail);
    }

    function update() {
        rafId = null;
        // Popovers get removed outright; take the rail with them. It comes back if the
        // host is reinserted and grows scrollable again.
        if (!el.isConnected) {
            bars.forEach(b => { b.rail.remove(); b.rail.hidden = true; });
            return;
        }
        const shown = el.getClientRects().length > 0;
        // Hosts can flip to overflow:hidden later (modal locks, layout modes)
        const cs = shown ? getComputedStyle(el) : null;
        let appeared = false;
        for (const b of bars) {
            const mode = cs && (b.a === "y" ? cs.overflowY : cs.overflowX);
            const scrollable = (mode === "auto" || mode === "scroll") && el[b.k.size] - el[b.k.view] > 1;
            if (scrollable && b.rail.parentNode !== el.parentNode) el.after(b.rail);
            if (scrollable && b.rail.hidden) appeared = true;
            b.rail.hidden = !scrollable;
        }
        // A list that just opened (or just outgrew its box) hints that it scrolls
        if (appeared) flash();
        const yBar = bars.find(b => b.a === "y" && !b.rail.hidden);
        const xBar = bars.find(b => b.a === "x" && !b.rail.hidden);
        for (const b of bars) {
            if (b.rail.hidden) continue;
            const o = hostFrame(b.rail);
            if (!o) continue;
            b.scale = o.scale;
            if (!b.thick) b.thick = b.a === "y" ? b.rail.offsetWidth : b.rail.offsetHeight;
            // Leave the corner free when both rails are up so they don't overlap
            const other = b.a === "y" ? xBar : yBar;
            const cut = other ? other.thick || 0 : 0;
            const s = b.rail.style;
            if (b.a === "y") {
                b.trackLen = Math.max(0, o.height - inset * 2 - cut);
                s.top = (o.top + inset) + "px";
                s.left = (o.left + o.width - b.thick) + "px";
                s.height = b.trackLen + "px";
            } else {
                b.trackLen = Math.max(0, o.width - inset * 2 - cut);
                s.left = (o.left + inset) + "px";
                s.top = (o.top + o.height - b.thick) + "px";
                s.width = b.trackLen + "px";
            }
            const size = el[b.k.size];
            const view = el[b.k.view];
            const max = size - view;
            b.thumbLen = Math.min(b.trackLen, Math.max(minThumb, b.trackLen * view / size));
            const offset = max > 0 ? (b.trackLen - b.thumbLen) * (el[b.k.pos] / max) : 0;
            const ts = b.thumb.style;
            if (b.a === "y") {
                ts.height = b.thumbLen + "px";
                ts.transform = `translateY(${offset}px)`;
            } else {
                ts.width = b.thumbLen + "px";
                ts.transform = `translateX(${offset}px)`;
            }
        }
    }

    // px of scroll per px of thumb travel
    function scrollRatio(b) {
        const free = b.trackLen - b.thumbLen;
        return free > 0 ? (el[b.k.size] - el[b.k.view]) / free : 0;
    }

    function startDrag(b, e, captureEl) {
        drag = { b, id: e.pointerId, from: e[b.k.client], start: el[b.k.pos], prevBehavior: el.style.scrollBehavior };
        // Smooth scroll-behavior would make the content trail the thumb
        el.style.scrollBehavior = "auto";
        captureEl.setPointerCapture(e.pointerId);
        b.rail.classList.add("cs-dragging");
        document.documentElement.classList.add("cs-drag-active");
        syncVisible();
    }

    function endDrag() {
        if (!drag) return;
        el.style.scrollBehavior = drag.prevBehavior;
        drag.b.rail.classList.remove("cs-dragging");
        drag = null;
        document.documentElement.classList.remove("cs-drag-active");
        syncVisible();
    }

    for (const b of bars) {
        // Called by the press guard (_csInstallPressGuard), which owns the rail's pointerdown
        b.rail._csPress = (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            if (e.target !== b.thumb) {
                // Jump the thumb's center to the click, then keep dragging from there
                const r = b.rail.getBoundingClientRect();
                const at = (e[b.k.client] - (b.a === "y" ? r.top : r.left)) / b.scale - b.thumbLen / 2;
                el[b.k.pos] = at * scrollRatio(b);
                schedule();
            }
            startDrag(b, e, b.rail);
        };

        b.rail.addEventListener("pointermove", (e) => {
            if (!drag || drag.b !== b || e.pointerId !== drag.id) return;
            el[b.k.pos] = drag.start + (e[b.k.client] - drag.from) / b.scale * scrollRatio(b);
        }, { signal });

        b.rail.addEventListener("pointerup", endDrag, { signal });
        b.rail.addEventListener("pointercancel", endDrag, { signal });
        b.rail.addEventListener("lostpointercapture", endDrag, { signal });

        // The rail isn't inside el, so the wheel wouldn't reach it on its own
        b.rail.addEventListener("wheel", (e) => {
            e.preventDefault();
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el[b.k.view] : 1;
            el.scrollBy({ left: e.deltaX * unit, top: e.deltaY * unit });
        }, { signal, passive: false });

        b.rail.addEventListener("pointerenter", () => { hoverRail = true; syncVisible(); }, { signal });
        b.rail.addEventListener("pointerleave", () => { hoverRail = false; syncVisible(); }, { signal });
    }

    el.addEventListener("pointerenter", () => { hoverEl = true; syncVisible(); schedule(); }, { signal });
    el.addEventListener("pointerleave", () => { hoverEl = false; syncVisible(); }, { signal });
    el.addEventListener("scroll", () => { flash(); schedule(); }, { signal, passive: true });

    // el's own box changes resize the track; its children changing size (rows added,
    // images loading, sections collapsing) is what moves scrollHeight
    const ro = new ResizeObserver(schedule);
    function observeChildren() {
        ro.disconnect();
        ro.observe(el);
        for (const child of el.children) ro.observe(child);
    }
    const mo = new MutationObserver(() => { observeChildren(); schedule(); });
    mo.observe(el, { childList: true });
    observeChildren();
    schedule();

    function dispose() {
        abort.abort();
        ro.disconnect();
        mo.disconnect();
        clearTimeout(scrollIdleTimer);
        if (rafId != null) cancelAnimationFrame(rafId);
        endDrag();
        bars.forEach(b => b.rail.remove());
        el.classList.remove("cs-host");
        delete el._customScrollbar;
    }

    el._customScrollbar = { update: schedule, dispose };
    return el._customScrollbar;
}

// A rail press is never a press on the page. Rails sit beside their host rather than
// inside it, so click-outside handlers (custom selects, the advanced stats popover,
// several of which listen in the capture phase) would take it as an outside click and
// close. We catch rail presses on window in the capture phase, before any page listener
// sees them, run the rail's own handler and stop them there. preventDefault on mousedown
// also keeps focus where it is (the leaderboard gun picker closes when its input blurs).
let _csGuardInstalled = false;
function _csInstallPressGuard() {
    if (_csGuardInstalled) return;
    _csGuardInstalled = true;
    const guard = (e) => {
        const rail = e.target instanceof Element ? e.target.closest(".cs-rail") : null;
        if (!rail) return;
        e.stopPropagation();
        if (e.type === "pointerdown") rail._csPress?.(e);
        else if (e.type !== "click") e.preventDefault();
    };
    for (const type of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"]) {
        window.addEventListener(type, guard, true);
    }
}

// Scrollers that hide their bar on purpose (tab strip, mobile header/combo strips).
// Add data-native-scrollbar to opt anything else out.
const _CS_OPT_OUT = "#tab-bar-scroll, .header-scroll, .combo-icon-scroll, [data-native-scrollbar]";

function _csAutoAttach(el) {
    if (!(el instanceof Element) || el._customScrollbar || el._csSkip) return;
    if (el === document.documentElement || el === document.body) return;
    if (el.matches(_CS_OPT_OUT)) { el._csSkip = true; return; }
    const cs = getComputedStyle(el);
    const scrolls = v => v === "auto" || v === "scroll";
    const y = scrolls(cs.overflowY);
    const x = scrolls(cs.overflowX);
    if (!x && !y) return;
    setupCustomScrollbar(el, { axis: x && y ? "both" : y ? "y" : "x" });
}

// Hand every scroll container in the page our scrollbar, whether it's in the static
// markup or built later by a modal, table or panel. We attach lazily on first hover
// (walking up from the pointer, which covers nested scrollers) or first scroll, so
// nothing has to register itself and big re-renders don't pay for a DOM scan.
(function initAutoScrollbars() {
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    document.addEventListener("pointerover", (e) => {
        for (let n = /** @type {Element} */ (e.target); n && n !== document.body; n = n.parentElement) _csAutoAttach(n);
    }, { passive: true });
    document.addEventListener("scroll", (e) => _csAutoAttach(e.target), { capture: true, passive: true });
})();

/* --- Global tooltip (#eft-tooltip; also used by the standalone /atlas page, which loads this file without app.js) --- */

(function initTooltip() {
    const tip = document.getElementById("eft-tooltip");
    // index.html loads us before #eft-tooltip exists, so try again once the page is parsed
    if (!tip) {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initTooltip, { once: true });
        return;
    }

    let activeTarget = null;
    let _tipW = 0;
    let _tipH = 0;
    let _lastX = 0;
    let _lastY = 0;

    const OFFSET_X = 14;
    const OFFSET_Y = 18;

    function position(cx, cy) {
        const margin = 8;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // Default: below-right of cursor; flip when near viewport edges
        let left = cx + OFFSET_X;
        if (left + _tipW > vw - margin) left = cx - _tipW - OFFSET_X;

        let top = cy + OFFSET_Y;
        if (top + _tipH > vh - margin) top = cy - _tipH - OFFSET_Y;

        tip.style.left = left + "px";
        tip.style.top  = top  + "px";
    }

    function show(target, cx, cy) {
        const html = target.dataset.tooltipHtml;
        const text = target.dataset.tooltip;
        if (!html && !text) return;
        if (html) {
            tip.innerHTML = html;
            tip.classList.add("html-tip");
        } else {
            tip.textContent = text;
            tip.classList.remove("html-tip");
        }
        tip.classList.add("visible");
        activeTarget = target;
        // Read dimensions once after content is set; reused on every mousemove.
        _tipW = tip.offsetWidth;
        _tipH = tip.offsetHeight;
        position(cx, cy);
    }

    function hide() {
        tip.classList.remove("visible", "html-tip");
        activeTarget = null;
    }

    // Re-reads target.dataset.tooltip and repaints - for callers that mutate
    // the tooltip text of the currently-hovered element (e.g. a delete button
    // swapping to a "Confirm?" prompt). mouseover only fires on a fresh
    // hover, so without this the new text wouldn't show until the mouse left
    // and re-entered the element.
    function refresh(target) {
        if (target === activeTarget) show(target, _lastX, _lastY);
    }

    // A tooltip for something outside our page (the 3D viewer's frame reports its own),
    // at page coordinates; null text hides it. The next hover of ours takes over as usual.
    const EXTERNAL = { dataset: {} };
    function showAt(text, cx, cy) {
        if (!text) { if (activeTarget === EXTERNAL) hide(); return; }
        if (activeTarget === EXTERNAL && EXTERNAL.dataset.tooltip === text) { position(cx, cy); return; }
        EXTERNAL.dataset.tooltip = text;
        show(EXTERNAL, cx, cy);
    }

    document.addEventListener("mousemove", (e) => {
        _lastX = e.clientX;
        _lastY = e.clientY;
        if (activeTarget) position(e.clientX, e.clientY);
    }, { passive: true });

    document.addEventListener("mouseover", (e) => {
        let target = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest("[data-tooltip], [data-tooltip-html]"));

        // Convert native title attributes to data-tooltip on first hover so
        // the browser never shows its default tooltip (e.g. from markdown content)
        if (!target) {
            const titled = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest("[title]"));
            if (titled) {
                const text = titled.getAttribute("title");
                if (text) {
                    titled.dataset.tooltip = text;
                    titled.removeAttribute("title");
                    target = titled;
                }
            }
        }

        if (!target) { hide(); return; }
        if (target === activeTarget) return;
        show(target, e.clientX, e.clientY);
    });

    // Hide when mouse leaves the document
    document.addEventListener("mouseleave", hide, true);

    window.EFTForge.tooltip = { hide, refresh, showAt };
})();

/* --- Custom select (also used by the standalone /atlas page, which loads this file without app.js) --- */

function setupCustomSelect(selectId) {
    const sel = /** @type {HTMLSelectElement | null} */ (document.getElementById(selectId));
    if (!sel) return null;

    // The hidden native select would otherwise remain an invisible tab stop
    sel.tabIndex = -1;

    const wrapper = document.createElement("div");
    wrapper.className = "custom-select-wrapper";
    wrapper.id = selectId + "-custom";
    sel.parentNode.insertBefore(wrapper, sel.nextSibling);

    const trigger = document.createElement("div");
    trigger.className = "custom-select-trigger";
    trigger.tabIndex = 0;
    trigger.setAttribute("role", "button");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    wrapper.appendChild(trigger);

    const list = document.createElement("div");
    list.className = "custom-select-list";
    wrapper.appendChild(list);

    let _disposeOptionMarquee = null;

    function syncTrigger() {
        const selected = sel.options[sel.selectedIndex];
        trigger.innerHTML = "";
        if (selected) {
            trigger.appendChild(document.createTextNode(selected.textContent));
        }
        /** @type {NodeListOf<HTMLElement>} */ (list.querySelectorAll(".custom-select-option")).forEach(item => {
            item.classList.toggle("selected", item.dataset.value === sel.value);
        });
    }

    function rebuild() {
        if (_disposeOptionMarquee) _disposeOptionMarquee();
        list.innerHTML = "";
        Array.from(sel.options).forEach((opt, i) => {
            const item = document.createElement("div");
            item.className = "custom-select-option" + (opt.selected ? " selected" : "");
            item.dataset.value = opt.value;
            item.style.setProperty("--i", String(i));
            const text = document.createElement("span");
            text.className = "marquee-text";
            text.appendChild(document.createTextNode(opt.textContent));
            item.appendChild(text);
            item.addEventListener("click", () => {
                sel.value = opt.value;
                sel.dispatchEvent(new Event("change"));
                setOpen(false);
                syncTrigger();
            });
            list.appendChild(item);
        });
        syncTrigger();
        _disposeOptionMarquee = _initMarqueeText(list, { hoverOnly: true, hoverTarget: ".custom-select-option" });
    }

    function setOpen(open) {
        wrapper.classList.toggle("open", open);
        trigger.setAttribute("aria-expanded", String(open));
    }

    trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        // close any other open custom selects
        document.querySelectorAll(".custom-select-wrapper.open").forEach(w => {
            if (w !== wrapper) {
                w.classList.remove("open");
                w.querySelector(".custom-select-trigger")?.setAttribute("aria-expanded", "false");
            }
        });
        setOpen(!wrapper.classList.contains("open"));
    });

    trigger.addEventListener("keydown", (e) => {
        // mirror the pointer-events:none mouse block of disabled selects
        if (wrapper.classList.contains("ammo-disabled")) return;
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            trigger.click();
        } else if (e.key === "Escape") {
            setOpen(false);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            // Closed-state native select behavior: arrows step through options
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            const next = sel.selectedIndex + step;
            if (next < 0 || next >= sel.options.length) return;
            sel.selectedIndex = next;
            sel.dispatchEvent(new Event("change"));
            syncTrigger();
        }
    });

    const closeOnOutsideClick = () => setOpen(false);
    document.addEventListener("click", closeOnOutsideClick);

    // rebuild when options are added/removed
    const observer = new MutationObserver(rebuild);
    observer.observe(sel, { childList: true });

    // sync trigger when value is set programmatically via input event
    sel.addEventListener("input", syncTrigger);

    rebuild();
    const scrollbar = setupCustomScrollbar(list, { inset: 4 });
    // Release observers and the document listener before replacing a dynamic form.
    wrapper.addEventListener("eftforge:dispose-select", () => {
        document.removeEventListener("click", closeOnOutsideClick);
        observer.disconnect();
        if (_disposeOptionMarquee) _disposeOptionMarquee();
        if (scrollbar) scrollbar.dispose();
    }, { once: true });
    return wrapper;
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
                const horizontalPadding = parseFloat(parentStyle.paddingLeft || "0") + parseFloat(parentStyle.paddingRight || "0");
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

/* --- Atlas read state (the Atlas button badge in app.js and the /atlas page share it) --- */

// One read list per game: marking a set read prunes ids its own index no longer lists, so
// a shared list would lose the other game's.
const ATLAS_READ_STORAGE      = { eft: "eftforge_atlas_read", arena: "eftforge_atlas_arena_read" };
const ATLAS_BADGE_OFF_STORAGE = "eftforge_atlas_badge_off";
// "local" when Atlas shows times in the viewer's own zone; absent means UTC+8. One choice
// for every Atlas page.
const ATLAS_TZ_STORAGE        = "eftforge_atlas_tz";
const ATLAS_NEW_DAYS          = 7;   // older sets never count as new

/**
 * @param {string} [game]
 * @returns {Set<string>}
 */
function atlasReadIds(game = "eft") {
    try {
        const ids = JSON.parse(localStorage.getItem(ATLAS_READ_STORAGE[game]) || "[]");
        return new Set(Array.isArray(ids) ? ids : []);
    } catch {
        return new Set();
    }
}

// Remember a set as read. Keep only ids still listed, so the list can't grow forever.
/**
 * @param {string} id
 * @param {string[]} listed
 * @param {string} [game]
 */
function markAtlasRead(id, listed, game = "eft") {
    const read = atlasReadIds(game);
    if (read.has(id)) return;
    read.add(id);
    const keep = new Set(listed);
    try {
        localStorage.setItem(ATLAS_READ_STORAGE[game], JSON.stringify([...read].filter(x => keep.has(x))));
    } catch { /* private mode: it just counts as new again next time */ }
}

// New for this viewer: one they can open (public, or unlocked by their key), detected in
// the last week, and not opened yet. A set the public can't open yet isn't new to them.
/**
 * @param {{ id: string, detected: string, locked?: boolean }} set
 * @param {number} now
 * @param {Set<string>} read
 */
function isAtlasUnread(set, now, read) {
    return !set.locked && Date.parse(set.detected) >= now - ATLAS_NEW_DAYS * 24 * 3600 * 1000 && !read.has(set.id);
}

function atlasBadgeHidden() {
    try { return localStorage.getItem(ATLAS_BADGE_OFF_STORAGE) === "1"; } catch { return false; }
}

/** @param {boolean} hidden */
function setAtlasBadgeHidden(hidden) {
    try {
        if (hidden) localStorage.setItem(ATLAS_BADGE_OFF_STORAGE, "1");
        else localStorage.removeItem(ATLAS_BADGE_OFF_STORAGE);
    } catch { /* private mode: the choice just won't persist */ }
}

function atlasLocalTime() {
    try { return localStorage.getItem(ATLAS_TZ_STORAGE) === "local"; } catch { return false; }
}

/** @param {boolean} local */
function setAtlasLocalTime(local) {
    try {
        if (local) localStorage.setItem(ATLAS_TZ_STORAGE, "local");
        else localStorage.removeItem(ATLAS_TZ_STORAGE);
    } catch { /* private mode: the choice just won't persist */ }
}

// Spread into Intl.DateTimeFormat options: UTC+8, or nothing so the browser's own zone applies.
function atlasZoneOptions() {
    return atlasLocalTime() ? {} : { timeZone: "Asia/Shanghai" };
}

// The zone a time is shown in, for the label after it: "UTC+8", or the viewer's zone at that
// moment ("EDT", or "UTC-4" where the browser has no short name), so a screenshot always says.
/** @param {Date} date */
function atlasZoneLabel(date) {
    if (!atlasLocalTime()) return "UTC+8";
    const part = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(date)
        .find(p => p.type === "timeZoneName");
    const name = part ? part.value : "";
    return !name || /^GMT/.test(name) ? `UTC${name.slice(3)}` : name;
}

// Seconds the shown zone is ahead of UTC at a moment (unix seconds), for lining chart ticks
// up with its whole hours and days.
/** @param {number} t */
function atlasZoneOffset(t) {
    return atlasLocalTime() ? -new Date(t * 1000).getTimezoneOffset() * 60 : 8 * 3600;
}

/* --- Exports --- */

EFTForge.utils.formatStat          = formatStat;
EFTForge.utils.withTimeout         = withTimeout;
EFTForge.utils.cacheSet            = cacheSet;
EFTForge.utils.cacheGet            = cacheGet;
EFTForge.utils.escapeHtml          = escapeHtml;
EFTForge.utils.shortNameHtml       = shortNameHtml;
EFTForge.utils.startPanelLoading   = startPanelLoading;
EFTForge.utils.stopPanelLoading    = stopPanelLoading;
EFTForge.utils.showToast           = showToast;
EFTForge.utils.replaceToast        = replaceToast;
EFTForge.utils.updateBlobColor     = _updateBlobColor;
EFTForge.utils._createModalOverlay = _createModalOverlay;
EFTForge.utils._clearMarqueeTimers = _clearMarqueeTimers;
EFTForge.utils._sleep              = _sleep;
EFTForge.utils._initMarqueeText    = _initMarqueeText;
EFTForge.utils.atlasReadIds        = atlasReadIds;
EFTForge.utils.markAtlasRead       = markAtlasRead;
EFTForge.utils.isAtlasUnread       = isAtlasUnread;
EFTForge.utils.atlasBadgeHidden    = atlasBadgeHidden;
EFTForge.utils.setAtlasBadgeHidden = setAtlasBadgeHidden;
EFTForge.utils.atlasLocalTime      = atlasLocalTime;
EFTForge.utils.setAtlasLocalTime   = setAtlasLocalTime;
EFTForge.utils.atlasZoneOptions    = atlasZoneOptions;
EFTForge.utils.atlasZoneLabel      = atlasZoneLabel;
EFTForge.utils.atlasZoneOffset     = atlasZoneOffset;
EFTForge.utils.ATLAS_READ_STORAGE      = ATLAS_READ_STORAGE;
EFTForge.utils.ATLAS_BADGE_OFF_STORAGE = ATLAS_BADGE_OFF_STORAGE;

/**
 * @param {HTMLElement} dots
 * @param {HTMLElement} container
 */
EFTForge.utils.initDotParallax = function (dots, container) {
    const STRENGTH = 7;
    const listeners = new Set();
    let _rafPending = false;
    let _mouseX = 0, _mouseY = 0;
    let _offset = [0, 0];

    // Move only the dots' own layer so we can shift the grid without repainting.
    function _apply() {
        _rafPending = false;
        const x = (_mouseX / window.innerWidth  - 0.5) * STRENGTH;
        const y = (_mouseY / window.innerHeight - 0.5) * STRENGTH;
        if (x === _offset[0] && y === _offset[1]) return;
        _offset = [x, y];
        dots.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        listeners.forEach(fn => fn(x, y));
    }

    // Accept page coordinates from mouse moves and the 3D viewer iframe.
    function pointer(x, y) {
        _mouseX = x;
        _mouseY = y;
        if (_rafPending) return;
        _rafPending = true;
        requestAnimationFrame(_apply);
    }

    // Start the tiles at the viewport's corner, wherever the build area sits.
    function _align() {
        const r = container.getBoundingClientRect();
        dots.style.backgroundPosition = `${-r.left}px ${-r.top}px`;
    }

    document.addEventListener("mousemove", e => pointer(e.clientX, e.clientY), { passive: true });
    new ResizeObserver(_align).observe(container);
    _align();
    window.EFTForge = window.EFTForge || {};
    EFTForge.dotParallax = {
        pointer,
        // Expose the current shift in CSS pixels and notify subscribers of changes.
        get offset() { return _offset; },
        onChange(fn) { listeners.add(fn); },
    };
};
