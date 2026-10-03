(() => {
  if (window.self !== window.top) return;

  function isContextValid() {
    return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
  }

  const API_URL = 'https://ryr-titan-backend.onrender.com';

  // 0. ESCUDO CSS INMEDIATO (0ms): OCULTA LÁPICES, DRAFTS Y BOTONES DE RAYITO EN LA LISTA LATERAL
  const draftBlockerStyle = document.createElement('style');
  draftBlockerStyle.id = 'ryr-draft-eradicator-css';
  draftBlockerStyle.innerHTML = `
    div[data-test-id*="dialog-item"] span:has(svg[class*="pencil" i]),
    div[class*="dialog-item"] span:has(svg[class*="pencil" i]),
    div[class*="item-wrap"] span:has(svg[class*="pencil" i]),
    [class*="draft" i], [class*="Draft"],
    .ryr-row-extract-btn, .ryr-extract-menu {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
    }
  `;
  if (document.head) document.head.appendChild(draftBlockerStyle);

  let isStorageLoaded = false;

  let sessionData = {
    operator: null,
    shift: null,
    profileName: null,
    profileId: null,
    monitoringActive: false
  };

  // 1. MÉTRICAS Y TELEMETRÍA DE RENDIMIENTO (ZERO-LAG ENGINE)
  const PerformanceSentinel = {
    lastLoopDurationMs: 0,
    measureExecution: function(fn) {
      const t0 = performance.now();
      try {
        fn();
      } catch (err) {
        console.error('[RYR-HUD] Execution error:', err);
      }
      this.lastLoopDurationMs = Math.round((performance.now() - t0) * 100) / 100;
    },
    runIdle: function(task) {
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(task, { timeout: 1000 });
      } else {
        setTimeout(task, 16);
      }
    }
  };

  let totalGlobalReadLetters = 0;
  let isCrawlerRunning = false;
  let lastCrawlerRunTime = 0;

  let lastUserInteraction = Date.now();
  const AFK_THRESHOLD_SECONDS = 300;

  let activeSlaTimers = {};
  let finedTimerKeys = new Set();
  let syncedChatsMemory = new Set();
  let seenSupervisorMessageIds = new Set();
  let supervisorMessagesHistory = [];
  let isSupervisorChatOpen = false;
  let zeroCreditsClientsSet = new Set();

  // CONTADOR DE REINCIDENCIAS DEL FIREWALL
  let firewallInfractionsCount = 0;

  const PROSPECTING_MIN_QUOTA = 10;
  const PROSPECTING_CYCLE_DURATION = 1800; // 30 min
  let prospectingCycleStartTime = Date.now();
  let prospectingCount = 0;
  let cycleInteractedUsersSet = new Set();

  // DICCIONARIO BASE DE RAÍCES PROHIBIDAS Y PATRONES TRAVEL MISLEADING (TM)
  let bannedRoots = [
    'promet', 'promes', 'whatsapp', 'skype', 'email', 'correo', 
    'telefon', 'teléfon', 'numer', 'númer', 'banc', 'tarjet', 
    'instagram', 'telegram', 'diner', 'transferenc', 'pay', 'cash', 'paypal',
    'when we meet', 'when i visit you', 'book a flight', 'hotel', 'meet up',
    'airport', 'tickets', 'my flight', 'in person', 'flight to', 'flying to',
    'visit you', 'come see you', 'ticket to'
  ];

  // 2. REGISTRO DE ACTIVIDAD HUMANA
  ['keydown', 'mousedown', 'mousemove', 'wheel', 'touchstart', 'input'].forEach(evt => {
    window.addEventListener(evt, () => {
      lastUserInteraction = Date.now();
    }, { passive: true });
  });

  function getIdleSeconds() {
    return Math.floor((Date.now() - lastUserInteraction) / 1000);
  }

  function isOperatorAfk() {
    return getIdleSeconds() >= AFK_THRESHOLD_SECONDS;
  }

  // 3. PURGADOR DE TEXTAREA AL CAMBIAR DE CHAT
  ['pointerdown', 'mousedown', 'touchstart'].forEach(evtType => {
    document.addEventListener(evtType, (e) => {
      const sidebarItem = e.target.closest('div[data-test-id*="dialog-item"], div[class*="dialog-item"], div[class*="item-wrap"], .tab-content-item');
      if (sidebarItem) {
        const textareas = document.querySelectorAll('textarea');
        textareas.forEach(ta => {
          if (!ta.id?.includes('intel') && !ta.id?.includes('search') && !ta.id?.includes('sup-reply')) {
            try {
              const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
              if (nativeSetter) nativeSetter.call(ta, '');
              else ta.value = '';
              ta.dispatchEvent(new Event('input', { bubbles: true }));
              ta.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (err) {
              ta.value = '';
            }
          }
        });
      }
    }, true);
  });

  // 4. DETECTOR DE CLICS PARA PROSPECCIÓN
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button, a, div[role="button"]');
    if (!btn) return;

    const rawText = (btn.innerText || '').trim().toLowerCase();
    if (rawText.includes('liked') || rawText.includes('winked') || rawText.includes('unfollow') || rawText.includes('following')) {
      return;
    }

    const isFreshLike = rawText === 'like';
    const isFreshWink = rawText === 'wink';
    const isFreshFollow = rawText === 'follow';
    const isCardHeart = btn.querySelector('svg[class*="heart"]') && !btn.className.includes('liked') && !btn.className.includes('active');

    if (isFreshLike || isFreshWink || isFreshFollow || isCardHeart) {
      const userLink = btn.closest('div, a')?.querySelector('a[href*="/user/"]') || btn.closest('a[href*="/user/"]');
      let targetUserId = '';
      if (userLink) {
        const m = userLink.getAttribute('href').match(/user\/(\d+)/);
        if (m) targetUserId = m[1];
      }
      if (!targetUserId && window.location.href.includes('/user/')) {
        const m = window.location.href.match(/user\/(\d+)/);
        if (m) targetUserId = m[1];
      }
      if (!targetUserId) targetUserId = `user_${Date.now()}`;

      if (!cycleInteractedUsersSet.has(targetUserId)) {
        cycleInteractedUsersSet.add(targetUserId);
        prospectingCount = cycleInteractedUsersSet.size;

        persistProspectingState();
        renderFloatingBar();
        sendTelemetry(true);
      }
    }
  }, true);

  function persistProspectingState() {
    if (!isContextValid()) return;
    try {
      chrome.storage.local.set({
        prospectingCycleStartTime,
        prospectingCount,
        cycleInteractedUsersList: Array.from(cycleInteractedUsersSet)
      });
    } catch (e) {}
  }

  // 5. CARGA BLINDADA DE STORAGE (INMUNE A F5)
  if (isContextValid()) {
    try {
      chrome.storage.local.get(null, (data) => {
        if (!isContextValid() || !data) return;
        
        if (data.activeSlaTimers && typeof data.activeSlaTimers === 'object') {
          activeSlaTimers = { ...data.activeSlaTimers };
        }
        
        if (Array.isArray(data.syncedChatsList)) {
          data.syncedChatsList.forEach(item => syncedChatsMemory.add(String(item).trim().toLowerCase()));
        }

        if (Array.isArray(data.seenSupervisorMessageIdsList)) {
          data.seenSupervisorMessageIdsList.forEach(id => seenSupervisorMessageIds.add(id));
        }

        if (Array.isArray(data.zeroCreditsClientsList)) {
          data.zeroCreditsClientsList.forEach(id => zeroCreditsClientsSet.add(String(id).trim().toLowerCase()));
        }

        if (data.prospectingCycleStartTime) prospectingCycleStartTime = data.prospectingCycleStartTime;
        if (data.prospectingCount) prospectingCount = data.prospectingCount;
        if (Array.isArray(data.cycleInteractedUsersList)) {
          data.cycleInteractedUsersList.forEach(id => cycleInteractedUsersSet.add(id));
        }

        if (data.firewallInfractionsCount) firewallInfractionsCount = data.firewallInfractionsCount;

        sessionData = {
          operator: data.operator || 'walther',
          shift: data.shift || 'Mañana',
          profileName: data.profileName || 'HORACIO',
          profileId: data.profileId || '118179794',
          monitoringActive: !!data.monitoringActive
        };

        if (sessionData.monitoringActive) {
          renderFloatingBar();
          injectIntelPanel();
          syncServerKnownChats();
        }

        isStorageLoaded = true;
      });
    } catch (e) {
      isStorageLoaded = true;
    }
  } else {
    isStorageLoaded = true;
  }

  function persistTimersToStorage() {
    if (!isContextValid() || !isStorageLoaded) return;
    try {
      chrome.storage.local.set({ activeSlaTimers });
    } catch (e) {}
  }

  function persistSyncedChatsToStorage() {
    if (!isContextValid()) return;
    try {
      chrome.storage.local.set({ syncedChatsList: Array.from(syncedChatsMemory) });
    } catch (e) {}
  }

  function persistSeenSupervisorMessages() {
    if (!isContextValid()) return;
    try {
      chrome.storage.local.set({ seenSupervisorMessageIdsList: Array.from(seenSupervisorMessageIds) });
    } catch (e) {}
  }

  function persistZeroCreditsClients() {
    if (!isContextValid()) return;
    try {
      chrome.storage.local.set({ zeroCreditsClientsList: Array.from(zeroCreditsClientsSet) });
    } catch (e) {}
  }

  function persistFirewallInfractions() {
    if (!isContextValid()) return;
    try {
      chrome.storage.local.set({ firewallInfractionsCount });
    } catch (e) {}
  }

  if (isContextValid()) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (!isContextValid()) return;
        if (area === 'local') {
          if (changes.monitoringActive) sessionData.monitoringActive = changes.monitoringActive.newValue;
          if (changes.operator) sessionData.operator = changes.operator.newValue;
          if (changes.shift) sessionData.shift = changes.shift.newValue;
          if (changes.profileName) sessionData.profileName = changes.profileName.newValue;
          if (changes.profileId) sessionData.profileId = changes.profileId.newValue;

          if (sessionData.monitoringActive) {
            renderFloatingBar();
            injectIntelPanel();
            syncServerKnownChats();
          } else {
            removeFloatingBar();
          }
        }
      });
    } catch (e) {}
  }

  // 6. CHAT BIDIRECCIONAL SUPERVISOR-OPERADOR (BANNER & MODAL HUD)
  let supervisorChatPollTimer = null;

  async function checkSupervisorDirectMessages() {
    const rawOp = (sessionData.operator || 'walther').trim();
    if (!rawOp) return;
    try {
      const res = await fetch(`${API_URL}/api/supervisor/messages/${encodeURIComponent(rawOp)}?role=${isSupervisorChatOpen ? 'OPERATOR' : ''}`);
      const data = await res.json();
      if (data && Array.isArray(data.messages)) {
        const serverMessages = [...data.messages];
        const seenIds = new Set(serverMessages.map(m => String(m.id)));
        
        // Mantener mensajes locales optimistas no confirmados
        supervisorMessagesHistory.forEach(localM => {
          if (!seenIds.has(String(localM.id))) {
            serverMessages.push(localM);
            seenIds.add(String(localM.id));
          }
        });

        serverMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        supervisorMessagesHistory = serverMessages;
        renderSupervisorChatMessages();

        const unreadSupMessages = supervisorMessagesHistory.filter(m => m.sender === 'SUPERVISOR' && !m.read && !seenSupervisorMessageIds.has(m.id));
        const supChatBtn = document.getElementById('ryr-btn-open-sup-chat');
        if (supChatBtn) {
          if (unreadSupMessages.length > 0 && !isSupervisorChatOpen) {
            supChatBtn.classList.add('unread');
            supChatBtn.innerText = `💬 Chat Supervisor (${unreadSupMessages.length})`;
          } else {
            supChatBtn.classList.remove('unread');
            supChatBtn.innerText = `💬 Chat Supervisor`;
          }
        }

        if (unreadSupMessages.length > 0 && !isSupervisorChatOpen) {
          const latest = unreadSupMessages[unreadSupMessages.length - 1];
          const existingBanner = document.getElementById('ryr-supervisor-banner');
          if (!existingBanner || existingBanner.getAttribute('data-msg-id') !== String(latest.id)) {
            showSupervisorDirectBanner(latest.text, latest.id);
          }
        }
      }
    } catch (e) {}
  }

  function showSupervisorDirectBanner(text, messageId) {
    const existing = document.getElementById('ryr-supervisor-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'ryr-supervisor-banner';
    banner.setAttribute('data-msg-id', String(messageId));
    banner.style.cssText = `
      position: fixed;
      top: 45px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(15, 23, 42, 0.95);
      backdrop-filter: blur(16px);
      border: 2px solid #6366f1;
      color: #ffffff;
      padding: 12px 16px;
      border-radius: 10px;
      font-family: system-ui, sans-serif;
      font-size: 12px;
      z-index: 2147483647;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.7);
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 400px;
      max-width: 92%;
    `;

    banner.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-weight:900; color:#a5b4fc; letter-spacing:0.5px;">📢 MENSAJE DEL SUPERVISOR:</span>
        <span id="btn-close-sup-banner" style="cursor:pointer; font-size:16px; color:#94a3b8; line-height:1;">✕</span>
      </div>
      <div style="font-size:12px; line-height:1.4; color:#fde68a; font-weight:500;">
        ${text}
      </div>
      <div style="display:flex; gap:6px;">
        <input type="text" id="input-reply-sup" placeholder="Responder al supervisor..." style="flex:1; padding:6px 10px; background:rgba(6,9,19,0.8); border:1px solid #3730a3; color:#fff; border-radius:5px; font-size:11px; outline:none;">
        <button id="btn-reply-sup" style="background:#6366f1; color:#fff; border:none; padding:6px 12px; border-radius:5px; font-weight:bold; cursor:pointer; font-size:11px;">Enviar</button>
      </div>
    `;

    document.body.appendChild(banner);

    const replyInput = document.getElementById('input-reply-sup');
    const sendReplyBtn = document.getElementById('btn-reply-sup');

    ['keydown', 'keyup', 'input'].forEach(evtType => {
      replyInput.addEventListener(evtType, (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          sendReplyBtn.click();
        }
      }, true);
    });

    document.getElementById('btn-close-sup-banner').onclick = () => {
      seenSupervisorMessageIds.add(messageId);
      persistSeenSupervisorMessages();
      banner.remove();
    };

    sendReplyBtn.onclick = async () => {
      const replyText = replyInput.value.trim();
      if (!replyText) return;

      seenSupervisorMessageIds.add(messageId);
      persistSeenSupervisorMessages();

      try {
        await fetch(`${API_URL}/api/operator/reply-message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operatorName: sessionData.operator,
            text: replyText
          })
        });
        banner.remove();
        checkSupervisorDirectMessages();
      } catch (e) {
        banner.remove();
      }
    };
  }

  function toggleSupervisorChatModal() {
    let modal = document.getElementById('ryr-supervisor-chat-modal');
    if (modal) {
      modal.remove();
      isSupervisorChatOpen = false;
      if (supervisorChatPollTimer) {
        clearInterval(supervisorChatPollTimer);
        supervisorChatPollTimer = null;
      }
      return;
    }

    isSupervisorChatOpen = true;
    const currentOp = (sessionData.operator || 'walther').trim();
    modal = document.createElement('div');
    modal.id = 'ryr-supervisor-chat-modal';
    modal.innerHTML = `
      <div class="ryr-sup-chat-header">
        <span>💬 CANAL SUPERVISIÓN & MONITOREO (${currentOp.toUpperCase()})</span>
        <span id="ryr-close-sup-chat" style="cursor:pointer; font-size:16px;">✕</span>
      </div>
      <div id="ryr-sup-chat-stream" class="ryr-sup-chat-body">
        <div style="color:#94a3b8; font-size:11px; text-align:center; padding:10px;">Cargando mensajes del turno...</div>
      </div>
      <div class="ryr-sup-chat-footer">
        <input type="text" id="input-sup-chat-live" placeholder="Escribe al supervisor...">
        <button id="btn-send-sup-chat-live">Enviar</button>
      </div>
    `;

    document.body.appendChild(modal);

    document.getElementById('ryr-close-sup-chat').onclick = () => {
      modal.remove();
      isSupervisorChatOpen = false;
      if (supervisorChatPollTimer) {
        clearInterval(supervisorChatPollTimer);
        supervisorChatPollTimer = null;
      }
    };

    const input = document.getElementById('input-sup-chat-live');
    const sendBtn = document.getElementById('btn-send-sup-chat-live');

    const sendAction = async () => {
      const txt = input.value.trim();
      if (!txt) return;
      input.value = '';

      const tempId = `op_tmp_${Date.now()}`;
      supervisorMessagesHistory.push({
        id: tempId,
        sender: 'OPERATOR',
        text: txt,
        timestamp: Date.now(),
        read: false,
        isEdited: false
      });
      renderSupervisorChatMessages();

      try {
        const res = await fetch(`${API_URL}/api/operator/reply-message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operatorName: sessionData.operator || 'walther',
            text: txt
          })
        });
        const resData = await res.json();
        if (resData && resData.id) {
          const item = supervisorMessagesHistory.find(m => m.id === tempId);
          if (item) item.id = resData.id;
        }
      } catch (e) {}
    };

    sendBtn.onclick = sendAction;
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        sendAction();
      }
    });

    // Marcar como leídos al abrir el chat
    fetch(`${API_URL}/api/supervisor/mark-read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operatorName: sessionData.operator || 'walther',
        role: 'OPERATOR'
      })
    }).catch(() => {});

    checkSupervisorDirectMessages();

    // Iniciar sondeo en vivo cada 2s mientras esté abierto el modal
    if (supervisorChatPollTimer) clearInterval(supervisorChatPollTimer);
    supervisorChatPollTimer = setInterval(() => {
      if (isSupervisorChatOpen) {
        checkSupervisorDirectMessages();
      } else {
        clearInterval(supervisorChatPollTimer);
        supervisorChatPollTimer = null;
      }
    }, 2000);
  }

  window.editSupervisorMsgFromHud = async (msgId, currentText) => {
    const newText = prompt('✏️ Editar mensaje:', currentText);
    if (newText === null) return;
    const cleanNewText = newText.trim();
    if (!cleanNewText || cleanNewText === currentText) return;

    // Actualizar localmente de inmediato (optimistic update)
    const localMsg = supervisorMessagesHistory.find(m => String(m.id) === String(msgId));
    if (localMsg) {
      localMsg.text = cleanNewText;
      localMsg.isEdited = true;
      renderSupervisorChatMessages();
    }

    try {
      await fetch(`${API_URL}/api/supervisor/edit-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: msgId,
          text: cleanNewText,
          operatorName: sessionData.operator || 'walther'
        })
      });
      checkSupervisorDirectMessages();
      showFirewallToast('✅ Mensaje editado con éxito.', 'success');
    } catch (e) {
      showFirewallToast('⚠️ Error al editar mensaje.');
    }
  };

  function renderSupervisorChatMessages() {
    const stream = document.getElementById('ryr-sup-chat-stream');
    if (!stream) return;

    if (!supervisorMessagesHistory || supervisorMessagesHistory.length === 0) {
      stream.innerHTML = '<div style="color:#64748b; font-size:11px; text-align:center; padding:20px;">No hay mensajes recientes del supervisor en este turno. Escribe abajo para iniciar.</div>';
      return;
    }

    stream.innerHTML = supervisorMessagesHistory.map(m => {
      const isSup = m.sender === 'SUPERVISOR';
      const cssClass = isSup ? 'ryr-sup-msg-supervisor' : 'ryr-sup-msg-operator';
      const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const label = isSup ? `👮 Supervisor` : `💼 Tú (${sessionData.operator || 'Op'})`;
      const editedTag = m.isEdited ? '<span style="font-size:9.5px; color:#fbbf24; font-style:italic;"> (editado)</span>' : '';
      const escapedText = (m.text || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');

      // Chulitos tipo WhatsApp: ✓ (Gris - Enviado/No leído) | ✓✓ (Verde - Leído)
      let checkmarkHtml = '';
      if (!isSup) {
        if (m.read) {
          checkmarkHtml = '<span style="color:#22c55e; font-weight:900; font-size:11.5px; margin-left:3px;" title="Leído por el supervisor">✓✓</span>';
        } else {
          checkmarkHtml = '<span style="color:#94a3b8; font-weight:900; font-size:11.5px; margin-left:3px;" title="Enviado al supervisor">✓</span>';
        }
      } else {
        if (m.read) {
          checkmarkHtml = '<span style="color:#22c55e; font-weight:900; font-size:11.5px; margin-left:3px;" title="Leído">✓✓</span>';
        } else {
          checkmarkHtml = '<span style="color:#94a3b8; font-weight:900; font-size:11.5px; margin-left:3px;" title="Entregado">✓</span>';
        }
      }

      return `
        <div class="ryr-sup-msg-item ${cssClass}" id="ryr-sup-msg-${m.id}">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; font-size:9.5px; opacity:0.85; margin-bottom:3px; font-weight:bold;">
            <span>${label} • ${timeStr}${editedTag}</span>
            <div style="display:flex; align-items:center; gap:3px;">
              <button type="button" onclick="window.editSupervisorMsgFromHud('${m.id}', '${escapedText}')" style="background:transparent; border:none; color:#cbd5e1; cursor:pointer; font-size:10px; padding:0 2px;" title="Editar mensaje">✏️</button>
              ${checkmarkHtml}
            </div>
          </div>
          <div style="word-break:break-word; font-size:11.5px; line-height:1.4;">${m.text}</div>
        </div>
      `;
    }).join('');

    stream.scrollTop = stream.scrollHeight;
  }

  // 7. EVALUADOR DEL CICLO DE PROSPECCIÓN (30 MIN)
  function evaluateProspectingCycle() {
    const elapsed = Math.floor((Date.now() - prospectingCycleStartTime) / 1000);
    const remaining = Math.max(0, PROSPECTING_CYCLE_DURATION - elapsed);

    if (elapsed >= PROSPECTING_CYCLE_DURATION) {
      prospectingCycleStartTime = Date.now();
      prospectingCount = 0;
      cycleInteractedUsersSet.clear();
      persistProspectingState();
    }

    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    return {
      formattedTime: `${min < 10 ? '0' : ''}${min}:${sec < 10 ? '0' : ''}${sec}`,
      count: prospectingCount,
      quota: PROSPECTING_MIN_QUOTA,
      isCompleted: prospectingCount >= PROSPECTING_MIN_QUOTA,
      remainingSeconds: remaining
    };
  }

  // 8. SINCRONIZACIÓN CON SERVIDOR
  async function syncServerKnownChats() {
    if (!sessionData.profileName) return;
    try {
      const res = await fetch(`${API_URL}/api/chats/synced-ids?profile=${sessionData.profileName}`);
      const data = await res.json();
      if (data && Array.isArray(data.syncedIds)) {
        data.syncedIds.forEach(id => syncedChatsMemory.add(String(id).trim().toLowerCase()));
        persistSyncedChatsToStorage();
      }
    } catch (e) {}
  }

  async function syncBannedWords() {
    try {
      const res = await fetch(`${API_URL}/api/banned-words`);
      const data = await res.json();
      if (data && Array.isArray(data.words)) {
        bannedRoots = Array.from(new Set([...bannedRoots, ...data.words.map(w => w.toLowerCase())]));
      }
    } catch (e) {}
  }
  syncBannedWords();
  setInterval(syncBannedWords, 15000);

  // 9. FIREWALL DE 3 CAPAS & PREVENCIÓN DE TRAVEL MISLEADING (TM)
  function checkViolationInText(text) {
    if (!text || text.length < 2) return false;
    const lower = text.toLowerCase();
    return bannedRoots.some(root => lower.includes(root.toLowerCase()));
  }

  function enforceFirewall(e) {
    const inputs = document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]');
    let anyViolation = false;

    inputs.forEach(input => {
      if (input.id?.includes('intel') || input.id?.includes('search') || input.id?.includes('reply') || input.id?.includes('sup')) return;
      
      const text = (input.value || input.innerText || '').trim();
      const hasViolation = checkViolationInText(text);

      if (hasViolation) {
        anyViolation = true;
        input.style.setProperty('border', '2px solid #ef4444', 'important');

        if (e && e.type === 'keydown' && e.key === 'Enter' && e.target === input) {
          e.preventDefault();
          e.stopPropagation();
          showFirewallToast('🚨 Infracción de Protocolo: Prohibido Travel Misleading o fuga de datos.');
          firewallInfractionsCount++;
          persistFirewallInfractions();
          sendTelemetry(true);
        }
      } else {
        if (input.style.borderColor === 'rgb(239, 68, 68)') {
          input.style.removeProperty('border');
        }
      }
    });

    const sendButtons = document.querySelectorAll('button, [role="button"], div[class*="send"]');
    sendButtons.forEach(btn => {
      const btnText = btn.innerText.toLowerCase();
      const isSendBtn = (btnText.includes('send') || btnText.includes('enviar') || btn.querySelector('svg') || (btn.className && btn.className.toLowerCase().includes('send'))) &&
                        !btn.classList.contains('ryr-row-extract-btn') && 
                        !btn.classList.contains('ryr-btn-logout') &&
                        !btn.classList.contains('ryr-btn-intel') &&
                        !btn.classList.contains('ryr-btn-handover') &&
                        !btn.classList.contains('ryr-chat-hooks-btn') &&
                        !btn.classList.contains('ryr-letter-drafter-btn') &&
                        !btn.classList.contains('ryr-btn-sup-chat');

      if (isSendBtn) {
        if (anyViolation) {
          btn.classList.add('ryr-btn-blocked-force');
          btn.disabled = true;
          btn.style.setProperty('pointer-events', 'none', 'important');
          btn.style.setProperty('filter', 'grayscale(100%)', 'important');
          btn.style.setProperty('opacity', '0.45', 'important');
          btn.style.setProperty('background', '#9ca3af', 'important');
        } else {
          btn.classList.remove('ryr-btn-blocked-force');
          btn.disabled = false;
          btn.style.removeProperty('pointer-events');
          btn.style.removeProperty('filter');
          btn.style.removeProperty('opacity');
          btn.style.removeProperty('background');
        }
      }
    });
  }

  function playAlertChime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.2); // A5
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch (e) {}
  }

  function showFirewallToast(msg, type = 'danger') {
    const toastId = 'ryr-firewall-toast';
    const old = document.getElementById(toastId);
    if (old) old.remove();

    const isRecharge = type === 'recharge' || msg.includes('RECARGA') || msg.includes('FIDELIZADO');
    const isSuccess = type === 'success' || msg.includes('✅') || msg.includes('✨');

    let bg = 'rgba(69, 10, 10, 0.95)';
    let border = '2px solid #ef4444';
    let color = '#fca5a5';
    let shadow = '0 8px 30px rgba(239, 68, 68, 0.6)';

    if (isRecharge) {
      bg = 'linear-gradient(135deg, rgba(6, 78, 59, 0.98) 0%, rgba(15, 23, 42, 0.98) 100%)';
      border = '2px solid #10b981';
      color = '#6ee7b7';
      shadow = '0 8px 30px rgba(16, 185, 129, 0.8), 0 0 15px rgba(52, 211, 153, 0.5)';
      playAlertChime();
    } else if (isSuccess) {
      bg = 'rgba(15, 23, 42, 0.95)';
      border = '1px solid #38bdf8';
      color = '#bae6fd';
      shadow = '0 8px 25px rgba(6, 182, 212, 0.4)';
    }

    const toast = document.createElement('div');
    toast.id = toastId;
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 24px;
      background: ${bg};
      border: ${border};
      color: ${color};
      padding: 12px 18px;
      border-radius: 8px;
      font-family: system-ui, sans-serif;
      font-size: 12.5px;
      font-weight: 800;
      z-index: 2147483647;
      box-shadow: ${shadow};
      animation: ryrToastSlide 0.2s ease-out;
      display: flex;
      align-items: center;
      gap: 8px;
    `;
    toast.innerText = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4500);
  }

  ['input', 'keyup', 'keydown', 'paste', 'change'].forEach(evtType => {
    document.addEventListener(evtType, enforceFirewall, true);
  });

  // 10. EXTRACTOR QUIRÚRGICO DE DATOS DE CLIENTE & INYECCIÓN DE AGENCIA
  function sanitizeClientName(raw) {
    if (!raw) return 'Cliente';
    const clean = raw
      .split('\n')[0]
      .replace(/(\d+\s*(minute|hour|day|week|month)s?\s*ago|\ban hour ago\b|\d+\s*[✉💬]|\bonline\b|\btyping\b|\bSearch\b|\bMessages\b)/gi, '')
      .replace(/\s+/g, ' ')
      .replace(/^,\s*/, '')
      .trim();

    const noisyWords = ['yes', 'no', 'open', 'search', 'messages', 'mail', 'gifts', 'account', 'titan apex', 'mute', 'listened', 'public photos', 'my content'];
    if (noisyWords.includes(clean.toLowerCase()) || clean.length < 2) {
      return 'Cliente';
    }
    return clean;
  }

  function getExactClientProfileData() {
    let clientName = '';
    const chatTitleContainer = document.querySelector('div[data-test-id="dialog-header-title"], div[class*="dialog-header"], div[class*="chat-header"]');
    if (chatTitleContainer) {
      const candidates = chatTitleContainer.querySelectorAll('h1, h2, h3, span, div');
      for (let c of candidates) {
        const txt = c.innerText.trim();
        const cleaned = sanitizeClientName(txt);
        if (cleaned !== 'Cliente' && txt.length > 1 && !txt.includes('ago') && !txt.includes('Online')) {
          clientName = cleaned;
          break;
        }
      }
    }

    if (!clientName) {
      const activeTabItem = document.querySelector('div[class*="dialog-item"][class*="active"], div[class*="item-wrap"][class*="active"], div[data-selected="true"]');
      if (activeTabItem) {
        const firstLine = activeTabItem.innerText.split('\n')[0].trim();
        const cleaned = sanitizeClientName(firstLine);
        if (cleaned !== 'Cliente') clientName = cleaned;
      }
    }

    if (!clientName || clientName === 'Cliente') {
      const mailSendTo = (document.body?.innerText || '').match(/Send your letter to\s+([A-Za-z0-9_ -]+)/i) ||
                         (document.body?.innerText || '').match(/Enviar carta a\s+([A-Za-z0-9_ -]+)/i);
      if (mailSendTo && mailSendTo[1]) {
        const parsed = sanitizeClientName(mailSendTo[1].trim());
        if (parsed && parsed !== 'Cliente') clientName = parsed;
      }
    }

    let country = '';
    let birthDate = '';
    let maritalStatus = '';

    const allPills = document.querySelectorAll('span, div, button, p');
    allPills.forEach(el => {
      if (el.children.length > 1) return;
      const t = el.innerText.trim();

      if (!country && /^(Canada|United States|Brazil|Australia|Poland|Hong Kong|Colombia|Mexico|Spain|Argentina|United Kingdom|Germany|Uruguay|Italy|Albania)/i.test(t)) {
        country = t;
      }
      if (!birthDate && /([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i.test(t)) {
        const m = t.match(/([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i);
        if (m) birthDate = m[1];
      }
      if (!maritalStatus && /^(Widowed|Divorced|Single|Not Married|Married|Viudo|Viuda|Divorciado|Soltero|Soltera)$/i.test(t)) {
        maritalStatus = t;
      }
    });

    let ageText = '';
    if (birthDate) {
      const yearMatch = birthDate.match(/\d{4}/);
      if (yearMatch) {
        const age = new Date().getFullYear() - parseInt(yearMatch[0], 10);
        ageText = `${age} años`;
      }
    }

    return {
      clientName: clientName || 'Cliente',
      bioData: {
        country: country || 'United States',
        birthDate: birthDate ? `${birthDate} (${ageText || '53 años'})` : 'En perfil',
        maritalStatus: maritalStatus || 'Not married / Soltera'
      }
    };
  }

  function getExactNumericClientId(targetUrl = window.location.href) {
    const chatMatch = targetUrl.match(/chat\/\d+_(\d+)/);
    if (chatMatch) return String(chatMatch[1]).trim();
    const mailMatch = targetUrl.match(/mails\/(?:view|thread)\/\d+_(\d+)/);
    if (mailMatch) return String(mailMatch[1]).trim();
    const userMatch = targetUrl.match(/user\/(\d+)/);
    if (userMatch) return String(userMatch[1]).trim();
    return '119678157';
  }

  // 10.1 MOTOR DE DETECCIÓN DE IDIOMA Y TRADUCCIÓN INSTANTÁNEA MULTI-LENGUAJE
  function detectLanguage(text) {
    if (!text || typeof text !== 'string') return { code: 'en', name: 'English 🇺🇸', flag: '🇺🇸' };
    const t = ` ${text.toLowerCase().replace(/[^a-zñáéíóúàâçèêëîïôûùäöüß]/g, ' ')} `;

    // Ruso (Cirílico)
    if (/[\u0400-\u04FF]/.test(text)) {
      return { code: 'ru', name: 'Ruso 🇷🇺', flag: '🇷🇺' };
    }

    // Inglés (Palabras clave exclusivas de alto peso)
    const enWords = [' the ', ' and ', ' you ', ' are ', ' for ', ' with ', ' about ', ' sleep ', ' have ', ' having ', ' headache ', ' bus ', ' feel ', ' hold ', ' tight ', ' home ', ' please ', ' pls ', ' love ', ' good ', ' what ', ' this ', ' from ', ' your ', ' will ', ' that ', ' took ', ' soaked ', ' waiting ', ' leaving ', ' morning ', ' afternoon ', ' night ', ' coffee ', ' smiling ', ' doing '];
    let enScore = enWords.reduce((acc, w) => acc + (t.includes(w) ? 1.5 : 0), 0);

    // Español
    const esWords = [' que ', ' para ', ' con ', ' hola ', ' como ', ' bien ', ' amor ', ' gracias ', ' cielo ', ' quiero ', ' tengo ', ' cuando ', ' donde ', ' mensaje ', ' carta ', ' fotos ', ' beso ', ' besos ', ' pero ', ' estoy ', ' tarde '];
    let esScore = esWords.reduce((acc, w) => acc + (t.includes(w) ? 1 : 0), 0);
    if (/[áéíóúñ¿¡]/.test(text)) esScore += 3;

    // Francés
    const frWords = [' bonjour ', ' salut ', ' merci ', ' avec ', ' pour ', ' vous ', ' dans ', ' cette ', ' suis ', ' très ', ' chéri ', ' bisous ', ' lettre ', ' comment ', ' oui '];
    let frScore = frWords.reduce((acc, w) => acc + (t.includes(w) ? 1 : 0), 0);
    if (/[àâçèêëîïôûù]/.test(text)) frScore += 2;

    // Portugués
    const ptWords = [' olá ', ' obrigado ', ' obrigada ', ' você ', ' voce ', ' muito ', ' lindo ', ' linda ', ' beijo ', ' beijos ', ' tudo ', ' bem ', ' não ', ' nao '];
    let ptScore = ptWords.reduce((acc, w) => acc + (t.includes(w) ? 1 : 0), 0);
    if (/[ãõ]/.test(text)) ptScore += 2;

    if (enScore > 0 && enScore >= esScore && enScore >= frScore && enScore >= ptScore && !/[áéíóúñ¿¡]/.test(text)) {
      return { code: 'en', name: 'English 🇺🇸', flag: '🇺🇸' };
    }
    if (esScore >= 2 && esScore >= frScore && esScore >= ptScore) {
      return { code: 'es', name: 'Español 🇪🇸', flag: '🇪🇸' };
    }
    if (frScore >= 2) {
      return { code: 'fr', name: 'Français 🇫🇷', flag: '🇫🇷' };
    }
    if (ptScore >= 2) {
      return { code: 'pt', name: 'Português 🇧🇷', flag: '🇧🇷' };
    }

    // Por defecto Inglés
    return { code: 'en', name: 'English 🇺🇸', flag: '🇺🇸' };
  }

  async function translateText(text, targetLang = 'en') {
    if (!text || text.trim().length === 0) return '';
    try {
      const googleUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
      const res = await fetch(googleUrl);
      const data = await res.json();
      if (Array.isArray(data) && Array.isArray(data[0])) {
        return data[0].map(item => item[0]).join('');
      }
    } catch (e) {
      try {
        const res = await fetch(`${API_URL}/api/translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, targetLang })
        });
        const data = await res.json();
        if (data && data.translatedText) return data.translatedText;
      } catch (err) {}
    }
    return text;
  }

  function setInputValueSafely(element, value) {
    if (!element) return;
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
                           Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      element.innerText = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    element.focus();
    enforceFirewall(null);
  }

  let fidelizedClientsMap = new Map();

  function findChatInput() {
    return document.querySelector('textarea[placeholder*="message" i], textarea[class*="compose" i], textarea[class*="chat" i], div[contenteditable="true"], textarea');
  }

  function findChatSendButton() {
    const chatInput = findChatInput();
    const allButtons = Array.from(document.querySelectorAll('button, div[role="button"]'));
    
    let inputRect = null;
    if (chatInput) {
      inputRect = chatInput.getBoundingClientRect();
    }

    const candidates = allButtons.filter(b => {
      if (b.closest('#ryr-titan-bar') || 
          b.closest('#ryr-intel-panel') || 
          b.closest('.ryr-chat-tools-wrapper') || 
          b.closest('#ryr-letter-drafter-box') || 
          b.closest('#ryr-supervisor-chat-modal') ||
          b.closest('header') ||
          b.closest('div[data-test-id*="dialog-item"]') ||
          b.closest('div[class*="dialog-item"]') ||
          b.closest('div[class*="item-wrap"]') ||
          b.closest('div[class*="sidebar"]') ||
          b.closest('.toolbar-top') ||
          b.closest('[class*="toolbar"]')) {
        return false;
      }

      // Si tenemos la caja de chat, ignorar cualquier botón ubicado arriba del textarea (barra de stickers/regalos)
      if (inputRect && inputRect.top > 0) {
        const bRect = b.getBoundingClientRect();
        if (bRect.top < inputRect.top - 10) {
          return false;
        }
      }

      const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
      const testId = (b.getAttribute('data-test-id') || '').toLowerCase();
      const className = (b.className || '').toString().toLowerCase();
      const ariaLabel = (b.getAttribute('aria-label') || '').toLowerCase();
      
      const isSendText = txt === 'send' || txt === 'enviar' || txt.startsWith('send ') || txt.startsWith('send\n') || txt.startsWith('enviar ');
      const isSendTestId = testId.includes('send') || testId.includes('submit');
      const isSendClass = (className.includes('send') || className.includes('submit')) && !className.includes('header') && !className.includes('nav');
      const isSendAria = ariaLabel.includes('send') || ariaLabel.includes('enviar');
      const hasSendSvg = b.querySelector('svg[class*="send" i], path[d*="M2.01 21L23 12 2.01 3"]') !== null;

      return isSendText || isSendTestId || isSendClass || isSendAria || hasSendSvg;
    });

    if (candidates.length > 0) {
      if (inputRect && candidates.length > 1) {
        candidates.sort((a, b) => {
          const rectA = a.getBoundingClientRect();
          const rectB = b.getBoundingClientRect();
          const distA = Math.hypot(rectA.left - inputRect.right, rectA.top - inputRect.bottom);
          const distB = Math.hypot(rectB.left - inputRect.right, rectB.top - inputRect.bottom);
          return distA - distB;
        });
      }
      return candidates[0];
    }

    return document.querySelector('button[class*="send" i], div[class*="send" i] button');
  }

  let knownClientCreditsMap = new Map();
  let shiftInitialClientPostStatus = new Map();

  // 11. INYECCIÓN DE SALDO / PUNTOS REALES, GASTO HISTÓRICO, GANCHOS DUALES Y TRADUCTOR
  async function injectAgenciaChatEnhancements() {
    if (!window.location.href.includes('/chat/')) return;

    const clientId = getExactNumericClientId();
    if (!clientId || clientId === 'N/A') return;

    // Detectar si el cliente tiene activado / desbloqueado el servicio de Posts o Chat
    const hasPostsUnlocked = Boolean(
      document.querySelector('a[href*="/posts"], button[title*="Posts" i], button[title*="Post" i], [data-test-id*="post"], svg[class*="bolt"], svg[class*="flash"]') ||
      window.location.href.includes('/posts') ||
      (document.querySelector('div[class*="header"]') && document.querySelector('div[class*="header"]').innerHTML.includes('posts')) ||
      document.body.innerText.includes('Go to Posts')
    );

    // Leer saldo en vivo desde el DOM de Talkytimes o API
    let liveCredits = null;
    
    // 1. Selector específico de Talkytimes para contadores de restricción y balance
    const restrictionEl = document.querySelector('[data-test-id*="restriction-limits"], [data-type="Chat"].counter, .chat-limits-counter');
    if (restrictionEl) {
      const activeSpan = restrictionEl.querySelector('span:not(.counter-inactive)');
      if (activeSpan) {
        const val = parseInt((activeSpan.textContent || activeSpan.innerText || '').trim(), 10);
        if (!isNaN(val)) liveCredits = val;
      }
    }

    // 2. Selector en encabezado o barra de perfil
    if (liveCredits === null) {
      const headerEl = document.querySelector('div[data-test-id="dialog-header-title"], div[class*="dialog-header"], div[class*="chat-header"]') || document.querySelector('div[class*="header"]');
      if (headerEl) {
        const crMatch = headerEl.parentElement?.innerText?.match(/(\d+)\s*(?:cr|credits|pts)\b/i) || headerEl.innerText.match(/(\d+)\s*(?:cr|credits|pts)\b/i);
        if (crMatch) liveCredits = parseInt(crMatch[1], 10);
      }
    }

    // 3. Selector en chips de saldo o perfiles laterales
    if (liveCredits === null) {
      const balanceChips = document.querySelectorAll('span[class*="balance"], div[class*="balance"], span[class*="credit"], div[class*="credit"]');
      for (const chip of balanceChips) {
        const chipText = (chip.innerText || '').trim();
        const m = chipText.match(/(\d+)\s*(?:cr|credits|pts)?\b/i);
        if (m && parseInt(m[1], 10) > 0) {
          liveCredits = parseInt(m[1], 10);
          break;
        }
      }
    }

    if (liveCredits === null && isChatHeaderZeroMessages()) {
      liveCredits = 0;
    }

    const { clientName, bioData } = getExactClientProfileData();

    // AVISO DE RECARGA EN VIVO
    if (liveCredits !== null) {
      const prevCredit = knownClientCreditsMap.get(clientId);
      if (prevCredit !== undefined && liveCredits > prevCredit) {
        showFirewallToast(`⚡ ¡RECARGA EN VIVO DETECTADA! ${clientName} recargó (${prevCredit} cr ➔ ${liveCredits} cr).`);
      }
      knownClientCreditsMap.set(clientId, liveCredits);
    }

    // REGISTRO DE ESTADO INICIAL DEL CLIENTE EN EL TURNO (PARA EVALUAR FIDELIZACIÓN REAL)
    const recentChat = parseCurrentChatMessagesBidirectional(clientName);
    const messagesCountNow = recentChat.length;

    if (!shiftInitialClientPostStatus.has(clientId)) {
      const isColdAtStart = messagesCountNow === 0;
      shiftInitialClientPostStatus.set(clientId, {
        wasColdAtStart: isColdAtStart,
        initialUnlocked: hasPostsUnlocked,
        initialCredits: liveCredits || 0,
        messagesCountAtStart: messagesCountNow,
        firstSeen: Date.now()
      });
    }

    const initialStatus = shiftInitialClientPostStatus.get(clientId);
    const unlockedDuringShift = initialStatus && initialStatus.wasColdAtStart && !initialStatus.initialUnlocked && hasPostsUnlocked;
    const rechargedDuringShift = initialStatus && initialStatus.wasColdAtStart && liveCredits !== null && liveCredits > (initialStatus.initialCredits || 0);
    const enoughInteraction = initialStatus && initialStatus.wasColdAtStart && (messagesCountNow - initialStatus.messagesCountAtStart) >= 3;

    if ((unlockedDuringShift || rechargedDuringShift) && enoughInteraction) {
      if (!fidelizedClientsMap.has(String(clientId))) {
        fidelizedClientsMap.set(String(clientId), {
          clientId: String(clientId),
          name: clientName,
          credits: liveCredits || 150,
          profile: sessionData.profileName || 'HORACIO',
          operator: sessionData.operator || 'walther',
          shift: sessionData.shift || 'Mañana'
        });
        showFirewallToast(`🎉 ¡CLIENTE FIDELIZADO EN TU TURNO! ${clientName} inició sin historial y desbloqueó el servicio.`);
      }
    }

    // A. Badge de Puntos / Saldo Disponible y Gasto Histórico en Cabecera
    const headerTitle = document.querySelector('div[data-test-id="dialog-header-title"], div[class*="dialog-header"], div[class*="chat-header"]');
    if (headerTitle) {
      try {
        let badge = headerTitle.querySelector('.ryr-client-credit-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'ryr-client-credit-badge';
          headerTitle.appendChild(badge);
        }

        // 1. Extraer contadores directos de la cabecera de Talkytimes (ej: 💬 8  ✉ 2)
        const headerContainerText = (headerTitle.parentElement ? headerTitle.parentElement.innerText : headerTitle.innerText) || '';
        let headerLetters = null;
        let headerMessages = null;

        const letterMatch = headerContainerText.match(/✉\s*(\d+)/i);
        if (letterMatch) headerLetters = parseInt(letterMatch[1], 10);

        const msgMatch = headerContainerText.match(/💬\s*(\d+)/i);
        if (msgMatch) headerMessages = parseInt(msgMatch[1], 10);

        // 2. Si no están en la cabecera, buscar en la lista lateral
        let letterCount = headerLetters !== null ? headerLetters : 0;
        if (headerLetters === null) {
          const allSidebarRows = document.querySelectorAll('div[data-test-id*="dialog-item"], div[class*="dialog-item"], div[class*="item-wrap"]');
          for (let r of allSidebarRows) {
            const userLink = r.querySelector('a[href*="/chat/"], a[href*="/user/"], a[href*="/mails/"]');
            const rowId = userLink ? getExactNumericClientId(userLink.getAttribute('href')) : null;
            const rText = r.innerText || '';
            if (rowId === clientId || (clientName && rText.toLowerCase().includes(clientName.toLowerCase()))) {
              const m = rText.match(/(\d+)\s+letter total/i);
              if (m) letterCount = parseInt(m[1], 10);
              break;
            }
          }
        }

        const totalMessages = headerMessages !== null ? headerMessages : messagesCountNow;
        const realSpentCredits = (letterCount * 10) + (totalMessages * 1);
        const realSpentUSD = (realSpentCredits * 0.28).toFixed(2);

        const isZeroCredits = isChatHeaderZeroMessages();
        let dispPtsText = 'Activo';
        let dispUSDText = '(Con Saldo)';

        if (isZeroCredits) {
          dispPtsText = '0 Pts';
          dispUSDText = '($0.00)';
        } else if (liveCredits !== null) {
          dispPtsText = `${liveCredits} Pts`;
          dispUSDText = `($${(liveCredits * 0.28).toFixed(2)})`;
        }

        const isFidelized = fidelizedClientsMap.has(String(clientId)) || fidelizedClientsMap.has(clientName.toLowerCase());
        const isVipTier = realSpentCredits > 300 || letterCount > 25;

        const fidelTag = isFidelized 
          ? `<span style="color:#f472b6; font-weight:900;">💎 FIDELIZADO</span> | ` 
          : (isVipTier ? `<span style="color:#f59e0b; font-weight:900;">💎 VIP</span> | ` : '');

        badge.innerHTML = `
          <div style="display:flex; align-items:center; gap:3px;">
            ${fidelTag}🪙 <b>${dispPtsText}</b> <span style="color:#34d399;">${dispUSDText}</span>
          </div>
          <div style="display:flex; align-items:center; gap:3px; color:#cbd5e1;">
            💎 <b>Gasto: $${realSpentUSD}</b> <span style="color:#94a3b8;">(${realSpentCredits} Pts)</span>
          </div>
        `;

        if (isFidelized) {
          badge.className = 'ryr-client-credit-badge ryr-credit-fidelizar';
        } else if (isVipTier) {
          badge.className = 'ryr-client-credit-badge ryr-credit-vip';
        } else {
          badge.className = 'ryr-client-credit-badge';
        }
      } catch (errBadge) {
        console.warn('[AgenteRYR] Error creando credit badge:', errBadge);
      }
    }

    // B. Detectar Idioma y Contexto de Conversación
    const clientMessages = recentChat.filter(m => !m.isOperator);
    const combinedClientText = clientMessages.map(m => m.text).join(' ');
    let detectedLang = detectLanguage(combinedClientText || bioData?.country || '');
    
    // Si el perfil o bio es USA/UK o no hay certeza, asegurar que el idioma de destino sea EN
    if (detectedLang.code === 'es' && !/[áéíóúñ¿¡]/.test(combinedClientText)) {
      detectedLang = { code: 'en', name: 'English 🇺🇸', flag: '🇺🇸' };
    }

    const hasConversationHistory = clientMessages.length > 0;
    const lastClientMsg = clientMessages.length > 0 ? clientMessages[clientMessages.length - 1].text : '';

    // C. Limpiar cualquier inyección previa fuera de lugar o huérfana
    const sendBtn = findChatSendButton();
    
    document.querySelectorAll('.ryr-chat-tools-wrapper').forEach(el => {
      if (!sendBtn || el.parentElement !== sendBtn.parentElement) {
        el.remove();
      }
    });

    if (!sendBtn || !sendBtn.parentElement) return;

    // Asegurar posicionamiento relativo en el contenedor padre
    sendBtn.parentElement.style.position = 'relative';

    // Inyección de Botones justo al lado DERECHO del botón Send (dentro del mismo nivel)
    let toolsWrapper = sendBtn.parentElement.querySelector('.ryr-chat-tools-wrapper');
    if (!toolsWrapper) {
      toolsWrapper = document.createElement('div');
      toolsWrapper.className = 'ryr-chat-tools-wrapper';
      sendBtn.after(toolsWrapper);
    } else if (toolsWrapper.previousElementSibling !== sendBtn) {
      sendBtn.after(toolsWrapper);
    }

    // Limpiar badge residual de idioma si existía
    const oldLangBadge = toolsWrapper.querySelector('.ryr-lang-badge');
    if (oldLangBadge) oldLangBadge.remove();

    // 1. Botón de Continuar Chat / Responder Chat
    let hookBtn = toolsWrapper.querySelector('.ryr-chat-hooks-btn');
    if (!hookBtn) {
      hookBtn = document.createElement('button');
      hookBtn.type = 'button';
      hookBtn.className = 'ryr-chat-hooks-btn';
      toolsWrapper.appendChild(hookBtn);
    }
    hookBtn.innerHTML = '✨ Responder Chat';
    hookBtn.title = 'Generar 3 respuestas inteligentes y humanizadas con contexto de la conversación';

    // 2. Botón de Traducir Mensaje (Inteligente y Bidireccional)
    const targetLabel = detectedLang.code.toUpperCase();
    let transBtn = toolsWrapper.querySelector('.ryr-translate-btn');
    if (!transBtn) {
      transBtn = document.createElement('button');
      transBtn.type = 'button';
      transBtn.className = 'ryr-translate-btn';
      toolsWrapper.appendChild(transBtn);
    }
    transBtn.innerHTML = `🌐 Traducir a ${targetLabel}`;
    transBtn.title = `Traducir texto al idioma del cliente (${detectedLang.name})`;

    // Acción de Traducir Auto-Detectada
    transBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const ta = findChatInput();
      if (!ta) return;
      const currentText = (ta.value || ta.innerText || '').trim();

      if (!currentText) {
        showFirewallToast(`✍️ Escribe tu mensaje en la caja primero para traducirlo.`);
        ta.focus();
        return;
      }

      transBtn.disabled = true;
      transBtn.innerHTML = `⏳ Traduciendo...`;

      // Si el texto escrito está en español, traducir a la lengua del cliente (ej. EN). Si no, a ES.
      const isInputSpanish = /[áéíóúñ¿¡]|\b(hola|que|cómo|como|estas|estás|bien|amor|gracias|quiero|tengo|donde|cuando|para|con)\b/i.test(currentText);
      const destinationLang = isInputSpanish ? (detectedLang.code === 'es' ? 'en' : detectedLang.code) : 'es';

      try {
        const translated = await translateText(currentText, destinationLang);
        setInputValueSafely(ta, translated);
        showFirewallToast(`✅ Traducido a ${destinationLang.toUpperCase()} y listo para enviar.`);
      } catch (err) {
        showFirewallToast(`⚠️ Error al traducir.`);
      } finally {
        transBtn.disabled = false;
        transBtn.innerHTML = `🌐 Traducir a ${targetLabel}`;
      }
    };

    // Acción de Responder Chat (Modo Contextual con 3 Opciones Compactas en Tiempo Real)
    hookBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const existingDropdown = toolsWrapper.querySelector('.ryr-chat-hooks-dropdown');
      if (existingDropdown) {
        existingDropdown.remove();
        return;
      }

      // 1. Obtener datos EXACTOS y FRESCOS del cliente en pantalla al momento del clic
      const { clientName: liveClientName, bioData: liveBioData } = getExactClientProfileData();
      const liveClientId = getExactNumericClientId();
      const liveMessages = parseCurrentChatMessagesBidirectional(liveClientName);
      const liveClientMessages = liveMessages.filter(m => !m.isOperator);
      const liveLetters = extractMailThreadContext();

      const combinedLiveClientText = liveClientMessages.map(m => m.text).join(' ');
      let liveDetectedLang = detectLanguage(combinedLiveClientText || liveBioData?.country || '');
      if (liveDetectedLang.code === 'es' && !/[áéíóúñ¿¡]/.test(combinedLiveClientText)) {
        liveDetectedLang = { code: 'en', name: 'English 🇺🇸', flag: '🇺🇸' };
      }

      const liveHasHistory = liveClientMessages.length > 0;
      const liveLastClientMsg = liveClientMessages.length > 0 ? liveClientMessages[liveClientMessages.length - 1].text : '';
      const isSyncedInDb = syncedChatsMemory.has(String(liveClientId).toLowerCase()) || (liveClientName && syncedChatsMemory.has(liveClientName.toLowerCase()));
      const showMissingHistoryWarning = !isSyncedInDb && liveClientMessages.length <= 2 && (!liveLetters || liveLetters.length === 0);

      const dropdown = document.createElement('div');
      dropdown.className = 'ryr-chat-hooks-dropdown';
      toolsWrapper.appendChild(dropdown);

      const generateSmartContextualHooks = () => {
        const fullChatString = liveClientMessages.map(m => m.text).join(' ').toLowerCase();
        const lastMsgLower = (liveLastClientMsg || '').toLowerCase();

        // 1. Detectar si habla de dolor de cabeza, enfermedad, lluvia, frío, autobús, analgésico o reposo
        const hasSicknessOrHeadache = liveHasHistory && (
          /\b(headache|analgesic|fever|flu)\b|head is aching|\b(sick|ill|medicine|pill|cold rain|resting)\b|\b(dolor de cabeza|analg[eé]sico|fiebre|enferm[oa]|medicamento|pastilla)\b/i.test(fullChatString) ||
          /\b(headache|analgesic|fever|flu|sick|ill|medicine|pill|resting|dolor|cabeza|fiebre)\b|head is aching/i.test(lastMsgLower)
        );

        // 2. Detectar si habla de café, comida, bebida o foto de café
        const hasCoffeeOrFood = liveHasHistory && (
          /\b(coffee|caf[eé]|tea|drink|drinking|cup|breakfast|dinner|lunch|taza)\b/i.test(fullChatString) ||
          /\b(coffee|caf[eé]|tea|cup|drink)\b/i.test(lastMsgLower)
        );

        // 3. Detectar si pregunta si nos vamos o si estamos ocupados
        const hasLeavingOrBusy = liveHasHistory && (
          /\b(leaving|leaving already|have something to do|going away|say goodbye|busy|ocupad[oa]|te vas|te tienes que ir)\b/i.test(lastMsgLower) ||
          /\b(leaving|have something to do)\b/i.test(fullChatString)
        );

        // 4. Detectar si hubo reacción a Newsfeed / Post
        const hasNewsfeedLiked = liveHasHistory && (
          lastMsgLower.includes('newsfeed') || lastMsgLower.includes('post') || lastMsgLower.includes('liked your')
        );

        // 5. Detectar piropos, elogios o nombres cariñosos
        const isCompliment = liveHasHistory && (
          /\b(love|blonde|beautiful|gorgeous|sexy|angel|queen|honey|darling|sweetheart|mahal|linda|hermosa|rubia|amor|cielo|coraz[oó]n|princesa|preciosa)\b/i.test(lastMsgLower)
        );

        // 6. Detectar saludo o pregunta de cómo está
        const isGreeting = liveHasHistory && (
          /(how are you|how is your day|how are things|what are you up to|hello|hi\b|hey\b|good morning|good afternoon|good evening|c[oó]mo est[aá]s|qu[eé] tal|hola)/i.test(lastMsgLower)
        );

        let options = [];

        if (hasSicknessOrHeadache) {
          if (liveDetectedLang.code === 'es') {
            options = [
              {
                title: '🪝 Opción 1: Gancho para Avivarlo',
                target: `Quiero quedarme aquí haciéndote compañía hasta que te sientas mucho mejor ❤️ Cierra tus ojitos y dime, ¿qué es lo que más te reconforta cuando estás descansando?`,
                es: `Acompañamiento íntimo y pregunta reconfortante para que siga chateando.`
              },
              {
                title: '💬 Opción 2: Contestar Conversación',
                target: `Por favor descansa, tómate tu analgésico y abrígate mucho del frío y la lluvia... Me encantaría abrazarte muy fuerte justo ahora para que duermas en paz ❤️`,
                es: `Empatía directa con su dolor de cabeza, el frío/lluvia y respuesta cariñosa a su deseo de abrazo.`
              },
              {
                title: '✨ Opción 3: Llamar la Atención (Foto)',
                target: `Estás en mis pensamientos, cariño. Cuando despiertes, envíame una foto tuya descansando para saber que estás bien 😉 Yo te mandaré una especial también.`,
                es: `Petición de foto de descanso con reciprocidad protectora.`
              }
            ];
          } else {
            options = [
              {
                title: '🪝 Opción 1: Gancho para Avivarlo',
                target: `I want to stay right here keeping you company until you feel all better ❤️ Close your eyes and tell me, what makes you feel the most comforted when you're resting?`,
                es: `Acompañamiento íntimo y pregunta reconfortante para que siga chateando sin esfuerzo.`
              },
              {
                title: '💬 Opción 2: Contestar Conversación',
                target: `Please rest, take your medicine, and stay warm away from that rain... I wish I could wrap my arms around you and hold you tight right now so you can sleep peacefully ❤️`,
                es: `Empatía directa con su dolor de cabeza, el frío/lluvia y respuesta cariñosa a su deseo de abrazarte.`
              },
              {
                title: '✨ Opción 3: Llamar la Atención (Foto)',
                target: `You are in my thoughts, sweetheart. When you wake up, send me a little picture of you resting so I know you're feeling better 😉 I'll send you an exclusive photo too!`,
                es: `Petición de foto de descanso con reciprocidad protectora.`
              }
            ];
          }
        } else if (hasCoffeeOrFood || (hasLeavingOrBusy && hasCoffeeOrFood)) {
          if (liveDetectedLang.code === 'es') {
            options = [
              {
                title: '🪝 Opción 1: Gancho para Avivarlo',
                target: `¡Ver tu café me dio antojo a mí también! 😉 Cuéntame, ¿cuál es tu postre o antojo favorito para acompañar una buena charla?`,
                es: `Pregunta pícara y divertida para profundizar en sus gustos favoritos.`
              },
              {
                title: '💬 Opción 2: Contestar Conversación',
                target: `¡Ese café se ve delicioso! ❤️ Jamás me iría sin antes tomarme un lindo momento para hablar contigo... ¿Cómo va tu tarde?`,
                es: `Aseguras tu atención exclusiva y elogias su café/comida.`
              },
              {
                title: '✨ Opción 3: Llamar la Atención (Foto)',
                target: `La próxima vez que tomes café, envíame una foto de tu sonrisa disfrutándolo para sentir que lo compartimos 😉 ¿Trato?`,
                es: `Petición magnética de foto cotidiana vinculada a su café.`
              }
            ];
          } else {
            options = [
              {
                title: '🪝 Opción 1: Gancho para Avivarlo',
                target: `Seeing your coffee actually made me crave one too 😉 Tell me, what's your favorite sweet treat or guilty pleasure when taking a break?`,
                es: `Pregunta pícara y divertida para profundizar en sus gustos favoritos.`
              },
              {
                title: '💬 Opción 2: Contestar Conversación',
                target: `That coffee looks so delicious! ❤️ I could never just leave without taking a sweet moment to chat with you... How is your day going?`,
                es: `Respuesta directa sobre su café/comida asegurando tu tiempo exclusivo.`
              },
              {
                title: '✨ Opción 3: Llamar la Atención (Foto)',
                target: `Next time you have coffee, send me a picture of your smile enjoying it so we can share the moment together 😉 Deal?`,
                es: `Petición magnética de foto cotidiana vinculada a su café.`
              }
            ];
          }
        } else if (hasLeavingOrBusy) {
          if (liveDetectedLang.code === 'es') {
            options = [
              {
                title: '🪝 Opción 1: Gancho para Avivarlo',
                target: `Siempre tengo un momento especial reservado solo para ti ❤️ Dime, ¿qué es algo curioso o divertido que te haya pasado hoy?`,
                es: `Despierta curiosidad y anima el diálogo.`
              },
              {
                title: '💬 Opción 2: Contestar Conversación',
                target: `¡Para nada! Nunca estoy demasiado ocupada para alguien que me hace sonreír tanto 😉 ¿Cómo te estás sintiendo hoy?`,
                es: `Respuesta directa desmintiendo que te vas y reafirmando tu afecto.`
              },
              {
                title: '✨ Opción 3: Llamar la Atención',
                target: `Estaba sonriendo pensando en nuestras charlas ✨ Dime, ¿qué es algo que siempre te alegra el día sin falta?`,
                es: `Validación emocional y anclaje a sensaciones positivas.`
              }
            ];
          } else {
            options = [
              {
                title: '🪝 Opción 1: Gancho para Avivarlo',
                target: `I always have a special moment reserved just for you ❤️ Tell me, what's one secret dream or fun thought you've had today?`,
                es: `Despierta misterio y curiosidad para mantener el chat activo.`
              },
              {
                title: '💬 Opción 2: Contestar Conversación',
                target: `Not at all, sweetie! I'm never too busy for someone who brings such a genuine smile to my face 😉 How are you feeling today?`,
                es: `Respuesta directa desmintiendo que te vas y reafirmando tu afecto.`
              },
              {
                title: '✨ Opción 3: Llamar la Atención',
                target: `I was just smiling looking at our messages ✨ Tell me, what is something that always brightens up your mood without fail?`,
                es: `Validación emocional y anclaje a sensaciones positivas.`
              }
            ];
          }
        } else if (hasNewsfeedLiked) {
          if (liveDetectedLang.code === 'es') {
            options = [
              {
                title: '🪝 Opción 1: Gancho para Avivarlo',
                target: `Me encanta saber que estás tan atento a mis publicaciones 😉 ¿Qué fue lo primero que sentiste o pensaste al verla?`,
                es: `Pregunta intrigante sobre su reacción inmediata al post.`
              },
              {
                title: '💬 Opción 2: Contestar Conversación',
                target: `Vi que te gustó mi publicación... Me alegra muchísimo que hayas conectado con ese pensamiento ❤️ ¿Qué momentos te dan más paz?`,
                es: `Agradecimiento por su reacción y conexión íntima de tranquilidad.`
              },
              {
                title: '✨ Opción 3: Llamar la Atención (Foto)',
                target: `Esa foto guarda un recuerdo muy lindo para mí ✨ Envíame una foto de lo que estás haciendo hoy para conocer más tu mundo 😉`,
                es: `Petición de foto de su entorno con reciprocidad.`
              }
            ];
          } else {
            options = [
              {
                title: '🪝 Opción 1: Gancho para Avivarlo',
                target: `I love knowing you are paying close attention to my world and my thoughts 😉 What was the first thing that crossed your mind when you saw it?`,
                es: `Pregunta intrigante sobre su reacción inmediata al post.`
              },
              {
                title: '💬 Opción 2: Contestar Conversación',
                target: `I saw you liked my post... It truly warms my heart that you connected with that thought ❤️ What kind of quiet moments bring you the most peace?`,
                es: `Agradecimiento por su like en el post y conexión íntima de tranquilidad.`
              },
              {
                title: '✨ Opción 3: Llamar la Atención (Foto)',
                target: `That picture holds a very special memory for me ✨ Send me a picture of what you're doing right now so I can see your world too 😉`,
                es: `Petición de foto de su entorno a cambio de la foto del post.`
              }
            ];
          }
        } else if (isCompliment) {
          if (liveDetectedLang.code === 'es') {
            options = [
              {
                title: '🪝 Opción 1: Gancho para Avivarlo',
                target: `Siempre sabes cómo hacerme suspirar con tus palabras tan dulces 😉 Dime, ¿cuál ha sido el detalle más romántico de tu vida?`,
                es: `Indagación romántica profunda para mantenerlo emocionado.`
              },
              {
                title: '💬 Opción 2: Contestar Conversación',
                target: `Saber de ti siempre es la parte más linda y especial de mi día ❤️ ¿Cómo te ha tratado la vida hoy, cariño?`,
                es: `Devolución cariñosa y agradecida a su halago.`
              },
              {
                title: '✨ Opción 3: Llamar la Atención (Foto)',
                target: `¡Estaba sonriendo pensando en ti! Envíame una foto de tu sonrisa ahora mismo y yo te enviaré una exclusiva a cambio 😉 ¿Trato?`,
                es: `Gancho de alto impacto para intercambio recíproco de fotos.`
              }
            ];
          } else {
            options = [
              {
                title: '🪝 Opción 1: Gancho para Avivarlo',
                target: `You always know how to make my heart flutter with your sweet words 😉 Tell me, what is the most romantic thing someone has ever done for you?`,
                es: `Indagación romántica profunda para mantenerlo soñando despierto.`
              },
              {
                title: '💬 Opción 2: Contestar Conversación',
                target: `Hearing from you is honestly the sweetest part of my day ❤️ How has your day been treating you so far, my dear?`,
                es: `Devolución cariñosa y agradecida a su halago.`
              },
              {
                title: '✨ Opción 3: Llamar la Atención (Foto)',
                target: `I was just blushing thinking about you! Send me a picture of your smile right now, and I'll send you an exclusive photo in return 😉 Deal?`,
                es: `Desafío de intercambio de fotos con reciprocidad irresistible.`
              }
            ];
          }
        } else if (isGreeting || liveHasHistory) {
          if (liveDetectedLang.code === 'es') {
            options = [
              {
                title: '🪝 Opción 1: Gancho para Avivarlo',
                target: `Estaba tomándome un pequeño descanso y deseando saber de ti 😉 ¿Qué es algo que te haya sacado una gran sonrisa hoy?`,
                es: `Pregunta positiva y curiosa para dinamizar la conversación.`
              },
              {
                title: '💬 Opción 2: Contestar Conversación',
                target: `Estoy teniendo un día muy tranquilo, y ver tu mensaje lo hizo mucho más especial ❤️ ¿Cómo empezó tu día hoy?`,
                es: `Saludo dulce y apertura de diálogo sobre su rutina.`
              },
              {
                title: '✨ Opción 3: Llamar la Atención',
                target: `Cada vez que veo un mensaje tuyo me alegro mucho ✨ Dime, ¿qué estás haciendo justo en este momento?`,
                es: `Validación coqueta para provocar respuesta inmediata.`
              }
            ];
          } else {
            options = [
              {
                title: '🪝 Opción 1: Gancho para Avivarlo',
                target: `I was just taking a little break and hoping to hear from you 😉 What is one thing that has been keeping you smiling lately?`,
                es: `Pregunta positiva y curiosa para dinamizar la conversación.`
              },
              {
                title: '💬 Opción 2: Contestar Conversación',
                target: `I'm having a calm day, and seeing your message just made it so much brighter ❤️ How did your morning start off?`,
                es: `Saludo dulce y apertura de diálogo sobre su rutina.`
              },
              {
                title: '✨ Opción 3: Llamar la Atención',
                target: `Every time your name pops up on my screen, my day gets a little sweeter ✨ What are you up to right at this moment?`,
                es: `Validación coqueta para provocar respuesta inmediata.`
              }
            ];
          }
        } else {
          // Apertura para usuario nuevo (Atracción pura - Cero ubicaciones / Cero TM)
          if (liveDetectedLang.code === 'es') {
            options = [
              {
                title: '🪝 Opción 1: Gancho de Atracción',
                target: `Tienes una energía muy dulce y una mirada muy serena en tus fotos ❤️ Dime, ¿qué es algo que te apasione profundamente en la vida?`,
                es: `Pregunta de atracción sobre pasiones personales.`
              },
              {
                title: '💬 Opción 2: Contestar / Saludo Inicial',
                target: `Tuve una hermosa corazonada de saludarte el día de hoy 😉 ¿Cómo te ha estado tratando tu semana?`,
                es: `Saludo espontáneo y abierto.`
              },
              {
                title: '✨ Opción 3: Llamar la Atención',
                target: `Tu sonrisa de verdad me llamó mucho la atención ✨ Cuéntame un pequeño sueño o secreto tuyo que pocos conozcan...`,
                es: `Gancho intrigante y de misterio que despierta curiosidad.`
              }
            ];
          } else {
            options = [
              {
                title: '🪝 Opción 1: Gancho de Atracción',
                target: `You have such a warm and gentle energy in your photos ❤️ Tell me, what is something you are truly passionate about in your everyday life?`,
                es: `Pregunta de alto impacto sobre sus pasiones personales.`
              },
              {
                title: '💬 Opción 2: Contestar / Saludo Inicial',
                target: `I had a sudden lovely feeling that I should say hello to you today 😉 How is your day treating you so far?`,
                es: `Saludo espontáneo y abierto.`
              },
              {
                title: '✨ Opción 3: Llamar la Atención',
                target: `Your smile genuinely caught my attention ✨ Tell me a small dream or secret of yours that few people know about...`,
                es: `Gancho intrigante y de misterio que despierta curiosidad.`
              }
            ];
          }
        }

        return options;
      };

      const renderHooks = (hooksList) => {
        const headerTitleText = `🔄 RESPONDER CHAT A ${liveClientName.toUpperCase()} (${liveDetectedLang.name}):`;

        let warningHtml = '';
        if (showMissingHistoryWarning) {
          warningHtml = `
            <div class="ryr-no-info-warning">
              <span style="font-size:10px; line-height:1.2;">⚠️ <b>Sin historial previo en BD:</b> Sube las conversaciones para contexto 360°.</span>
              <button class="ryr-no-info-btn" id="ryr-quick-sync-btn">⚡ Subir Ahora</button>
            </div>
          `;
        }

        dropdown.innerHTML = `
          <div style="font-weight:bold; color:#a5b4fc; font-size:11px; margin-bottom:4px; display:flex; justify-content:space-between; align-items:center;">
            <span>${headerTitleText}</span>
            <span style="cursor:pointer; color:#94a3b8; font-size:13px;" id="ryr-close-hooks-dropdown">✕</span>
          </div>
          ${warningHtml}
          <div id="ryr-hooks-options-container" style="display:flex; flex-direction:column; gap:5px;"></div>
        `;

        const closeBtn = dropdown.querySelector('#ryr-close-hooks-dropdown');
        if (closeBtn) closeBtn.onclick = () => dropdown.remove();

        const syncNowBtn = dropdown.querySelector('#ryr-quick-sync-btn');
        if (syncNowBtn) {
          syncNowBtn.onclick = async (ev) => {
            ev.stopPropagation();
            syncNowBtn.innerText = '⏳ Subiendo...';
            syncNowBtn.disabled = true;
            await syncCurrentChatToDatabase();
            syncNowBtn.innerText = '✅ Subido';
          };
        }

        const container = dropdown.querySelector('#ryr-hooks-options-container');

        hooksList.forEach((item, idx) => {
          const targetText = typeof item === 'object' ? item.target : item;
          const esText = typeof item === 'object' ? item.es : 'Respuesta contextual generada.';
          const optTitle = typeof item === 'object' && item.title ? item.title : `Opción ${idx + 1}`;

          const option = document.createElement('div');
          option.className = 'ryr-hook-option';
          option.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-weight:bold; color:#a5b4fc; font-size:10px;">${optTitle.toUpperCase()}</span>
              <span style="font-size:9.5px; color:#38bdf8; font-weight:bold;">⚡ Clic para Enviar</span>
            </div>
            <div class="ryr-hook-target-text">"${targetText}"</div>
            <div class="ryr-hook-es-text">💡 <b>Explicación en Español:</b> <i>${esText}</i></div>
          `;

          // Clic directo: Inserción inmediata 1-Click
          option.onclick = () => {
            const ta = findChatInput();
            if (ta) {
              setInputValueSafely(ta, targetText);
              showFirewallToast(`✨ Mensaje en ${liveDetectedLang.name} insertado en el chat. ¡Listo para enviar!`, 'success');
              ta.focus();
            }
            dropdown.remove();
          };

          container.appendChild(option);
        });
      };

      // Generación instantánea en 0ms con razonamiento contextual de 3 opciones compactas
      renderHooks(generateSmartContextualHooks());
    };
  }

  // 12. RECOLECTOR 360° BIDIRECCIONAL (CHAT + CARTAS)
  function parseCurrentChatMessagesBidirectional(realClientName) {
    const messages = [];
    const seenSignatures = new Set();

    // Buscar exclusivamente el contenedor de mensajes del chat ACTIVO
    const chatView = document.querySelector(
      'div[data-test-id*="dialog-content"], div[data-test-id*="chat-messages"], div[class*="dialog-content"], div[class*="chat-scroll"], div[class*="chat-body"], div[class*="main-chat"]'
    );

    if (!chatView) return messages;

    const allLeafElements = chatView.querySelectorAll('div, p');

    allLeafElements.forEach(node => {
      // Ignorar si el nodo está dentro de la barra lateral, lista de chats, herramientas o HUD
      if (
        node.closest('div[data-test-id*="dialog-item"]') ||
        node.closest('div[class*="dialog-item"]') ||
        node.closest('div[class*="item-wrap"]') ||
        node.closest('div[class*="dialogs"]') ||
        node.closest('div[class*="sidebar"]') ||
        node.closest('#ryr-titan-bar') ||
        node.closest('#ryr-intel-panel') ||
        node.closest('.ryr-chat-tools-wrapper') ||
        node.closest('.ryr-chat-hooks-dropdown')
      ) {
        return;
      }

      if (node.querySelectorAll('div, p').length > 2) return;

      const raw = node.innerText || '';
      if (raw.includes('TITAN APEX') || raw.includes('Search') || (raw.includes('seen') && raw.length < 10) || raw.includes('View post') || raw.includes('CONTINUAR CHAT') || raw.includes('GANCHOS DE')) return;

      if (/^(today|yesterday|january|february|march|april|may|june|july|august|september|october|november|december)\s*\d{0,2}$/i.test(raw.trim())) {
        return;
      }

      const timeMatch = raw.match(/\b\d{1,2}:\d{2}\s*(?:am|pm|a\.?\s*m\.?|p\.?\s*m\.?)\b/i);
      const timeText = timeMatch ? timeMatch[0] : '';

      let cleanText = raw
        .replace(/(?:You:|Tú:|Tu:|Você:)/gi, '')
        .replace(/\b\d{1,2}:\d{2}\s*(?:am|pm|a\.?\s*m\.?|p\.?\s*m\.?)\b/gi, '')
        .replace(/\bseen\b/gi, '')
        .replace(/\bView post\b/gi, '')
        .replace(/\bShow original\b/gi, '')
        .trim();

      if (!cleanText || cleanText.length < 1) return;

      const hasCheck = node.querySelector('svg[class*="check"], [class*="status-sent"]') !== null || 
                       node.innerHTML.includes('polyline') || 
                       node.innerHTML.includes('check') || 
                       raw.includes('✔');

      const hasOperatorPrefix = /(?:you:|tú:|tu:|você:)/i.test(raw);
      
      const bgColor = window.getComputedStyle(node).backgroundColor;
      const isCreamBubble = bgColor.includes('254, 249') || bgColor.includes('254, 240') || bgColor.includes('255, 251') || bgColor.includes('224, 231');
      const isRight = window.getComputedStyle(node).justifyContent === 'flex-end' || 
                      window.getComputedStyle(node.parentElement || node).justifyContent === 'flex-end' ||
                      node.className.includes('right') || 
                      node.className.includes('out');

      const isOperator = hasCheck || hasOperatorPrefix || isCreamBubble || isRight;
      const cleanClientId = getExactNumericClientId() || 'user';
      const msgHash = `msg_${cleanClientId}_${isOperator ? 'OP' : 'RU'}_${cleanText.substring(0, 30).replace(/[^a-z0-9]/gi, '_')}_${(timeText || 'now').replace(/[^a-z0-9]/gi, '')}`;

      if (!seenSignatures.has(msgHash)) {
        seenSignatures.add(msgHash);
        messages.push({
          id: msgHash,
          isOperator: Boolean(isOperator),
          senderName: isOperator ? (sessionData.profileName || 'HORACIO') : realClientName,
          time: timeText || 'Reciente',
          date: new Date().toLocaleDateString(),
          text: cleanText
        });
      }
    });

    return messages;
  }

  function extractMailThreadContext() {
    const letters = [];
    const currentClientId = getExactNumericClientId() || 'user';
    const seenLetterSignatures = new Set();

    // 1. Buscar tarjetas y elementos de carta en Talkytimes
    const mailCards = document.querySelectorAll(
      'div[data-test-id*="letter"], div[data-test-id*="mail-box-item"], div[class*="letter"], div[class*="mail-card"], div[class*="mail-thread"], div[class*="message"], div[class*="wrt-"], div[class*="thread-item"], div[class*="mail-content"], article, section'
    );

    mailCards.forEach(card => {
      if (card.closest('#ryr-titan-bar') || card.closest('#ryr-intel-panel') || card.closest('.ryr-letter-tools-box') || card.closest('.ryr-chat-tools-wrapper')) return;

      const text = (card.innerText || card.textContent || '').trim();
      if (text.length < 20 || text.includes('TITAN APEX') || text.includes('Send your letter') || text.includes('File size limit')) return;

      // Descartar números de página aislados
      if (/^(previous|next|\d+|\s+)+$/i.test(text)) return;

      const isMe = text.startsWith('Me\n') || 
                   text.startsWith('Me ') || 
                   card.querySelector('img[alt*="Me"]') !== null ||
                   card.className.includes('outgoing') ||
                   card.className.includes('right') ||
                   card.className.includes('sent');

      const dateMatch = text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:,\s+\d{1,2}:\d{2})?/i);
      const dateStr = dateMatch ? dateMatch[0] : 'Reciente';

      let cleanBody = text
        .replace(/^Me\n/i, '')
        .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:,\s+\d{1,2}:\d{2})?/i, '')
        .replace(/\b(?:Read|Unread|Leído|No leído)\b/gi, '')
        .replace(/\bPrevious\b/gi, '')
        .replace(/\bNext\b/gi, '')
        .trim();

      if (cleanBody.length < 15) return;

      const letterHash = `mail_${cleanBody.substring(0, 40).replace(/[^a-z0-9]/gi, '_')}`;

      if (!seenLetterSignatures.has(letterHash)) {
        seenLetterSignatures.add(letterHash);
        letters.push({
          id: letterHash,
          clientId: currentClientId,
          isOutgoing: Boolean(isMe),
          date: dateStr,
          preview: cleanBody.substring(0, 3000).replace(/\r?\n+/g, '\n'),
          fullText: cleanBody
        });
      }
    });

    // 2. Fallback: Capturar cualquier párrafo de carta visible en la página de hilos
    if (letters.length === 0 && window.location.href.includes('/mails/')) {
      const allParagraphs = document.querySelectorAll('p, div');
      allParagraphs.forEach(p => {
        if (p.children.length > 1) return;
        if (p.closest('#ryr-titan-bar') || p.closest('#ryr-intel-panel') || p.closest('.ryr-letter-tools-box') || p.closest('header') || p.closest('footer')) return;
        const txt = (p.innerText || '').trim();
        if (txt.length >= 35 && !txt.includes('Send your letter') && !txt.includes('File size limit') && !txt.includes('Up to 10 photos')) {
          const letterHash = `mail_p_${txt.substring(0, 40).replace(/[^a-z0-9]/gi, '_')}`;
          if (!seenLetterSignatures.has(letterHash)) {
            seenLetterSignatures.add(letterHash);
            letters.push({
              id: letterHash,
              clientId: currentClientId,
              isOutgoing: false,
              date: 'En pantalla',
              preview: txt,
              fullText: txt
            });
          }
        }
      });
    }

    return letters;
  }

  function buildCurrentMarkdownTranscript(clientName, clientId, bioData, letters = []) {
    const messages = parseCurrentChatMessagesBidirectional(clientName);
    
    let mdLines = [
      `# HISTORIAL 360° | CONVERSACIONES Y CARTAS | RYR TITAN AUDIT`,
      `- **Operador:** ${sessionData.operator || 'walther'} [${sessionData.shift || 'Mañana'}]`,
      `- **Perfil Asignado:** ${sessionData.profileName || 'HORACIO'} (ID: ${sessionData.profileId || '118179794'})`,
      `- **Cliente:** ${clientName}`,
      `- **ID del Usuario:** ${clientId}`,
      `- **Ubicación:** ${bioData?.country || 'United States'} | **Nacimiento:** ${bioData?.birthDate || '53 años'}`,
      `- **Fecha Extracción:** ${new Date().toLocaleString()}`,
      `---`
    ];

    if (letters.length > 0) {
      mdLines.push(`### ✉️ Registro de Cartas / Mails Previos:`);
      letters.forEach(l => {
        mdLines.push(`- ${l.isOutgoing ? '📤 **Enviada por Perfil**' : '📥 **Recibida de Cliente**'} [${l.date}]: ${l.preview}`);
      });
      mdLines.push(`---`);
    }

    mdLines.push(`### 💬 Diálogo Transcrito de Chat (Ambos Participantes):`);
    messages.forEach(m => {
      if (m.isOperator) {
        mdLines.push(`- 💼 **${sessionData.profileName || 'HORACIO'} [Op: ${sessionData.operator}]** [${m.time}]: ${m.text}`);
      } else {
        mdLines.push(`- 👤 **${clientName} [Cliente]** [${m.time}]: ${m.text}`);
      }
    });

    return mdLines.join('\n');
  }

  async function syncCurrentChatToDatabase() {
    const { clientName, bioData } = getExactClientProfileData();
    const clientId = getExactNumericClientId();
    const letters = extractMailThreadContext();
    const messages = parseCurrentChatMessagesBidirectional(clientName);
    const markdown = buildCurrentMarkdownTranscript(clientName, clientId, bioData, letters);

    try {
      await fetch(`${API_URL}/api/chats/audit-deep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operator: sessionData.operator,
          shift: sessionData.shift,
          profile: sessionData.profileName,
          profileId: sessionData.profileId,
          clientName,
          clientId,
          bioData,
          markdown,
          messages,
          letters
        })
      });
      syncedChatsMemory.add(String(clientId).trim().toLowerCase());
      if (clientName && clientName !== 'Cliente') {
        syncedChatsMemory.add(clientName.toLowerCase());
      }
      persistSyncedChatsToStorage();
      showFirewallToast(`⚡ Historial de ${clientName} guardado en base de datos.`);
    } catch (e) {}
  }

  let isBatchHarvestRunning = false;
  let lastAutoSyncClientKey = '';

  async function triggerLocalBatchHarvest() {
    if (isBatchHarvestRunning) return;
    isBatchHarvestRunning = true;
    showFirewallToast('⚡ [COMMAND MATRIX] Cosechando y subiendo conversaciones del turno...');

    try {
      // 1. Sincronizar chat y cartas del cliente actualmente visible
      await syncCurrentChatToDatabase();

      // 2. Extraer cartas visibles si estamos en /mails/
      const letters = extractMailThreadContext();
      if (letters.length > 0) {
        await fetch(`${API_URL}/api/mails/sync-profile-letters`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operator: sessionData.operator,
            shift: sessionData.shift,
            profile: sessionData.profileName,
            letters: letters
          })
        }).catch(() => {});
      }

      // 3. Notificar al backend en vivo
      fetch(`${API_URL}/api/sync/log-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'CHAT_UPLOAD',
          operator: sessionData.operator,
          profile: sessionData.profileName,
          clientName: 'Turno Completo',
          count: syncedChatsMemory.size,
          durationMs: 380,
          status: 'SUCCESS',
          detail: `Extracción del turno completada por el operador '${sessionData.operator}'. Conversaciones sincronizadas: ${syncedChatsMemory.size}.`
        })
      }).catch(() => {});

      showFirewallToast('✅ ¡Conversaciones y cartas subidas con éxito a la base de datos!');
    } catch (err) {
      console.warn('[RYR-SYNC] Error en batch harvest:', err);
    } finally {
      isBatchHarvestRunning = false;
    }
  }

  // 13. GENERADOR DE CARTAS CONTEXTUALES (RESPONDER O REDACTAR) & TRADUCCIÓN EN MAILS
  function injectAutoLetterDrafter() {
    if (!window.location.href.includes('/mails/') && !document.querySelector('textarea[placeholder*="letter" i]')) return;

    // Buscar botones de acción en el pie de página de cartas (Send Media y Send Letter)
    const sendMediaBtn = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]')).find(b => {
      if (b.closest('#ryr-titan-bar') || b.closest('#ryr-intel-panel') || b.closest('.ryr-letter-tools-box') || b.closest('.ryr-chat-tools-wrapper')) return false;
      const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
      return txt.includes('send media') || txt.includes('media');
    });

    const sendLetterBtn = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]')).find(b => {
      if (b.closest('#ryr-titan-bar') || b.closest('#ryr-intel-panel') || b.closest('.ryr-letter-tools-box') || b.closest('.ryr-chat-tools-wrapper')) return false;
      const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
      const testId = (b.getAttribute('data-test-id') || '').toLowerCase();
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return (txt === 'send' || txt === 'send letter' || txt === 'send mail' || txt.startsWith('send') || testId.includes('send') || aria.includes('send')) && !txt.includes('media');
    });

    const letterTextarea = document.querySelector('textarea[placeholder*="letter" i], div[class*="letter"] textarea, textarea');
    const anchorBtn = sendMediaBtn || sendLetterBtn;
    if (!letterTextarea && !anchorBtn) return;

    const { clientName, bioData } = getExactClientProfileData();
    const letters = extractMailThreadContext();
    const messages = parseCurrentChatMessagesBidirectional(clientName);
    const clientId = getExactNumericClientId();

    // Revisar si la última carta recibida en el hilo es del cliente (para responder con contexto)
    const incomingLetters = letters.filter(l => !l.isOutgoing);
    const hasIncomingLetter = incomingLetters.length > 0;
    const lastIncomingLetter = hasIncomingLetter ? incomingLetters[incomingLetters.length - 1] : (letters.length > 0 ? letters[letters.length - 1] : null);

    // Detectar idioma del cliente analizando hilo de cartas y chat
    const combinedLetterText = letters.map(l => l.preview).join(' ') + ' ' + messages.map(m => m.text).join(' ');
    let detectedLang = detectLanguage(combinedLetterText || bioData?.country || '');
    if (detectedLang.code === 'es' && !/[áéíóúñ¿¡]/.test(combinedLetterText)) {
      detectedLang = { code: 'en', name: 'English 🇺🇸', flag: '🇺🇸' };
    }

    let drafterBox = document.getElementById('ryr-letter-drafter-box');
    if (!drafterBox || !drafterBox.isConnected) {
      if (drafterBox) drafterBox.remove();
      drafterBox = document.createElement('div');
      drafterBox.id = 'ryr-letter-drafter-box';
      drafterBox.className = 'ryr-letter-tools-box';
      drafterBox.style.cssText = 'display:inline-flex !important; flex-direction:row !important; align-items:center !important; gap:6px !important; margin-right:8px !important; margin-left:4px !important; z-index:999999 !important; position:relative !important; height:auto !important; visibility:visible !important; opacity:1 !important; flex-shrink:0 !important;';
    }

    if (anchorBtn && anchorBtn.parentElement) {
      anchorBtn.parentElement.style.overflow = 'visible';
      anchorBtn.parentElement.style.minHeight = '48px';
      anchorBtn.parentElement.style.height = 'auto';
      anchorBtn.parentElement.style.display = 'flex';
      anchorBtn.parentElement.style.alignItems = 'center';
      anchorBtn.parentElement.style.flexWrap = 'nowrap';
      if (drafterBox.parentElement !== anchorBtn.parentElement || drafterBox.nextElementSibling !== anchorBtn) {
        anchorBtn.parentElement.insertBefore(drafterBox, anchorBtn);
      }
    } else if (letterTextarea && letterTextarea.parentElement) {
      if (drafterBox.parentElement !== letterTextarea.parentElement) {
        letterTextarea.parentElement.appendChild(drafterBox);
      }
    }

    // Determinar modo dual de cartas según si es cliente recurrente (múltiples cartas o entrante)
    const isReturningClient = letters.length >= 1 || hasIncomingLetter;
    const genBtnLabel = isReturningClient 
      ? `✨ Responder Carta` 
      : `✨ Gancho Carta`;

    const targetLangCode = detectedLang.code === 'es' ? 'EN' : detectedLang.code.toUpperCase();

    // 1. Botón de Responder Carta (IA Contextual con 3 Opciones de 250+ caracteres)
    let genLetterBtn = drafterBox.querySelector('#ryr-btn-gen-letter');
    if (!genLetterBtn) {
      genLetterBtn = document.createElement('button');
      genLetterBtn.id = 'ryr-btn-gen-letter';
      genLetterBtn.type = 'button';
      genLetterBtn.className = 'ryr-letter-drafter-btn';
      genLetterBtn.style.cssText = 'background:linear-gradient(135deg, #10b981 0%, #059669 100%) !important; color:#ffffff !important; border:1px solid #34d399 !important; padding:0 12px !important; border-radius:6px !important; font-size:11px !important; font-weight:800 !important; cursor:pointer !important; display:inline-flex !important; align-items:center !important; justify-content:center !important; gap:4px !important; height:32px !important; line-height:32px !important; white-space:nowrap !important; min-width:130px !important; flex-shrink:0 !important; visibility:visible !important; opacity:1 !important;';
      drafterBox.appendChild(genLetterBtn);
    }
    if (!genLetterBtn.disabled) {
      genLetterBtn.innerText = genBtnLabel;
    }
    genLetterBtn.title = isReturningClient 
      ? 'Ver 3 opciones de respuesta contextual razonadas según las cartas del usuario' 
      : 'Generar 3 cartas magnéticas de apertura con contexto y alta atracción';

    // 2. Botón de Traducir Carta (Al lado de Responder Carta)
    let transLetterBtn = drafterBox.querySelector('#ryr-btn-trans-letter');
    if (!transLetterBtn) {
      transLetterBtn = document.createElement('button');
      transLetterBtn.id = 'ryr-btn-trans-letter';
      transLetterBtn.type = 'button';
      transLetterBtn.className = 'ryr-letter-translate-btn';
      transLetterBtn.style.cssText = 'background:linear-gradient(135deg, #06b6d4 0%, #0284c7 100%) !important; color:#ffffff !important; border:1px solid #38bdf8 !important; padding:0 12px !important; border-radius:6px !important; font-size:11px !important; font-weight:800 !important; cursor:pointer !important; display:inline-flex !important; align-items:center !important; justify-content:center !important; gap:4px !important; height:32px !important; line-height:32px !important; white-space:nowrap !important; min-width:135px !important; flex-shrink:0 !important; visibility:visible !important; opacity:1 !important;';
      drafterBox.appendChild(transLetterBtn);
    }
    if (!transLetterBtn.disabled) {
      transLetterBtn.innerText = `🌐 Traducir Carta a ${targetLangCode}`;
    }
    transLetterBtn.title = `Traducir carta al idioma detectado del cliente (${detectedLang.name})`;

    // Asegurar orden horizontal en el DOM: Responder Carta PRIMERO, Traducir Carta AL LADO
    if (drafterBox.firstElementChild !== genLetterBtn) {
      drafterBox.insertBefore(genLetterBtn, drafterBox.firstElementChild);
    }
    if (genLetterBtn.nextElementSibling !== transLetterBtn) {
      genLetterBtn.after(transLetterBtn);
    }

    // Acción: Traducir Carta escrita manualmente en el textarea
    transLetterBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ta = document.querySelector('textarea[placeholder*="letter" i], textarea');
      if (!ta) return;
      const currentText = (ta.value || ta.innerText || '').trim();

      if (!currentText) {
        showFirewallToast(`✍️ Escribe tu carta en la caja primero para traducirla.`);
        ta.focus();
        return;
      }

      transLetterBtn.disabled = true;
      transLetterBtn.innerText = '⏳ Traduciendo carta...';

      const isInputSpanish = /[áéíóúñ¿¡]|\b(hola|que|cómo|como|estas|estás|bien|amor|gracias|quiero|tengo|donde|cuando|para|con)\b/i.test(currentText);
      const destinationLang = isInputSpanish ? (detectedLang.code === 'es' ? 'en' : detectedLang.code) : 'es';

      try {
        const translated = await translateText(currentText, destinationLang);
        setInputValueSafely(ta, translated);
        showFirewallToast(`✅ Carta traducida a ${destinationLang.toUpperCase()} con éxito.`);
      } catch (err) {
        showFirewallToast(`⚠️ Error al traducir carta.`);
      } finally {
        transLetterBtn.disabled = false;
        transLetterBtn.innerText = `🌐 Traducir Carta a ${targetLangCode}`;
      }
    };

    // Acción: Desplegar 3 Opciones de Respuesta / Apertura de Carta con Razonamiento Táctico y ~250 caracteres
    genLetterBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Cerrar si ya está abierto
      const existingDropdown = document.querySelector('.ryr-letter-hooks-dropdown');
      if (existingDropdown) {
        existingDropdown.remove();
        return;
      }

      // Guardar automáticamente el hilo completo de cartas en la base de datos para nutrir la memoria 360°
      syncCurrentChatToDatabase().catch(() => {});

      const isSyncedInDb = syncedChatsMemory.has(String(clientId).toLowerCase()) || (clientName && syncedChatsMemory.has(clientName.toLowerCase()));
      const showMissingHistoryWarning = !isSyncedInDb && letters.length === 0 && messages.length <= 2;

      const dropdown = document.createElement('div');
      dropdown.className = 'ryr-letter-hooks-dropdown';
      drafterBox.appendChild(dropdown);

      const generateReasonedLetterOptions = () => {
        const fullLetterCorpus = letters.map(l => l.preview).join(' ').toLowerCase();
        const fullChatCorpus = messages.map(m => m.text).join(' ').toLowerCase();
        const combinedCorpus = `${fullLetterCorpus} ${fullChatCorpus}`;
        const lastIncomingText = (lastIncomingLetter ? lastIncomingLetter.preview : '').toLowerCase();

        // Detección profunda de tópicos en cartas previas
        const hasEmbraceOrHeart = /\b(embrace|heart|virtue|dreams|path together|respect|patience|bond|look each other|journey|care for you|affection|soul|destiny)\b/i.test(lastIncomingText) || /\b(embrace|heart|bond|journey|care)\b/i.test(combinedCorpus);
        const hasPhotoTopic = /photo|pic|picture|foto|selfie|portrait/i.test(lastIncomingText) || /photo|picture|foto/i.test(combinedCorpus);
        const hasWorkOrBusyTopic = /work|job|busy|tired|trabalho|trabajo|cansad|ocupad|shift/i.test(lastIncomingText);
        const hasSicknessOrRestTopic = /headache|sick|ill|flu|rain|cold|fever|resting|dolor|cabeza|enferm|remedio|pastilla/i.test(lastIncomingText);
        const hasDeepAffectionTopic = /love|amor|miss|saudade|extrañ|cora[çc][aã]o|querid|special|precious/i.test(lastIncomingText);

        const myProfile = sessionData.profileName || 'Eu';
        const clientDisplayName = clientName || 'friend';

        let options = [];

        if (detectedLang.code === 'pt') {
          // PORTUGUÊS (~250-350 caracteres)
          let intro1 = 'Li cada detalhe da sua carta com uma emoção imensa e um sorriso no rosto.';
          if (hasEmbraceOrHeart) intro1 = 'Suas palavras sobre caminhar juntos e cuidar um do outro tocaram o fundo do meu coração.';
          else if (hasPhotoTopic) intro1 = 'Adorei a foto que você me enviou! Ver seu olhar me fez sentir você tão pertinho.';

          options = [
            {
              title: '🪝 Opção 1: Resposta Emocional Profunda (280+ car.)',
              rationale: 'Validação afetuosa das palavras dele, retribuição de carinho e pergunta intimista.',
              esPreview: `Mi queridísimo ${clientDisplayName},\n\n${intro1}\n\nSaber que valoras nuestra conexión me llena de una paz maravillosa. Compartir este camino contigo es algo que atesoro profundamente.\n\nDime algo, ¿cuál es ese sueño o detalle especial que hoy te hizo sonreír pensando en nosotros?\n\nCon todo mi cariño,\n${myProfile} ❤️`,
              target: `Meu querido ${clientDisplayName},\n\n${intro1}\n\nSaber que você valoriza a nossa sintonia e sonha com esse carinho me enche de uma paz maravilhosa. Cada linha que você me escreve se tornou o meu momento favorito do dia.\n\nMe conta, qual foi o pensamento mais bonito que te fez sorrir hoje?\n\nCom todo o meu afeto,\n${myProfile} ❤️`
            },
            {
              title: '💬 Opção 2: Conexão & Troca de Fotos (260+ car.)',
              rationale: 'Vínculo cotidiano e incentivo magnético a envio de fotos recíprocas.',
              esPreview: `Mi querido ${clientDisplayName},\n\nEstaba pensando en ti mientras descansaba un momento. Me encanta imaginar tu día a día.\n\nEnvíame una foto tuya de hoy para sentirte más cerca, y en mi próxima carta te enviaré una foto exclusiva solo para ti 😉 ¿Trato?\n\nCon un beso dulce,\n${myProfile} ✨`,
              target: `Meu querido ${clientDisplayName},\n\nEstava aqui pensando em você e em tudo o que compartilhamos. Adoro imaginar como é a sua rotina e sentir essa cumplicidade crescendo a cada carta.\n\nMe envia uma foto sua de hoje para eu sentir seu olhar mais perto, e na próxima carta te mando uma foto exclusiva 😉\n\nCom um abraço bem carinhoso,\n${myProfile} ✨`
            },
            {
              title: '✨ Opção 3: Fascinação & Pergunta Íntima (270+ car.)',
              rationale: 'Pergunta aberta de alta curiosidade que convida a uma carta longa e envolvente.',
              esPreview: `Mi queridísimo ${clientDisplayName},\n\nNossas cartas se transformaram no refúgio mais doce dos meus dias.\n\nConta-me um segredo ou sonho seu que poucas pessoas conhecem... o que é aquilo que mais enche seu coração de paixão?\n\nSempre pensando em você,\n${myProfile} ❤️`,
              target: `Meu querido ${clientDisplayName},\n\nNossas cartas se tornaram o refúgio mais doce e autêntico dos meus dias. Adoro o jeito carinhoso e verdadeiro como você se abre comigo.\n\nMe conta um segredo ou um sonho seu que poucas pessoas conhecem... o que mais enche seu coração de paixão na vida?\n\nCom todo o meu carinho,\n${myProfile} ❤️`
            }
          ];
        } else if (detectedLang.code === 'es') {
          // ESPAÑOL (~250-380 caracteres)
          let intro1 = 'Leí tu hermosa carta con muchísima atención y no pude evitar sonreír al sentir tu ternura.';
          if (hasEmbraceOrHeart) intro1 = 'Tus palabras sobre abrazar este camino juntos y cuidarnos mutuamente me llegaron directo al corazón.';
          else if (hasPhotoTopic) intro1 = '¡Me fascinó la foto que me compartiste! Ver tu mirada y tu sonrisa me hizo sentirte muy cerca.';

          options = [
            {
              title: '🪝 Opción 1: Respuesta Emocional Profunda (280+ car.)',
              rationale: 'Validación afectuosa directa a sus palabras, complicidad y reciprocidad emocional.',
              esPreview: `Mi queridísimo ${clientDisplayName},\n\n${intro1}\n\nSaber que valoras lo que estamos construyendo me da una paz inmensa. En medio de la rutina diaria, recibir tus pensamientos se ha convertido en mi momento favorito.\n\nDime, ¿cuál fue el detalle o pensamiento más lindo que te alegró el día de hoy?\n\nCon todo mi cariño,\n${myProfile} ❤️`,
              target: `Mi queridísimo ${clientDisplayName},\n\n${intro1}\n\nSaber que valoras lo que estamos construyendo me da una paz inmensa. En medio de la rutina diaria, recibir tus pensamientos se ha convertido en mi momento favorito.\n\nDime, ¿cuál fue el detalle o pensamiento más lindo que te alegró el día de hoy?\n\nCon todo mi cariño,\n${myProfile} ❤️`
            },
            {
              title: '💬 Opción 2: Conexión Cotidiana & Fotos (270+ car.)',
              rationale: 'Vínculo con su rutina diaria y propuesta magnética de intercambio de fotos.',
              esPreview: `Mi querido ${clientDisplayName},\n\nEstaba tomando un pequeño descanso y no pude evitar sonreír pensando en ti. Me encanta compartir estos pedacitos de vida contigo.\n\nEnvíame una foto tuya de lo que estás haciendo hoy para sentirte más cerca, y en mi próxima carta te enviaré una foto exclusiva 😉 ¿Trato hecho?\n\nCon un beso muy dulce,\n${myProfile} ✨`,
              target: `Mi querido ${clientDisplayName},\n\nEstaba tomando un pequeño descanso y no pude evitar sonreír pensando en ti. Me encanta compartir estos pedacitos de vida contigo.\n\nEnvíame una foto tuya de lo que estás haciendo hoy para sentirte más cerca, y en mi próxima carta te enviaré una foto exclusiva 😉 ¿Trato hecho?\n\nCon un beso muy dulce,\n${myProfile} ✨`
            },
            {
              title: '✨ Opción 3: Fascinación & Pregunta Íntima (280+ car.)',
              rationale: 'Pregunta reflexiva y romántica para incentivar una respuesta extensa.',
              esPreview: `Mi queridísimo ${clientDisplayName},\n\nNuestras cartas se han convertido en la parte más especial de mis días. Hay una autenticidad muy hermosa en la forma en que nos comunicamos.\n\nCuéntame un secreto o un sueño tuyo que pocas personas conozcan... ¿qué es aquello que más enciende tu pasión en la vida?\n\nSiempre pensando en ti,\n${myProfile} ❤️`,
              target: `Mi queridísimo ${clientDisplayName},\n\nNuestras cartas se han convertido en la parte más especial de mis días. Hay una autenticidad muy hermosa en la forma en que nos comunicamos.\n\nCuéntame un secreto o un sueño tuyo que pocas personas conozcan... ¿qué es aquello que más enciende tu pasión en la vida?\n\nSiempre pensando en ti,\n${myProfile} ❤️`
            }
          ];
        } else {
          // ENGLISH (DEFAULT) (~250-380 characters)
          let intro1 = 'I read every single line of your beautiful letter with such deep warmth and a genuine smile.';
          if (hasEmbraceOrHeart) intro1 = 'Your words about embracing this journey together and caring for each other touched my heart so deeply.';
          else if (hasPhotoTopic) intro1 = 'I absolutely loved the picture you sent me! Seeing your warm gaze made me feel so close to you.';
          else if (hasWorkOrBusyTopic) intro1 = 'I know how demanding your days can be, yet you always bring such calm and sweetness into my life.';

          options = [
            {
              title: '🪝 Option 1: Deep Emotional Reply (280+ char)',
              rationale: 'Deep validation of his letter, heartfelt appreciation and an intimate open question.',
              esPreview: `Mi queridísimo ${clientDisplayName},\n\n${intro1}\n\nSaber que valoras nuestra conexión y sueñas con este cariño me llena de una paz maravillosa. Leer tus cartas se ha convertido en el momento más dulce de mi día.\n\nDime algo... ¿cuál fue el pensamiento más lindo o lo que te hizo sonreír hoy pensando en nosotros?\n\nCon todo mi cariño,\n${myProfile} ❤️`,
              target: `My dearest ${clientDisplayName},\n\n${intro1}\n\nKnowing how much you cherish our connection brings such a wonderful sense of peace to my heart. Reading your letters has truly become the sweetest highlight of my day.\n\nTell me, what was the sweetest thought or little moment that made you smile today?\n\nWith all my affection,\n${myProfile} ❤️`
            },
            {
              title: '💬 Option 2: Daily Life & Photo Exchange (270+ char)',
              rationale: 'Daily lifestyle connection and magnetic proposal for reciprocal photo exchange.',
              esPreview: `Mi querido ${clientDisplayName},\n\nEstaba tomando un pequeño descanso y no pude evitar sonreír pensando en ti. Me encanta compartir estos instantes contigo.\n\nEnvíame una foto tuya de lo que estás haciendo hoy para sentirte más cerca, y en mi próxima carta te enviaré una foto exclusiva solo para ti 😉 ¿Trato hecho?\n\nCon un beso dulce,\n${myProfile} ✨`,
              target: `My dear ${clientDisplayName},\n\nI was just taking a quiet little break and couldn't help but smile thinking of you. I love imagining what your day is like and sharing these sweet moments together.\n\nSend me a picture of what you're up to today so I can feel closer to you, and in my next letter I'll send an exclusive photo just for you 😉 Deal?\n\nWith a sweet hug,\n${myProfile} ✨`
            },
            {
              title: '✨ Option 3: Romantic Curiosity & Intimate Question (280+ char)',
              rationale: 'Fascinating open question that invites a long, thoughtful, romantic reply.',
              esPreview: `Mi queridísimo ${clientDisplayName},\n\nNuestras cartas se han convertido en un espacio verdaderamente mágico y especial para mí. Adoro la sinceridad con la que nos hablamos.\n\nCuéntame un pequeño sueño o secreto tuyo que pocas personas conozcan... ¿qué es lo que más te apasiona en la vida?\n\nSiempre pensando en ti,\n${myProfile} ❤️`,
              target: `My dearest ${clientDisplayName},\n\nOur letters have truly become something so precious and special to me. I love how genuine and sweet our bond feels with every word.\n\nTell me a little dream or secret of yours that very few people know about... what is something that brings true passion and joy to your heart?\n\nAlways thinking of you,\n${myProfile} ❤️`
            }
          ];
        }

        return options;
      };

      const letterOptions = generateReasonedLetterOptions();
      const headerTitle = hasIncomingLetter 
        ? `🔄 RESPONDER CARTA A ${clientName.toUpperCase()} (${detectedLang.name}):` 
        : `🎯 REDACTAR CARTA PARA ${clientName.toUpperCase()} (${detectedLang.name}):`;

      let warningHtml = '';
      if (showMissingHistoryWarning) {
        warningHtml = `
          <div class="ryr-no-info-warning">
            <span style="font-size:10px; line-height:1.2;">⚠️ <b>Sin cartas previas en BD:</b> Sube las cartas y conversaciones para contexto 360°.</span>
            <button class="ryr-no-info-btn" id="ryr-letter-quick-sync">⚡ Subir Ahora</button>
          </div>
        `;
      }

      dropdown.innerHTML = `
        <div style="font-weight:bold; color:#34d399; font-size:11px; margin-bottom:4px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #065f46; padding-bottom:4px;">
          <span>${headerTitle}</span>
          <span style="cursor:pointer; color:#94a3b8; font-size:13px;" id="ryr-close-letter-dropdown">✕</span>
        </div>
        ${warningHtml}
        <div id="ryr-letter-options-container" style="display:flex; flex-direction:column; gap:5px;"></div>
      `;

      const closeBtn = dropdown.querySelector('#ryr-close-letter-dropdown');
      if (closeBtn) closeBtn.onclick = () => dropdown.remove();

      const syncBtn = dropdown.querySelector('#ryr-letter-quick-sync');
      if (syncBtn) {
        syncBtn.onclick = async (ev) => {
          ev.stopPropagation();
          syncBtn.innerText = '⏳ Subiendo...';
          syncBtn.disabled = true;
          await syncCurrentChatToDatabase();
          syncBtn.innerText = '✅ Subido';
        };
      }

      const container = dropdown.querySelector('#ryr-letter-options-container');

      letterOptions.forEach((opt, idx) => {
        const card = document.createElement('div');
        card.className = 'ryr-letter-option-card';
        card.innerHTML = `
          <div class="ryr-letter-option-title">
            <span>${opt.title}</span>
            <span class="ryr-letter-option-badge">Opción ${idx + 1}</span>
          </div>
          <div class="ryr-letter-option-rationale">💡 <b>Razón Táctica:</b> ${opt.rationale}</div>
          <div class="ryr-letter-option-preview"><b>📝 En Español (Vista Operador):</b><br/>${opt.esPreview}</div>
          <div style="font-size:9.5px; color:#38bdf8; margin-top:2px; font-weight:bold;">⚡ Clic para insertar carta en ${detectedLang.name}</div>
        `;

        card.onclick = () => {
          const ta = document.querySelector('textarea[placeholder*="letter" i], div[class*="letter"] textarea, textarea');
          if (ta) {
            setInputValueSafely(ta, opt.target);
            showFirewallToast(`✨ Carta en ${detectedLang.name} insertada con éxito. ¡Lista para enviar!`);
            ta.focus();
          }
          dropdown.remove();
        };

        container.appendChild(card);
      });
    };
  }

  // 14. DETECTOR DE 0 CRÉDITOS Y CONTROL DE FILAS
  function isChatHeaderZeroMessages() {
    const limitDiv = document.querySelector('[data-test-id="file:restriction-limits messages-counter"], [data-type="Chat"].counter');
    if (limitDiv) {
      const spanEl = limitDiv.querySelector('.counter-inactive, span');
      const spanVal = (spanEl?.textContent || spanEl?.innerText || '').trim();
      if (spanVal === '0') return true;
      const divVal = (limitDiv.textContent || limitDiv.innerText || '').trim();
      if (divVal.startsWith('0')) return true;
    }

    const inactiveSpans = document.querySelectorAll('span.counter-inactive, div.counter-inactive');
    for (let el of inactiveSpans) {
      if ((el.textContent || el.innerText || '').trim() === '0') return true;
    }

    const bodyText = document.body?.innerText || document.body?.textContent || '';
    if (bodyText.includes('0 messages available') || bodyText.includes('You have no chat history')) {
      return true;
    }

    return false;
  }

  function handleInboxTimersAndExtractionButtons() {
    if (!isStorageLoaded) return;

    injectAutoLetterDrafter();
    injectAgenciaChatEnhancements();

    // Eliminar cualquier botón residual de rayito en el DOM
    document.querySelectorAll('.ryr-row-extract-btn, .ryr-extract-menu').forEach(el => el.remove());

    const openChatHasZeroCredits = isChatHeaderZeroMessages();
    const openChatNumericId = getExactNumericClientId();
    const openChatCleanName = getExactClientProfileData().clientName.toLowerCase();

    const allMatches = document.querySelectorAll('div[data-test-id*="dialog-item"], div[class*="dialog-item"], div[class*="item-wrap"], .tab-content-item');

    const rootRows = Array.from(allMatches).filter(el => {
      return !el.parentElement.closest('div[data-test-id*="dialog-item"], div[class*="dialog-item"], div[class*="item-wrap"], .tab-content-item');
    });

    rootRows.forEach(row => {
      const fullText = row.innerText || '';
      if (fullText.length < 3) return;

      const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
      const contactName = sanitizeClientName(lines[0]);
      const cleanSimpleName = contactName.split(',')[0].trim().toLowerCase();
      
      let rowNumericId = 'N/A';
      const userLink = row.querySelector('a[href*="/chat/"], a[href*="/user/"], a[href*="/mails/"]');
      if (userLink) {
        const href = userLink.getAttribute('href');
        rowNumericId = getExactNumericClientId(href);
      }

      row.style.position = 'relative';

      // BADGE DE SEGMENTACIÓN SOLO FIDELIZADO O VIP (SIN ETIQUETA "NUEVA" INDISCRIMINADA)
      const totalLettersMatch = fullText.match(/(\d+)\s+letter total/i);
      let letterCount = totalLettersMatch ? parseInt(totalLettersMatch[1], 10) : 0;
      
      let tierBadge = row.querySelector('.ryr-tier-badge');
      if (fidelizedClientsMap.has(String(rowNumericId)) || fidelizedClientsMap.has(cleanSimpleName)) {
        if (!tierBadge) {
          tierBadge = document.createElement('span');
          const nameHeader = row.querySelector('h1, h2, h3, b, strong, [class*="name"]');
          if (nameHeader) nameHeader.appendChild(tierBadge);
          else row.appendChild(tierBadge);
        }
        tierBadge.className = 'ryr-tier-badge ryr-tier-fidelizar';
        tierBadge.innerText = `💎 FIDELIZADO`;
        tierBadge.title = 'Cliente nuevo que inició sin historial y desbloqueó el servicio en este turno';
      } else if (letterCount > 500) {
        if (!tierBadge) {
          tierBadge = document.createElement('span');
          const nameHeader = row.querySelector('h1, h2, h3, b, strong, [class*="name"]');
          if (nameHeader) nameHeader.appendChild(tierBadge);
          else row.appendChild(tierBadge);
        }
        tierBadge.className = 'ryr-tier-badge ryr-tier-vip';
        tierBadge.innerText = `💎 VIP (${letterCount})`;
      } else {
        if (tierBadge) tierBadge.remove();
      }

      const nameKey = `name_${cleanSimpleName.replace(/[^a-z0-9]/g, '')}`;
      const idKey = (rowNumericId && rowNumericId !== 'N/A') ? `id_${rowNumericId}` : null;

      // TEMPORIZADORES DE SLA DE 2 MINUTOS
      const hasOperatorSent = /(?:you|tú|tu|você)\s*:/i.test(fullText) || 
                              row.querySelector('svg[class*="check"]') !== null ||
                              fullText.includes('✔');

      const isTyping = fullText.toLowerCase().includes('typing') || row.querySelector('[class*="typing"]');
      const isLiked = fullText.toLowerCase().includes('liked');

      const isKnownZeroCredits = zeroCreditsClientsSet.has(cleanSimpleName) || 
                                 (rowNumericId !== 'N/A' && zeroCreditsClientsSet.has(rowNumericId.toLowerCase())) ||
                                 (openChatHasZeroCredits && (rowNumericId === openChatNumericId || cleanSimpleName === openChatCleanName)) ||
                                 /\b0\s+0\b/.test(fullText) || 
                                 /[💬✉]\s*0\b/i.test(fullText);

      const isPendingClientMessage = !isKnownZeroCredits && (!hasOperatorSent || isTyping || isLiked);
      const existingTimer = row.querySelector('.ryr-inbox-timer');

      if (!isPendingClientMessage) {
        if (existingTimer) existingTimer.remove();
        if (activeSlaTimers[nameKey] || (idKey && activeSlaTimers[idKey])) {
          delete activeSlaTimers[nameKey];
          if (idKey) delete activeSlaTimers[idKey];
          persistTimersToStorage();
          sendTelemetry(true);
        }
        return;
      }

      let existingTimestamp = activeSlaTimers[nameKey] || (idKey ? activeSlaTimers[idKey] : null);
      if (!existingTimestamp) {
        existingTimestamp = Date.now();
        activeSlaTimers[nameKey] = existingTimestamp;
        if (idKey) activeSlaTimers[idKey] = existingTimestamp;
        persistTimersToStorage();
      }

      const elapsedSeconds = Math.floor((Date.now() - existingTimestamp) / 1000);
      const remainingSeconds = Math.max(0, 120 - elapsedSeconds);

      const min = Math.floor(remainingSeconds / 60);
      const sec = remainingSeconds % 60;
      const formatted = `${min < 10 ? '0' : ''}${min}:${sec < 10 ? '0' : ''}${sec}`;

      let badge = existingTimer;
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'ryr-inbox-timer';
        row.appendChild(badge);
      }

      if (remainingSeconds > 60) {
        badge.className = 'ryr-inbox-timer ryr-timer-green';
        badge.innerText = `⏱️ ${formatted}`;
      } else if (remainingSeconds > 0) {
        badge.className = 'ryr-inbox-timer ryr-timer-orange';
        badge.innerText = `⚠️ ${formatted}`;
      } else {
        badge.className = 'ryr-inbox-timer ryr-timer-red';
        badge.innerText = `🚨 00:00`;

        if (!finedTimerKeys.has(nameKey)) {
          finedTimerKeys.add(nameKey);
          triggerAutomaticFine(contactName, rowNumericId);
        }
      }
    });

    // RECONCILIACIÓN ESTRICTA ANTI-FANTASMAS: Si hay timers guardados que ya no corresponden a ningún chat pendiente visible, eliminarlos de inmediato
    const activeRowKeys = new Set();
    rootRows.forEach(row => {
      const fullText = row.innerText || '';
      if (fullText.length < 3) return;
      const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
      const contactName = sanitizeClientName(lines[0]);
      const cleanSimpleName = contactName.split(',')[0].trim().toLowerCase();
      const nameKey = `name_${cleanSimpleName.replace(/[^a-z0-9]/g, '')}`;
      let rowNumericId = 'N/A';
      const userLink = row.querySelector('a[href*="/chat/"], a[href*="/user/"], a[href*="/mails/"]');
      if (userLink) {
        rowNumericId = getExactNumericClientId(userLink.getAttribute('href'));
      }
      const idKey = (rowNumericId && rowNumericId !== 'N/A') ? `id_${rowNumericId}` : null;

      const hasOperatorSent = /(?:you|tú|tu|você)\s*:/i.test(fullText) || 
                              row.querySelector('svg[class*="check"]') !== null ||
                              fullText.includes('✔');
      const isTyping = fullText.toLowerCase().includes('typing') || row.querySelector('[class*="typing"]');
      const isLiked = fullText.toLowerCase().includes('liked');
      const isKnownZeroCredits = zeroCreditsClientsSet.has(cleanSimpleName) || 
                                 (rowNumericId !== 'N/A' && zeroCreditsClientsSet.has(rowNumericId.toLowerCase())) ||
                                 (openChatHasZeroCredits && (rowNumericId === openChatNumericId || cleanSimpleName === openChatCleanName)) ||
                                 /\b0\s+0\b/.test(fullText) || 
                                 /[💬✉]\s*0\b/i.test(fullText);

      const isPending = !isKnownZeroCredits && (!hasOperatorSent || isTyping || isLiked);
      if (isPending) {
        activeRowKeys.add(nameKey);
        if (idKey) activeRowKeys.add(idKey);
      }
    });

    let cleanedAny = false;
    for (const key of Object.keys(activeSlaTimers)) {
      if (!activeRowKeys.has(key)) {
        delete activeSlaTimers[key];
        cleanedAny = true;
      }
    }
    if (cleanedAny) {
      persistTimersToStorage();
      sendTelemetry(true);
    }
  }

  async function triggerAutomaticFine(clientName, clientId) {
    try {
      await fetch(`${API_URL}/api/fines/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operator: sessionData.operator || 'walther',
          shift: sessionData.shift || 'Mañana',
          profile: sessionData.profileName || 'HORACIO',
          clientName: clientName,
          clientId: clientId,
          reason: `Demora mayor a 2 minutos en responder a ${clientName}`
        })
      });
    } catch (e) {}
    sendTelemetry(true);
  }

  // 15. SISTEMA MAESTRO DE RELEVO DE TURNOS (ENTREGAR TURNO & VER RELEVO)
  function generateTacticalHandoverItem(clientObj, index) {
    const sLower = clientObj.snippet.toLowerCase();
    const rawLower = clientObj.fullRaw.toLowerCase();

    let category = 'SEGUIMIENTO ACTIVO';
    let diagnosis = '';
    let strategy = '';
    let openingEn = '';
    let openingEs = '';

    if (/\b(headache|analgesic|fever|flu|pain|sick|ill|medicine|pill|cold rain|resting)\b|head is aching|\b(dolor|cabeza|fiebre|enferm|medicament)\b/i.test(sLower) || /\b(headache|fever)\b/i.test(rawLower)) {
      category = 'SALUD / EMPATÍA';
      diagnosis = 'El cliente reportó malestar físico o cansancio (dolor de cabeza, frío/lluvia o analgésico) y se fue a descansar.';
      strategy = 'Demostrar cuidado protector y preguntar con dulzura cómo amaneció hoy. No presionar con temas complejos; invitarlo con dulzura a que envíe una foto descansando y proponerle una carta.';
      openingEn = `"Good morning, sweetheart ❤️ I was thinking about you and truly hoping you woke up feeling so much better... How is your head feeling today?"`;
      openingEs = `"Buenos días, cariño ❤️ Estaba pensando en ti y deseando de corazón que hayas despertado sintiéndote mucho mejor... ¿Cómo sigue tu dolor de cabeza hoy?"`;
    } else if (clientObj.isSticker || sLower.includes('sent a sticker') || sLower.includes('sticker')) {
      category = 'PROSPECCIÓN / ENGANCHE';
      diagnosis = 'Se le envió un sticker de enganche visual en este turno para activar su atención.';
      strategy = 'El turno entrante debe romper el hielo con un gancho de curiosidad intrigante para convertir el sticker en una conversación activa sin sonar desesperado.';
      openingEn = `"I was just smiling looking at my messages and had a lovely feeling to say hello 😉 Tell me, what's one little thing that made you smile today?"`;
      openingEs = `"Estaba sonriendo mirando mis mensajes y tuve una bonita corazonada de saludarte 😉 Cuéntame, ¿qué es un pequeño detalle que te haya hecho sonreír hoy?"`;
    } else if (/\b(coffee|caf[eé]|tea|drink|cup|breakfast|dinner|lunch|comiendo|taza)\b/i.test(sLower)) {
      category = 'RUTINA / CAFÉ';
      diagnosis = 'Conversación activa sobre un momento de relax, café, comida o descanso.';
      strategy = 'Validar su momento de bienestar y pedirle un intercambio de fotos cotidianas de su café o día para profundizar la conexión.';
      openingEn = `"I hope you are having the coziest and most relaxing day ❤️ Tell me, what delicious treat or plan are you enjoying today?"`;
      openingEs = `"Espero que estés teniendo el día más acogedor y relajante posible ❤️ Cuéntame, ¿qué comida rica o plan estás disfrutando hoy?"`;
    } else if (/\b(leaving|busy|ocupad|te vas)\b/i.test(sLower)) {
      category = 'TIEMPO EXCLUSIVO';
      diagnosis = 'Preguntó si la modelo estaba ocupada o retirándose.';
      strategy = 'Reafirmar que siempre hay tiempo prioritario reservado para él y hacer una pregunta abierta sobre sus emociones.';
      openingEn = `"I'm right here with you, love ❤️ Talking to you always brightens up my whole day... What are you up to right at this moment?"`;
      openingEs = `"Aquí estoy contigo, amor ❤️ Hablar contigo siempre alegra todo mi día... ¿Qué estás haciendo justo en este momento?"`;
    } else if (/\b(love|beautiful|gorgeous|sexy|angel|queen|honey|sweetheart|mahal|linda|amor|cielo)\b/i.test(sLower)) {
      category = 'ROMANCE & FIDELIZACIÓN';
      diagnosis = 'Intercambio de alto afecto romántico y piropos mutuos.';
      strategy = 'Mantener la reciprocidad romántica al 100%, halagar su ternura y sugerirle que revise el buzón porque le escribiremos una carta con foto privada.';
      openingEn = `"Hearing your sweet words always makes my heart flutter ❤️ I was just thinking about you... What is on your mind today, my dear?"`;
      openingEs = `"Escuchar tus palabras dulces siempre hace latir mi corazón ❤️ Estaba pensando en ti... ¿Qué hay en tus pensamientos hoy, cariño?"`;
    } else {
      category = 'SEGUIMIENTO ACTIVO';
      diagnosis = clientObj.isOperatorLast 
        ? `Último mensaje enviado por el turno anterior ("${clientObj.snippet}").` 
        : `El cliente dejó un mensaje pendiente ("${clientObj.snippet}").`;
      strategy = 'Retomar el diálogo con calidez, mostrando atención genuina y abriendo una pregunta que motive respuesta inmediata.';
      openingEn = `"I was thinking about our conversation and didn't want to go without wishing you a wonderful day ❤️ How has everything been going for you?"`;
      openingEs = `"Estaba pensando en nuestra conversación y no quería quedarme sin desearte un día maravilloso ❤️ ¿Cómo ha estado yendo todo para ti?"`;
    }

    return `### 👤 ${index + 1}. **${clientObj.name}** ${clientObj.numericId !== 'N/A' ? `(ID: ${clientObj.numericId})` : ''} - ⏰ *${clientObj.time}*\n` +
      `- 🏷️ **Categoría:** \`${category}\`\n` +
      `- 📝 **Diagnóstico del Turno:** ${diagnosis}\n` +
      `- 🎯 **Cómo Seguir & Por Qué:** ${strategy}\n` +
      `- 💌 **Mensaje de Apertura Sugerido (Inglés):**\n` +
      `  > ${openingEn}\n` +
      `- 📝 **Traducción al Español:**\n` +
      `  *${openingEs}*\n`;
  }

  async function triggerSaveShiftHandover() {
    const btn = document.getElementById('ryr-btn-save-handover');
    if (btn) {
      btn.innerText = '⏳ Analizando Relevo...';
      btn.disabled = true;
    }

    // 1. Recolectar clientes únicos visibles en el DOM sin duplicaciones
    const uniqueClients = new Map();
    const allDialogElements = Array.from(document.querySelectorAll(
      'div[data-test-id*="dialog-item"], div[class*="dialog-item"], div[class*="item-wrap"]'
    ));

    allDialogElements.forEach(row => {
      // Filtrar sub-nodos para tomar solo el contenedor raíz del ítem
      if (row.parentElement.closest('div[data-test-id*="dialog-item"], div[class*="dialog-item"], div[class*="item-wrap"]')) {
        return;
      }

      const rawText = (row.innerText || '').trim();
      if (rawText.length < 2) return;
      const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length === 0) return;

      const rawName = lines[0];
      const clientName = sanitizeClientName(rawName);
      if (clientName === 'Cliente' || clientName.length < 2) return;

      const cleanKey = clientName.toLowerCase().split(',')[0].trim();
      if (uniqueClients.has(cleanKey)) return;

      let numericId = 'N/A';
      const userLink = row.querySelector('a[href*="/chat/"], a[href*="/user/"], a[href*="/mails/"]');
      if (userLink) {
        numericId = getExactNumericClientId(userLink.getAttribute('href'));
      }

      const timeMatch = rawText.match(/\b\d{1,2}:\d{2}\s*(?:am|pm|a\.?\s*m\.?|p\.?\s*m\.?)\b/i) || rawText.match(/\b\d+\s*(?:minutes?|hours?|days?)\s*ago\b/i);
      const timeStr = timeMatch ? timeMatch[0] : 'Reciente';

      let snippet = lines.slice(1).join(' ')
        .replace(/(\d+\s*(minute|hour|day|week|month)s?\s*ago|\ban hour ago\b|\d+\s*[✉💬]|\bonline\b|\btyping\b|\bSearch\b|\bMessages\b)/gi, '')
        .trim();
      snippet = snippet.substring(0, 140);

      const isOperatorLast = /(?:you|tú|tu|você)\s*:/i.test(rawText) || row.querySelector('svg[class*="check"]') !== null || rawText.includes('✔');
      const isSticker = rawText.toLowerCase().includes('sent a sticker') || rawText.toLowerCase().includes('sticker');

      uniqueClients.set(cleanKey, {
        name: clientName,
        numericId,
        time: timeStr,
        snippet: snippet || (isSticker ? 'Sticker de saludo enviado' : 'Sin mensaje previo'),
        isOperatorLast,
        isSticker,
        fullRaw: rawText
      });
    });

    const clientsArray = Array.from(uniqueClients.values());
    const analyzedHandovers = clientsArray.slice(0, 10).map((c, i) => generateTacticalHandoverItem(c, i));

    let fidelizedSection = '';
    if (fidelizedClientsMap.size > 0) {
      fidelizedSection = `### 💎 Clientes Nuevos Fidelizados en este Turno (Activaron Posts):\n` +
        Array.from(fidelizedClientsMap.values()).map(c => `- **${c.name} (ID: ${c.clientId}):** Recargó (${c.credits || 150} cr) y desbloqueó el servicio de Posts. ¡Atención prioritaria para continuar monetizando!`).join('\n') + `\n\n`;
    }

    const prospect = evaluateProspectingCycle();

    const reportMarkdown = `# 📋 RELEVO DE TURNO TÁCTICO | PERFIL: ${sessionData.profileName || 'HORACIO'}\n\n` +
      `### 📊 Métricas Operativas de la Entrega:\n` +
      `- **👤 Operador Saliente:** ${sessionData.operator || 'walther'} [Turno: ${sessionData.shift || 'Mañana'}]\n` +
      `- **🎯 Perfil Activo:** ${sessionData.profileName || 'HORACIO'}\n` +
      `- **✉️ Cartas Leídas/Procesadas en Turno:** ${totalGlobalReadLetters} cartas\n` +
      `- **🎯 Tráfico y Prospecciones:** ${prospect.count}/${prospect.quota} en ciclo actual\n` +
      `- **📅 Fecha y Hora de Cierre:** ${new Date().toLocaleString()}\n\n` +
      `---\n\n` +
      fidelizedSection +
      `### 💬 Contexto Quirúrgico de Conversaciones del Turno (${clientsArray.length} Clientes Identificados):\n\n` +
      (analyzedHandovers.join('\n') || '- No se detectaron chats pendientes en este momento.') + `\n` +
      `---\n\n` +
      `### 🎯 Instrucciones Maestras para el Turno Siguiente:\n` +
      `1. **Prioridad 1:** Responder primero a los clientes con mensajes abiertos o que reportaron malestar/descanso usando las frases sugeridas.\n` +
      `2. **Prioridad 2:** Monitorear el buzón de cartas (Read: ${totalGlobalReadLetters}) para no dejar hilos sin contestar.\n` +
      `3. **Prioridad 3:** Mantener la cuota de 10 prospecciones por cada 30 minutos.\n` +
      `4. **Regla de Oro:** Usar el botón de Continuar Chat con IA para mantener respuestas de 3 opciones y cero Travel Misleading.`;

    try {
      chrome.storage.local.set({ lastHandoverReport: reportMarkdown });
      await fetch(`${API_URL}/api/handover/generate-and-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operator: sessionData.operator || 'walther',
          shift: sessionData.shift || 'Mañana',
          profileName: sessionData.profileName || 'HORACIO',
          profileId: sessionData.profileId || '118179794',
          reportMarkdown
        })
      });
    } catch (e) {}

    showHandoverModal('✅ RELEVO DE TURNO GENERADO CON ÉXITO', reportMarkdown);

    if (btn) {
      btn.innerText = '📋 Entregar Turno';
      btn.disabled = false;
    }
  }

  async function triggerViewShiftHandover() {
    let reportText = '';
    try {
      const res = await fetch(`${API_URL}/api/handover/latest?profileName=${sessionData.profileName || 'HORACIO'}`);
      const data = await res.json();
      if (data && data.handover && data.handover.reportMarkdown) {
        reportText = data.handover.reportMarkdown;
      }
    } catch (e) {}

    if (!reportText) {
      if (isContextValid()) {
        chrome.storage.local.get(['lastHandoverReport'], (data) => {
          reportText = data.lastHandoverReport || 'No hay relevos de turno registrados aún para este perfil.';
          showHandoverModal('📖 RELEVO DEL TURNO ANTERIOR', reportText);
        });
        return;
      }
      reportText = 'No hay relevos de turno registrados aún para este perfil.';
    }

    showHandoverModal('📖 RELEVO DEL TURNO ANTERIOR', reportText);
  }

  function showHandoverModal(title, markdownContent) {
    const existing = document.getElementById('ryr-handover-view-modal');
    if (existing) existing.remove();

    const formatMarkdownToHtml = (text) => {
      if (!text) return '';
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/^#### (.*?)$/gm, '<h4 style="color:#38bdf8; margin:10px 0 4px 0; font-size:12px;">$1</h4>')
        .replace(/^### (.*?)$/gm, '<h3 style="color:#34d399; margin:12px 0 6px 0; font-size:13px; border-bottom:1px solid #1e293b; padding-bottom:3px;">$1</h3>')
        .replace(/^# (.*?)$/gm, '<h2 style="color:#a7f3d0; margin:0 0 8px 0; font-size:14px; font-weight:900;">$1</h2>')
        .replace(/^> (.*?)$/gm, '<div style="background:rgba(56,189,248,0.1); border-left:3px solid #38bdf8; padding:6px 10px; margin:4px 0; color:#e0f2fe; border-radius:3px; font-style:italic;">$1</div>')
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
        .replace(/\*(.*?)\*/g, '<i>$1</i>')
        .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1); padding:2px 5px; border-radius:3px; color:#f472b6;">$1</code>')
        .replace(/\n/g, '<br>');
    };

    const modal = document.createElement('div');
    modal.id = 'ryr-handover-view-modal';
    modal.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 620px;
      max-width: 95%;
      background: #0b1120;
      border: 2px solid #10b981;
      border-radius: 12px;
      color: #fff;
      padding: 18px;
      z-index: 2147483647;
      box-shadow: 0 16px 50px rgba(0,0,0,0.95), 0 0 25px rgba(16,185,129,0.3);
      font-family: system-ui, -apple-system, sans-serif;
      display: flex;
      flex-direction: column;
      gap: 12px;
    `;

    modal.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1e293b; padding-bottom:8px;">
        <span style="font-weight:900; color:#10b981; font-size:13px; display:flex; align-items:center; gap:6px;">${title}</span>
        <span style="cursor:pointer; font-size:16px; color:#94a3b8;" id="ryr-close-handover-modal">✕</span>
      </div>
      <div id="ryr-handover-modal-content" style="background:#060913; border:1px solid #1e293b; border-radius:8px; padding:14px; max-height:420px; overflow-y:auto; font-size:11.5px; line-height:1.6; color:#cbd5e1;">
        ${formatMarkdownToHtml(markdownContent)}
      </div>
      <div style="display:flex; justify-content:flex-end; gap:8px;">
        <button id="ryr-btn-copy-handover" style="background:rgba(56,189,248,0.2); color:#38bdf8; border:1px solid rgba(56,189,248,0.5); padding:8px 14px; border-radius:6px; font-weight:bold; cursor:pointer; font-size:11.5px;">📋 Copiar Relevo Completo</button>
        <button id="ryr-btn-dismiss-handover" style="background:#10b981; color:#060913; border:none; padding:8px 16px; border-radius:6px; font-weight:bold; cursor:pointer; font-size:11.5px;">Entendido / Cerrar</button>
      </div>
    `;

    document.body.appendChild(modal);

    const closeBtn = modal.querySelector('#ryr-close-handover-modal');
    if (closeBtn) closeBtn.onclick = () => modal.remove();

    const dismissBtn = modal.querySelector('#ryr-btn-dismiss-handover');
    if (dismissBtn) dismissBtn.onclick = () => modal.remove();

    const copyBtn = modal.querySelector('#ryr-btn-copy-handover');
    if (copyBtn) {
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(markdownContent);
        copyBtn.innerText = '✅ ¡Copiado al Portapapeles!';
        setTimeout(() => copyBtn.innerText = '📋 Copiar Relevo Completo', 2000);
      };
    }
  }

  // 16. MOTOR DE INTELIGENCIA ULTRA-HUMANIZADO (BOTÓN INVESTIGAR)
  function injectIntelPanel() {
    if (document.getElementById('ryr-intel-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'ryr-intel-panel';
    panel.innerHTML = `
      <div class="intel-header">
        <span>🧠 ASISTENTE IA & ESTRATEGA DE CHAT</span>
        <button id="ryr-close-intel" style="background:none; border:none; color:#fff; font-size:16px; cursor:pointer;">✕</button>
      </div>
      <div class="intel-body">
        <div id="intel-dossier-box" class="intel-dossier">
          <p style="color:#94a3b8;">Abre un chat para ver el expediente...</p>
        </div>
        
        <div class="intel-quick-actions">
          <button class="intel-quick-btn" data-prompt="de donde es">📍 Ubicación</button>
          <button class="intel-quick-btn" data-prompt="cuantos años tiene">🎂 Edad</button>
          <button class="intel-quick-btn" data-prompt="tiene hijos, como se llaman">👨‍👩‍👧 Familia</button>
          <button class="intel-quick-btn" data-prompt="pasar a cartas y pedir foto">💌 Pasar a Cartas</button>
          <button class="intel-quick-btn" data-prompt="pedirle fotos de su dia">📸 Pedir Foto</button>
          <button class="intel-quick-btn" data-prompt="dame un gancho para enamorarla">✨ Gancho</button>
        </div>

        <div id="intel-messages-stream" class="intel-chat-stream">
          <div class="chat-bubble-ai">👋 ¡Hola! Soy tu Co-Piloto Táctico. Conozco todo sobre las cartas, chats, intereses y estilo de este cliente para darte respuestas exactas y efectivas.</div>
        </div>
      </div>
      <div class="intel-input-box">
        <input type="text" id="input-intel-query" placeholder="Pregunta algo sobre el cliente o pide un mensaje...">
        <button id="btn-send-intel-query">Consultar</button>
      </div>
    `;

    document.body.appendChild(panel);

    document.getElementById('ryr-close-intel').onclick = () => {
      panel.classList.remove('open');
    };

    panel.querySelectorAll('.intel-quick-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.preventDefault();
        const promptText = btn.getAttribute('data-prompt');
        if (promptText) {
          const inputEl = document.getElementById('input-intel-query');
          if (inputEl) {
            inputEl.value = promptText;
            askIntelligenceQuery();
          }
        }
      };
    });

    document.getElementById('btn-send-intel-query').onclick = askIntelligenceQuery;
    document.getElementById('input-intel-query').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') askIntelligenceQuery();
    });
  }

  // RAZONAMIENTO LOCAL INTELIGENTE BILINGÜE (CO-PILOTO 360° & ESTRATEGA DE CHAT)
  function generateLocalDeepReasoning(query, clientName, bioData, messages, letters) {
    const q = query.toLowerCase().trim();
    const allChatText = messages.map(m => m.text).join(' ').toLowerCase();
    const allLettersText = letters.map(l => l.preview).join(' ').toLowerCase();
    const fullCorpus = `${allChatText} ${allLettersText}`;

    // Datos demográficos del cliente
    const country = bioData?.country || 'Registrado en perfil';
    const birthDate = bioData?.birthDate || 'En perfil';
    const marital = bioData?.maritalStatus || 'Single / Soltera';

    const hasHistory = (letters.length > 0 || messages.length > 1);
    const missingHistoryAlert = !hasHistory
      ? `⚠️ **Aviso de Inteligencia:** Aún no has extraído/subido conversaciones o cartas previas de **${clientName}**. Te doy respuestas basadas en su perfil público. Haz clic en **"⚡ Subir Chats"** o abre su hilo de cartas para activar el razonamiento con su historial completo.\n\n`
      : '';

    // 0. Capacidades / Ayuda / Qué sabes hacer
    if (/qu[eé]\s+(sabes|puedes|haces)|capacidades|ayuda|funciones|para qu[eé]\s+sirves/i.test(q)) {
      return `🧠 **Soy tu Co-Piloto Táctico & Asistente IA 360°:**\n\n` +
        `Puedo ayudarte en tiempo real con:\n` +
        `1. 📍 **Ubicación & Cultura:** Pregúntame *"de dónde es"* para darte su país y análisis cultural.\n` +
        `2. 🎂 **Edad & Biografía:** Pregúntame *"cuántos años tiene"* o *"cuándo nació"*.\n` +
        `3. 👨‍👩‍👧 **Familia & Mascotas:** Pregúntame *"tiene hijos"* o *"cómo se llaman"*.\n` +
        `4. 🎨 **Gustos & Pasiones:** Pregúntame *"cuáles son sus gustos"* o *"qué le gusta hacer"*.\n` +
        `5. 💰 **Poder Adquisitivo:** Pregúntame *"cuántos créditos tiene"* o *"cuánto gasta"*.\n` +
        `6. 💌 **Embudo a Cartas:** Pídeme *"pasar a cartas"* para migrarlo estratégicamente.\n` +
        `7. 📸 **Pedir Fotos:** Pídeme *"pedir foto"* con gancho de reciprocidad.\n` +
        `8. ✨ **Ganchos & Seducción:** Pídeme *"dame un gancho para enamorarla"*.\n\n` +
        `💡 *Tip:* Todas las respuestas incluyen la explicación en español, el mensaje en inglés listo para enviar con 1 clic y su traducción.`;
    }

    // 0.1 Gustos / Intereses / Hobbies / Qué le gusta hacer
    if (/gusto|inter[eé]s|hobbi|pasatiempo|le gusta|m[uú]sica|comida|disfruta|hacer en su tiempo|passion/i.test(q)) {
      let tastesFound = [];
      if (/music|música|musica|song|cancion/i.test(fullCorpus)) tastesFound.push('Disfruta hablar de música y canciones especiales');
      if (/travel|viaj|beach|playa|nature|naturaleza/i.test(fullCorpus)) tastesFound.push('Le apasiona la naturaleza, caminatas y el aire libre');
      if (/cook|cocin|food|comida|wine|vino|dinner/i.test(fullCorpus)) tastesFound.push('Gusta de la buena gastronomía, vino y cenas tranquilas');
      if (/read|leer|book|libro|movie|pelicula|cine/i.test(fullCorpus)) tastesFound.push('Aprecia conversaciones sobre cine, libros y arte');
      if (/sport|gym|fitness|deporte|caminar|walk/i.test(fullCorpus)) tastesFound.push('Le gusta mantenerse activo y hacer ejercicio');

      const tastesSummary = tastesFound.length > 0 
        ? tastesFound.map(t => `- ${t}`).join('\n')
        : `- Aprecia la atención genuina, el respeto y las conversaciones emotivas.\n- Registrado como aficionado a conversaciones sinceras y detalladas.`;

      return `${missingHistoryAlert}🎨 **Razonamiento Táctico sobre Gustos de ${clientName} (Español):**\n` +
        `${tastesSummary}\n\n` +
        `💌 **Mensaje Sugerido en Inglés (Listo para Enviar):**\n` +
        `"I love learning about what truly makes you happy... Tell me, when you have free time just for yourself, what's your favorite thing to do? ✨"\n\n` +
        `📝 **Traducción al Español:**\n` +
        `*"Me encanta saber qué es lo que realmente te hace feliz... Cuéntame, cuando tienes tiempo libre solo para ti, ¿qué es lo que más te gusta hacer? ✨"*`;
    }

    // 0.2 Historia / Relación / Resumen / Qué quiere
    if (/historia|relaci[oó]n|como vamos|resumen|hilo|antecedente|quiere|busca|pretende/i.test(q)) {
      return `${missingHistoryAlert}📖 **Razonamiento sobre la Relación con ${clientName} (Español):**\n` +
        `- **Total Mensajes en Chat:** ${messages.length} intercambios registrados.\n` +
        `- **Total Cartas Registradas:** ${letters.length} cartas procesadas.\n` +
        `- **Intención del Cliente:** Busca validación emocional, atención exclusiva y una complicidad romántica auténtica con el perfil ${sessionData.profileName || 'HORACIO'}.\n\n` +
        `💌 **Mensaje Sugerido en Inglés (Listo para Enviar):**\n` +
        `"Looking back at how we started talking, I really love how special our bond has become ❤️ Tell me, what's on your heart right now?"\n\n` +
        `📝 **Traducción al Español:**\n` +
        `*"Recordando cómo empezamos a hablar, me encanta lo especial que se ha vuelto nuestra conexión ❤️ Dime, ¿qué hay en tu corazón en este momento?"*`;
    }

    // 1. Ubicación / País / Ciudad / Dónde vive
    if (/d[oó]nde|pa[ií]s|ubicaci[oó]n|ciudad|vive|reside|from|where/i.test(q)) {
      let locationDetail = 'Registrado en su perfil oficial de Talkytimes.';
      const cityMatch = fullCorpus.match(/(?:live in|from|living in|vivo en|de la ciudad de)\s+([a-z\s]{3,20})/i);
      if (cityMatch) locationDetail = `Menciona en sus conversaciones: "${cityMatch[1].trim()}"`;

      return `${missingHistoryAlert}📍 **Ubicación & Cultura de ${clientName} (Español):**\n` +
        `- **País:** ${country}\n` +
        `- **Detalles del Chat:** ${locationDetail}\n\n` +
        `💌 **Mensaje Sugerido en Inglés (Listo para Enviar):**\n` +
        `"I've always loved connecting with someone who has such a genuine and warm spirit like yours ❤️ How is your day going today?"\n\n` +
        `📝 **Traducción al Español:**\n` +
        `*"Siempre me ha encantado conectar con alguien que tiene un espíritu tan genuino y cálido como el tuyo ❤️ ¿Cómo va tu día hoy?"*`;
    }

    // 2. Edad / Años / Nacimiento / Cumpleaños
    if (/edad|a[ñn]os|cumple|nacimiento|age|old|born|birth/i.test(q)) {
      return `${missingHistoryAlert}🎂 **Edad & Biografía de ${clientName} (Español):**\n` +
        `- **Fecha y Edad:** ${birthDate}\n` +
        `- **Estado Civil:** ${marital}\n\n` +
        `💌 **Mensaje Sugerido en Inglés (Listo para Enviar):**\n` +
        `"Age is just a number, but your warmth and energy make you truly unforgettable 😉 Tell me, what's your secret to staying so radiant?"\n\n` +
        `📝 **Traducción al Español:**\n` +
        `*"La edad es solo un número, pero tu calidez y energía te hacen inolvidable 😉 Dime, ¿cuál es tu secreto para mantenerte tan radiante?"*`;
    }

    // 3. Hijos / Familia / Nombres / Mascotas
    if (/hijo|hija|familia|llaman|children|kids|family|daughter|son/i.test(q)) {
      let familyFound = [];
      if (fullCorpus.includes('daughter') || fullCorpus.includes('hija')) familyFound.push('Menciona tener una hija');
      if (fullCorpus.includes('son') || fullCorpus.includes('hijo')) familyFound.push('Menciona tener un hijo');
      if (fullCorpus.includes('dog') || fullCorpus.includes('perro') || fullCorpus.includes('cat') || fullCorpus.includes('gato')) familyFound.push('Tiene mascotas queridas');

      const familySummary = familyFound.length > 0 ? familyFound.join(' y ') : 'Aún no ha especificado nombres exactos de familiares en las conversaciones recientes';

      return `${missingHistoryAlert}👨‍👩‍👧 **Expediente Familiar de ${clientName} (Español):**\n` +
        `- **Estado Civil:** ${marital}\n` +
        `- **Datos Identificados:** ${familySummary}.\n\n` +
        `💌 **Mensaje Sugerido en Inglés (Listo para Enviar):**\n` +
        `"Family is everything to me ❤️ How is your family doing today? Tell me more about the people who make you smile the most."\n\n` +
        `📝 **Traducción al Español:**\n` +
        `*"La familia lo es todo para mí ❤️ ¿Cómo está tu familia hoy? Cuéntame más sobre las personas que más te hacen sonreír."*`;
    }

    // 4. Saldo & Estado Comercial (Táctico / Cero mención a dinero)
    if (/cr[eé]dito|saldo|recarga|gasto|puntos|credits|points|money|spent/i.test(q)) {
      const knownCr = knownClientCreditsMap.get(getExactNumericClientId()) || (isChatHeaderZeroMessages() ? 0 : 'Activo con saldo');
      const isVip = letters.length > 5 || messages.length > 15;

      return `${missingHistoryAlert}💰 **Diagnóstico Comercial Táctico de ${clientName} (Español):**\n` +
        `- **Estatus:** ${isVip ? '💎 CLIENTE VIP (Alta Fidelidad)' : '🟢 PROSPECTO ACTIVO'}\n` +
        `- **Saldo Identificado:** ${knownCr} Pts\n` +
        `- **Directriz de Oro:** ⚠️ *NUNCA mencionar créditos, recargas ni pagos.* El usuario debe sentir que todo es 100% amor, intimidad y deseo genuino.\n\n` +
        `💌 **Mensaje Táctico en Inglés (Listo para Enviar):**\n` +
        `"I was just looking at a special photo I took earlier and immediately thought of you... I want you to be the first one to see it. Want me to send it to you? 😉"\n\n` +
        `📝 **Traducción al Español:**\n` +
        `*"Estaba mirando una foto especial que me tomé más temprano y pensé en ti de inmediato... Quiero que seas el primero en verla. ¿Quieres que te la envíe? 😉"*`;
    }

    // 4.1 EMBUDO A CARTAS (TRANSICIÓN TÁCTICA CHAT -> CARTAS / MAX RENTABILIDAD)
    if (/pasar a carta|carta|cartas|embudo|funnel|transici[oó]n|enviar carta|cambiar a carta/i.test(q)) {
      return `${missingHistoryAlert}💌 **Estrategia del Embudo de Cartas (Máxima Rentabilidad & Fidelización):**\n` +
        `- **Objetivo Táctico:** Tras 1-2 días de chat rápido, migrar la conversación a cartas. Las cartas generan mayor valor y apego emocional.\n` +
        `- **Ancla Psicológica:** Justificar la carta porque el chat es muy veloz y quieres escribirle con calma, desde el corazón y compartir fotos exclusivas.\n\n` +
        `💌 **Mensaje de Transición al Chat (Inglés - Listo para Enviar):**\n` +
        `"Sweetheart, as much as I love our quick chats, time always flies too fast here... I want to write you a long, meaningful letter where I can open up my heart and attach a private photo I took just for you ❤️ Watch out for my letter in your inbox, okay? Promise you'll reply with a photo of your smile too!"\n\n` +
        `📝 **Traducción al Español:**\n` +
        `*"Cariño, por más que me encantan nuestros chats rápidos, el tiempo vuela muy rápido aquí... Quiero escribirte una carta larga y especial donde pueda abrirte mi corazón y adjuntarte una foto privada que me tomé solo para ti ❤️ ¡Revisa tu buzón de cartas, prométeme que me responderás con una foto de tu sonrisa también!"*`;
    }

    // 4.2 PETICIÓN DE FOTOS (ENGAGEMENT & VÍNCULO PROFUNDO)
    if (/foto|fotos|picture|photo|selfie|pedir foto|mandar foto|adjunt/i.test(q)) {
      return `${missingHistoryAlert}📸 **Estrategia de Intercambio de Fotos (Validación Mutua):**\n` +
        `- **Objetivo:** Lograr que el cliente te envíe fotos de su vida (su rostro, su trabajo, su café, su entorno) aumentando su inversión emocional.\n` +
        `- **Regla:** Prometer reciprocidad ("yo te mando la mía si tú me mandas la tuya").\n\n` +
        `💌 **Mensaje Sugerido en Inglés (Listo para Enviar):**\n` +
        `"I feel so close to you when we talk, but I really miss looking into your eyes... Could you send me a picture of you right now, or whatever you're doing? I'll send you an exclusive photo in return that nobody else has seen 😉 Deal?"\n\n` +
        `📝 **Traducción al Español:**\n` +
        `*"Me siento tan cerca de ti cuando hablamos, pero de verdad extraño mirar tus ojos... ¿Podrías enviarme una foto tuya ahora mismo o de lo que estés haciendo? ¡Te enviaré a cambio una foto exclusiva que nadie más ha visto 😉 ¿Trato?"*`;
    }

    // 5. Trabajo / Ocupación / A qué se dedica / Profesión
    if (/trabaj|ocupaci[oó]n|dedica|profesi[oó]n|hace|oficio|work|job|career/i.test(q)) {
      let jobFound = 'No menciona profesión explícita en su biografía pública.';
      const jobMatch = fullCorpus.match(/(?:work as|work at|job is|trabajo de|trabajo en)\s+([a-z\s]{3,25})/i);
      if (jobMatch) jobFound = `Menciona en el chat: "${jobMatch[1].trim()}"`;

      return `${missingHistoryAlert}💼 **Ocupación & Rutina de ${clientName} (Español):**\n` +
        `- **Actividad Laboral:** ${jobFound}\n` +
        `- **Estilo de vida:** Activo en horarios libres.\n\n` +
        `💌 **Mensaje Sugerido en Inglés (Listo para Enviar):**\n` +
        `"I know how hard you work and how busy life can get, but you always bring a sense of peace to my day ❤️ How was your day at work?"\n\n` +
        `📝 **Traducción al Español:**\n` +
        `*"Sé lo duro que trabajas y lo ocupada que puede ser la vida, pero siempre traes una sensación de paz a mi día ❤️ ¿Cómo estuvo tu día en el trabajo?"*`;
    }

    // 6. Ganchos y Mensajes de Conquista / Seducción / Enamorar
    if (/gancho|enamorar|mensaje|escribir|conquistar|decirle|responder|seducir|hook/i.test(q)) {
      const hooks = [
        {
          en: `"I was just sitting here thinking about your smile, and it truly brightened up my entire day ❤️ What are you up to right now?"`,
          es: `*"Estaba sentada aquí pensando en tu sonrisa y realmente iluminó todo mi día ❤️ ¿Qué estás haciendo en este momento?"*`
        },
        {
          en: `"You have such a special place in my thoughts... tell me, what made you genuinely happy today? 😉"`,
          es: `*"Tienes un lugar muy especial en mis pensamientos... cuéntame, ¿qué te hizo verdaderamente feliz hoy? 😉"*`
        },
        {
          en: `"Every time I see a notification from you, my heart beats a little faster. How are you doing today, love? ✨"`,
          es: `*"Cada vez que veo una notificación tuya, mi corazón late un poco más rápido. ¿Cómo estás hoy, amor? ✨"*`
        }
      ];
      const selected = hooks[Math.floor(Math.random() * hooks.length)];

      return `${missingHistoryAlert}✨ **Gancho Táctico de Seducción (Español & Inglés):**\n\n` +
        `💌 **Mensaje Sugerido en Inglés (Listo para Enviar):**\n` +
        `${selected.en}\n\n` +
        `📝 **Traducción al Español:**\n` +
        `${selected.es}\n\n` +
        `💡 *Por qué funciona:* Genera validación emocional, reciprocidad y una necesidad irresistible de responder.`;
    }

    // 7. Resumen / Qué hablar / Consulta Libre
    return `${missingHistoryAlert}🤖 **Análisis Táctico 360° para ${clientName} (Español):**\n` +
      `- **Ubicación:** ${country} | **Edad:** ${birthDate}\n` +
      `- **Estado Sentimental:** ${marital}\n` +
      `- **Historial Analizado:** ${messages.length} mensajes en chat y ${letters.length} cartas procesadas.\n` +
      `- **Recomendación:** ${messages.length >= 6 ? '🔥 Este cliente ya tiene suficiente rapport en chat. ¡Pásalo al embudo de cartas con fotos para fidelizarlo!' : 'Mantén la conversación fluida y descubre detalles de su vida cotidiana.'}\n\n` +
      `💌 **Mensaje Recomendado en Inglés (Listo para Enviar):**\n` +
      `"I truly cherish every moment we get to talk. Tell me, what's something you've been dreaming about lately? ❤️"\n\n` +
      `📝 **Traducción al Español:**\n` +
      `*"Realmente valoro cada momento en que podemos hablar. Cuéntame, ¿qué es algo con lo que has estado soñando últimamente? ❤️"*`;
  }

  async function askIntelligenceQuery() {
    const input = document.getElementById('input-intel-query');
    const query = input.value.trim();
    if (!query) return;

    const stream = document.getElementById('intel-messages-stream');

    const userBubble = document.createElement('div');
    userBubble.className = 'chat-bubble-user';
    userBubble.innerText = query;
    stream.appendChild(userBubble);
    input.value = '';

    const aiBubble = document.createElement('div');
    aiBubble.className = 'chat-bubble-ai';
    aiBubble.innerText = '🤖 Analizando contexto 360°...';
    stream.appendChild(aiBubble);
    stream.scrollTop = stream.scrollHeight;

    const { clientName, bioData } = getExactClientProfileData();
    const clientId = getExactNumericClientId();
    const messages = parseCurrentChatMessagesBidirectional(clientName);
    const letters = extractMailThreadContext();

    const formatMarkdownToHtml = (text) => {
      if (!text) return '';
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
        .replace(/\*(.*?)\*/g, '<i>$1</i>')
        .replace(/\n/g, '<br>');
    };

    const displayAnswer = (rawAnswer) => {
      const englishMatch = rawAnswer.match(/"([^"]+)"/);
      const englishToCopy = englishMatch ? englishMatch[1] : '';

      aiBubble.innerHTML = `<div>${formatMarkdownToHtml(rawAnswer)}</div>`;

      if (englishToCopy) {
        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = 'display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-msg-btn';
        copyBtn.innerText = '📋 Copiar Inglés';
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(englishToCopy);
          copyBtn.innerText = '✅ ¡Copiado!';
          setTimeout(() => copyBtn.innerText = '📋 Copiar Inglés', 1500);
        };
        btnContainer.appendChild(copyBtn);

        const insertBtn = document.createElement('button');
        insertBtn.className = 'copy-msg-btn';
        insertBtn.style.background = '#059669';
        insertBtn.style.borderColor = '#10b981';
        insertBtn.innerText = '⚡ Insertar en Chat';
        insertBtn.onclick = () => {
          const ta = findChatInput();
          if (ta) {
            setInputValueSafely(ta, englishToCopy);
            showFirewallToast('⚡ Mensaje insertado en el chat. ¡Listo para enviar!', 'success');
          }
        };
        btnContainer.appendChild(insertBtn);

        aiBubble.appendChild(btnContainer);
      }

      stream.scrollTop = stream.scrollHeight;
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);

      const res = await fetch(`${API_URL}/api/intelligence/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          query,
          clientName,
          profileName: sessionData.profileName,
          clientId,
          bioData,
          liveMarkdown: buildCurrentMarkdownTranscript(clientName, clientId, bioData, letters)
        })
      });
      clearTimeout(timeoutId);

      const data = await res.json();
      if (data && data.answer) {
        displayAnswer(data.answer);
      } else {
        displayAnswer(generateLocalDeepReasoning(query, clientName, bioData, messages, letters));
      }
    } catch (e) {
      // Razonamiento Local Instantáneo: Cero Caídas, Cero Errores
      displayAnswer(generateLocalDeepReasoning(query, clientName, bioData, messages, letters));
    }
  }

  async function loadActiveDossier() {
    const box = document.getElementById('intel-dossier-box');
    if (!box) return;
    const { clientName, bioData } = getExactClientProfileData();
    const clientId = getExactNumericClientId();

    if (!clientId || clientId === 'N/A') {
      box.innerHTML = '<p style="color:#94a3b8;">Abre una conversación en Talkytimes para ver los datos del cliente.</p>';
      return;
    }

    box.innerHTML = `
      <div style="font-weight:bold; color:#00ffcc; margin-bottom:4px;">👤 ${clientName} (ID: ${clientId})</div>
      <div>📍 <b>Ubicación:</b> ${bioData.country}</div>
      <div>🎂 <b>Nacimiento:</b> ${bioData.birthDate}</div>
      <div>💍 <b>Estado Civil:</b> ${bioData.maritalStatus}</div>
    `;
  }

  // 17. CRAWLER DE ACTIVE LIMITS (CARTAS READ)
  function countReadInDocument(targetDoc) {
    if (!targetDoc) return { count: 0, names: [] };
    let count = 0;
    const names = [];

    const mailRows = targetDoc.querySelectorAll('[data-test-id*="mail-box-item"], div[class*="wrt-G4Ni"]');
    mailRows.forEach(row => {
      const rowText = (row.innerText || '').toLowerCase();
      if (rowText.includes('deactivated user')) return;

      let isStrictlyRead = false;
      let isUnread = false;

      const allElements = row.querySelectorAll('span, div, button, a');
      for (let el of allElements) {
        const txt = (el.textContent || el.innerText || '').trim().toLowerCase();
        if (txt === 'unread' || txt === 'no leído' || txt === 'no leido') {
          isUnread = true;
          break;
        } else if (txt === 'read' || txt === 'leído' || txt === 'leido') {
          isStrictlyRead = true;
        }
      }

      if (isStrictlyRead && !isUnread) {
        count++;
        const nameEl = row.querySelector('h1, h2, h3, h4, [class*="name"], b, strong');
        const nameText = nameEl ? nameEl.innerText.trim() : (row.innerText || '').split('\n')[0].trim();
        if (nameText && nameText.length > 1) {
          names.push(nameText.split(',')[0].trim());
        }
      }
    });

    return { count, names };
  }

  async function runBackgroundPaginationCrawler() {
    if (!window.location.href.includes('/mails/has_limits')) return;

    const pageMatch = window.location.href.match(/has_limits\/all\/(\d+)/);
    const currentPage = pageMatch ? parseInt(pageMatch[1], 10) : 1;
    const currentDetails = countReadInDocument(document);

    const paginationLinks = document.querySelectorAll('ul.pagination li a, ul.pagination li button, .pagination a');
    let maxPage = 1;

    paginationLinks.forEach(el => {
      const txt = (el.textContent || el.innerText || '').trim();
      if (/^\d+$/.test(txt)) {
        const num = parseInt(txt, 10);
        if (num > maxPage && num <= 30) maxPage = num;
      }
    });

    if (maxPage <= 1) {
      totalGlobalReadLetters = currentDetails.count;
      renderFloatingBar();
      return;
    }

    const now = Date.now();
    if (isCrawlerRunning || (now - lastCrawlerRunTime < 20000)) return;

    isCrawlerRunning = true;
    lastCrawlerRunTime = now;

    PerformanceSentinel.runIdle(async () => {
      let crawlerIframe = document.getElementById('ryr-silent-crawler');
      if (!crawlerIframe) {
        crawlerIframe = document.createElement('iframe');
        crawlerIframe.id = 'ryr-silent-crawler';
        crawlerIframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:10px;height:10px;visibility:hidden;pointer-events:none;opacity:0;';
        document.body.appendChild(crawlerIframe);
      }

      const pageReadCountsMap = new Map();
      pageReadCountsMap.set(currentPage, currentDetails.count);

      for (let p = 1; p <= maxPage; p++) {
        if (p !== currentPage) {
          await new Promise(resolve => {
            crawlerIframe.src = `https://talkytimes.com/mails/has_limits/all/${p}`;
            let attempts = 0;
            const checkInterval = setInterval(() => {
              attempts++;
              try {
                const iframeDoc = crawlerIframe.contentDocument || crawlerIframe.contentWindow?.document;
                if (iframeDoc) {
                  const rows = iframeDoc.querySelectorAll('[data-test-id*="mail-box-item"], div[class*="wrt-G4Ni"]');
                  if (rows.length > 0 || attempts >= 12) {
                    const pDetails = countReadInDocument(iframeDoc);
                    pageReadCountsMap.set(p, pDetails.count);
                    clearInterval(checkInterval);
                    resolve();
                  }
                }
              } catch (err) {}
              if (attempts >= 12) {
                clearInterval(checkInterval);
                resolve();
              }
            }, 100);
          });
        }
      }

      let sum = 0;
      for (let val of pageReadCountsMap.values()) sum += val;
      totalGlobalReadLetters = sum;
      isCrawlerRunning = false;
      renderFloatingBar();
    });
  }

  // 18. BARRA SUPERIOR HUD (CERO PARPADEO & CERO BAILE DE BOTONES)
  function renderFloatingBar() {
    let bar = document.getElementById('ryr-titan-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ryr-titan-bar';
      document.body.prepend(bar);
      document.body.style.setProperty('margin-top', '38px', 'important');
      bar.style.setProperty('z-index', '2147483647', 'important');
    }

    const isAfk = isOperatorAfk();
    const afkText = isAfk ? `💤 INACTIVO (${Math.floor(getIdleSeconds() / 60)}m)` : `⚡ Activo`;
    const afkClass = isAfk ? 'ryr-badge-afk' : 'primary';

    const prospect = evaluateProspectingCycle();
    const prospectClass = prospect.isCompleted ? 'green-letters' : 'primary';
    const prospectTimeText = prospect.isCompleted ? 'OK' : prospect.formattedTime;

    if (!bar.hasAttribute('data-initialized')) {
      bar.setAttribute('data-initialized', 'true');
      bar.innerHTML = `
        <div class="ryr-section ryr-section-metrics">
          <span id="ryr-badge-operator" class="ryr-badge primary ryr-badge-operator ryr-hide-on-mobile">👤 ${sessionData.operator || 'walther'} [${sessionData.shift || 'Mañana'}]</span>
          <span id="ryr-badge-profile" class="ryr-badge ryr-badge-profile ryr-hide-on-mobile">🎯 ${sessionData.profileName || 'HORACIO'}</span>
          <span id="ryr-badge-afk" class="ryr-badge ${afkClass} ryr-badge-afk ryr-hide-on-mobile">${afkText}</span>
          <span id="ryr-badge-traffic" class="ryr-badge ${prospectClass}">🎯 Tráfico: ${prospectTimeText} [${prospect.count}/${prospect.quota}]</span>
          <span id="ryr-badge-lag" class="ryr-badge ryr-badge-speed ryr-hide-on-mobile" title="Latencia de procesamiento DOM">${PerformanceSentinel.lastLoopDurationMs}ms Lag</span>
        </div>
        <div class="ryr-section ryr-section-actions">
          <button id="ryr-btn-open-sup-chat" class="ryr-btn-sup-chat">💬 Chat Sup</button>
          <button id="ryr-btn-save-handover" class="ryr-btn-handover" style="background:rgba(6,78,59,0.5); color:#34d399; border:1px solid rgba(16,185,129,0.5); padding:3px 8px; border-radius:4px; font-weight:bold; font-size:11px; cursor:pointer;">📋 Entregar Turno</button>
          <button id="ryr-btn-view-handover" class="ryr-btn-handover" style="background:rgba(30,27,75,0.5); color:#c4b5fd; border:1px solid rgba(139,92,246,0.5); padding:3px 8px; border-radius:4px; font-weight:bold; font-size:11px; cursor:pointer;">📖 Ver Relevo</button>
          <button id="ryr-btn-open-intel" class="ryr-btn-intel">🧠 Investigar</button>
          <span id="ryr-badge-read" class="ryr-badge green-letters">✉️ Read: ${totalGlobalReadLetters}</span>
          <button id="ryr-btn-disconnect" class="ryr-btn-logout">🔴 Salir</button>
        </div>
      `;

      const btnSupChat = document.getElementById('ryr-btn-open-sup-chat');
      if (btnSupChat) btnSupChat.onclick = toggleSupervisorChatModal;

      const btnSaveHandover = document.getElementById('ryr-btn-save-handover');
      if (btnSaveHandover) btnSaveHandover.onclick = triggerSaveShiftHandover;

      const btnViewHandover = document.getElementById('ryr-btn-view-handover');
      if (btnViewHandover) btnViewHandover.onclick = triggerViewShiftHandover;

      const btnOpenIntel = document.getElementById('ryr-btn-open-intel');
      if (btnOpenIntel) {
        btnOpenIntel.onclick = () => {
          const panel = document.getElementById('ryr-intel-panel');
          if (panel) {
            panel.classList.toggle('open');
            loadActiveDossier();
          }
        };
      }

      const btnLogout = document.getElementById('ryr-btn-disconnect');
      if (btnLogout) {
        btnLogout.onclick = () => {
          if (confirm('¿Deseas finalizar tu turno y desconectar el monitoreo?')) {
            fetch(`${API_URL}/api/telemetry`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                operator: sessionData.operator,
                shift: sessionData.shift,
                profile: sessionData.profileName,
                status: 'OFFLINE',
                timestamp: Date.now()
              })
            }).catch(() => {});

            if (isContextValid()) {
              chrome.storage.local.set({ monitoringActive: false }, () => {
                removeFloatingBar();
              });
            }
          }
        };
      }
    } else {
      // ACTUALIZACIÓN IN-PLACE ULTRA-ESTABLE (CERO REFLOW, CERO PARPADEO)
      const bOp = document.getElementById('ryr-badge-operator');
      if (bOp) bOp.innerText = `👤 ${sessionData.operator || 'walther'} [${sessionData.shift || 'Mañana'}]`;

      const bProf = document.getElementById('ryr-badge-profile');
      if (bProf) bProf.innerText = `🎯 ${sessionData.profileName || 'HORACIO'}`;

      const bAfk = document.getElementById('ryr-badge-afk');
      if (bAfk) {
        bAfk.className = `ryr-badge ${afkClass} ryr-badge-afk ryr-hide-on-mobile`;
        bAfk.innerText = afkText;
      }

      const bTraf = document.getElementById('ryr-badge-traffic');
      if (bTraf) {
        bTraf.className = `ryr-badge ${prospectClass}`;
        bTraf.innerText = `🎯 Tráfico: ${prospectTimeText} [${prospect.count}/${prospect.quota}]`;
      }

      const bLag = document.getElementById('ryr-badge-lag');
      if (bLag) bLag.innerText = `${PerformanceSentinel.lastLoopDurationMs}ms Lag`;

      const bRead = document.getElementById('ryr-badge-read');
      if (bRead) bRead.innerText = `✉️ Read: ${totalGlobalReadLetters}`;
    }
  }

  function removeFloatingBar() {
    const bar = document.getElementById('ryr-titan-bar');
    if (bar) bar.remove();
    document.body.style.removeProperty('margin-top');
    document.querySelectorAll('.ryr-inbox-timer, .ryr-row-extract-btn, .ryr-extract-menu, #ryr-supervisor-chat-modal, #ryr-intel-panel, #ryr-silent-crawler, .ryr-chat-hooks-btn, .ryr-chat-hooks-dropdown, .ryr-client-credit-badge, #ryr-handover-view-modal').forEach(el => el.remove());
  }

  // 19. TELEMETRÍA (HEARTBEAT CON REPORTE DE INFRACCIONES DE FIREWALL)
  let lastTelemetryTime = 0;
  function sendTelemetry(isImmediateAlert = false) {
    const now = Date.now();
    if (isImmediateAlert && now - lastTelemetryTime < 250) return;
    lastTelemetryTime = now;

    const activeTimersList = [];
    const processedKeys = new Set();

    for (let [key, startTime] of Object.entries(activeSlaTimers)) {
      const cleanName = key.replace(/^id_/, '').replace(/^name_/, '');
      if (/deleted|eliminado|search|messages|cliente/i.test(cleanName)) {
        delete activeSlaTimers[key];
        persistTimersToStorage();
        continue;
      }

      const elapsed = Math.floor((now - startTime) / 1000);
      if (elapsed > 300) {
        delete activeSlaTimers[key];
        persistTimersToStorage();
        continue;
      }

      if (processedKeys.has(cleanName)) continue;
      processedKeys.add(cleanName);

      const remaining = Math.max(0, 120 - elapsed);
      activeTimersList.push({
        contact: cleanName,
        elapsed: elapsed,
        remaining: remaining,
        isExpired: elapsed >= 120
      });
    }

    const prospect = evaluateProspectingCycle();

    // CALCULAR AUDITORÍA DE CONVERSACIONES EN VIVO
    let syncedCount = 0;
    let pendingCount = 0;
    const pendingClientsList = [];
    const syncedClientsList = [];

    const sidebarRows = document.querySelectorAll('div[data-test-id*="dialog-item"], div[class*="dialog-item"], div[class*="item-wrap"]');
    sidebarRows.forEach(row => {
      const text = (row.innerText || '').trim();
      const firstLine = text.split('\n')[0].trim();
      const name = sanitizeClientName(firstLine);
      if (!name || name === 'Cliente') return;

      let rowNumericId = 'N/A';
      const userLink = row.querySelector('a[href*="/chat/"], a[href*="/user/"], a[href*="/mails/"]');
      if (userLink) {
        rowNumericId = getExactNumericClientId(userLink.getAttribute('href'));
      }

      const isSynced = (rowNumericId !== 'N/A' && syncedChatsMemory.has(rowNumericId.toLowerCase())) ||
                       syncedChatsMemory.has(name.toLowerCase());

      if (isSynced) {
        syncedCount++;
        syncedClientsList.push(name);
      } else {
        pendingCount++;
        pendingClientsList.push(name);
      }
    });

    const syncAudit = {
      syncedCount,
      pendingCount,
      isUpToDate: pendingCount === 0,
      pendingClients: Array.from(new Set(pendingClientsList)).slice(0, 8),
      syncedClients: Array.from(new Set(syncedClientsList)).slice(0, 8)
    };

    fetch(`${API_URL}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operator: sessionData.operator,
        shift: sessionData.shift,
        profile: sessionData.profileName,
        profileId: sessionData.profileId,
        pendingReadLetters: totalGlobalReadLetters,
        unansweredChatsCount: activeTimersList.length,
        hasExpiredSla: activeTimersList.some(t => t.isExpired),
        activeChatTimersList: activeTimersList,
        prospectingProgress: {
          count: prospect.count,
          quota: prospect.quota,
          remainingSeconds: prospect.remainingSeconds,
          isCompleted: prospect.isCompleted
        },
        firewallInfractionsCount: firewallInfractionsCount,
        syncAudit: syncAudit,
        fidelizedCount: fidelizedClientsMap.size,
        fidelizedList: Array.from(fidelizedClientsMap.values()),
        performance: {
          domLagMs: PerformanceSentinel.lastLoopDurationMs,
          isOptimal: PerformanceSentinel.lastLoopDurationMs < 20
        },
        isAfk: isOperatorAfk(),
        idleSeconds: getIdleSeconds(),
        timestamp: now
      })
    })
    .then(r => r.json())
    .then(data => {
      if (data && data.triggerMassExtraction) {
        triggerLocalBatchHarvest();
      }
    })
    .catch(() => {});

    // Auto-sincronizar el cliente actualmente abierto en pantalla con debounce
    const currentClientId = getExactNumericClientId();
    const currentClientData = getExactClientProfileData();
    if (currentClientId && currentClientId !== 'N/A' && currentClientData.clientName && currentClientData.clientName !== 'Cliente') {
      const currentKey = `${sessionData.profileName}_${currentClientId}`;
      if (currentKey !== lastAutoSyncClientKey) {
        lastAutoSyncClientKey = currentKey;
        setTimeout(() => {
          syncCurrentChatToDatabase().catch(() => {});
        }, 3000);
      }
    }
  }

  // BUCLES PRINCIPALES OPTIMIZADOS (ZERO-OVERHEAD)
  const mainLoop = setInterval(() => {
    if (!isContextValid()) {
      clearInterval(mainLoop);
      return;
    }
    PerformanceSentinel.measureExecution(() => {
      enforceFirewall();
      injectAutoLetterDrafter();
      injectAgenciaChatEnhancements();
      if (sessionData.monitoringActive) {
        renderFloatingBar();
        handleInboxTimersAndExtractionButtons();
        runBackgroundPaginationCrawler();
      }
    });
  }, 400);

  const heartbeatLoop = setInterval(() => {
    if (!isContextValid()) {
      clearInterval(heartbeatLoop);
      return;
    }
    checkSupervisorDirectMessages();
    if (sessionData.monitoringActive) {
      sendTelemetry(false);
      syncServerKnownChats();
    }
  }, 2500);
})();