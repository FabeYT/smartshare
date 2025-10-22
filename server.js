const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;

// Cluster für Skalierung
if (cluster.isMaster && process.env.NODE_ENV !== 'development') {
  //console.log(`🏗️  Master ${process.pid} is running`);
  
  // Fork workers
  for (let i = 0; i < Math.min(numCPUs, 4); i++) {
    cluster.fork();
  }
  
  cluster.on('exit', (worker, code, signal) => {
    console.log(`❌ Worker ${worker.process.pid} died. Forking new worker...`);
    cluster.fork();
  });
  
  return;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false
});

// Erweiterte Middleware
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: false
}));

app.use(express.json({ 
  limit: '100mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.use(express.urlencoded({ 
  extended: true, 
  limit: '100mb' 
}));

// KORRIGIERTE Datei-Upload Konfiguration mit Verzeichnis-Prüfung
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Stelle sicher, dass Upload-Verzeichnis existiert
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log(`✅ Upload-Verzeichnis erstellt: ${UPLOAD_DIR}`);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Bereinige alte Dateien
    cleanupOldFiles(UPLOAD_DIR);
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const safeFileName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + safeFileName);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 50
  },
  fileFilter: (req, file, cb) => {
    const dangerousExtensions = ['.exe', '.bat', '.cmd', '.sh', '.php', '.js', '.jar'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    
    if (dangerousExtensions.includes(fileExtension)) {
      return cb(new Error('Dateityp nicht erlaubt'), false);
    }
    
    const allowedMimes = [
      'image/', 'video/', 'audio/', 'text/', 'application/pdf',
      'application/msword', 'application/vnd.openxmlformats-officedocument.',
      'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
      'application/zip', 'application/x-rar-compressed'
    ];
    
    const isAllowed = allowedMimes.some(mime => file.mimetype.startsWith(mime));
    if (!isAllowed) {
      return cb(new Error('Dateityp nicht unterstützt'), false);
    }
    
    cb(null, true);
  }
});

// Memory Management
const activeConnections = new Map();
// Globale Variablen für Connection Management
let connectionIntervals = new Map();

const MEMORY_LIMITS = {
    MAX_MEMORY_USAGE: 500 * 1024 * 1024, // 500MB Hard Limit
    WARNING_THRESHOLD: 400 * 1024 * 1024, // 400MB Warning
    CHUNK_SIZE: 20 * 1024 * 1024,
    MAX_CONCURRENT_TRANSFERS: 5
};

function updateMemoryUsage(delta) {
  currentMemoryUsage += delta;
  
  if (currentMemoryUsage > MAX_MEMORY_USAGE) {
    cleanupMemory();
  }
}

function cleanupMemory() {
  const now = Date.now();
  const memoryTimeout = 5 * 60 * 1000;
  
  fileTransfers.forEach((transfer, transferId) => {
    if (now - transfer.timestamp > memoryTimeout) {
      if (transfer.chunks) {
        updateMemoryUsage(-transfer.totalSize);
      }
      fileTransfers.delete(transferId);
    }
  });
  
  console.log(`🧹 Memory bereinigt. Aktuelle Nutzung: ${formatFileSize(currentMemoryUsage)}`);
}

let currentMemoryUsage = 0;
let activeTransferCount = 0;

function checkMemoryUsage() {
    const usage = process.memoryUsage();
    const realUsage = usage.heapUsed + usage.external;
    
    if (realUsage > MEMORY_LIMITS.MAX_MEMORY_USAGE) {
        console.error('🚨 CRITICAL: Memory limit exceeded - rejecting new connections');
        return false;
    }
    
    if (realUsage > MEMORY_LIMITS.WARNING_THRESHOLD) {
        console.warn('⚠️ WARNING: High memory usage -', formatFileSize(realUsage));
        cleanupMemory();
    }
    
    return true;
}




function emergencyCleanup() {
  // Sofortige Bereinigung bei kritischem Memory
  const transferIds = Array.from(fileTransfers.keys());
  transferIds.slice(5).forEach(transferId => { // Behalte nur 5 neueste
    const transfer = fileTransfers.get(transferId);
    if (transfer && transfer.chunks) {
      updateMemoryUsage(-transfer.totalSize);
    }
    fileTransfers.delete(transferId);
  });
  
  // Schließe inaktive Verbindungen
  activeConnections.forEach((info, ws) => {
    if (ws.readyState === WebSocket.OPEN && Date.now() - info.lastActivity > 30000) {
      ws.close(1000, 'Memory cleanup');
    }
  });
}



// Erweiterte Raum- und Geräteverwaltung
const rooms = new Map();
const devices = new Map();
const connections = new Map();
const fileTransfers = new Map();

// Verbesserte persistente Speicherung
const DATA_DIR = path.join(__dirname, 'data');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

// Stelle sicher, dass Datenverzeichnis existiert
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Korrigierte Ladefunktionen mit besserer Fehlerbehandlung
function loadDevices() {
  try {
    if (fs.existsSync(DEVICES_FILE)) {
      const data = fs.readFileSync(DEVICES_FILE, 'utf8').trim();
      if (data) {
        const devicesData = JSON.parse(data);
        devicesData.forEach(device => {
          device.online = false;
          device.ws = null;
          device.lastSeen = new Date(device.lastSeen);
          devices.set(device.id, device);
        });
        console.log(`✅ ${devicesData.length} gespeicherte Geräte geladen`);
      } else {
        //console.log('ℹ️  Devices file is empty');
      }
    }
  } catch (error) {
    console.error('❌ Fehler beim Laden der Geräte:', error);
    // Erstelle leere Datei falls beschädigt
    try {
      fs.writeFileSync(DEVICES_FILE, JSON.stringify([]));
      console.log('✅ Neue devices.json Datei erstellt');
    } catch (writeError) {
      console.error('❌ Fehler beim Erstellen der devices.json:', writeError);
    }
  }
}

function saveDevices() {
  try {
    const devicesToSave = Array.from(devices.values()).map(device => ({
      id: device.id,
      name: device.name,
      type: device.type,
      platform: device.platform,
      browser: device.browser,
      userAgent: device.userAgent,
      pinned: device.pinned || false,
      lastSeen: device.lastSeen,
      roomId: device.roomId,
      customName: device.customName,
      online: false
    }));
    
    // Verwende writeFile statt writeFileSync für bessere Fehlerbehandlung
    fs.writeFile(DEVICES_FILE, JSON.stringify(devicesToSave, null, 2), (err) => {
      if (err) {
        if (err.code === 'EBUSY') {
          console.log('⚠️ Gerätedatei temporär gesperrt, versuche später erneut...');
          // Versuche in 2 Sekunden erneut
          setTimeout(saveDevices, 2000);
        } else {
          console.error('❌ Fehler beim Speichern der Geräte:', err);
        }
      } else {
        console.log('✅ Geräte erfolgreich gespeichert');
      }
    });
  } catch (error) {
    console.error('❌ Unerwarteter Fehler in saveDevices:', error);
  }
}

