window.EFTForge = window.EFTForge || {};

async function refreshBuildStats() {
  if (!EFTForge.state.currentGun) return null;

  const attachmentIds = collectAttachmentIds(EFTForge.state.buildTree);

  const toggle = document.getElementById("full-mag-toggle");
  const ammoSelect = document.getElementById("ammo-select");
  const assumeFull = toggle ? toggle.checked : false;
  const selectedAmmo = ammoSelect ? ammoSelect.value : null;
  const strengthLevel = EFTForge.state.currentStrengthLevel;

  try {
      const data = await calculateBuild({
          base_item_id: EFTForge.state.currentGun.id,
          attachment_ids: attachmentIds,
          assume_full_mag: assumeFull,
          selected_ammo_id: selectedAmmo,
          strength_level: strengthLevel,
          equip_ergo_modifier: EFTForge.state.currentEquipErgoModifier
      });
      updateStatsPanel(data);
      return data;

  } catch (err) {
      console.error("Failed to calculate build stats:", err);
      showToast(t("toast.connectionError"), t("toast.serverUnreachable") + " " + (EFTForge.config.IS_LOCAL_DEV ? t("toast.networkHintDev") : t("toast.networkHintProd")), 5000);
      return null;
  }
}

async function updateStatsPanel(data) {
  const { t } = EFTForge.lang;

  const statsBox = document.getElementById("stats");

  if (!EFTForge.state.currentGun) {
    statsBox.innerHTML = `
      <div style="opacity:0.5; padding:40px; text-align:center;">
        ${t("stats.selectWeapon")}
      </div>
    `;
    return;
  }

    if (!data) {
        return;
    }

  // Create controls once
  if (!document.getElementById("stats-content")) {

    statsBox.innerHTML = `
      <div class="mag-controls">
        <label>
          <input type="checkbox" id="full-mag-toggle" checked>
          ${t("stats.fullMag")}
        </label>
        <select id="ammo-select"></select>
      </div>

      <div id="stats-content"></div>
    `;

    document
      .getElementById("full-mag-toggle")
      .addEventListener("change", refreshBuildStats);

    document
      .getElementById("ammo-select")
      .addEventListener("change", () => {
        const caliber = EFTForge.state.currentGun?.caliber;
        if (caliber) {
          const sel = document.getElementById("ammo-select");
          const prefs = JSON.parse(localStorage.getItem("eftforge_ammo_prefs") || "{}");
          prefs[caliber] = sel.value;
          localStorage.setItem("eftforge_ammo_prefs", JSON.stringify(prefs));
        }
        refreshBuildStats();
      });

    await loadAmmoForGun(EFTForge.state.currentGun);
    await refreshBuildStats();
    return;
  }

  const content = document.getElementById("stats-content");

  const savedStaminaPanel = document.getElementById("stamina-panel");
  const savedEquipErgoPanel = document.getElementById("equip-ergo-panel");
  savedStaminaPanel?.remove();
  savedEquipErgoPanel?.remove();

  const eed = parseFloat(data.evo_ergo_delta ?? 0);
  const totalErgo = parseFloat(data.total_ergo ?? 0);
  const totalWeight = parseFloat(data.total_weight ?? 0);
  EFTForge.state.lastTotalWeight = totalWeight;
  EFTForge.state.lastTotalErgo = totalErgo;
  EFTForge.state.lastRecoilV = data.recoil_vertical ?? null;
  EFTForge.state.lastRecoilH = data.recoil_horizontal ?? null;
  EFTForge.state.lastEED = parseFloat(data.evo_ergo_delta ?? 0);

  const eedClass = eed >= 0 ? "positive" : "negative";
  const overswingClass = data.overswing ? "negative" : "positive";

  const armStamina = parseFloat(data.arm_stamina ?? 0);

  // Snapshot current fill widths so the transition starts from the previous value
  const prevFills = content.querySelectorAll(".stat-bar-fill");
  const isFirstRender = prevFills.length === 0;
  const prevErgoW = prevFills[0]?.style.width || "0%";
  const prevRVW   = prevFills[1]?.style.width || "0%";
  const prevRHW   = prevFills[2]?.style.width || "0%";

  if (isFirstRender) {
    content.style.height = "0";
    content.style.overflow = "hidden";
    content.style.opacity = "0";
  }

  content.innerHTML = `
    <div class="stats-section">
      <div class="section-title">${t("stats.title")}</div>

      <div class="stat-bar-row">
        <div class="stat-bar-label">${t("stats.ergo")}</div>
        <div class="stat-bar-track">
          <div class="stat-bar-fill ergo-bar" style="width:${prevErgoW}" data-target="${Math.min(totalErgo, 100)}"></div>
          <div class="stat-bar-value">${Math.abs(totalErgo - Math.round(totalErgo)) < 0.001 ? Math.round(totalErgo) : totalErgo.toFixed(1)}</div>
        </div>
      </div>

      <div class="stat-bar-row">
        <div class="stat-bar-label">${t("stats.verRecoil")}</div>
        <div class="stat-bar-track">
          <div class="stat-bar-fill recoil-bar" style="width:${prevRVW}" data-target="${data.recoil_vertical !== null && data.recoil_vertical !== undefined ? Math.min(Math.round(data.recoil_vertical), 500) / 5 : 0}"></div>
          <div class="stat-bar-value">${data.recoil_vertical !== null && data.recoil_vertical !== undefined ? Math.round(data.recoil_vertical) : "—"}</div>
        </div>
      </div>

      <div class="stat-bar-row">
        <div class="stat-bar-label">${t("stats.horRecoil")}</div>
        <div class="stat-bar-track">
          <div class="stat-bar-fill recoil-bar" style="width:${prevRHW}" data-target="${data.recoil_horizontal !== null && data.recoil_horizontal !== undefined ? Math.min(Math.round(data.recoil_horizontal), 500) / 5 : 0}"></div>
          <div class="stat-bar-value">${data.recoil_horizontal !== null && data.recoil_horizontal !== undefined ? Math.round(data.recoil_horizontal) : "—"}</div>
        </div>
      </div>

      <div class="stats-divider"></div>

      <div class="stat-row stat-row-weight"><span class="stat-label">${t("stats.weight")}</span><span>${totalWeight.toFixed(3)} kg</span></div>
      <div class="stat-row stat-row-eed">
        <span class="stat-label">${t("stats.eed")}<span class="stamina-info-btn${eed >= 0 && eed < 7 && EFTForge.state.currentEquipErgoModifier === 0 ? " eed-warn-active" : ""}" id="equip-ergo-info-btn" title="Configure equipment ergonomics modifier">i</span>:</span>
        <span id="eed-value-span" class="${eedClass}">${eed > 0 ? "+" : ""}${eed.toFixed(1)}</span>${eed >= 0 && eed < 7 && EFTForge.state.currentEquipErgoModifier === 0 ? `<span class="eed-warning-icon" data-tooltip="${t("stats.eedWarnTooltip")}">⚠</span>` : ""}
      </div>
      <div class="stat-row">
        <span class="stat-label">${t("stats.overswing")}</span>
        <span id="overswing-value-span" class="${overswingClass}">${data.overswing ? t("stats.yes") : t("stats.no")}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">${t("stats.armStamina")}<span class="stamina-info-btn" id="stamina-info-btn" title="Configure strength level">i</span>:</span>
        <span>${armStamina.toFixed(1)}s</span>
      </div>
    </div>
  `;

  // On first render, grow height from 0 so the tree slides down smoothly
  if (isFirstRender) {
    const targetHeight = content.scrollHeight;
    content.style.transition = "height 0.3s ease, opacity 0.25s ease";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      content.style.height = targetHeight + "px";
      content.style.opacity = "1";
    }));
    const onHeightDone = (e) => {
      if (e.propertyName !== "height") return;
      content.removeEventListener("transitionend", onHeightDone);
      content.style.height = "";
      content.style.overflow = "";
      content.style.opacity = "";
      content.style.transition = "";
    };
    content.addEventListener("transitionend", onHeightDone);
  }

  // Animate stat bar fills from 0 to their target widths
  requestAnimationFrame(() => requestAnimationFrame(() => {
    content.querySelectorAll(".stat-bar-fill[data-target]").forEach(el => {
      el.style.width = el.dataset.target + "%";
    });
  }));

  // Toggle panel on i button click
  document.getElementById("stamina-info-btn").addEventListener("click", () => {
      const existing = document.getElementById("stamina-panel");
      if (existing) {
          existing.style.height = existing.scrollHeight + "px";
          existing.style.opacity = "1";
          void existing.offsetHeight;
          existing.style.height = "0px";
          existing.style.opacity = "0";
          existing.style.marginTop = "0px";
          existing.style.padding = "0px";
          existing.style.borderWidth = "0px";
          setTimeout(() => existing.remove(), 200);
      } else {
          const panel = document.createElement("div");
          panel.className = "stamina-panel";
          panel.id = "stamina-panel";
          panel.innerHTML = `
              <span class="beta-badge">${t("stats.beta")}</span>
                <div class="stamina-disclaimer">${t("stats.staminaDisclaimer").replace("\n", "<br>")}</div>
              <div class="strength-control">
                  <label style="color:#eee;">${t("stats.strengthLv")}</label>
                  <div class="strength-input-row">
                      <input type="range" id="strength-slider" min="0" max="51" step="1" value="${EFTForge.state.currentStrengthLevel}" />
                      <input type="number" id="strength-input" min="0" max="51" value="${EFTForge.state.currentStrengthLevel}" />
                  </div>
              </div>
          `;
          document.getElementById("stamina-info-btn").closest(".stat-row").after(panel);

          panel.style.height = "0px";
          panel.style.opacity = "0";
          void panel.offsetHeight;
          panel.style.height = panel.scrollHeight + "px";
          panel.style.opacity = "1";
          panel.addEventListener("transitionend", () => {
              panel.style.height = "";
              panel.style.opacity = "";
          }, { once: true });

          wireStrengthControls();
      }
  });

  // Make the EED warning triangle also open the same panel
  document.querySelector(".eed-warning-icon")?.addEventListener("click", () =>
      document.getElementById("equip-ergo-info-btn")?.click()
  );

  // Toggle equip ergo panel on i button click
  document.getElementById("equip-ergo-info-btn").addEventListener("click", () => {
      const existing = document.getElementById("equip-ergo-panel");
      if (existing) {
          existing.style.height = existing.scrollHeight + "px";
          existing.style.opacity = "1";
          void existing.offsetHeight;
          existing.style.height = "0px";
          existing.style.opacity = "0";
          existing.style.marginTop = "0px";
          existing.style.padding = "0px";
          existing.style.borderWidth = "0px";
          setTimeout(() => existing.remove(), 200);
      } else {
          const panel = document.createElement("div");
          panel.className = "stamina-panel";
          panel.id = "equip-ergo-panel";
          panel.innerHTML = `
                <div class="stamina-disclaimer"><strong style="color:#eee;">${t("stats.eedLabel")}</strong> ${t("stats.eedDesc")}</div>
                <div class="stamina-disclaimer"><strong style="color:#eee;">${t("stats.overswing")}</strong> ${t("stats.overswingDesc")}</div>
              <div class="strength-control">
                  <label style="color:#eee;">${t("stats.equipErgoLabel")}</label>
                  <div class="stamina-disclaimer">${t("stats.equipErgoDisclaimer")}</div>
                  <div class="strength-input-row">
                      <input type="range" id="equip-ergo-slider" min="0" max="100" step="1" value="${Math.round(-EFTForge.state.currentEquipErgoModifier * 100)}" />
                      <span class="input-prefix">-</span><input type="number" id="equip-ergo-input" min="0" max="100" value="${Math.round(-EFTForge.state.currentEquipErgoModifier * 100)}" />
                      <span class="input-suffix">%</span>
                  </div>
              </div>
          `;
          document.getElementById("overswing-value-span").closest(".stat-row").after(panel);

          panel.style.height = "0px";
          panel.style.opacity = "0";
          void panel.offsetHeight;
          panel.style.height = panel.scrollHeight + "px";
          panel.style.opacity = "1";
          panel.addEventListener("transitionend", () => {
              panel.style.height = "";
              panel.style.opacity = "";
          }, { once: true });

          wireEquipErgoControls();
      }
  });

  if (savedStaminaPanel) {
    document.getElementById("stamina-info-btn")?.closest(".stat-row")?.after(savedStaminaPanel);
    wireStrengthControls();
  }
  if (savedEquipErgoPanel) {
    document.getElementById("overswing-value-span")?.closest(".stat-row")?.after(savedEquipErgoPanel);
    wireEquipErgoControls();
  }
}

