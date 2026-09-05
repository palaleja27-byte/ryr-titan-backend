(() => {
  if (window.self !== window.top) return;

  function isContextValid() {
    return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
  }

  const API_URL = 'https://ryr-titan-backend.onrender.com';

  // 0. ESCUDO CSS INMEDIATO (0ms): OCULTA CUALQUIER LÁPIZ O ETIQUETA DRAFT EN LA LISTA LATERAL
  const draftBlockerStyle = document.createElement('style');
  draftBlockerStyle.id = 'ryr-draft-eradicator-css';
  draftBlockerStyle.innerHTML = `
    div[data-test-id*="dialog-item"] span:has(svg[class*="pencil" i]),
    div[class*="dialog-item"] span:has(svg[class*="pencil" i]),
    div[class*="item-wrap"] span:has(svg[class*="pencil" i]),
    [class*="draft" i], [class*="Draft"] {
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

  let totalGlobalReadLetters = 0;
  const pageReadCounts = new Map();
  let isCrawlerRunning = false;
  let lastCrawlerRunTime = 0;

  let lastUserInteraction = Date.now();
  const AFK_THRESHOLD_SECONDS = 300;

  let activeSlaTimers = {};
  let finedTimerKeys = new Set();
  let syncedChatsMemory = new Set();
  let seenSupervisorMessageIds = new Set();

  const PROSPECTING_MIN_QUOTA = 10;
  const PROSPECTING_CYCLE_DURATION = 1800; // 30 min
  let prospectingCycleStartTime = Date.now();
  let prospectingCount = 0;
  let cycleInteractedUsersSet = new Set();

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

  // 2. ELIMINADOR DE TEXTAREA AL CAMBIAR DE CHAT (EVITA DUPLICAR EL TEXTO EN OTRAS CLIENTAS)
  ['pointerdown', 'mousedown', 'touchstart'].forEach(evtType => {
    document.addEventListener(evtType, (e) => {
      const sidebarItem = e.target.closest('div[data-test-id*="dialog-item"], div[class*="dialog-item"], div[class*="item-wrap"], .tab-content-item');
      if (sidebarItem && !e.target.closest('.ryr-row-extract-btn')) {
        const textareas = document.querySelectorAll('textarea');
        textareas.forEach(ta => {
          if (!ta.id?.includes('intel') && !ta.id?.includes('search')) {
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

  // 3. DETECTOR DE CLICS PARA SEGUIMIENTO
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

  // 4. RECUPERAR DATOS Y CARGA BLINDADA DE STORAGE (INMUNE A F5)
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

        if (data.prospectingCycleStartTime) prospectingCycleStartTime = data.prospectingCycleStartTime;
        if (data.prospectingCount) prospectingCount = data.prospectingCount;
        if (Array.isArray(data.cycleInteractedUsersList)) {
          data.cycleInteractedUsersList.forEach(id => cycleInteractedUsersSet.add(id));
        }

        if (data.monitoringActive) {
          sessionData = {
            operator: data.operator || 'walther',
            shift: data.shift || 'Mañana',
            profileName: data.profileName || 'HORACIO',
            profileId: data.profileId || '118179794',
            monitoringActive: true
          };
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

  // 5. REVISAR MENSAJES DIRECTOS DEL SUPERVISOR EN TIEMPO REAL
  async function checkSupervisorDirectMessages() {
    if (!sessionData.operator) return;
    try {
      const res = await fetch(`${API_URL}/api/supervisor/messages/${sessionData.operator}`);
      const data = await res.json();
      if (data && Array.isArray(data.messages)) {
        const unreadSupMessages = data.messages.filter(m => m.sender === 'SUPERVISOR' && !seenSupervisorMessageIds.has(m.id));
        if (unreadSupMessages.length > 0) {
          const latest = unreadSupMessages[unreadSupMessages.length - 1];
          showSupervisorDirectBanner(latest.text, latest.id);
        }
      }
    } catch (e) {}
  }

  // NOTIFICACIÓN DEL SUPERVISOR GLASSMORPHISM TRANSLÚCIDA
  function showSupervisorDirectBanner(text, messageId) {
    const existing = document.getElementById('ryr-supervisor-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'ryr-supervisor-banner';
    banner.style.cssText = `
      position: fixed;
      top: 48px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(15, 23, 42, 0.72);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(168, 85, 247, 0.4);
      color: #ffffff;
      padding: 14px 18px;
      border-radius: 12px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 12px;
      z-index: 2147483647;
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.1);
      display: flex;
      flex-direction: column;
      gap: 10px;
      width: 420px;
      max-width: 95%;
    `;

    banner.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-weight:900; color:#00ffcc; letter-spacing:0.5px;">📢 MENSAJE DEL SUPERVISOR:</span>
        <span id="btn-close-sup-banner" style="cursor:pointer; font-size:16px; color:#94a3b8; line-height:1;">✕</span>
      </div>
      <div style="font-size:12px; line-height:1.4; color:#fde68a; font-weight:500;">
        ${text}
      </div>
      <div style="display:flex; gap:6px;">
        <input type="text" id="input-reply-sup" placeholder="Escribe tu respuesta al supervisor..." style="flex:1; padding:7px 10px; background:rgba(6,9,19,0.65); border:1px solid rgba(58,80,107,0.7); color:#fff; border-radius:6px; font-size:11px; outline:none;">
        <button id="btn-reply-sup" style="background:#8b5cf6; color:#060913; border:none; padding:7px 14px; border-radius:6px; font-weight:bold; cursor:pointer; font-size:11px;">Responder</button>
      </div>
    `;

    document.body.appendChild(banner);

    document.getElementById('btn-close-sup-banner').onclick = () => {
      seenSupervisorMessageIds.add(messageId);
      persistSeenSupervisorMessages();
      banner.remove();
    };

    document.getElementById('btn-reply-sup').onclick = async () => {
      const input = document.getElementById('input-reply-sup');
      const replyText = input.value.trim();
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
      } catch (e) {
        banner.remove();
      }
    };
  }

  // 6. EVALUADOR DEL CICLO DE SEGUIMIENTO (30 MINUTOS)
  function evaluateProspectingCycle() {
    const elapsed = Math.floor((Date.now() - prospectingCycleStartTime) / 1000);
    const remaining = Math.max(0, PROSPECTING_CYCLE_DURATION - elapsed);

    if (elapsed >= PROSPECTING_CYCLE_DURATION) {
      prospectingCycleStartTime = Date.now();
      prospectingCount = 0;
      cycleInteractedUsersSet.clear();
      persistProspectingState();
    }

    if (prospectingCount < PROSPECTING_MIN_QUOTA && (remaining === 300 || remaining === 180)) {
      showNonInvasiveTrackingToast(Math.floor(remaining / 60), prospectingCount, PROSPECTING_MIN_QUOTA);
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

  function showNonInvasiveTrackingToast(remainingMinutes, count, quota) {
    const toastId = 'ryr-tracking-toast';
    if (document.getElementById(toastId)) return;

    const toast = document.createElement('div');
    toast.id = toastId;
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: rgba(30, 27, 75, 0.9);
      backdrop-filter: blur(12px);
      border: 2px solid #8b5cf6;
      color: #f87171;
      padding: 12px 16px;
      border-radius: 8px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 12px;
      z-index: 2147483647;
      box-shadow: 0 8px 30px rgba(0,0,0,0.75);
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-width: 320px;
    `;

    toast.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-weight:900; color:#00ffcc;">🎯 RECORDATORIO DE SEGUIMIENTO</span>
        <span style="cursor:pointer; font-size:14px; color:#94a3b8;" onclick="this.parentElement.parentElement.remove()">✕</span>
      </div>
      <div>
        Te quedan <b>${remainingMinutes} minutos</b> para completar tu cuota de tráfico (<b>${count}/${quota}</b>).
      </div>
      <div style="font-size:11px; color:#fde68a;">
        💡 <i>Recuerda usar los filtros de búsqueda por países en Search para atraer usuarias de varios países.</i>
      </div>
      <a href="https://talkytimes.com/search" style="background:#8b5cf6; color:#060913; text-align:center; padding:6px; border-radius:4px; font-weight:bold; text-decoration:none; font-size:11px; margin-top:2px;">
        🔍 Ir a Search y Filtrar Países
      </a>
    `;

    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 12000);
  }

  // 7. SINCRONIZACIÓN CON EL SERVIDOR
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

  // 8. FIREWALL 100% BLINDADO
  function checkViolationInText(text) {
    const lower = text.toLowerCase();
    return bannedRoots.some(root => lower.includes(root.toLowerCase()));
  }

  function enforceFirewall() {
    const inputs = document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]');
    let anyViolation = false;

    inputs.forEach(input => {
      if (input.id?.includes('intel') || input.id?.includes('search')) return;
      
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

    const sendButtons = document.querySelectorAll('button, [role="button"], div[class*="send"]');
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

  // 9. EXTRACTOR EXACTO DE NOMBRE Y DATOS
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
      clientName: clientName || 'Ka, 51',
      bioData: {
        country: country || 'Brazil',
        birthDate: birthDate ? `${birthDate} (${ageText || '51 años'})` : 'En perfil',
        maritalStatus: maritalStatus || 'Not married / Soltera'
      }
    };
  }

  function getExactNumericClientId(targetUrl = window.location.href) {
    const chatMatch = targetUrl.match(/chat\/\d+_(\d+)/);
    if (chatMatch) return String(chatMatch[1]).trim();
    const mailMatch = targetUrl.match(/mails\/view\/\d+_(\d+)/);
    if (mailMatch) return String(mailMatch[1]).trim();
    const userMatch = targetUrl.match(/user\/(\d+)/);
    if (userMatch) return String(userMatch[1]).trim();
    return '119678157';
  }

  // 10. RECOLECTOR BIDIRECCIONAL COMPLETO
  function parseCurrentChatMessagesBidirectional(realClientName) {
    const messages = [];
    const seenSignatures = new Set();

    const chatView = document.querySelector('div[class*="dialog-content"], div[class*="chat-scroll"], div[class*="main-chat"], div[class*="messages"]') || document.body;
    const allLeafElements = chatView.querySelectorAll('div, p');

    allLeafElements.forEach(node => {
      if (node.querySelectorAll('div, p').length > 2) return;

      const raw = node.innerText || '';
      if (raw.includes('TITAN APEX') || raw.includes('Search') || (raw.includes('seen') && raw.length < 10) || raw.includes('View post')) return;

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
      const signature = `${isOperator ? 'OP' : 'USER'}_${cleanText.substring(0, 40)}`;

      if (!seenSignatures.has(signature)) {
        seenSignatures.add(signature);
        messages.push({
          isOperator: Boolean(isOperator),
          senderName: isOperator ? (sessionData.profileName || 'HORACIO') : realClientName,
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
      `- **Operador:** ${sessionData.operator || 'walther'} [${sessionData.shift || 'Mañana'}]`,
      `- **Perfil Asignado:** ${sessionData.profileName || 'HORACIO'} (ID: ${sessionData.profileId || '118179794'})`,
      `- **Cliente:** ${clientName}`,
      `- **ID del Usuario:** ${clientId}`,
      `- **Ubicación:** ${bioData?.country || 'Brazil'} | **Nacimiento:** ${bioData?.birthDate || '51 años'}`,
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
    const finalClientName = (clientNameParam && !['Search', 'Cliente'].includes(clientNameParam)) ? sanitizeClientName(clientNameParam) : clientName;

    if (btnElement) btnElement.innerText = '⏳';

    const messages = parseCurrentChatMessagesBidirectional(finalClientName);
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
      if (btnElement) {
        btnElement.style.setProperty('background', '#1d4ed8', 'important');
        btnElement.style.setProperty('color', '#ffffff', 'important');
        btnElement.innerText = '⚡';
      }
    }
  }

  // 11. CONTROL DE FILAS Y CANDADO ESTRICTO DE 💬 0 (SIN CRONÓMETRO SI NO HAY MENSAJES)
  function handleInboxTimersAndExtractionButtons() {
    if (!isStorageLoaded) return;

    // Detectar 💬 0 en la cabecera activa
    const activeHeader = document.querySelector('div[data-test-id="dialog-header-title"], div[class*="dialog-header"], div[class*="chat-header"]');
    const activeHeaderText = activeHeader ? activeHeader.innerText : '';
    const openChatHasZeroCredits = /💬\s*0\b/i.test(activeHeaderText);

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
      const userLink = row.querySelector('a[href*="/chat/"], a[href*="/user/"]');
      if (userLink) {
        const href = userLink.getAttribute('href');
        rowNumericId = getExactNumericClientId(href);
      }

      row.style.position = 'relative';

      const nameKey = `name_${cleanSimpleName.replace(/[^a-z0-9]/g, '')}`;
      const idKey = (rowNumericId && rowNumericId !== 'N/A') ? `id_${rowNumericId}` : null;

      // Purga de borradores
      const allTextNodes = row.querySelectorAll('span, div, p, b');
      allTextNodes.forEach(el => {
        if (el.children.length === 0 && el.textContent.toLowerCase().includes('draft:')) {
          el.textContent = '';
          el.style.setProperty('display', 'none', 'important');
          if (el.parentElement) el.parentElement.style.setProperty('display', 'none', 'important');
        }
      });

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
            <button id="btn-opt-full">📜 Historial Completo (Día 1)</button>
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
        btnExtract.innerText = '⚡';
      } else {
        btnExtract.style.setProperty('background', '#1d4ed8', 'important');
        btnExtract.style.setProperty('color', '#ffffff', 'important');
        btnExtract.style.setProperty('border', '1px solid #60a5fa', 'important');
        btnExtract.innerText = '⚡';
      }

      // EVALUACIÓN DE TEMPORIZADOR
      const hasOperatorSent = /(?:you|tú|tu|você)\s*:/i.test(fullText) || 
                              row.querySelector('svg[class*="check"]') !== null ||
                              fullText.includes('✔');

      const isTyping = fullText.toLowerCase().includes('typing') || row.querySelector('[class*="typing"]');
      const isLiked = fullText.toLowerCase().includes('liked');

      // CANDADO: Si la clienta tiene 💬 0 (como Ka, 51), NO poner cronómetro
      const isThisActiveChatZero = openChatHasZeroCredits && (rowNumericId === openChatNumericId || cleanSimpleName === openChatCleanName);
      const hasZeroMessagesInRow = /💬\s*0\b/i.test(fullText);

      const isPendingClientMessage = (!hasOperatorSent && !isThisActiveChatZero && !hasZeroMessagesInRow) || isTyping || isLiked;

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

      // RECUPERAR TIMESTAMP INMUTABLE
      let existingTimestamp = activeSlaTimers[nameKey] || (idKey ? activeSlaTimers[idKey] : null);

      if (!existingTimestamp) {
        existingTimestamp = Date.now();
        activeSlaTimers[nameKey] = existingTimestamp;
        if (idKey) activeSlaTimers[idKey] = existingTimestamp;
        persistTimersToStorage();
      } else {
        activeSlaTimers[nameKey] = existingTimestamp;
        if (idKey) activeSlaTimers[idKey] = existingTimestamp;
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
  }

  async function triggerAutomaticFine(clientName, clientId) {
    showFineAlertBanner(clientName);
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

  function showFineAlertBanner(clientName) {
    const existing = document.getElementById('ryr-fine-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'ryr-fine-toast';
    toast.style.cssText = 'position:fixed; bottom:20px; left:20px; background:#450a0a; border:2px solid #ef4444; color:#f87171; padding:12px 18px; border-radius:8px; font-weight:bold; font-size:13px; z-index:2147483647; box-shadow:0 6px 25px rgba(239,68,68,0.6); animation:ryr-pulse 1s infinite; font-family:system-ui,sans-serif;';
    toast.innerHTML = `🚨 MULTA DE $10.000 COP GENERADA<br><span style="font-size:11px; color:#fca5a5; font-weight:normal;">Superaste los 2 minutos sin responder a <b>${clientName}</b>.</span>`;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 8000);
  }

  // 12. PANEL DE INTELIGENCIA DE USUARIOS
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
          <div class="chat-bubble-ai">👋 ¡Hola! Soy tu Co-Piloto. Pregúntame sobre la clienta o pídeme mensajes de ataque y conquista personalizados.</div>
        </div>
      </div>
      <div class="intel-input-box">
        <input type="text" id="input-intel-query" placeholder="Pregunta algo o pide un mensaje...">
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
    aiBubble.innerText = '🤖 Analizando en tiempo real...';
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

    box.innerHTML = `
      <div style="font-weight:bold; color:#00ffcc; margin-bottom:4px;">👤 ${clientName} (ID: ${clientId})</div>
      <div>📍 <b>Ubicación:</b> ${bioData.country}</div>
      <div>🎂 <b>Nacimiento:</b> ${bioData.birthDate}</div>
      <div>💍 <b>Estado Civil:</b> ${bioData.maritalStatus}</div>
    `;
  }

  // 13. CRAWLER DE ACTIVE LIMITS (SOLO CARTAS READ)
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
        const txt = el.innerText.trim().toLowerCase();
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

    const paginationLinks = document.querySelectorAll('ul.pagination li a, ul.pagination li button, .pagination a, [class*="pagination"] a, [class*="pagination"] button');
    let maxPage = 1;

    paginationLinks.forEach(el => {
      const txt = el.innerText.trim();
      if (/^\d+$/.test(txt)) {
        const num = parseInt(txt, 10);
        if (num > maxPage && num <= 30) {
          maxPage = num;
        }
      }
    });

    if (maxPage <= 1) {
      totalGlobalReadLetters = currentDetails.count;
      renderFloatingBar();
      return;
    }

    const now = Date.now();
    if (isCrawlerRunning || (now - lastCrawlerRunTime < 20000)) {
      renderFloatingBar();
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
                if (rows.length > 0 || attempts >= 15) {
                  const pDetails = countReadInDocument(iframeDoc);
                  pageReadCountsMap.set(p, pDetails.count);
                  clearInterval(checkInterval);
                  resolve();
                }
              }
            } catch (err) {}
            if (attempts >= 15) {
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
  }

  // 14. BARRA SUPERIOR
  function renderFloatingBar() {
    let bar = document.getElementById('ryr-titan-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ryr-titan-bar';
      document.body.prepend(bar);
    }

    document.body.style.setProperty('margin-top', '38px', 'important');
    bar.style.setProperty('z-index', '2147483647', 'important');

    const idleSec = getIdleSeconds();
    const isAfk = isOperatorAfk();
    const afkText = isAfk ? `💤 INACTIVO (${Math.floor(idleSec / 60)}m)` : `⚡ Activo`;
    const afkClass = isAfk ? 'ryr-badge-afk' : 'primary';

    const prospect = evaluateProspectingCycle();
    const prospectClass = prospect.isCompleted ? 'green-letters' : 'primary';
    const prospectTimeText = prospect.isCompleted ? 'OK' : prospect.formattedTime;

    bar.innerHTML = `
      <div class="ryr-section">
        <span class="ryr-dot"></span>
        <span class="ryr-title">TITAN APEX</span>
        <span class="ryr-badge primary">👤 ${sessionData.operator || 'walther'} [${sessionData.shift || 'Mañana'}]</span>
        <span class="ryr-badge">🎯 ${sessionData.profileName || 'HORACIO'}</span>
        <span class="ryr-badge ${afkClass}">${afkText}</span>
        <span class="ryr-badge ${prospectClass}">🎯 Seguimiento: ${prospectTimeText} [${prospect.count}/${prospect.quota}]</span>
        <button id="ryr-btn-open-intel" class="ryr-btn-intel">🧠 Investigar Usuario</button>
      </div>
      <div class="ryr-section">
        <span class="ryr-badge green-letters">✉️ Cartas Pendientes (Read): ${totalGlobalReadLetters}</span>
        <button id="ryr-btn-disconnect" class="ryr-btn-logout">🔴 Desconectar</button>
      </div>
    `;

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

  // 15. TELEMETRÍA (SEGUNDEROS DE CHATS EN VIVO CON AUTO-PURGA DE VENCIDOS)
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
      checkSupervisorDirectMessages();
    }
  }, 2500);
})();