function loadRooms() {
  try {
    if (fs.existsSync(ROOMS_FILE)) {
      const data = fs.readFileSync(ROOMS_FILE, 'utf8').trim();
      if (data) {
        const roomsData = JSON.parse(data);
        roomsData.forEach(room => {
          room.devices = new Set(room.devices);
          room.created = new Date(room.created);
          rooms.set(room.id, room);
        });
        console.log(`✅ ${roomsData.length} gespeicherte Räume geladen`);
      } else {
        console.log('ℹ️  Rooms file is empty');
      }
    }
  } catch (error) {
    console.error('❌ Fehler beim Laden der Räume:', error);
    // Erstelle leere Datei falls beschädigt
    try {
      fs.writeFileSync(ROOMS_FILE, JSON.stringify([]));
      console.log('✅ Neue rooms.json Datei erstellt');
    } catch (writeError) {
      console.error('❌ Fehler beim Erstellen der rooms.json:', writeError);
    }
  }
}

function saveRooms() {
  try {
    const roomsToSave = Array.from(rooms.values()).map(room => ({
      id: room.id,
      name: room.name,
      created: room.created,
      createdBy: room.createdBy,
      devices: Array.from(room.devices)
    }));
    
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(roomsToSave, null, 2));
  } catch (error) {
    console.error('❌ Fehler beim Speichern der Räume:', error);
  }
}

// Lade Daten beim Start
loadDevices();
loadRooms();

function detectPlatform(userAgent) {
    const ua = userAgent.toLowerCase();
    
    let platform = 'Unknown';
    let browser = 'Unknown';
    
    // Zuerst Mobile Geräte erkennen
    if (ua.includes('iphone') || ua.includes('ipod')) {
        platform = 'iOS';
    } else if (ua.includes('ipad')) {
        platform = 'iPadOS';
    } else if (ua.includes('android')) {
        platform = 'Android';
    } else if (ua.includes('windows')) {
        platform = 'Windows';
    } else if (ua.includes('mac os') || ua.includes('macos')) {
        platform = 'macOS';
    } else if (ua.includes('linux')) {
        platform = 'Linux';
    }
    
    // Verbesserte Browser-Erkennung
    if (ua.includes('safari') && !ua.includes('chrome') && !ua.includes('crios')) {
        browser = 'Safari';
    } else if (ua.includes('chrome') && !ua.includes('edg')) {
        browser = 'Chrome';
    } else if (ua.includes('firefox')) {
        browser = 'Firefox';
    } else if (ua.includes('edge')) {
        browser = 'Edge';
    } else if (ua.includes('opera')) {
        browser = 'Opera';
    } else if (ua.includes('samsung')) {
        browser = 'Samsung Internet';
    }
    
    return { platform, browser };
}

// Verbessere die Browser-Erkennung:
function detectBrowser(userAgent) {
  const ua = userAgent.toLowerCase();
  if (ua.includes('chrome') && !ua.includes('edg')) return 'Chrome';
  else if (ua.includes('firefox')) return 'Firefox';
  else if (ua.includes('safari') && !ua.includes('chrome')) return 'Safari';
  else if (ua.includes('edge')) return 'Edge';
  else if (ua.includes('opera')) return 'Opera';
  else if (ua.includes('samsung')) return 'Samsung Internet';
  return 'Unbekannt';
}

function generateStableDeviceId(userAgent, req) {
    // Vereinfachte Device-ID für bessere Stabilität
    const ua = userAgent.toLowerCase();
    const isIOS = ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod');
    
    if (isIOS) {
        // Für iOS: Vereinfachte ID ohne IP für bessere Stabilität
        const seed = userAgent + (req.headers['accept-language'] || '');
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
            const char = seed.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return 'ios-' + Math.abs(hash).toString(36);
    } else {
        // Normale Logik für andere Geräte
        const ip = req.headers['x-forwarded-for'] || 
                 req.connection.remoteAddress || 
                 req.socket.remoteAddress ||
                 (req.connection.socket ? req.connection.socket.remoteAddress : null);
        
        const seed = userAgent + (ip || '') + (req.headers['accept-language'] || '');
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
            const char = seed.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return 'device-' + Math.abs(hash).toString(36);
    }
}