function wireStrengthControls() {
    const slider = document.getElementById("strength-slider");
    const numInput = document.getElementById("strength-input");
    if (!slider || !numInput) return;

    // Use "input" only to update the label and number box live while dragging
    // Do NOT call refreshBuildStats here — it rebuilds the DOM and kills the drag
    slider.addEventListener("input", () => {
        EFTForge.state.currentStrengthLevel = parseInt(slider.value);
        numInput.value = EFTForge.state.currentStrengthLevel;

        // Recalculate arm stamina inline without triggering a DOM rebuild
        const armStamina = calcArmStamina(EFTForge.state.lastTotalWeight, EFTForge.state.lastTotalErgo, EFTForge.state.currentStrengthLevel, EFTForge.state.currentEquipErgoModifier);

        const staminaSpan = document.querySelector("#stamina-info-btn")?.closest(".stat-row")?.lastElementChild;
        if (staminaSpan) staminaSpan.textContent = armStamina.toFixed(1) + "s";
    });

    slider.addEventListener("change", () => {
        // Update the display directly instead of triggering a full rebuild
        localStorage.setItem("eftforge_strength_level", EFTForge.state.currentStrengthLevel);
        const armStamina = calcArmStamina(EFTForge.state.lastTotalWeight, EFTForge.state.lastTotalErgo, EFTForge.state.currentStrengthLevel, EFTForge.state.currentEquipErgoModifier);

        const staminaSpan = document.querySelector("#stamina-info-btn")?.closest(".stat-row")?.lastElementChild;
        if (staminaSpan) staminaSpan.textContent = armStamina.toFixed(1) + "s";
    });

    numInput.addEventListener("change", () => {
        let val = parseInt(numInput.value);
        if (isNaN(val)) val = 10;
        val = Math.max(0, Math.min(51, val));
        EFTForge.state.currentStrengthLevel = val;
        numInput.value = val;
        slider.value = val;
        localStorage.setItem("eftforge_strength_level", val);
        refreshBuildStats();
    });

    numInput.addEventListener("input", () => {
        numInput.value = numInput.value.replace(/[^0-9]/g, "");
        let val = parseInt(numInput.value);
        if (isNaN(val)) return;
        val = Math.max(0, Math.min(51, val));
        EFTForge.state.currentStrengthLevel = val;
        numInput.value = val;
        slider.value = val;

        const armStamina = calcArmStamina(EFTForge.state.lastTotalWeight, EFTForge.state.lastTotalErgo, EFTForge.state.currentStrengthLevel, EFTForge.state.currentEquipErgoModifier);

        const staminaSpan = document.querySelector("#stamina-info-btn")?.closest(".stat-row")?.lastElementChild;
        if (staminaSpan) staminaSpan.textContent = armStamina.toFixed(1) + "s";
    });
}

