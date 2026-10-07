// RYR TITAN APEX - SERVICE WORKER

// Escuchar cuando la extensión se instala o actualiza
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    console.log("🚀 RYR TITAN APEX instalado con éxito.");
    // Inicializar valores por defecto
    chrome.storage.local.set({
      monitoringActive: false,
      activeSlaTimers: {},
      syncedChatsList: []
    });
  }
});

// Mantener el worker despierto para procesos críticos
chrome.runtime.onConnect.addListener((port) => {
  console.log("🔌 Canal de comunicación activo.");
});

// Listener para mensajes si se requiere comunicación entre scripts (Opcional en nuestro modelo de Storage)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "checkStatus") {
    sendResponse({ status: "alive" });
  }
  return true;
});