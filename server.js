(() => {
  if (window.self !== window.top) return;

  function isContextValid() {
    return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
  }

  const API_URL = 'https://ryr-titan-backend.onrender.com';

  let sessionData = {
    operator: null,
    shift: null,
    profileName: null,
    profileId: null,
    monitoringActive: false
  };

  let totalGlobalReadLetters = 0;
  let pendingLetterUserNames = [];
  const pageReadCounts = new Map();
  let isCrawlerRunning = false;
  let lastCrawlerRunTime = 0;

  let lastUserInteraction = Date.now();
  const AFK_THRESHOLD_SECONDS = 300;

  let activeSlaTimers = {};
  let finedTimerKeys = new Set();
  let syncedChatsMemory = new Set();

  const PROSPECTING_CYCLE_DURATION = 1800;
  const PROSPECTING_MIN_QUOTA = 10;
  
  let hasStorageLoaded = false;
  let prospectingCycleStartTime = 0;
  let prospectingCount = 0;
  let cycleInteractedUsersSet = new Set();

  let modalSnoozedUntil = 0;
  let countAtSnooze = 0;
  let adminInvasiveModalEnabled = true;

  let lastFocusedClientId = '';
  let consecutiveMessagesSentToActiveClient = 0;
  let hasChatMonopolyWarning = false;
  let unattendedChatsCount = 0;

  let bannedRoots = [
    'promet', 'promes', 'whatsapp', 'skype', 'email', 'correo', 
    'telefon', 'teléfon', 'numer', 'númer', 'banc', 'tarjet', 
    'instagram', 'telegram', 'diner', 'transferenc', 'pay', 'cash'
  ];

  // 1. REGISTRO DE ACTIVIDAD
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

  // 2. RECUPERAR DATOS Y SESIÓN PERSISTENTE
  if (isContextValid()) {
    try {
      chrome.storage.local.get(null, (data) => {
        if (!isContextValid() || !data) return;

        const now = Date.now();

        if (data.prospectingCycleStartTime && (now - data.prospectingCycleStartTime < PROSPECTING_CYCLE_DURATION * 1000)) {
          prospectingCycleStartTime = data.prospectingCycleStartTime;
          prospectingCount = data.prospectingCount || 0;
          if (Array.isArray(data.cycleInteractedUsersList)) {
            cycleInteractedUsersSet = new Set(data.cycleInteractedUsersList);
          }
        } else {
          prospectingCycleStartTime = now;
          prospectingCount = 0;
          cycleInteractedUsersSet.clear();
          chrome.storage.local.set({
            prospectingCycleStartTime: now,
            prospectingCount: 0,
            cycleInteractedUsersList: []
          });
        }

        if (data.activeSlaTimers) activeSlaTimers = data.activeSlaTimers;
        if (Array.isArray(data.syncedChatsList)) {
          data.syncedChatsList.forEach(item => syncedChatsMemory.add(String(item).trim().toLowerCase()));
        }

        hasStorageLoaded = true;

        if (data.monitoringActive) {
          sessionData = {
            operator: data.operator || 'walther',
            shift: data.shift || 'Tarde',
            profileName: data.profileName || 'HORACIO',
            profileId: data.profileId || '118179794',
            monitoringActive: true
          };
          renderFloatingBar();
          injectIntelPanel();
          syncServerKnownChats();
        }
      });
    } catch (e) {}
  }

  function persistTimersToStorage() {
    if (!isContextValid()) return;
    try {
      chrome.storage.local.set({ activeSlaTimers });
    } catch (e) {}
  }

  function persistProspectingToStorage() {
    if (!isContextValid()) return;
    try {
      chrome.storage.local.set({
        prospectingCycleStartTime,
        prospectingCount,
        cycleInteractedUsersList: Array.from(cycleInteractedUsersSet)
      });
    } catch (e) {}
  }

  function persistSyncedChatsToStorage() {
    if (!isContextValid()) return;
    try {
      chrome.storage.local.set({ syncedChatsList: Array.from(syncedChatsMemory) });
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

  // 3. SENSOR DE SEGUIMIENTO (10 USUARIOS / 30 MIN)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button, [role="button"], a, div[class*="heart"], div[class*="like"], div[class*="wink"], div[class*="follow"]');
    if (!btn || btn.id?.includes('ryr')) return;

    const txt = (btn.innerText || '').toLowerCase().trim();
    const isAlreadyFollowingOrLiked = txt === 'liked' || txt === 'unfollow' || txt.includes('unfollow') || btn.classList.contains('active');
    if (isAlreadyFollowingOrLiked) return;

    const isNewFollowAction = txt === 'like' || txt === 'wink' || txt === 'follow' || 
                              btn.querySelector('svg[class*="heart"], [class*="like"], [class*="follow"]');

    if (isNewFollowAction) {
      let targetUserId = '';
      const urlMatch = window.location.href.match(/(?:user|chat)\/(\d+)/);
      if (urlMatch) targetUserId = urlMatch[1];

      const card = btn.closest('div[class*="card"], div[class*="item"], div[class*="user"], div[class*="profile"], div[class*="box"]') || document;
      if (!targetUserId && card) {
        const link = card.querySelector('a[href*="/user/"], a[href*="/chat/"]');
        if (link) {
          const m = link.getAttribute('href').match(/(?:user|chat)\/(\d+)/);
          if (m) targetUserId = m[1];
        }
        const nameEl = card.querySelector('h1, h2, h3, h4, [class*="name"], [class*="title"]');
        if (!targetUserId && nameEl) targetUserId = 'user_' + nameEl.innerText.trim().toLowerCase();
      }

      if (!targetUserId) {
        const headerName = document.querySelector('h1, h2, [class*="header"] [class*="name"], [class*="user-name"]');
        if (headerName) targetUserId = 'user_' + headerName.innerText.trim().toLowerCase();
      }

      if (!targetUserId) targetUserId = 'target_' + Date.now();

      if (!cycleInteractedUsersSet.has(targetUserId)) {
        cycleInteractedUsersSet.add(targetUserId);
        prospectingCount++;
        persistProspectingToStorage();
        updateBarNumbersOnly();
        sendTelemetry(true);

        if (prospectingCount >= PROSPECTING_MIN_QUOTA) {
          removeGoogleToastNotification();
        }
      }
    }
  }, true);

  // 4. NOTIFICACIÓN FLOTANTE TIPO GOOGLE
  function evaluateProspectingCycle() {
    if (!hasStorageLoaded || prospectingCycleStartTime === 0) return;

    const now = Date.now();
    const elapsed = Math.floor((now - prospectingCycleStartTime) / 1000);
    const remaining = Math.max(0, PROSPECTING_CYCLE_DURATION - elapsed);

    if (prospectingCount < PROSPECTING_MIN_QUOTA && (remaining <= 300 || elapsed >= PROSPECTING_CYCLE_DURATION)) {
      renderGoogleToastNotification(remaining, prospectingCount);
    } else {
      removeGoogleToastNotification();
    }

    if (elapsed >= PROSPECTING_CYCLE_DURATION) {
      prospectingCycleStartTime = Date.now();
      prospectingCount = 0;
      cycleInteractedUsersSet.clear();
      persistProspectingToStorage();
      updateBarNumbersOnly();
      sendTelemetry(true);
    }
  }

  function renderGoogleToastNotification(remainingSec, currentCount) {
    if (document.getElementById('ryr-google-toast')) {
      const elCount = document.getElementById('ryr-toast-count');
      const elTimer = document.getElementById('ryr-toast-timer');
      if (elCount) elCount.innerText = `${currentCount}/${PROSPECTING_MIN_QUOTA}`;
      if (elTimer) {
        const min = Math.floor(remainingSec / 60);
        const sec = remainingSec % 60;
        elTimer.innerText = `${min < 10 ? '0' : ''}${min}:${sec < 10 ? '0' : ''}${sec}`;
      }
      return;
    }

    const toast = document.createElement('div');
    toast.id = 'ryr-google-toast';

    const min = Math.floor(remainingSec / 60);
    const sec = remainingSec % 60;
    const timeStr = `${min < 10 ? '0' : ''}${min}:${sec < 10 ? '0' : ''}${sec}`;

    toast.innerHTML = `
      <div class="ryr-toast-header">
        <span>🔔 Recordatorio de Tráfico</span>
        <button class="ryr-toast-close" onclick="document.getElementById('ryr-google-toast')?.remove()">✕</button>
      </div>
      <div>
        Es momento de interactuar con nuevos perfiles en Search.<br>
        Progreso: <b id="ryr-toast-count" style="color:#10b981;">${currentCount}/${PROSPECTING_MIN_QUOTA}</b> | Tiempo: <span id="ryr-toast-timer" style="color:#f59e0b;">${timeStr}</span>
      </div>
      <button style="background:#10b981; color:#060913; border:none; padding:6px 10px; border-radius:4px; font-weight:bold; cursor:pointer; font-size:11px;" onclick="window.location.href='https://talkytimes.com/search'">
        🔍 Ir a Search
      </button>
    `;

    document.body.appendChild(toast);
  }

  function removeGoogleToastNotification() {
    const toast = document.getElementById('ryr-google-toast');
    if (toast) toast.remove();
  }

  // 5. FIREWALL 100% BLINDADO
  function checkViolationInText(text) {
    const lower = text.toLowerCase();
    return bannedRoots.some(root => lower.includes(root.toLowerCase()));
  }

  function enforceFirewall() {
    const inputs = document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]');
    let anyViolation = false;

    inputs.forEach(input => {
      const text = (input.value || input.innerText || '').trim();
      const hasViolation = checkViolationInText(text);

      if (hasViolation) {
        anyViolation = true;
        input.style.setProperty('border', '2px solid #ef4444', 'important');
      } else {
        if (input.style.borderColor === 'rgb(239, 68, 68)') {
          input.style.removeProperty('border');
        }
      }
    });

    const sendButtons = document.querySelectorAll('button, [role="button"]');
    sendButtons.forEach(btn => {
      const btnText = btn.innerText.toLowerCase();
      const isSendBtn = (btnText.includes('send') || btnText.includes('enviar') || btn.querySelector('svg') || (btn.className && btn.className.toLowerCase().includes('send'))) &&
                        !btn.classList.contains('ryr-row-extract-btn') && 
                        !btn.classList.contains('ryr-btn-logout') &&
                        !btn.classList.contains('ryr-btn-intel');

      if (isSendBtn) {
        if (anyViolation) {
          btn.classList.add('ryr-btn-blocked-force');
          btn.disabled = true;
          btn.setAttribute('disabled', 'true');
          btn.style.setProperty('background-color', '#9ca3af', 'important');
          btn.style.setProperty('background', '#9ca3af', 'important');
          btn.style.setProperty('pointer-events', 'none', 'important');
          btn.style.setProperty('cursor', 'not-allowed', 'important');
          btn.style.setProperty('filter', 'grayscale(100%)', 'important');
          btn.style.setProperty('opacity', '0.45', 'important');
        } else {
          btn.classList.remove('ryr-btn-blocked-force');
          btn.disabled = false;
          btn.removeAttribute('disabled');
          btn.style.removeProperty('background-color');
          btn.style.removeProperty('background');
          btn.style.removeProperty('pointer-events');
          btn.style.removeProperty('cursor');
          btn.style.removeProperty('filter');
          btn.style.removeProperty('opacity');
        }
      }
    });

    if (anyViolation) {
      document.body.classList.add('ryr-firewall-blocked');
    } else {
      document.body.classList.remove('ryr-firewall-blocked');
    }
  }

  ['input', 'keyup', 'keydown', 'paste', 'change'].forEach(evtType => {
    document.addEventListener(evtType, enforceFirewall, true);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT' || activeEl.isContentEditable)) {
        const text = (activeEl.value || activeEl.innerText || '').trim();
        if (checkViolationInText(text)) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          activeEl.style.setProperty('border', '2px solid #ef4444', 'important');
          enforceFirewall();
          return false;
        }
      }
    }
  }, true);

  // 6. RASTREO DE MONOPOLIO
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button, [role="button"]');
    if (btn) {
      const btnText = btn.innerText.toLowerCase();
      if (btnText.includes('send') || btnText.includes('enviar') || btn.classList.value.includes('send')) {
        const currentActiveId = getExactNumericClientId();
        if (currentActiveId !== 'N/A') {
          if (currentActiveId === lastFocusedClientId) {
            consecutiveMessagesSentToActiveClient++;
          } else {
            lastFocusedClientId = currentActiveId;
            consecutiveMessagesSentToActiveClient = 1;
          }
          evaluateChatMonopoly();
        }
      }
    }
  }, true);

  function evaluateChatMonopoly() {
    const totalWaitingOtherChats = Object.keys(activeSlaTimers).filter(k => k !== lastFocusedClientId).length;
    unattendedChatsCount = totalWaitingOtherChats;

    if (consecutiveMessagesSentToActiveClient >= 4 && totalWaitingOtherChats >= 2) {
      hasChatMonopolyWarning = true;
    } else {
      hasChatMonopolyWarning = false;
    }
    updateBarNumbersOnly();
    sendTelemetry(true);
  }

  // 7. EXTRACTOR DE DATOS
  function extractSectionPills(sectionTitle) {
    const allHeaders = document.querySelectorAll('h1, h2, h3, h4, span, div, strong');
    for (let h of allHeaders) {
      if (h.children.length === 0 && h.innerText.trim().toLowerCase() === sectionTitle.toLowerCase()) {
        const container = h.closest('div, section') || h.parentElement;
        if (container) {
          const pills = container.querySelectorAll('button, span, div[class*="pill"], div[class*="badge"], div[class*="tag"], [class*="chip"]');
          const results = Array.from(pills)
            .map(p => p.innerText.trim())
            .filter(v => v && v.toLowerCase() !== sectionTitle.toLowerCase() && v.length > 1);
          if (results.length > 0) {
            return Array.from(new Set(results)).join(', ');
          }
        }
      }
    }
    return '';
  }

  function sanitizeClientName(raw) {
    if (!raw) return 'Clienta';
    const clean = raw
      .split('\n')[0]
      .replace(/(\d+\s*(minute|hour|day|week|month)s?\s*ago|\ban hour ago\b|\d+\s*[✉💬]|\bonline\b|\btyping\b|\bSearch\b|\bMessages\b)/gi, '')
      .replace(/\s+/g, ' ')
      .replace(/^,\s*/, '')
      .trim();

    const noisyWords = ['yes', 'no', 'open', 'search', 'messages', 'mail', 'gifts', 'account', 'titan apex', 'mute', 'listened', 'public photos', 'my content', 'more'];
    if (noisyWords.includes(clean.toLowerCase()) || clean.length < 2) {
      return 'Clienta';
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
        if (cleaned !== 'Clienta' && txt.length > 1 && !txt.includes('ago') && !txt.includes('Online')) {
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
        if (cleaned !== 'Clienta') clientName = cleaned;
      }
    }

    let country = '';
    let birthDate = '';
    let maritalStatus = '';

    const allPills = document.querySelectorAll('span, div, button, p');
    allPills.forEach(el => {
      if (el.children.length > 1) return;
      const t = el.innerText.trim();

      if (!country && /^(United States|Brazil|Australia|Poland|Hong Kong|Colombia|Canada|Mexico|Spain|Argentina|United Kingdom|Germany|France|Uruguay)/i.test(t)) {
        country = t;
      }
      if (!birthDate && /([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i.test(t)) {
        const m = t.match(/([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i);
        if (m) birthDate = m[1];
      }
      if (!maritalStatus && /^(Divorced|Widowed|Single|Not Married|Married|Viudo|Viuda|Divorciado|Soltero|Soltera)$/i.test(t)) {
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

    const interests = extractSectionPills('Interests') || 'Traveling, Hockey';

    return {
      clientName: clientName || 'Kath',
      bioData: {
        country: country || 'United States',
        birthDate: birthDate ? `${birthDate} (${ageText})` : 'Edad en perfil',
        maritalStatus: maritalStatus || 'Not married',
        interests: interests
      }
    };
  }

  function getExactNumericClientId(targetUrl = window.location.href) {
    const chatMatch = targetUrl.match(/chat\/\d+_(\d+)/);
    if (chatMatch) return String(chatMatch[1]).trim();
    const userMatch = targetUrl.match(/user\/(\d+)/);
    if (userMatch) return String(userMatch[1]).trim();
    return '119478500';
  }

  // 8. PARSER DE DIÁLOGOS BIDIRECCIONAL JERÁRQUICO (CAPTURA HORACIO VS CLIENTA)
  function isOperatorMessageContainer(node) {
    let current = node;
    for (let i = 0; i < 5 && current && current !== document.body; i++) {
      const text = (current.innerText || '').trim();
      const cls = (current.className || '').toLowerCase();
      const style = window.getComputedStyle(current);

      if (/(?:you:|tú:|tu:|você:)/i.test(text)) return true;

      // Iconos de enviado / checks
      if (current.querySelector('svg[class*="check"], svg[data-icon="check"], [class*="status-sent"], [class*="read-check"]')) {
        return true;
      }

      // Clases comunes de emisor saliente
      if (/out|right|self|mine|outgoing|from-me/i.test(cls) && !/incoming|left|other/i.test(cls)) {
        return true;
      }

      // Alineación a la derecha
      if (style.justifyContent === 'flex-end' || style.alignSelf === 'flex-end' || style.textAlign === 'right' || style.marginLeft === 'auto') {
        return true;
      }

      // Color de fondo amarillo/crema o azul claro del operador
      const bg = style.backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        if (bg.includes('254, 249') || bg.includes('254, 240') || bg.includes('255, 251') || bg.includes('224, 231') || bg.includes('238, 242')) {
          return true;
        }
      }

      current = current.parentElement;
    }
    return false;
  }

  function parseCurrentChatMessagesBidirectional(realName) {
    const allBubbles = document.querySelectorAll('div[class*="message-wrap"], div[class*="message-item"], div[class*="dialog-msg"], div[class*="chat-message"]');
    const leafNodes = Array.from(allBubbles).filter(el => {
      return !el.querySelector('div[class*="message-wrap"], div[class*="message-item"], div[class*="dialog-msg"], div[class*="chat-message"]');
    });

    const messages = [];
    const seenSignatures = new Set();

    leafNodes.forEach(node => {
      const textRaw = node.innerText || '';
      if (textRaw.includes('seen') && textRaw.length < 10) return;
      if (textRaw.includes('View post') && textRaw.length < 15) return;
      if (/^\+\d+$/.test(textRaw.trim())) return;

      const isOperator = isOperatorMessageContainer(node);

      const timeEl = node.querySelector('time, [class*="time"], [class*="date"]') || node.closest('[class*="wrap"]')?.querySelector('time') || node.parentElement?.querySelector('time');
      const timeText = timeEl ? timeEl.innerText.trim() : '';

      let cleanText = textRaw
        .replace(/(You:|Tú:|Tu:|Você:)/gi, '')
        .replace(/\d+:\d+\s*(am|pm)/gi, '')
        .replace(/seen/gi, '')
        .replace(/View post/gi, '')
        .trim();

      const signature = `${isOperator ? 'OP' : 'USER'}_${cleanText}`;

      if (cleanText.length > 0 && !seenSignatures.has(signature)) {
        seenSignatures.add(signature);
        messages.push({
          isOperator: Boolean(isOperator),
          senderName: isOperator ? (sessionData.profileName || 'HORACIO') : realName,
          time: timeText || 'Reciente',
          text: cleanText
        });
      }
    });

    return messages;
  }

  function buildCurrentMarkdownTranscript(clientName, clientId, bioData) {
    const messages = parseCurrentChatMessagesBidirectional(clientName);
    
    let mdLines = [
      `# HISTORIAL DE CONVERSACIÓN | RYR TITAN AUDIT`,
      `- **Operador:** ${sessionData.operator || 'walther'} [${sessionData.shift || 'Tarde'}]`,
      `- **Perfil Asignado:** ${sessionData.profileName || 'HORACIO'} (ID: ${sessionData.profileId || '118179794'})`,
      `- **Cliente:** ${clientName}`,
      `- **ID del Usuario:** ${clientId}`,
      `- **Ubicación:** ${bioData?.country} | **Nacimiento:** ${bioData?.birthDate}`,
      `- **Fecha:** ${new Date().toLocaleString()}`,
      `---`,
      `### Diálogo Transcrito (Ambos Participantes):`
    ];

    messages.forEach(m => {
      if (m.isOperator) {
        mdLines.push(`- 💼 **${sessionData.profileName || 'HORACIO'} [Op: ${sessionData.operator}]** [${m.time}]: ${m.text}`);
      } else {
        mdLines.push(`- 👤 **${clientName} [Cliente]** [${m.time}]: ${m.text}`);
      }
    });

    return mdLines.join('\n');
  }

  async function executeExtraction(clientNameParam, explicitNumericId, mode = 'RECENT', btnElement = null) {
    let finalClientId = explicitNumericId;
    if (!finalClientId || finalClientId === 'N/A' || isNaN(finalClientId)) {
      finalClientId = getExactNumericClientId();
    }

    const { clientName, bioData } = getExactClientProfileData();
    const finalClientName = (clientNameParam && !['Search', 'Cliente', 'Yes', 'No', 'Open', 'More'].includes(clientNameParam)) ? sanitizeClientName(clientNameParam) : clientName;

    // EXTRACCIÓN HISTÓRICA DESDE EL PRIMER DÍA
    if (mode === 'FULL') {
      if (btnElement) btnElement.innerText = '📜...';
      const jumpFirstBtn = Array.from(document.querySelectorAll('button, a, span')).find(el => el.innerText.includes('The very 1st message') || el.innerText.includes('Jump to'));
      if (jumpFirstBtn) {
        jumpFirstBtn.click();
        await new Promise(r => setTimeout(r, 1200));
      }

      // Ciclo de scroll hacia arriba progresivo para forzar carga de mensajes antiguos
      const chatContainer = document.querySelector('div[class*="dialog-content"], div[class*="chat-scroll"], div[class*="messages-wrap"], div[class*="message-list"]');
      if (chatContainer) {
        for (let s = 0; s < 12; s++) {
          chatContainer.scrollTop = 0;
          await new Promise(r => setTimeout(r, 250));
        }
      }
    }

    const messages = parseCurrentChatMessagesBidirectional(finalClientName);
    if (messages.length === 0 && !window.location.href.includes('/user/')) {
      if (btnElement) btnElement.innerText = '❌';
      return;
    }

    if (btnElement) btnElement.innerText = '⏳';

    const targetMessages = mode === 'RECENT' ? messages.slice(-100) : messages;
    const markdownDoc = buildCurrentMarkdownTranscript(finalClientName, finalClientId, bioData);

    try {
      const res = await fetch(`${API_URL}/api/chats/audit-deep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operator: sessionData.operator,
          profile: sessionData.profileName || 'HORACIO',
          clientName: finalClientName,
          clientId: String(finalClientId).trim(),
          bioData: bioData,
          markdown: markdownDoc,
          messages: targetMessages
        })
      });

      const data = await res.json();
      if (data.success) {
        syncedChatsMemory.add(String(finalClientId).trim().toLowerCase());
        syncedChatsMemory.add(finalClientName.toLowerCase());
        persistSyncedChatsToStorage();
      }

      if (btnElement) {
        btnElement.style.setProperty('background', '#334155', 'important');
        btnElement.style.setProperty('color', '#94a3b8', 'important');
        btnElement.innerText = '⚡';
      }

      loadActiveDossier();
    } catch (err) {
      if (btnElement) btnElement.innerText = '⚠️';
    }
  }

  // 9. CONTROL DE FILAS
  function handleInboxTimersAndExtractionButtons() {
    const allMatches = document.querySelectorAll('div[data-test-id*="dialog-item"], div[class*="dialog-item"], div[class*="item-wrap"], .tab-content-item');
    const validUnansweredKeys = new Set();

    const rootRows = Array.from(allMatches).filter(el => {
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        if (parent.matches && parent.matches('div[data-test-id*="dialog-item"], div[class*="dialog-item"], div[class*="item-wrap"], .tab-content-item')) {
          return false;
        }
        parent = parent.parentElement;
      }
      return true;
    });

    rootRows.forEach(row => {
      const fullText = row.innerText || '';
      if (fullText.length < 3) return;

      const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
      const contactName = sanitizeClientName(lines[0]);
      const cleanSimpleName = contactName.split(',')[0].trim().toLowerCase();
      
      let rowNumericId = 'N/A';
      const userLink = row.querySelector('a[href*="/chat/"], a[href*="/user/"]');
      if (userLink) {
        const href = userLink.getAttribute('href');
        rowNumericId = getExactNumericClientId(href);
      }

      row.style.position = 'relative';

      const isThisRowSynced = syncedChatsMemory.has(contactName.toLowerCase()) || 
                              syncedChatsMemory.has(cleanSimpleName) ||
                              (rowNumericId !== 'N/A' && syncedChatsMemory.has(rowNumericId.toLowerCase()));

      let btnExtract = row.querySelector('.ryr-row-extract-btn');
      if (!btnExtract) {
        btnExtract = document.createElement('button');
        btnExtract.className = 'ryr-row-extract-btn';
        btnExtract.innerText = '⚡';
        btnExtract.onclick = (e) => {
          e.stopPropagation();
          document.querySelectorAll('.ryr-extract-menu').forEach(m => m.remove());

          const menu = document.createElement('div');
          menu.className = 'ryr-extract-menu';
          menu.innerHTML = `
            <button id="btn-opt-100">📄 Últimos 100</button>
            <button id="btn-opt-full">📜 Historial Completo</button>
          `;

          menu.querySelector('#btn-opt-100').onclick = (ev) => {
            ev.stopPropagation();
            menu.remove();
            executeExtraction(contactName, rowNumericId, 'RECENT', btnExtract);
          };

          menu.querySelector('#btn-opt-full').onclick = (ev) => {
            ev.stopPropagation();
            menu.remove();
            executeExtraction(contactName, rowNumericId, 'FULL', btnExtract);
          };

          row.appendChild(menu);

          setTimeout(() => {
            window.addEventListener('click', () => menu.remove(), { once: true });
          }, 100);
        };
        row.appendChild(btnExtract);
      }

      if (isThisRowSynced) {
        btnExtract.style.setProperty('background', '#334155', 'important');
        btnExtract.style.setProperty('color', '#94a3b8', 'important');
        btnExtract.style.setProperty('border', '1px solid #475569', 'important');
      } else {
        btnExtract.style.setProperty('background', '#1d4ed8', 'important');
        btnExtract.style.setProperty('color', '#ffffff', 'important');
        btnExtract.style.setProperty('border', '1px solid #60a5fa', 'important');
      }

      // TEMPORIZADOR
      const isDeactivated = fullText.includes('Deactivated user');
      const isTyping = fullText.toLowerCase().includes('typing') || row.querySelector('[class*="typing"]');
      const isLiked = fullText.toLowerCase().includes('liked');
      const hasOperatorPrefix = /(?:you|tú|tu|você)\s*:/i.test(fullText);
      const isOperatorReplied = hasOperatorPrefix && !isTyping && !isLiked;

      const timerKey = rowNumericId !== 'N/A' ? rowNumericId : contactName;
      const existingTimer = row.querySelector('.ryr-inbox-timer');

      if (isOperatorReplied || isDeactivated) {
        if (existingTimer) existingTimer.remove();
        if (activeSlaTimers[timerKey]) {
          delete activeSlaTimers[timerKey];
          persistTimersToStorage();
          sendTelemetry(true);
        }
        return;
      }

      validUnansweredKeys.add(timerKey);

      if (!activeSlaTimers[timerKey]) {
        activeSlaTimers[timerKey] = Date.now();
        persistTimersToStorage();
      }

      const startTimestamp = activeSlaTimers[timerKey];
      const elapsedSeconds = Math.floor((Date.now() - startTimestamp) / 1000);
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

        if (!finedTimerKeys.has(timerKey)) {
          finedTimerKeys.add(timerKey);
          triggerAutomaticFine(contactName, rowNumericId);
        }
      }
    });

    let changed = false;
    for (let k in activeSlaTimers) {
      if (!validUnansweredKeys.has(k)) {
        delete activeSlaTimers[k];
        changed = true;
      }
    }
    if (changed) {
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
          shift: sessionData.shift || 'Tarde',
          profile: sessionData.profileName || 'HORACIO',
          clientName: clientName,
          clientId: clientId,
          reason: `Demora mayor a 2 minutos en responder a ${clientName}`
        })
      });
    } catch (e) {}
    sendTelemetry(true);
  }

  // 10. PANEL DE INTELIGENCIA DE USUARIOS (OPERADOR)
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
          <button class="intel-quick-btn" onclick="window.sendQuickPrompt('de donde es')">📍 Ubicación</button>
          <button class="intel-quick-btn" onclick="window.sendQuickPrompt('cuantos años tiene')">🎂 Edad</button>
          <button class="intel-quick-btn" onclick="window.sendQuickPrompt('dame un mensaje para enamorarla')">💌 Mensaje</button>
        </div>

        <div id="intel-messages-stream" class="intel-chat-stream">
          <div class="chat-bubble-ai">👋 ¡Hola! Pregúntame sobre la clienta o pídeme cómo responder a su último mensaje.</div>
        </div>
      </div>
      <div class="intel-input-box">
        <input type="text" id="input-intel-query" placeholder="Pregunta sobre la clienta o pide un mensaje...">
        <button id="btn-send-intel-query">Consultar</button>
      </div>
    `;

    document.body.appendChild(panel);

    document.getElementById('ryr-close-intel').onclick = () => {
      panel.classList.remove('open');
    };

    window.sendQuickPrompt = (promptText) => {
      document.getElementById('input-intel-query').value = promptText;
      askIntelligenceQuery();
    };

    document.getElementById('btn-send-intel-query').onclick = askIntelligenceQuery;
    document.getElementById('input-intel-query').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') askIntelligenceQuery();
    });
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
    aiBubble.innerText = '🤖 Analizando con Groq en tiempo real...';
    stream.appendChild(aiBubble);
    stream.scrollTop = stream.scrollHeight;

    const { clientName, bioData } = getExactClientProfileData();
    const clientId = getExactNumericClientId();
    const liveMarkdown = buildCurrentMarkdownTranscript(clientName, clientId, bioData);

    try {
      const res = await fetch(`${API_URL}/api/intelligence/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: query,
          clientName: clientName,
          profileName: sessionData.profileName,
          clientId: clientId,
          bioData: bioData,
          liveMarkdown: liveMarkdown
        })
      });
      const data = await res.json();
      const rawAnswer = data.answer || 'No se pudo generar respuesta.';

      const englishMatch = rawAnswer.match(/"([^"]+)"/);
      const englishToCopy = englishMatch ? englishMatch[1] : '';

      aiBubble.innerHTML = `<div>${rawAnswer}</div>` + (englishToCopy ? `
        <button class="copy-msg-btn" onclick="navigator.clipboard.writeText('${englishToCopy.replace(/'/g, "\\'")}'); this.innerText='✅ Copiado!'; setTimeout(()=>this.innerText='📋 Copiar Inglés', 1500);">
          📋 Copiar Inglés
        </button>
      ` : '');

      stream.scrollTop = stream.scrollHeight;
    } catch (e) {
      aiBubble.innerText = '⚠️ Error de conexión con el servidor.';
    }
  }

  async function loadActiveDossier() {
    const box = document.getElementById('intel-dossier-box');
    const { clientName, bioData } = getExactClientProfileData();
    const clientId = getExactNumericClientId();

    if (!clientId || clientId === 'N/A') {
      box.innerHTML = '<p style="color:#94a3b8;">Abre una conversación en Talkytimes para ver los datos del cliente.</p>';
      return;
    }

    executeExtraction(clientName, clientId, 'RECENT', null);

    box.innerHTML = `
      <div style="font-weight:bold; color:#00ffcc; margin-bottom:4px;">👤 ${clientName} (ID: ${clientId})</div>
      <div>📍 <b>Ubicación:</b> ${bioData.country}</div>
      <div>🎂 <b>Nacimiento:</b> ${bioData.birthDate}</div>
      <div>💍 <b>Estado Civil:</b> ${bioData.maritalStatus}</div>
    `;
  }

  // 11. CRAWLER DE ACTIVE LIMITS
  function extractReadLetterDetailsFromDoc(targetDoc) {
    if (!targetDoc) return { count: 0, names: [] };
    let count = 0;
    const names = [];
    const mailRows = targetDoc.querySelectorAll('[data-test-id="file:mail-box-item-root"], div[class*="wrt-G4Ni"]');

    mailRows.forEach(row => {
      const badges = row.querySelectorAll('span, div');
      let isRead = false;
      for (let b of badges) {
        const txt = b.innerText.trim().toLowerCase();
        if (txt === 'read' || txt === 'leído' || txt === 'leido') {
          isRead = true;
          break;
        }
      }
      if (isRead) {
        count++;
        const nameEl = row.querySelector('h3, h4, [class*="name"], span');
        if (nameEl) names.push(nameEl.innerText.trim());
      }
    });

    return { count, names };
  }

  async function runBackgroundPaginationCrawler() {
    if (!window.location.href.includes('/mails/has_limits')) return;

    const pageMatch = window.location.href.match(/has_limits\/all\/(\d+)/);
    const currentPage = pageMatch ? parseInt(pageMatch[1], 10) : 1;
    const currentCount = countReadInDocument(document);
    pageReadCounts.set(currentPage, currentCount);

    let maxPage = 1;
    const pageElements = document.querySelectorAll('ul.pagination li, [class*="pagination"] button, [class*="pagination"] a, span');
    pageElements.forEach(el => {
      const num = parseInt(el.innerText.trim(), 10);
      if (!isNaN(num) && num > maxPage && num < 40) {
        maxPage = num;
      }
    });

    if (maxPage <= 1) {
      totalGlobalReadLetters = currentCount;
      pendingLetterUserNames = currentDetails.names;
      updateBarNumbersOnly();
      return;
    }

    const now = Date.now();
    if (isCrawlerRunning || (now - lastCrawlerRunTime < 20000)) {
      recalculateTotalFromMap();
      return;
    }

    isCrawlerRunning = true;
    lastCrawlerRunTime = now;

    let crawlerIframe = document.getElementById('ryr-silent-crawler');
    if (!crawlerIframe) {
      crawlerIframe = document.createElement('iframe');
      crawlerIframe.id = 'ryr-silent-crawler';
      crawlerIframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:10px;height:10px;visibility:hidden;pointer-events:none;opacity:0;';
      document.body.appendChild(crawlerIframe);
    }

    let allCollectedNames = [...currentDetails.names];

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
                const rows = iframeDoc.querySelectorAll('[data-test-id="file:mail-box-item-root"], div[class*="wrt-G4Ni"]');
                if (rows.length > 0 || attempts >= 15) {
                  const pDetails = extractReadLetterDetailsFromDoc(iframeDoc);
                  pageReadCounts.set(p, pDetails.count);
                  allCollectedNames = [...allCollectedNames, ...pDetails.names];
                  clearInterval(checkInterval);
                  resolve();
                }
              }
            } catch (err) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 100);
        });
      }
    }

    pendingLetterUserNames = Array.from(new Set(allCollectedNames));
    isCrawlerRunning = false;
    recalculateTotalFromMap();
  }

  function recalculateTotalFromMap() {
    let sum = 0;
    for (let val of pageReadCounts.values()) sum += val;
    totalGlobalReadLetters = sum;
    updateBarNumbersOnly();
  }

  // 12. BARRA SUPERIOR
  function renderFloatingBar() {
    if (!sessionData.monitoringActive) return;

    let bar = document.getElementById('ryr-titan-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ryr-titan-bar';
      bar.style.cssText = 'position:fixed !important; top:0 !important; left:0 !important; width:100vw !important; height:38px !important; background:#0b132b !important; border-bottom:2px solid #10b981 !important; color:#ffffff !important; display:flex !important; align-items:center !important; justify-content:space-between !important; padding:0 16px !important; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif !important; font-size:12px !important; z-index:2147483647 !important; box-shadow:0 4px 15px rgba(0,0,0,0.7) !important; box-sizing:border-box !important;';

      bar.innerHTML = `
        <div class="ryr-section" style="display:flex; align-items:center; gap:10px;">
          <span class="ryr-dot" style="width:8px; height:8px; border-radius:50%; background:#10b981; display:inline-block;"></span>
          <span class="ryr-title" style="font-weight:800; color:#10b981; letter-spacing:1px;">TITAN APEX</span>
          <span class="ryr-badge primary">👤 ${sessionData.operator || 'walther'} [${sessionData.shift || 'Tarde'}]</span>
          <span class="ryr-badge">🎯 ${sessionData.profileName || 'HORACIO'}</span>
          <span class="ryr-badge ${isOperatorAfk() ? 'ryr-badge-afk' : ''}" id="ryr-badge-afk">⚡ Activo</span>
          <span class="ryr-badge" id="ryr-badge-prospecting" style="border-color:#10b981; color:#34d399;">🎯 Seguimiento: 30:00 [0/10]</span>
          <span class="ryr-badge ryr-badge-monopoly" id="ryr-badge-monopoly" style="display:none;">⚠️ Rota de Chat</span>
          <button id="ryr-btn-open-intel" class="ryr-btn-intel">🧠 Investigar Usuario</button>
        </div>
        <div class="ryr-section" style="display:flex; align-items:center; gap:10px;">
          <span class="ryr-badge green-letters" id="ryr-badge-letters">✉️ Cartas Pendientes (Read): ${totalGlobalReadLetters}</span>
          <button id="ryr-btn-disconnect" class="ryr-btn-logout">🔴 Desconectar</button>
        </div>
      `;

      document.body.prepend(bar);
      document.body.style.setProperty('margin-top', '38px', 'important');

      document.getElementById('ryr-btn-open-intel').onclick = () => {
        const panel = document.getElementById('ryr-intel-panel');
        if (panel) {
          panel.classList.toggle('open');
          loadActiveDossier();
        }
      };

      document.getElementById('ryr-btn-disconnect').onclick = () => {
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

    updateBarNumbersOnly();
  }

  function updateBarNumbersOnly() {
    const elLetters = document.getElementById('ryr-badge-letters');
    if (elLetters) elLetters.innerText = `✉️ Cartas Pendientes (Read): ${totalGlobalReadLetters}`;

    const elAfk = document.getElementById('ryr-badge-afk');
    if (elAfk) {
      const idleSec = getIdleSeconds();
      const isAfk = isOperatorAfk();
      elAfk.innerText = isAfk ? `💤 INACTIVO (${Math.floor(idleSec / 60)}m)` : `⚡ Activo`;
      elAfk.className = isAfk ? 'ryr-badge ryr-badge-afk' : 'ryr-badge';
    }

    const elProspect = document.getElementById('ryr-badge-prospecting');
    if (elProspect && hasStorageLoaded && prospectingCycleStartTime > 0) {
      const elapsed = Math.floor((Date.now() - prospectingCycleStartTime) / 1000);
      const remaining = Math.max(0, PROSPECTING_CYCLE_DURATION - elapsed);
      const min = Math.floor(remaining / 60);
      const sec = remaining % 60;
      const timeStr = `${min < 10 ? '0' : ''}${min}:${sec < 10 ? '0' : ''}${sec}`;

      const isQuotaDone = prospectingCount >= PROSPECTING_MIN_QUOTA;
      elProspect.innerText = isQuotaDone 
        ? `✅ Seguimiento OK [${prospectingCount}/${PROSPECTING_MIN_QUOTA}]` 
        : `🎯 Seguimiento: ${timeStr} [${prospectingCount}/${PROSPECTING_MIN_QUOTA}]`;
      
      elProspect.style.borderColor = isQuotaDone ? '#10b981' : '#f59e0b';
      elProspect.style.color = isQuotaDone ? '#34d399' : '#fde68a';
    }

    const elMonopoly = document.getElementById('ryr-badge-monopoly');
    if (elMonopoly) {
      if (hasChatMonopolyWarning && unattendedChatsCount > 0) {
        elMonopoly.style.display = 'inline-flex';
        elMonopoly.innerText = `⚠️ Rota de Chat (${unattendedChatsCount} en espera)`;
      } else {
        elMonopoly.style.display = 'none';
      }
    }
  }

  function removeFloatingBar() {
    const bar = document.getElementById('ryr-titan-bar');
    if (bar) bar.remove();
    document.body.style.removeProperty('margin-top');
    document.querySelectorAll('.ryr-inbox-timer, .ryr-row-extract-btn, .ryr-extract-menu').forEach(el => el.remove());
    const panel = document.getElementById('ryr-intel-panel');
    if (panel) panel.remove();
    const crawler = document.getElementById('ryr-silent-crawler');
    if (crawler) crawler.remove();
  }

  // 12. TELEMETRÍA
  let lastTelemetryTime = 0;
  function sendTelemetry(isImmediateAlert = false) {
    const now = Date.now();
    if (isImmediateAlert && now - lastTelemetryTime < 500) return;
    lastTelemetryTime = now;

    const activeTimersList = [];
    for (let [contact, startTime] of Object.entries(activeSlaTimers)) {
      const elapsed = Math.floor((now - startTime) / 1000);
      const remaining = Math.max(0, 120 - elapsed);
      activeTimersList.push({
        contact: contact.replace(/^name_/, ''),
        elapsed: elapsed,
        remaining: remaining,
        isExpired: elapsed >= 120
      });
    }

    const elapsedProspect = Math.floor((now - prospectingCycleStartTime) / 1000);
    const remainingProspect = Math.max(0, PROSPECTING_CYCLE_DURATION - elapsedProspect);

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
          count: prospectingCount,
          quota: PROSPECTING_MIN_QUOTA,
          remainingSeconds: remainingProspect,
          isCompleted: prospectingCount >= PROSPECTING_MIN_QUOTA
        },
        monopolyStatus: {
          hasMonopoly: hasChatMonopolyWarning,
          focusedClient: lastFocusedClientId,
          consecutiveSent: consecutiveMessagesSentToActiveClient,
          unattendedCount: unattendedChatsCount
        },
        isAfk: isOperatorAfk(),
        idleSeconds: getIdleSeconds(),
        timestamp: now
      })
    }).catch(() => {});
  }

  const mainLoop = setInterval(() => {
    if (!isContextValid()) {
      clearInterval(mainLoop);
      return;
    }
    if (sessionData.monitoringActive) {
      renderFloatingBar();
      enforceFirewall();
      handleInboxTimersAndExtractionButtons();
      runBackgroundPaginationCrawler();
    }
  }, 1000);

  const heartbeatLoop = setInterval(() => {
    if (!isContextValid()) {
      clearInterval(heartbeatLoop);
      return;
    }
    if (sessionData.monitoringActive) {
      sendTelemetry(false);
      syncServerKnownChats();
    }
  }, 10000);
})();