wss.on('connection', (ws, req) => {
    const userAgent = req.headers['user-agent'] || 'Unbekannt';
    const { platform, browser } = detectPlatform(userAgent);
    const deviceId = generateStableDeviceId(userAgent, req);
    
    // Safari-spezifische Optimierungen
    const isIOS = /iPhone|iPad|iPod/.test(userAgent);
    const isSafari = browser === 'Safari';
    
    console.log(`📱 Neue Verbindung: ${deviceId}`);
    console.log(`   🔍 Erkannt als: ${platform} - ${browser}`);
    console.log(`   🌐 IP: ${req.socket.remoteAddress}`);
    console.log(`   🍎 iOS Safari: ${isIOS && isSafari ? 'Ja' : 'Nein'}`);
    
    // SOFORTIGE Welcome-Nachricht für iOS Safari
    if (isIOS && isSafari) {
        console.log('📱 iOS Safari erkannt - aktiviere Sofort-Modus');
        
        // Sofortige Welcome-Nachricht senden (nicht warten)
        const welcomeMsg = JSON.stringify({
            type: 'welcome',
            deviceId: deviceId,
            serverInfo: {
                maxFileSize: '500MB',
                chunkSize: '1MB', // Kleinere Chunks für iOS Stabilität
                supportsProgress: true,
                browser: 'safari',
                platform: 'ios',
                safariOptimized: true,
                connection: 'instant'
            },
            timestamp: Date.now()
        });
        
        try {
            ws.send(welcomeMsg);
            console.log('✅ Sofort-Welcome an iOS Safari gesendet');
        } catch (e) {
            console.log('⚠️ Sofort-Welcome fehlgeschlagen, wird später erneut versucht');
        }
    }
    
    // Memory Management
    activeConnections.set(ws, {
        deviceId,
        connectedAt: Date.now(),
        lastActivity: Date.now(),
        userAgent: userAgent,
        platform: platform,
        browser: browser,
        ip: req.socket.remoteAddress,
        isIOS: isIOS && isSafari
    });
    
    // Prüfe ob Gerät bereits bekannt ist
    const existingDevice = devices.get(deviceId);
    
    if (existingDevice) {
        existingDevice.ws = ws;
        existingDevice.online = true;
        existingDevice.lastSeen = new Date();
        existingDevice.userAgent = userAgent;
        existingDevice.platform = platform;
        existingDevice.browser = browser;
        existingDevice.ip = req.socket.remoteAddress;
        console.log(`🔄 Bekanntes Gerät wieder verbunden: ${existingDevice.name}`);
    } else {
        const deviceName = generateDeviceName(platform, browser);
        
        devices.set(deviceId, {
            id: deviceId,
            ws: ws,
            name: deviceName,
            customName: null,
            type: getDeviceType(platform),
            platform: platform,
            browser: browser,
            userAgent: userAgent,
            pinned: false,
            online: true,
            lastSeen: new Date(),
            roomId: null,
            connectionStrength: 'good',
            ip: req.socket.remoteAddress
        });
        
        console.log(`🆕 Neues Gerät registriert: ${deviceName}`);
    }
    
    connections.set(ws, deviceId);
    
    // Normale Welcome-Nachricht für alle Geräte (außer iOS Safari - die haben schon eine)
    if (!(isIOS && isSafari)) {
        setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'welcome',
                    deviceId: deviceId,
                    serverInfo: {
                        maxFileSize: '500MB',
                        chunkSize: '20MB',
                        supportsProgress: true,
                        browser: browser.toLowerCase(),
                        platform: platform.toLowerCase(),
                        serverVersion: '2.0.0'
                    },
                    timestamp: Date.now()
                }));
            }
        }, 100);
    }
    
    // Nachrichten verarbeiten mit iOS Safari Optimierungen
    ws.on('message', (message) => {
        try {
            const connectionInfo = activeConnections.get(ws);
            if (connectionInfo) {
                connectionInfo.lastActivity = Date.now();
            }
            
            const data = JSON.parse(message);
            handleMessage(deviceId, data);
            
        } catch (error) {
            console.error('❌ Fehler beim Verarbeiten der Nachricht:', error);
            
            // Vereinfachte Fehlermeldung für iOS Safari
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Nachrichtenfehler'
                }));
            }
        }
    });
    
    // Verbesserte Verbindungsüberwachung für iOS
    ws.on('close', (code, reason) => {
        console.log(`🔌 Verbindung geschlossen: ${deviceId} (${platform}-${browser})`);
        
        const connectionInfo = activeConnections.get(ws);
        if (connectionInfo && connectionInfo.isIOS) {
            console.log('📱 iOS Verbindung geschlossen - spezielle Protokollierung');
        }
        
        // Gerät als offline markieren
        const device = devices.get(deviceId);
        if (device) {
            device.online = false;
            device.lastSeen = new Date();
            device.ws = null;
            
            // Raum-Benachrichtigungen
            if (device.roomId) {
                const room = rooms.get(device.roomId);
                if (room) {
                    broadcastToRoom(device.roomId, {
                        type: 'deviceLeft',
                        deviceId: device.id,
                        deviceName: device.customName || device.name,
                        deviceCount: room.devices.size - 1,
                        reason: 'Verbindung getrennt'
                    }, device.id);
                    
                    broadcastDeviceList(device.roomId);
                }
            }
        }
        
        // Cleanup
        activeConnections.delete(ws);
        connections.delete(ws);
        saveDevices();
    });
    
    ws.on('error', (error) => {
        console.error('❌ WebSocket Fehler:', {
            deviceId: deviceId,
            error: error.message,
            browser: browser,
            platform: platform
        });
    });
    
    // Verbesserter Heartbeat für iOS
    setupIOSHeartbeat(ws, deviceId, isIOS && isSafari);
});


function setupIOSHeartbeat(ws, deviceId, isIOS) {
    if (!isIOS) return;
    
    console.log('❤️ Aktiviere iOS-spezifischen Heartbeat');
    
    const heartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify({
                    type: 'ping',
                    timestamp: Date.now(),
                    ios_heartbeat: true
                }));
            } catch (error) {
                console.log('⚠️ iOS Heartbeat fehlgeschlagen');
                clearInterval(heartbeatInterval);
            }
        } else {
            clearInterval(heartbeatInterval);
        }
    }, 10000); // 10 Sekunden für iOS
    
    // Cleanup bei Verbindungsende
    ws.on('close', () => {
        clearInterval(heartbeatInterval);
    });
    
    ws.on('error', () => {
        clearInterval(heartbeatInterval);
    });
}

// SPEZIELLE iOS STABILITÄTS-ROUTES
app.get('/api/ios-health', (req, res) => {
    res.json({
        status: 'ok',
        server: 'active',
        timestamp: Date.now(),
        ios_support: true,
        websocket_port: process.env.PORT || 5000
    });
});

app.post('/api/ios-reconnect', (req, res) => {
    res.json({
        status: 'ready',
        message: 'Server bereit für Reconnect',
        session_support: true
    });
});

// Safari-spezifischer Endpoint für Verbindungstests
app.get('/api/safari-check', (req, res) => {
  res.json({
    status: 'ok',
    browser: 'safari',
    supportsWebSockets: true,
    timestamp: new Date().toISOString(),
    serverVersion: '2.0.0-safari'
  });
});

function checkForDuplicateConnections(deviceId, currentWs) {
    let duplicateFound = false;
    
    connections.forEach((existingDeviceId, existingWs) => {
        if (existingDeviceId === deviceId && existingWs !== currentWs) {
            console.log(`🔄 Doppelte Verbindung erkannt für Gerät: ${deviceId}`);
            
            // Schließe die ältere Verbindung
            if (existingWs.readyState === WebSocket.OPEN) {
                existingWs.send(JSON.stringify({
                    type: 'duplicate_connection',
                    message: 'Neue Verbindung erkannt - diese Verbindung wird geschlossen',
                    keepThisConnection: false
                }));
                
                setTimeout(() => {
                    if (existingWs.readyState === WebSocket.OPEN) {
                        existingWs.close(1000, 'Duplicate connection - newer connection available');
                    }
                }, 1000);
            }
            
            duplicateFound = true;
        }
    });
    
    if (duplicateFound) {
        // Benachrichtige die neue Verbindung
        if (currentWs.readyState === WebSocket.OPEN) {
            currentWs.send(JSON.stringify({
                type: 'duplicate_connection',
                message: 'Ältere Verbindung wurde geschlossen',
                keepThisConnection: true
            }));
        }
    }
}