function wireEquipErgoControls() {
    const slider = document.getElementById("equip-ergo-slider");
    const numInput = document.getElementById("equip-ergo-input");
    if (!slider || !numInput) return;

    function updateEquipErgoDisplay() {
        const eed = calcEED(EFTForge.state.lastTotalErgo, EFTForge.state.lastTotalWeight, EFTForge.state.currentEquipErgoModifier);
        const overswing = eed < 0;

        const eedSpan = document.getElementById("eed-value-span");
        if (eedSpan) {
            eedSpan.className = eed >= 0 ? "positive" : "negative";
            eedSpan.textContent = (eed > 0 ? "+" : "") + eed.toFixed(1);
        }

        const eedRow = eedSpan?.closest(".stat-row-eed");
        const infoBtn = document.getElementById("equip-ergo-info-btn");
        if (eedRow) {
            const existing = eedRow.querySelector(".eed-warning-icon");
            if (eed >= 0 && eed < 7 && EFTForge.state.currentEquipErgoModifier === 0) {
                if (!existing) {
                    const icon = document.createElement("span");
                    icon.className = "eed-warning-icon";
                    icon.dataset.tooltip = t("stats.eedWarnTooltip");
                    icon.textContent = "⚠";
                    icon.style.cursor = "pointer";
                    icon.addEventListener("click", () => document.getElementById("equip-ergo-info-btn")?.click());
                    eedSpan.after(icon);
                }
                infoBtn?.classList.add("eed-warn-active");
            } else {
                existing?.remove();
                infoBtn?.classList.remove("eed-warn-active");
            }
        }

        const overswingSpan = document.getElementById("overswing-value-span");
        if (overswingSpan) {
            overswingSpan.className = overswing ? "negative" : "positive";
            overswingSpan.textContent = overswing ? t("stats.yes") : t("stats.no");
        }

        const armStamina = calcArmStamina(EFTForge.state.lastTotalWeight, EFTForge.state.lastTotalErgo, EFTForge.state.currentStrengthLevel, EFTForge.state.currentEquipErgoModifier);
        const staminaSpan = document.querySelector("#stamina-info-btn")?.closest(".stat-row")?.lastElementChild;
        if (staminaSpan) staminaSpan.textContent = armStamina.toFixed(1) + "s";
    }

    slider.addEventListener("input", () => {
        EFTForge.state.currentEquipErgoModifier = -parseInt(slider.value) / 100;
        numInput.value = Math.round(-EFTForge.state.currentEquipErgoModifier * 100);
        updateEquipErgoDisplay();
    });

    slider.addEventListener("change", () => {
        updateEquipErgoDisplay();
    });

    numInput.addEventListener("change", () => {
        let val = parseInt(numInput.value);
        if (isNaN(val)) val = 0;
        val = Math.max(0, Math.min(100, val));
        EFTForge.state.currentEquipErgoModifier = -val / 100;
        numInput.value = val;
        slider.value = val;
        refreshBuildStats();
    });

    numInput.addEventListener("input", () => {
        numInput.value = numInput.value.replace(/[^0-9]/g, "");
        let val = parseInt(numInput.value);
        if (isNaN(val)) return;
        val = Math.max(0, Math.min(100, val));
        EFTForge.state.currentEquipErgoModifier = -val / 100;
        numInput.value = val;
        slider.value = val;
        updateEquipErgoDisplay();
    });
}

function closeConfigPanel(id) {
    const panel = document.getElementById(id);
    if (!panel) return;
    panel.style.height = panel.scrollHeight + "px";
    panel.style.opacity = "1";
    void panel.offsetHeight;
    panel.style.height = "0px";
    panel.style.opacity = "0";
    panel.style.marginTop = "0px";
    panel.style.padding = "0px";
    panel.style.borderWidth = "0px";
    setTimeout(() => panel.remove(), 200);
}

document.addEventListener("click", (e) => {
    if (!e.target.closest("#slots")) return;
    closeConfigPanel("stamina-panel");
    closeConfigPanel("equip-ergo-panel");
}, true);
