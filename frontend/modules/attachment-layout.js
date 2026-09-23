window.EFTForge = window.EFTForge || {};

EFTForge.attachmentLayout = (() => {
    const GUN_COL = 7;
    const GUN_SPAN = 3;
    const COLS = 10;
    const BODY_ORDER = ["receiver", "handguard", "catch", "barrel", "gas_block", "muzzle"];
    const FRAME_ROLES = new Set([...BODY_ORDER, "stock", "pistol_grip", "grip"]);
    const RECEIVER_ROLES = new Set(["receiver", "stock", "pistol_grip", "grip"]);
    const CONTINUATIONS = new Set([...BODY_ORDER, "stock", "rear_sight", "front_sight"]);
    const ROLE_ORDER = [...BODY_ORDER, "stock", "scope", "rear_sight", "front_sight", "charge",
        "magazine", "pistol_grip", "foregrip", "bipod", "launcher", "tactical", "mount"];
    const HANDGUARD_PORTS = new Map([
        ["left", { delta: -1, direction: 1 }],
        ["right", { delta: 1, direction: 1 }],
        ["bottom", { delta: 0, direction: 1 }],
        ["top", { delta: 0, direction: -1 }],
        ["offset_left", { delta: -1, direction: -1 }],
    ]);

    function compareText(a, b) {
        return a < b ? -1 : a > b ? 1 : 0;
    }

    function compareNodes(a, b) {
        const rank = role => ROLE_ORDER.includes(role) ? ROLE_ORDER.indexOf(role) : ROLE_ORDER.length;
        return rank(a.role) - rank(b.role) || compareText(a.order, b.order) || compareText(a.id, b.id);
    }

    function inContext(node, roles) {
        for (let owner = node.parent; owner; owner = owner.parent) {
            if (!roles.has(owner.role)) return false;
        }
        return true;
    }

    function clampCol(col) {
        return Math.max(1, Math.min(COLS, col));
    }

    function compute(entries) {
        const nodes = new Map();
        for (const entry of entries) {
            if (typeof entry.id !== "string" || !entry.id) {
                throw new TypeError("Attachment layout requires a nonempty instance path");
            }
            if (nodes.has(entry.id)) throw new RangeError(`Duplicate attachment layout path: ${entry.id}`);
            nodes.set(entry.id, {
                id: entry.id, parentId: entry.parentId, role: entry.role, mount: entry.mount,
                order: String(entry.order ?? entry.id), children: [], parent: null, depth: 0,
            });
        }

        const roots = [];
        for (const node of nodes.values()) {
            node.parent = nodes.get(node.parentId) ?? null;
            if (node.parent) node.parent.children.push(node);
            else roots.push(node);
        }
        const ordered = [];
        const pending = roots.slice();
        while (pending.length) {
            const node = pending.pop();
            node.children.sort(compareNodes);
            ordered.push(node);
            for (const child of node.children) {
                child.depth = node.depth + 1;
                pending.push(child);
            }
        }
        if (ordered.length !== nodes.size) {
            throw new RangeError("Attachment layout cannot contain an ancestry cycle");
        }
        ordered.sort((a, b) => a.depth - b.depth || compareNodes(a, b));

        const positions = new Map();
        const anchors = new Set();
        const occupied = new Set();
        for (let col = GUN_COL; col < GUN_COL + GUN_SPAN; col++) occupied.add(`${col},0`);

        function anchor(node, col, row, direction = 1) {
            if (!node || anchors.has(node.id)) return;
            while (occupied.has(`${col},${row}`)) row += direction;
            anchors.add(node.id);
            positions.set(node.id, { col, row });
            occupied.add(`${col},${row}`);
        }

        function first(role, context = FRAME_ROLES) {
            return ordered.find(node => node.role === role && inContext(node, context));
        }

        // Reserve the weapon silhouette before any accessory can consume its cells.
        // Promote structural slots through receivers/chassis without moving their owners.
        const primaryBody = new Map();
        for (const role of BODY_ORDER) {
            const node = first(role);
            if (node) primaryBody.set(role, node);
        }
        let bodyCol = GUN_COL - 1;
        for (const node of primaryBody.values()) anchor(node, bodyCol--, 0);
        anchor(first("stock"), 10, 0);
        anchor(first("magazine"), 8, 1);
        anchor(first("pistol_grip"), 9, 1);
        anchor(first("charge"), 10, -1, -1);
        anchor(first("rear_sight"), 9, -1, -1);

        const front = first("front_sight");
        const frontOwner = primaryBody.get("muzzle") ?? primaryBody.get("barrel") ?? primaryBody.get("handguard");
        const frontCol = frontOwner ? positions.get(frontOwner.id).col : Math.max(1, bodyCol);
        anchor(front, frontCol, -1, -1);

        const optic = ordered.find(node => ["scope", "mount"].includes(node.role) && inContext(node, RECEIVER_ROLES));
        anchor(optic, 8, -1, -1);
        for (const role of ["foregrip", "bipod", "launcher"]) anchor(first(role, RECEIVER_ROLES), 7, 1);

        // Extend repeated body/stock parts vertically before laying out their accessories.
        // Keep their child sights and rails eligible for their own functional directions.
        for (const node of ordered) {
            if (anchors.has(node.id) || !inContext(node, FRAME_ROLES)) continue;
            const body = primaryBody.get(node.role);
            if (!body && node.role !== "stock") continue;
            const parent = node.parent ? positions.get(node.parent.id) : null;
            const col = body ? positions.get(body.id).col : 10;
            anchor(node, col, Math.max(1, (parent?.row ?? 0) + 1));
        }

        // Start a visual branch at every unanchored child of the weapon or an anchor.
        // Preserve the real parent paths for selection and highlighting in the renderer.
        const branchRoots = ordered.filter(node => !anchors.has(node.id) && (!node.parent || anchors.has(node.parent.id)));
        const mountIndexes = new Map();

        function handguardPort(node) {
            if (node.parent?.role !== "handguard") return null;
            const measured = HANDGUARD_PORTS.get(node.mount);
            if (measured) return measured;
            if (!["tactical", "mount"].includes(node.role)) return null;
            // Spread unmeasured rails below the owner without claiming their physical side.
            const siblings = node.parent.children.filter(child =>
                ["tactical", "mount"].includes(child.role) && !HANDGUARD_PORTS.has(child.mount));
            return { delta: [-1, 1, 0][siblings.indexOf(node) % 3], direction: 1 };
        }

        function plan(node) {
            const owner = node.parent;
            const parent = owner ? positions.get(owner.id) : { col: 7, row: 0 };
            const col = parent.col;
            const port = handguardPort(node);
            if (port) {
                return { col: clampCol(col + port.delta), row: parent.row + port.direction,
                    direction: port.direction, priority: 5, fixedLane: true };
            }
            if (node.role === "stock") {
                return { col: 10, row: Math.max(1, parent.row + 1), direction: 1, priority: 0 };
            }
            if (["rear_sight", "front_sight"].includes(node.role)) {
                const sightCol = owner?.role === node.role ? col : node.role === "rear_sight" ? 9 : frontCol;
                return { col: sightCol, row: Math.min(-1, parent.row - 1), direction: -1, priority: 0 };
            }
            if (node.role === "scope" || (node.role === "mount" && inContext(node, RECEIVER_ROLES))) {
                return { col: inContext(node, RECEIVER_ROLES) ? 8 : col,
                    row: Math.min(-1, parent.row - 1), direction: -1, priority: 10 };
            }
            if (node.role === "tactical") {
                return { col, row: Math.min(-1, parent.row - 1), direction: -1, priority: 20 };
            }
            if (["foregrip", "bipod", "launcher"].includes(node.role)) {
                return { col: node.role === "launcher" && owner ? 6 : col,
                    row: Math.max(1, parent.row + 1), direction: 1, priority: 20 };
            }
            if (node.role === "charge") return { col: 7, row: 1, direction: 1, priority: 20 };
            if (node.role === "magazine" || node.role === "pistol_grip") {
                return { col: node.role === "magazine" ? 8 : 9,
                    row: Math.max(1, parent.row + 1), direction: 1, priority: 20 };
            }
            if (node.role === "mount" && owner && BODY_ORDER.includes(owner.role)) {
                const index = mountIndexes.get(owner.id) ?? 0;
                mountIndexes.set(owner.id, index + 1);
                return { col: clampCol(col + [-1, 1, 0][index % 3]),
                    row: Math.max(1, parent.row + 1) + Math.floor(index / 3), direction: 1, priority: 30 };
            }
            const direction = parent.row < 0 ? -1 : 1;
            return { col, row: parent.row + direction, direction, priority: 40 };
        }

        // Keep a branch within its owner's neighboring lanes. Repeated structural
        // slots and single-child adapters continue in one column, even at depth.
        function measure(node, col, direction, lanes) {
            const cells = [{ id: node.id, col, row: 0 }];
            const used = new Set([`${col},0`]);
            const children = node.children.filter(child => !anchors.has(child.id));
            for (let index = 0; index < children.length; index++) {
                const child = children[index];
                let childCol = col;
                const port = handguardPort(child);
                const childDirection = port?.direction ?? direction;
                if (port) {
                    childCol = clampCol(col + port.delta);
                } else if (children.length > 1 && !(child.role === node.role && CONTINUATIONS.has(child.role))) {
                    childCol = Math.max(lanes.min, Math.min(lanes.max, col + [-1, 1, 0][index % 3]));
                }
                const childLanes = port ? { min: childCol, max: childCol } : lanes;
                const branch = measure(child, childCol, childDirection, childLanes);
                let offset = childDirection;
                while (branch.some(cell => used.has(`${cell.col},${cell.row + offset}`))) offset += childDirection;
                for (const cell of branch) {
                    const placed = { ...cell, row: cell.row + offset };
                    cells.push(placed);
                    used.add(`${placed.col},${placed.row}`);
                }
            }
            return cells;
        }

        const branches = branchRoots.map(node => ({ node, ...plan(node) }));
        branches.sort((a, b) => a.priority - b.priority || a.node.depth - b.node.depth || compareNodes(a.node, b.node));
        for (const branch of branches) {
            const owner = branch.node.parent;
            const laneCenter = branch.node.role === "mount" && owner && BODY_ORDER.includes(owner.role)
                ? positions.get(owner.id).col : branch.col;
            // Keep descendants of a physical port in that port's lane through adapters.
            const lanes = branch.fixedLane ? { min: branch.col, max: branch.col }
                : { min: clampCol(laneCenter - 1), max: clampCol(laneCenter + 1) };
            const cells = measure(branch.node, branch.col, branch.direction, lanes);
            let offset = branch.row;
            while (cells.some(cell => occupied.has(`${cell.col},${cell.row + offset}`))) offset += branch.direction;
            for (const cell of cells) {
                const row = cell.row + offset;
                positions.set(cell.id, { col: cell.col, row });
                occupied.add(`${cell.col},${row}`);
            }
        }

        const rows = [0, ...Array.from(positions.values(), position => position.row)];
        const minRow = Math.min(...rows);
        const maxRow = Math.max(...rows);
        for (const [id, position] of positions) {
            positions.set(id, { col: position.col, row: position.row - minRow + 1, extras: false });
        }
        return { positions, gunCol: GUN_COL, gunRow: 1 - minRow, gunSpan: GUN_SPAN,
            totalCols: COLS, totalRows: maxRow - minRow + 1 };
    }

    return { compute };
})();