function setupConnectionHeartbeat(ws, deviceId) {
    const heartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            const device = devices.get(deviceId);
            if (device && device.online) {
                // Prüfe auf Inaktivität
                const connectionInfo = activeConnections.get(ws);
                if (connectionInfo && (Date.now() - connectionInfo.lastActivity) > 30000) {
                    // Sende Ping bei Inaktivität
                    ws.send(JSON.stringify({
                        type: 'ping',
                        timestamp: Date.now()
                    }));
                }
            }
        } else {
            // Verbindung geschlossen - Interval bereinigen
            clearInterval(heartbeatInterval);
        }
    }, 15000);
    
    // Interval für Cleanup speichern
    if (!connectionIntervals) connectionIntervals = new Map();
    connectionIntervals.set(ws, heartbeatInterval);
    
    // Cleanup bei Verbindungsende
    ws.on('close', () => {
        const interval = connectionIntervals.get(ws);
        if (interval) {
            clearInterval(interval);
            connectionIntervals.delete(ws);
        }
    });
}


// CORS für Safari verbessern
app.use((req, res, next) => {
  const userAgent = req.headers['user-agent'] || '';
  const isSafari = userAgent.includes('Safari') && !userAgent.includes('Chrome');
  
  if (isSafari) {
    // Erweiterte CORS-Header für Safari
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  
  next();
});

// Erweiterte Hilfsfunktionen
function generateDeviceName(platform, browser) {
  const platformNames = {
    'Windows': 'Windows PC',
    'macOS': 'Mac',
    'Linux': 'Linux PC',
    'Android': 'Android Gerät',
    'iOS': 'iPhone',
    'iPadOS': 'iPad',
    'Unbekannt': 'Unbekanntes Gerät'
  };
  
  const baseName = platformNames[platform] || platform;
  return `${baseName} (${browser})`;
}

function getDeviceType(platform) {
  const mobilePlatforms = ['Android', 'iOS'];
  const tabletPlatforms = ['iPadOS'];
  const desktopPlatforms = ['Windows', 'macOS', 'Linux'];
  
  if (mobilePlatforms.includes(platform)) return 'mobile';
  if (tabletPlatforms.includes(platform)) return 'tablet';
  if (desktopPlatforms.includes(platform)) return 'desktop';
  return 'unknown';
}

// KORRIGIERTE Nachrichtenverarbeitung mit besserem Error Handling
function handleMessage(deviceId, data) {
  const device = devices.get(deviceId);
  
  try {
    switch (data.type) {
      // NEUE CASES HIER EINFÜGEN:
      case 'client_identify':
        handleClientIdentify(deviceId, data);
        break;
        
      case 'desktop':
      case 'mobile':
      case 'tablet':
        console.log(`⚠️  Alte Nachrichtenformat erkannt, konvertiere zu deviceInfo`);
        handleDeviceInfo(deviceId, {
          name: data.name || device.name,
          type: data.type,
          customName: data.customName
        });
        break;

      // BESTEHENDE CASES:
      case 'deviceInfo':
        handleDeviceInfo(deviceId, data);
        break;
        
      case 'fileTransfer':
        handleFileTransfer(deviceId, data);
        break;

      case 'fileChunk':
        handleFileChunk(deviceId, data);
        break;

      case 'fileComplete':
        handleFileComplete(deviceId, data);
        break;
        
      case 'updateDeviceName':
        handleUpdateDeviceName(deviceId, data);
        break;
        
      case 'fileProgress':
        handleFileProgress(deviceId, data);
        break;
        
      case 'ping':
        if (device) {
          device.lastSeen = new Date();
          device.connectionStrength = data.connectionStrength || 'good';
          if (device.ws && device.ws.readyState === WebSocket.OPEN) {
            device.ws.send(JSON.stringify({ 
              type: 'pong',
              timestamp: data.timestamp || Date.now()
            }));
          }
        }
        break;

      case 'transferComplete':
        // Bereinige den Transfer
        const transfer = fileTransfers.get(data.transferId);
        if (transfer) {
            if (transfer.chunks) {
                updateMemoryUsage(-transfer.totalSize);
            }
            fileTransfers.delete(data.transferId);
            console.log(`✅ Transfer ${data.transferId} abgeschlossen und bereinigt`);
        }
        break;
        
      case 'requestFileDownload':
        handleFileDownload(deviceId, data);
        break;

      case 'requestMissingChunks':
        handleRequestMissingChunks(deviceId, data);
        break;
        
      case 'transferRejected':
        handleTransferRejected(deviceId, data);
        break;
        
      case 'transferAccepted':
        handleTransferAccepted(deviceId, data);
        break;
        
      case 'togglePinDevice':
        handleTogglePinDevice(deviceId, data);
        break;
        
      case 'joinRoom':
        handleJoinRoom(deviceId, data);
        break;
        
      case 'createRoom':
        handleCreateRoom(deviceId, data);
        break;
        
      case 'leaveRoom':
        handleLeaveRoom(deviceId);
        break;
        
      case 'fileCancel':
        handleFileCancel(deviceId, data);
        break;
        
      default:
        console.warn(`⚠️ Unbekannter Nachrichtentyp: ${data.type}`, data);
        if (device && device.ws && device.ws.readyState === WebSocket.OPEN) {
          device.ws.send(JSON.stringify({
            type: 'error',
            message: `Unbekannter Nachrichtentyp: ${data.type}`
          }));
        }
    }
  } catch (error) {
    console.error(`❌ Fehler in handleMessage für Typ ${data.type}:`, error);
    if (device && device.ws && device.ws.readyState === WebSocket.OPEN) {
      device.ws.send(JSON.stringify({
        type: 'error',
        message: 'Interner Server Fehler'
      }));
    }
  }
}

// Füge diese neue Funktion hinzu:
function handleClientIdentify(deviceId, data) {
  const device = devices.get(deviceId);
  if (!device) {
    console.error(`❌ Gerät nicht gefunden für client_identify: ${deviceId}`);
    return;
  }

  console.log(`🔐 Client Identifikation erhalten:`, {
    clientId: data.clientId,
    sessionId: data.sessionId,
    platform: data.platform,
    browser: data.userAgent ? detectBrowser(data.userAgent) : 'Unbekannt'
  });

  // Aktualisiere Geräteinformationen basierend auf client_identify
  if (data.userAgent) {
    const { platform, browser } = detectPlatform(data.userAgent);
    device.platform = platform;
    device.browser = browser;
    device.userAgent = data.userAgent;
    
    // Korrigiere den Gerätenamen basierend auf der tatsächlichen Plattform
    if (platform !== device.platform) {
      console.log(`🔄 Korrigiere Plattform von "${device.platform}" zu "${platform}"`);
      device.platform = platform;
      device.name = generateDeviceName(platform, browser);
    }
  }

  device.clientId = data.clientId;
  device.sessionId = data.sessionId;
  device.language = data.language;
  device.lastSeen = new Date();

  // Sende Bestätigung zurück
  if (device.ws && device.ws.readyState === WebSocket.OPEN) {
    device.ws.send(JSON.stringify({
      type: 'welcome',
      deviceId: deviceId,
      serverInfo: {
        maxFileSize: '500MB',
        chunkSize: '20MB',
        supportsProgress: true,
        serverVersion: '2.0.0'
      }
    }));
  }

  // Wenn eine vorherige Session vorhanden ist, versuche sie wiederherzustellen
  if (data.previousSession) {
    console.log(`🔄 Versuche Session-Wiederherstellung: ${data.previousSession}`);
    // Hier könntest du Session-spezifische Daten wiederherstellen
  }

  console.log(`✅ Client identifiziert: ${device.name} (${device.platform} - ${device.browser})`);
  
  // Aktualisiere Geräteliste falls in einem Raum
  if (device.roomId) {
    broadcastDeviceList(device.roomId);
  }
  
  saveDevices();
}

function handleRequestMissingChunks(deviceId, data) {
  console.log(`🔍 Fordere fehlende Chunks an für Transfer ${data.transferId}:`, data.missingChunks);
  
  const transfer = fileTransfers.get(data.transferId);
  if (!transfer) {
    console.error(`❌ Transfer nicht gefunden: ${data.transferId}`);
    return;
  }
  
  const sender = devices.get(transfer.fromDeviceId);
  if (!sender || !sender.ws || sender.ws.readyState !== WebSocket.OPEN) {
    console.error(`❌ Sender nicht verfügbar für Transfer: ${data.transferId}`);
    return;
  }
  
  // Sende fehlende Chunks erneut
  data.missingChunks.forEach(chunkIndex => {
    if (transfer.chunks && transfer.chunks[chunkIndex]) {
      sender.ws.send(JSON.stringify({
        type: 'fileChunk',
        targetDeviceId: deviceId,
        transferId: data.transferId,
        fileIndex: 0,
        chunkIndex: chunkIndex,
        totalChunks: data.totalChunks,
        data: transfer.chunks[chunkIndex],
        fileSize: transfer.files[0].size
      }));
      console.log(`📨 Sende Chunk ${chunkIndex} erneut für Transfer ${data.transferId}`);
    }
  });
}


// FEHLENDE FUNKTION HINZUFÜGEN - nach handleFileChunk
function handleFileComplete(deviceId, data) {
  console.log(`✅ Dateiübertragung abgeschlossen für Transfer: ${data.transferId}`);
  
  const transfer = fileTransfers.get(data.transferId);
  if (!transfer) {
    console.error(`❌ Transfer nicht gefunden: ${data.transferId}`);
    return;
  }

  // Bereinige den Transfer aus dem Memory
  if (transfer.chunks) {
    updateMemoryUsage(-transfer.totalSize);
  }
  fileTransfers.delete(data.transferId);
  
  console.log(`🗑️ Transfer ${data.transferId} bereinigt`);
}




// Korrigierte DeviceInfo Verarbeitung
function handleDeviceInfo(deviceId, data) {
  const device = devices.get(deviceId);
  if (!device) {
    console.error(`❌ Gerät nicht gefunden: ${deviceId}`);
    return;
  }

  device.name = data.name || device.name;
  device.customName = data.customName || device.customName;
  device.type = data.type || device.type; // Korrektur: verwende data.type direkt
  device.lastSeen = new Date();
  
  console.log(`📝 DeviceInfo aktualisiert für ${deviceId}:`, {
    name: device.name,
    customName: device.customName,
    type: device.type
  });
  
  if (device.roomId) {
    broadcastDeviceList(device.roomId);
  }
  saveDevices();
}



function handleFileChunk(deviceId, data) {
    const { transferId, chunkIndex, totalChunks, data: chunkData, fileSize } = data;
    const transfer = fileTransfers.get(transferId);
    
    if (!transfer) {
        console.error(`❌ Transfer nicht gefunden: ${transferId}`);
        return;
    }
    
    // Initialisiere chunks Array falls nicht vorhanden
    if (!transfer.chunks) {
        transfer.chunks = [];
        transfer.receivedChunks = 0;
        transfer.startTime = Date.now();
        transfer.totalSize = fileSize;
        updateMemoryUsage(fileSize);
    }
    
    // Bereinige den Chunk-Daten
    let cleanChunkData = chunkData;
    
    // Entferne Data-URL Prefix falls vorhanden
    if (chunkData.startsWith('data:')) {
        const commaIndex = chunkData.indexOf(',');
        if (commaIndex !== -1) {
            cleanChunkData = chunkData.substring(commaIndex + 1);
        }
    }
    
    // Entferne nicht-Base64 Zeichen
    cleanChunkData = cleanChunkData.replace(/[^A-Za-z0-9+/=]/g, '');
    
    // Speichere Chunk an der richtigen Position
    transfer.chunks[chunkIndex] = cleanChunkData;
    transfer.receivedChunks++;
    
    console.log(`📦 Chunk ${chunkIndex + 1}/${totalChunks} empfangen für Transfer ${transferId}`);
    
    // Sende Fortschritt an Sender
    const sender = devices.get(transfer.fromDeviceId);
    if (sender && sender.ws) {
        const progress = Math.round((transfer.receivedChunks / totalChunks) * 100);
        sender.ws.send(JSON.stringify({
            type: 'uploadProgress',
            transferId: transferId,
            progress: progress,
            receivedChunks: transfer.receivedChunks,
            totalChunks: totalChunks
        }));
    }
    
    // Wenn alle Chunks empfangen wurden, sende die komplette Datei an den Empfänger
    if (transfer.receivedChunks === totalChunks) {
        console.log(`✅ Alle Chunks empfangen für Transfer ${transferId}, kombiniere Datei...`);
        
        try {
            // Kombiniere alle Chunks zu einem Base64 String
            const completeFileData = transfer.chunks.join('');
            
            const receiver = devices.get(transfer.targetDeviceId);
            if (receiver && receiver.ws && receiver.ws.readyState === WebSocket.OPEN) {
                // Sende die komplette Datei als bereinigte Base64-Daten
                receiver.ws.send(JSON.stringify({
                    type: 'fileComplete',
                    transferId: transferId,
                    fileName: transfer.files[0].name,
                    fileType: transfer.files[0].type || 'application/octet-stream',
                    fileSize: transfer.files[0].size,
                    fileData: completeFileData,
                    fromDevice: transfer.fromDevice
                }));
                
                console.log(`📨 Datei "${transfer.files[0].name}" an Empfänger gesendet`);
                
                // Bestätigung an Sender
                if (sender && sender.ws) {
                    sender.ws.send(JSON.stringify({
                        type: 'transferComplete',
                        transferId: transferId,
                        fileName: transfer.files[0].name,
                        targetDevice: receiver.customName || receiver.name
                    }));
                }
                
                // Übertragung als abgeschlossen markieren
                transfer.status = 'completed';
                transfer.endTime = Date.now();
                
            } else {
                console.error(`❌ Empfänger nicht erreichbar für Transfer ${transferId}`);
                if (sender && sender.ws) {
                    sender.ws.send(JSON.stringify({
                        type: 'transferError',
                        transferId: transferId,
                        message: 'Empfänger nicht erreichbar'
                    }));
                }
            }
        } catch (error) {
            console.error(`❌ Fehler beim Kombinieren der Datei für Transfer ${transferId}:`, error);
            const sender = devices.get(transfer.fromDeviceId);
            if (sender && sender.ws) {
                sender.ws.send(JSON.stringify({
                    type: 'transferError',
                    transferId: transferId,
                    message: 'Fehler beim Verarbeiten der Datei'
                }));
            }
        }
    }
}

function handleFileProgress(deviceId, data) {
  const targetDevice = devices.get(data.targetDeviceId);
  if (targetDevice && targetDevice.ws) {
    targetDevice.ws.send(JSON.stringify({
      type: 'transferProgress',
      transferId: data.transferId,
      progress: data.progress,
      fileIndex: data.fileIndex
    }));
  }
}

function handleFileCancel(deviceId, data) {
  const transfer = fileTransfers.get(data.transferId);
  if (transfer) {
    if (transfer.chunks) {
      updateMemoryUsage(-transfer.totalSize);
    }
    fileTransfers.delete(data.transferId);
    console.log(`🗑️ Transfer ${data.transferId} abgebrochen`);
  }
}

// Verbesserte Dateiübertragung mit Chunk-Support
function handleFileTransfer(senderId, data) {
  const sender = devices.get(senderId);
  const receiver = devices.get(data.targetDeviceId);
  
  if (!receiver) {
    sender.ws.send(JSON.stringify({
      type: 'transferError',
      message: 'Zielgerät nicht gefunden'
    }));
    return;
  }
  
  if (sender.roomId !== receiver.roomId) {
    sender.ws.send(JSON.stringify({
      type: 'transferError',
      message: 'Gerät nicht im selben Raum'
    }));
    return;
  }
  
  const transferId = data.transferId || generateTransferId();
  
  fileTransfers.set(transferId, {
    files: data.files,
    fromDevice: sender.customName || sender.name,
    fromDeviceId: senderId,
    targetDeviceId: data.targetDeviceId,
    timestamp: new Date(),
    totalSize: data.files[0].size,
    status: 'pending',
    chunks: [],
    receivedChunks: 0
  });
  
  // Benachrichtigung an Empfänger
  if (receiver.online && receiver.ws && receiver.ws.readyState === WebSocket.OPEN) {
    receiver.ws.send(JSON.stringify({
      type: 'incomingFile',
      files: data.files,
      fromDevice: sender.customName || sender.name,
      fromDeviceId: senderId,
      transferId: transferId,
      totalSize: data.files[0].size
    }));
    
    sender.ws.send(JSON.stringify({
      type: 'transferStarted',
      targetDevice: receiver.customName || receiver.name,
      transferId: transferId
    }));
    
    console.log(`📤 Dateiübertragung gestartet: ${sender.name} → ${receiver.name}, Datei: ${data.files[0].name}, Größe: ${formatFileSize(data.files[0].size)}`);
  } else {
    sender.ws.send(JSON.stringify({
      type: 'transferError',
      message: 'Zielgerät ist offline'
    }));
  }
}

// Verbesserte UpdateDeviceName Funktion
function handleUpdateDeviceName(deviceId, data) {
  const device = devices.get(deviceId);
  if (device) {
    device.name = data.name;
    device.customName = data.name; // Speichere auch als customName
    device.lastSeen = new Date();
    console.log(`📝 Gerätename aktualisiert: ${deviceId} -> ${data.name}`);
    
    if (device.roomId) {
      broadcastDeviceList(device.roomId);
    }
    saveDevices();
    
    // Bestätigung an das Gerät senden
    if (device.ws && device.ws.readyState === WebSocket.OPEN) {
      device.ws.send(JSON.stringify({
        type: 'deviceNameUpdated',
        name: data.name
      }));
    }
  }
}

// KORRIGIERTE Raum-Funktionen mit Case-Insensitive Matching
function handleJoinRoom(deviceId, data) {
  const device = devices.get(deviceId);
  const requestedRoomName = data.roomName || data.roomId;
  
  if (!requestedRoomName || requestedRoomName.trim() === '') {
    device.ws.send(JSON.stringify({
      type: 'roomError',
      message: 'Raumname darf nicht leer sein'
    }));
    return;
  }

  // Case-insensitive Suche nach Raum
  const requestedRoomNameLower = requestedRoomName.toLowerCase().trim();
  let foundRoom = null;
  
  for (const room of rooms.values()) {
    if (room.name.toLowerCase() === requestedRoomNameLower) {
      foundRoom = room;
      break;
    }
  }

  if (!foundRoom) {
    console.log(`❌ Raum nicht gefunden: ${requestedRoomName}. Verfügbare Räume:`, Array.from(rooms.values()).map(r => r.name));
    device.ws.send(JSON.stringify({
      type: 'roomError',
      message: 'Raum nicht gefunden'
    }));
    return;
  }

  // Verlasse aktuellen Raum
  if (device.roomId) {
    handleLeaveRoom(deviceId);
  }

  // Raum beitreten
  device.roomId = foundRoom.id;
  foundRoom.devices.add(deviceId);

  console.log(`🚪 Gerät ${device.customName || device.name} betritt Raum: ${foundRoom.name} (${foundRoom.id})`);

  // Bestätigung an Gerät senden
  device.ws.send(JSON.stringify({
    type: 'roomJoined',
    roomId: foundRoom.id,
    roomName: foundRoom.name,
    deviceCount: foundRoom.devices.size
  }));

  // Aktualisiere alle Geräte im Raum
  broadcastDeviceList(foundRoom.id);
  broadcastToRoom(foundRoom.id, {
    type: 'deviceJoined',
    deviceId: device.id,
    deviceName: device.customName || device.name,
    deviceCount: foundRoom.devices.size
  }, device.id);

  saveDevices();
  saveRooms();
}

function generateRoomId() {
  return 'room-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

function handleCreateRoom(deviceId, data) {
  const device = devices.get(deviceId);
  const roomName = data.roomName || data.roomId;
  
  if (!roomName || roomName.trim() === '') {
    device.ws.send(JSON.stringify({
      type: 'roomError',
      message: 'Raumname darf nicht leer sein'
    }));
    return;
  }

  // Prüfe ob Raum bereits existiert (case-insensitive)
  const roomNameLower = roomName.toLowerCase().trim();
  let roomExists = false;
  
  for (const [existingRoomId, existingRoom] of rooms.entries()) {
    if (existingRoom.name.toLowerCase() === roomNameLower) {
      roomExists = true;
      break;
    }
  }

  if (roomExists) {
    console.log(`❌ Raum existiert bereits: ${roomName}`);
    device.ws.send(JSON.stringify({
      type: 'roomError',
      message: 'Raum existiert bereits'
    }));
    return;
  }

  // Verlasse aktuellen Raum
  if (device.roomId) {
    handleLeaveRoom(deviceId);
  }

  // Neuen Raum erstellen
  const roomId = generateRoomId();
  rooms.set(roomId, {
    id: roomId,
    name: roomName.trim(),
    created: new Date(),
    createdBy: deviceId,
    devices: new Set([deviceId])
  });

  device.roomId = roomId;

  console.log(`🏠 Neuer Raum erstellt: ${roomName} (${roomId}) von ${device.customName || device.name}`);

  device.ws.send(JSON.stringify({
    type: 'roomCreated',
    roomId: roomId,
    roomName: roomName.trim()
  }));

  broadcastDeviceList(roomId);
  saveDevices();
  saveRooms();
}

function handleLeaveRoom(deviceId) {
  const device = devices.get(deviceId);
  
  if (!device.roomId) return;
  
  const roomId = device.roomId;
  const room = rooms.get(roomId);
  
  if (room) {
    room.devices.delete(deviceId);
    
    if (room.devices.size === 0) {
      rooms.delete(roomId);
      console.log(`🗑️ Raum ${roomId} entfernt (leer)`);
    } else {
      // Benachrichtige andere Geräte
      broadcastToRoom(roomId, {
        type: 'deviceLeft',
        deviceId: device.id,
        deviceName: device.customName || device.name,
        deviceCount: room.devices.size
      }, device.id);
    }
  }
  
  device.roomId = null;
  device.ws.send(JSON.stringify({
    type: 'roomLeft'
  }));
  
  console.log(`🚪 Gerät ${device.customName || device.name} verlässt Raum: ${roomId}`);
  saveDevices();
  saveRooms();
}

// Verbesserte Broadcast-Funktionen
function broadcastToRoom(roomId, message, excludeDeviceId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  let delivered = 0;
  room.devices.forEach(deviceId => {
    if (deviceId === excludeDeviceId) return;
    
    const device = devices.get(deviceId);
    if (device && device.online && device.ws && device.ws.readyState === WebSocket.OPEN) {
      try {
        device.ws.send(JSON.stringify(message));
        delivered++;
      } catch (error) {
        console.error(`❌ Fehler beim Senden an ${deviceId}:`, error);
      }
    }
  });
  
  return delivered;
}

function broadcastDeviceList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  const deviceList = Array.from(room.devices)
    .map(deviceId => devices.get(deviceId))
    .filter(device => device)
    .map(device => ({
      id: device.id,
      name: device.customName || device.name,
      originalName: device.name,
      type: device.type,
      platform: device.platform,
      browser: device.browser,
      pinned: device.pinned || false,
      online: device.online || false,
      lastSeen: device.lastSeen,
      connectionStrength: device.connectionStrength || 'good',
      hasCustomName: !!device.customName
    }));
  
  broadcastToRoom(roomId, {
    type: 'deviceList',
    devices: deviceList,
    roomInfo: {
      id: roomId,
      name: room.name,
      deviceCount: deviceList.length
    }
  });
}

// Verbesserte Datei-Download-Funktion
function handleFileDownload(deviceId, data) {
  const device = devices.get(deviceId);
  const transfer = fileTransfers.get(data.transferId);
  
  if (!transfer) {
    device.ws.send(JSON.stringify({
      type: 'downloadError',
      message: 'Datei nicht gefunden'
    }));
    return;
  }

  // Sende Datei in Chunks
  const sender = devices.get(transfer.fromDeviceId);
  if (sender && sender.online && sender.ws && sender.ws.readyState === WebSocket.OPEN) {
    sender.ws.send(JSON.stringify({
      type: 'sendFileData',
      targetDeviceId: deviceId,
      transferId: data.transferId,
      fileIndex: data.fileIndex,
      chunkSize: data.chunkSize || 20 * 1024 * 1024
    }));
  } else {
    device.ws.send(JSON.stringify({
      type: 'downloadError',
      message: 'Sender nicht verfügbar'
    }));
  }
}

// Weitere Handler-Funktionen
function handleTransferRejected(deviceId, data) {
  const sender = devices.get(data.fromDeviceId);
  if (sender && sender.online && sender.ws) {
    sender.ws.send(JSON.stringify({
      type: 'transferRejected',
      message: 'Empfänger hat die Übertragung abgelehnt'
    }));
  }
  
  fileTransfers.delete(data.transferId);
}

function handleTransferAccepted(deviceId, data) {
  const sender = devices.get(data.fromDeviceId);
  if (sender && sender.online && sender.ws) {
    sender.ws.send(JSON.stringify({
      type: 'transferAccepted',
      message: 'Empfänger hat die Übertragung akzeptiert'
    }));
  }
  
  console.log(`✅ Übertragung ${data.transferId} wurde akzeptiert`);
}

function handleTogglePinDevice(deviceId, data) {
  const device = devices.get(deviceId);
  const targetDevice = devices.get(data.targetDeviceId);
  
  if (targetDevice && device.roomId === targetDevice.roomId) {
    targetDevice.pinned = !targetDevice.pinned;
    console.log(`📌 Gerät ${targetDevice.name} ${targetDevice.pinned ? 'angepinnt' : 'abgepinnt'}`);
    broadcastDeviceList(device.roomId);
    saveDevices();
  }
}

// Verbesserte API-Routen
app.post('/api/upload', upload.array('files'), (req, res) => {
  try {
    const files = req.files.map(file => ({
      name: file.originalname,
      size: file.size,
      type: file.mimetype,
      path: file.filename,
      url: `/api/download/${file.filename}`,
      uploadedAt: new Date()
    }));
    
    res.json({
      success: true,
      files: files,
      totalSize: files.reduce((sum, file) => sum + file.size, 0)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(UPLOAD_DIR, filename);
  
  if (fs.existsSync(filePath)) {
    const originalName = filename.split('-').slice(2).join('-');
    const stats = fs.statSync(filePath);
    
    res.setHeader('Content-Disposition', `attachment; filename="${originalName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Cache-Control', 'no-cache');
    
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    
    fileStream.on('error', (error) => {
      console.error('❌ Download Fehler:', error);
      res.status(500).json({ error: 'Download fehlgeschlagen' });
    });
  } else {
    res.status(404).json({ error: 'Datei nicht gefunden' });
  }
});

// Neue API-Endpoints für erweiterte Funktionalität
app.get('/api/server-info', (req, res) => {
  const memoryUsage = process.memoryUsage();
  res.json({
    status: 'online',
    connections: activeConnections.size,
    rooms: rooms.size,
    devices: devices.size,
    memory: {
      used: formatFileSize(memoryUsage.heapUsed),
      total: formatFileSize(memoryUsage.heapTotal),
      rss: formatFileSize(memoryUsage.rss)
    },
    transfers: fileTransfers.size,
    uptime: process.uptime(),
    maxFileSize: '500MB',
    chunkSize: '20MB'
  });
});

app.delete('/api/transfers/:transferId', (req, res) => {
  const transferId = req.params.transferId;
  const transfer = fileTransfers.get(transferId);
  
  if (transfer) {
    if (transfer.chunks) {
      updateMemoryUsage(-transfer.totalSize);
    }
    fileTransfers.delete(transferId);
    res.json({ success: true, message: 'Transfer gelöscht' });
  } else {
    res.status(404).json({ success: false, error: 'Transfer nicht gefunden' });
  }
});

app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(rooms.values()).map(room => ({
    id: room.id,
    name: room.name,
    created: room.created,
    deviceCount: room.devices.size,
    createdBy: room.createdBy
  }));
  
  res.json(roomList);
});

// KORRIGIERTE Dateibereinigung mit Verzeichnis-Prüfung
function cleanupOldFiles(directory, maxAge = 24 * 60 * 60 * 1000) {
  // Überprüfe ob Verzeichnis existiert
  if (!fs.existsSync(directory)) {
    console.log(`ℹ️  Upload-Verzeichnis existiert nicht: ${directory}`);
    return;
  }
  
  const now = Date.now();
  
  try {
    const files = fs.readdirSync(directory);
    let cleanedCount = 0;
    
    files.forEach(file => {
      const filePath = path.join(directory, file);
      
      try {
        const stats = fs.statSync(filePath);
        
        if (now - stats.mtime.getTime() > maxAge) {
          fs.unlinkSync(filePath);
          cleanedCount++;
        }
      } catch (statError) {
        console.error(`❌ Fehler beim Zugriff auf Datei ${filePath}:`, statError);
      }
    });
    
    if (cleanedCount > 0) {
      console.log(`🧹 ${cleanedCount} alte Dateien bereinigt`);
    }
  } catch (error) {
    console.error('❌ Fehler bei Dateibereinigung:', error);
  }
}

// Hilfsfunktionen
function generateTransferId() {
  return 'transfer-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Hauptroute
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Erweiterte regelmäßige Bereinigung
setInterval(() => {
  const now = new Date();
  const deviceTimeout = 30 * 60 * 1000;
  const pinnedDeviceTimeout = 24 * 60 * 60 * 1000;
  const transferTimeout = 60 * 60 * 1000;
  const connectionTimeout = 5 * 60 * 1000;
  
  let cleanedDevices = 0;
  let cleanedTransfers = 0;
  let cleanedConnections = 0;
  
  // Bereinige inaktive Verbindungen
  activeConnections.forEach((info, ws) => {
    if (now - info.lastActivity > connectionTimeout) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'Inaktivität');
      }
      activeConnections.delete(ws);
      cleanedConnections++;
    }
  });
  
  // Bereinige alte Geräte
  devices.forEach((device, deviceId) => {
    const timeSinceLastSeen = now - device.lastSeen;
    const isExpired = device.pinned ? 
      timeSinceLastSeen > pinnedDeviceTimeout : 
      timeSinceLastSeen > deviceTimeout;
    
    if (isExpired && !device.online) {
      if (device.roomId) {
        const room = rooms.get(device.roomId);
        if (room) {
          room.devices.delete(deviceId);
          if (room.devices.size === 0) {
            rooms.delete(device.roomId);
          }
        }
      }
      
      if (device.ws && device.ws.readyState === WebSocket.OPEN) {
        device.ws.close();
      }
      devices.delete(deviceId);
      cleanedDevices++;
    }
  });
  
  // Bereinige alte Transfers
  fileTransfers.forEach((transfer, transferId) => {
    if (now - transfer.timestamp > transferTimeout) {
      if (transfer.chunks) {
        updateMemoryUsage(-transfer.totalSize);
      }
      fileTransfers.delete(transferId);
      cleanedTransfers++;
    }
  });
  
  // Bereinige Upload-Verzeichnis (nur wenn es existiert)
  cleanupOldFiles(UPLOAD_DIR);
  
  if (cleanedDevices > 0 || cleanedTransfers > 0 || cleanedConnections > 0) {
    console.log(`🧹 Bereinigung: ${cleanedDevices} Geräte, ${cleanedTransfers} Transfers, ${cleanedConnections} Verbindungen`);
    saveDevices();
    saveRooms();
  }
  
  // Memory-Status loggen
  const memoryUsage = process.memoryUsage();
  if (memoryUsage.heapUsed > 400 * 1024 * 1024) {
    console.log(`⚠️  Hohe Memory-Nutzung: ${formatFileSize(memoryUsage.heapUsed)}`);
  }
}, 60000);

// Graceful Shutdown
process.on('SIGINT', () => {
  console.log('🛑 Server wird heruntergefahren...');
  
  // Speichere alle Daten
  saveDevices();
  saveRooms();
  
  // Schließe alle WebSocket-Verbindungen
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1000, 'Server shutdown');
    }
  });
  
  setTimeout(() => {
    console.log('👋 Server heruntergefahren');
    process.exit(0);
  }, 1000);
});

// Server starten
const PORT = process.env.PORT || 80;      // HTTP
server.listen(PORT, () => {
  if (cluster.isWorker) {
    //console.log(`🚀 Worker ${process.pid} läuft auf Port ${PORT}`);
  } else {
    console.log(`🚀 ETKn Share Server läuft auf Port ${PORT}`);
    console.log(`🌐 Besuchen Sie: http://localhost:${PORT}`);
    console.log(`🏠 Raum-basierte Geräteerkennung aktiviert`);
    console.log(`💾 Max. Dateigröße: 500MB`);
    console.log(`🔧 Chunk-Größe: 1MB`);
    console.log(`📊 Memory-Limit: ${formatFileSize(MAX_MEMORY_USAGE)}`);
    console.log(`📁 Upload-Verzeichnis: ${UPLOAD_DIR}`);
  }
});

// Export für Tests
module.exports = { app, server, wss, devices, rooms };
