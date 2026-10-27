// Globals shared across the frontend's classic <script> files, for the type checker
// (`npm run typecheck`). Nothing here exists at runtime.
//
// Every script shares one global scope, so a top-level function in one file is
// already visible to the checker in every other file. Only names reached through
// `window.` or the EFTForge namespace need declaring here. When a script hangs a new
// name on either, add it below, or `npm run typecheck` will fail where it is used.
//
// Each script starts from `window.EFTForge = window.EFTForge || {}` and adds its own
// member, so all of them are optional. They are `any` for now; give one a real type
// once its module is checked.

interface EFTForgeNamespace {
    _dev?: any;
    ammoTable?: any;
    armorSim?: any;
    api?: any;
    atlas?: any;
    atlasMatching?: any;
    buildCodeCatalogs?: any;
    builder3d?: any;
    builder3dPanels?: any;
    calc?: any;
    com?: any;
    config?: any;
    desktopSettings?: any;
    dotParallax?: any;
    lang?: any;
    leaderboard?: any;
    mediaViewer?: any;
    news?: any;
    optimizer?: any;
    perfMetrics?: any;
    profile?: any;
    state?: any;
    statsPanel?: any;
    tabs?: any;
    tooltip?: any;
    tracker?: any;
    utils?: any;
}

declare var EFTForge: EFTForgeNamespace;

interface Window {
    EFTForge: EFTForgeNamespace;

    // Injected into index.html by backend/desktop.py in the desktop app, absent on the web.
    __EFTFORGE_DESKTOP__?: {
        appVersion: string;
        adminKey: string;
        communityMode: "local" | "connected";
    };
    // Tauri API, desktop app only.
    __TAURI__?: any;

    _AG_OVERRIDES: any;
    _AG_OVERRIDES_BASE: any;
    _SLOT_PLACEHOLDER_MAP: any;
    _agDevTool: any;
    _bpAmmo: any;
    _bpAmmoFor: any;
    _bpAmmoKey: any;
    _bpGetLastImageUrl: any;
    _bpGetLastKey: any;
    _bpGetPlaceholderUrl: any;
    _bpIsAwaiting: any;
    _bpIsEnabled: any;
    _bpIsGloballyDisabled: any;
    _bpIsInflight: any;
    _confirmUnlistMyBuild: any;
    _deleteComment: any;
    _deleteOwnComment: any;
    _devLastBatchResult: any;
    _slotPlaceholderHtml: any;
    _toggleBuildComments: any;
    _toggleCbTagFilter: any;
    _togglePendingTag: any;
    _toggleTagFilter: any;
    _updateTreeViewToggle: any;
    collectAllVisibleSlots: any;
    computeGridPositions: any;
    exportBuildImage: any;
    fetchBuildImageForExport: any;
    flashConflictInGrid: any;
    flashConflictSlotInGrid: any;
    flashGunCellInGrid: any;
    handleFavClick: any;
    initBpGlobalStatus: any;
    renderFullTree: any;
    resetBuildPreview: any;
    scheduleBuildPreview: any;
    showGridView: any;
    showListView: any;
    t: any;
    tClass: any;
    tFmt: any;
    tSlot: any;
    toggleFavoritesFilter: any;
    toggleImgGen: any;
    updateAttTableHeaderImg: any;
}

// State some modules keep on the DOM elements it belongs to.
interface Element {
    _ammoDisabledHandler?: (e: Event) => void; // stats-panel: only ever cleared, nothing sets it any more
    _comboEntry?: any; // slot-selector: the combo result a row renders
    _csPress?: (e: PointerEvent) => void; // utils: custom scrollbar rail press handler
    _csSkip?: boolean; // utils: opted out of the custom scrollbar
    _customScrollbar?: any; // utils: the custom scrollbar attached to this element
    _displayedBuilds?: any[]; // build-manager: community builds currently listed
    _displayedMyBuilds?: any[]; // build-manager: own builds currently listed
    _fx?: any; // gun-list: card hover effect state
    _myBuilds?: any[]; // build-manager: own builds fetched for this list
    _publicBuilds?: any[]; // build-manager: community builds fetched for this list
    _swipeRemoveFn?: () => void; // tree/slot-selector: detaches a row's swipe handler
}

// Third-party libraries loaded as plain scripts (marked.min.js, lzstring.min.js).
declare var marked: any;
declare var LZString: any;
