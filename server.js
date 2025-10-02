const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Datei-Upload Konfiguration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const safeFileName = file.originalname.replace(/[^a-zA-Z0-9.\-]/g, '_');
    cb(null, Date.now() + '-' + safeFileName);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

// Raum- und Geräteverwaltung
const rooms = new Map();
const devices = new Map();
const connections = new Map();
const fileTransfers = new Map();

// Persistente Gerätespeicherung
const DEVICES_FILE = path.join(__dirname, 'devices.json');

function loadDevices() {
  try {
    if (fs.existsSync(DEVICES_FILE)) {
      const data = fs.readFileSync(DEVICES_FILE, 'utf8');
      const devicesData = JSON.parse(data);
      devicesData.forEach(device => {
        // Setze Gerät als offline beim Laden
        device.online = false;
        device.ws = null;
        device.lastSeen = new Date(device.lastSeen);
        devices.set(device.id, device);
      });
      console.log(`✅ ${devicesData.length} gespeicherte Geräte geladen`);
    }
  } catch (error) {
    console.error('❌ Fehler beim Laden der Geräte:', error);
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
      // Speichere keine WebSocket-Instanzen
      online: false
    }));
    
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(devicesToSave, null, 2));
  } catch (error) {
    console.error('❌ Fehler beim Speichern der Geräte:', error);
  }
}

// Geräte beim Start laden
loadDevices();

// Plattform-Erkennung
function detectPlatform(userAgent) {
  const ua = userAgent.toLowerCase();
  
  // Betriebssystem
  let platform = 'Unbekannt';
  if (ua.includes('windows')) platform = 'Windows';
  else if (ua.includes('mac os') || ua.includes('macos')) platform = 'macOS';
  else if (ua.includes('linux')) platform = 'Linux';
  else if (ua.includes('android')) platform = 'Android';
  else if (ua.includes('ios') || ua.includes('iphone') || ua.includes('ipad')) platform = 'iOS';
  else if (ua.includes('ipod')) platform = 'iOS';
  
  // Browser
  let browser = 'Unbekannt';
  if (ua.includes('chrome') && !ua.includes('edg')) browser = 'Chrome';
  else if (ua.includes('firefox')) browser = 'Firefox';
  else if (ua.includes('safari') && !ua.includes('chrome')) browser = 'Safari';
  else if (ua.includes('edge')) browser = 'Edge';
  else if (ua.includes('opera')) browser = 'Opera';
  
  return { platform, browser };
}

// Geräte-ID basierend auf User-Agent und anderen Merkmalen generieren
function generateStableDeviceId(userAgent, req) {
  // Kombiniere User-Agent mit IP-Adresse für bessere Stabilität
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const seed = userAgent + ip;
  
  // Einfacher Hash für Stabilität
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  
  return 'device-' + Math.abs(hash).toString(36);
}

// WebSocket-Verbindungen
wss.on('connection', (ws, req) => {
  const userAgent = req.headers['user-agent'] || 'Unbekannt';
  const deviceId = generateStableDeviceId(userAgent, req);
  const { platform, browser } = detectPlatform(userAgent);
  
  console.log(`📱 Neue Verbindung: ${deviceId} (${platform} - ${browser})`);
  
  // Prüfe ob Gerät bereits bekannt ist
  const existingDevice = devices.get(deviceId);
  
  if (existingDevice) {
    // Aktualisiere bestehendes Gerät
    existingDevice.ws = ws;
    existingDevice.online = true;
    existingDevice.lastSeen = new Date();
    existingDevice.userAgent = userAgent;
    console.log(`🔄 Bekanntes Gerät wieder verbunden: ${existingDevice.name}`);
  } else {
    // Neues Gerät erstellen
    const deviceName = generateDeviceName(platform, browser);
    
    devices.set(deviceId, {
      id: deviceId,
      ws: ws,
      name: deviceName,
      type: getDeviceType(platform),
      platform: platform,
      browser: browser,
      userAgent: userAgent,
      pinned: false,
      online: true,
      lastSeen: new Date(),
      roomId: null // Startet ohne Raum
    });
    
    console.log(`🆕 Neues Gerät registriert: ${deviceName}`);
  }
  
  connections.set(ws, deviceId);
  
  // Gerät begrüßen
  ws.send(JSON.stringify({
    type: 'welcome',
    deviceId: deviceId
  }));
  
  // Nachrichten verarbeiten
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(deviceId, data);
    } catch (error) {
      console.error('❌ Fehler beim Verarbeiten der Nachricht:', error);
    }
  });
  
  // Verbindung schließen
  ws.on('close', () => {
    console.log(`🔌 Verbindung geschlossen: ${deviceId}`);
    const disconnectedDeviceId = connections.get(ws);
    const device = devices.get(disconnectedDeviceId);
    
    if (device) {
      device.online = false;
      device.lastSeen = new Date();
      // WebSocket-Referenz entfernen, aber Gerät in Map behalten
      device.ws = null;
      
      // Benachrichtige andere Geräte im Raum
      if (device.roomId) {
        broadcastToRoom(device.roomId, {
          type: 'deviceLeft',
          deviceId: device.id,
          deviceName: device.name
        }, device.id);
      }
    }
    
    connections.delete(ws);
    saveDevices(); // Speichere Änderungen
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket Fehler:', error);
  });
});

// Gerätenamen generieren
function generateDeviceName(platform, browser) {
  const platformNames = {
    'Windows': 'Windows PC',
    'macOS': 'Mac',
    'Linux': 'Linux PC',
    'Android': 'Android Gerät',
    'iOS': 'iPhone/iPad',
    'Unbekannt': 'Unbekanntes Gerät'
  };
  
  const baseName = platformNames[platform] || platform;
  return `${baseName} (${browser})`;
}

// Gerätetyp basierend auf Plattform bestimmen
function getDeviceType(platform) {
  const mobilePlatforms = ['Android', 'iOS'];
  const desktopPlatforms = ['Windows', 'macOS', 'Linux'];
  
  if (mobilePlatforms.includes(platform)) return 'mobile';
  if (desktopPlatforms.includes(platform)) return 'desktop';
  return 'unknown';
}

// Nachrichten verarbeiten
function handleMessage(deviceId, data) {
  const device = devices.get(deviceId);
  
  switch (data.type) {
    case 'deviceInfo':
      device.name = data.name || device.name;
      device.type = data.type || device.type;
      device.lastSeen = new Date();
      if (device.roomId) {
        broadcastDeviceList(device.roomId);
      }
      saveDevices();
      break;
      
    case 'fileTransfer':
      handleFileTransfer(deviceId, data);
      break;

    case 'updateDeviceName':
      handleUpdateDeviceName(deviceId, data);
      break;
      
    case 'fileData':
      handleFileData(deviceId, data);
      break;
      
    case 'ping':
      device.lastSeen = new Date();
      device.ws.send(JSON.stringify({ type: 'pong' }));
      break;
      
    case 'requestFileDownload':
      handleFileDownload(deviceId, data);
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
  }
}

// Raum beitreten
function handleJoinRoom(deviceId, data) {
  const device = devices.get(deviceId);
  const roomId = data.roomId.toLowerCase().trim();
  
  if (!roomId) {
    device.ws.send(JSON.stringify({
      type: 'roomError',
      message: 'Raumname darf nicht leer sein'
    }));
    return;
  }
  
  // Verlasse aktuellen Raum falls vorhanden
  if (device.roomId) {
    handleLeaveRoom(deviceId);
  }
  
  // Prüfe ob Raum existiert
  if (!rooms.has(roomId)) {
    device.ws.send(JSON.stringify({
      type: 'roomError',
      message: 'Raum nicht gefunden'
    }));
    return;
  }
  
  // Raum beitreten
  device.roomId = roomId;
  rooms.get(roomId).devices.add(deviceId);
  
  console.log(`🚪 Gerät ${device.name} betritt Raum: ${roomId}`);
  
  // Bestätigung an Gerät senden
  device.ws.send(JSON.stringify({
    type: 'roomJoined',
    roomId: roomId,
    roomName: rooms.get(roomId).name
  }));
  
  // Geräteliste an alle im Raum senden
  broadcastDeviceList(roomId);
  
  // Benachrichtige andere Geräte im Raum
  broadcastToRoom(roomId, {
    type: 'deviceJoined',
    deviceId: device.id,
    deviceName: device.name
  }, device.id);
  
  saveDevices();
}

// Raum erstellen
function handleCreateRoom(deviceId, data) {
  const device = devices.get(deviceId);
  const roomId = data.roomId.toLowerCase().trim();
  const roomName = data.roomName || roomId;
  
  if (!roomId) {
    device.ws.send(JSON.stringify({
      type: 'roomError',
      message: 'Raumname darf nicht leer sein'
    }));
    return;
  }
  
  // Verlasse aktuellen Raum falls vorhanden
  if (device.roomId) {
    handleLeaveRoom(deviceId);
  }
  
  // Prüfe ob Raum bereits existiert
  if (rooms.has(roomId)) {
    device.ws.send(JSON.stringify({
      type: 'roomError',
      message: 'Raum existiert bereits'
    }));
    return;
  }
  
  // Neuen Raum erstellen
  rooms.set(roomId, {
    name: roomName,
    created: new Date(),
    createdBy: deviceId,
    devices: new Set([deviceId])
  });
  
  device.roomId = roomId;
  
  console.log(`🏠 Neuer Raum erstellt: ${roomName} (${roomId}) von ${device.name}`);
  
  // Bestätigung an Gerät senden
  device.ws.send(JSON.stringify({
    type: 'roomCreated',
    roomId: roomId,
    roomName: roomName
  }));
  
  // Geräteliste senden (nur dieses Gerät zunächst)
  broadcastDeviceList(roomId);
  saveDevices();
}

// Raum verlassen
function handleLeaveRoom(deviceId) {
  const device = devices.get(deviceId);
  
  if (!device.roomId) return;
  
  const roomId = device.roomId;
  const room = rooms.get(roomId);
  
  if (room) {
    room.devices.delete(deviceId);
    
    // Wenn Raum leer ist, entferne ihn
    if (room.devices.size === 0) {
      rooms.delete(roomId);
      console.log(`🗑️ Raum ${roomId} entfernt (leer)`);
    }
    
    // Benachrichtige andere Geräte im Raum
    broadcastToRoom(roomId, {
      type: 'deviceLeft',
      deviceId: device.id,
      deviceName: device.name
    }, device.id);
  }
  
  device.roomId = null;
  device.ws.send(JSON.stringify({
    type: 'roomLeft'
  }));
  
  console.log(`🚪 Gerät ${device.name} verlässt Raum: ${roomId}`);
  saveDevices();
}

// An alle Geräte in einem Raum senden (außer optionalem excludeDeviceId)
function broadcastToRoom(roomId, message, excludeDeviceId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  room.devices.forEach(deviceId => {
    if (deviceId === excludeDeviceId) return;
    
    const device = devices.get(deviceId);
    if (device && device.online && device.ws && device.ws.readyState === WebSocket.OPEN) {
      device.ws.send(JSON.stringify(message));
    }
  });
}

// Geräte anpinnen/abpinnen
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

function handleUpdateDeviceName(deviceId, data) {
    const device = devices.get(deviceId);
    if (device) {
        device.name = data.name;
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

// Dateiübertragung verarbeiten
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
  
  // Prüfe ob beide Geräte im selben Raum sind
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
    fromDevice: sender.name,
    fromDeviceId: senderId,
    targetDeviceId: data.targetDeviceId,
    timestamp: new Date()
  });
  
  // Benachrichtigung an Empfänger senden (falls online)
  if (receiver.online && receiver.ws && receiver.ws.readyState === WebSocket.OPEN) {
    receiver.ws.send(JSON.stringify({
      type: 'incomingFile',
      files: data.files,
      fromDevice: sender.name,
      fromDeviceId: senderId,
      transferId: transferId
    }));
    
    sender.ws.send(JSON.stringify({
      type: 'transferStarted',
      targetDevice: receiver.name
    }));
    
    console.log(`📤 Dateiübertragung von ${sender.name} an ${receiver.name} angefordert`);
  } else {
    sender.ws.send(JSON.stringify({
      type: 'transferError',
      message: 'Zielgerät ist offline'
    }));
  }
}

// Übertragung ablehnen behandeln
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

// Übertragung akzeptieren behandeln
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

// Dateidaten verarbeiten
function handleFileData(deviceId, data) {
  // Datei an Zielgerät weiterleiten
  if (data.targetDeviceId) {
    const targetDevice = devices.get(data.targetDeviceId);
    if (targetDevice && targetDevice.online && targetDevice.ws && targetDevice.ws.readyState === WebSocket.OPEN) {
      targetDevice.ws.send(JSON.stringify({
        type: 'fileData',
        fileName: data.fileName,
        fileType: data.fileType,
        fileSize: data.fileSize,
        data: data.data
      }));
      console.log(`📨 Datei ${data.fileName} an Empfänger weitergeleitet`);
    }
  }
}

// Datei-Download verarbeiten
function handleFileDownload(deviceId, data) {
  const device = devices.get(deviceId);
  const transfer = fileTransfers.get(data.transferId);
  
  if (!transfer) {
    if (device.online && device.ws) {
      device.ws.send(JSON.stringify({
        type: 'downloadError',
        message: 'Datei nicht gefunden'
      }));
    }
    return;
  }

  // Fordere den Sender auf, die Datei zu senden
  const sender = devices.get(transfer.fromDeviceId);
  if (sender && sender.online && sender.ws && sender.ws.readyState === WebSocket.OPEN) {
    sender.ws.send(JSON.stringify({
      type: 'sendFileData',
      targetDeviceId: deviceId,
      transferId: data.transferId,
      fileIndex: data.fileIndex
    }));
    console.log(`📥 Fordere Datei ${data.fileIndex} von Sender an`);
  } else {
    if (device.online && device.ws) {
      device.ws.send(JSON.stringify({
        type: 'downloadError',
        message: 'Sender nicht verfügbar'
      }));
    }
  }
}

// Geräteliste an alle Clients in einem Raum senden
function broadcastDeviceList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  const deviceList = Array.from(room.devices)
    .map(deviceId => devices.get(deviceId))
    .filter(device => device && device.online) // Nur online Geräte
    .map(device => ({
      id: device.id,
      name: device.name,
      type: device.type,
      platform: device.platform,
      browser: device.browser,
      pinned: device.pinned || false,
      online: device.online || false,
      lastSeen: device.lastSeen
    }));
  
  const message = JSON.stringify({
    type: 'deviceList',
    devices: deviceList
  });
  
  broadcastToRoom(roomId, {
    type: 'deviceList',
    devices: deviceList
  });
}

// IDs generieren
function generateTransferId() {
  return 'transfer-' + Math.random().toString(36).substr(2, 9);
}

// API-Routen
app.post('/api/upload', upload.array('files'), (req, res) => {
  try {
    const files = req.files.map(file => ({
      name: file.originalname,
      size: file.size,
      type: file.mimetype,
      path: file.filename,
      url: `/api/download/${file.filename}`
    }));
    
    res.json({
      success: true,
      files: files
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Download-Route
app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);
  
  if (fs.existsSync(filePath)) {
    const originalName = filename.split('-').slice(1).join('-');
    res.setHeader('Content-Disposition', `attachment; filename="${originalName}"`);
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Datei nicht gefunden' });
  }
});

app.get('/api/devices', (req, res) => {
  const deviceList = Array.from(devices.values()).map(device => ({
    id: device.id,
    name: device.name,
    type: device.type,
    platform: device.platform,
    browser: device.browser,
    pinned: device.pinned || false,
    online: device.online || false,
    lastSeen: device.lastSeen
  }));
  
  res.json(deviceList);
});

// Gerät anpinnen/abpinnen API
app.post('/api/devices/:deviceId/toggle-pin', (req, res) => {
  const deviceId = req.params.deviceId;
  const device = devices.get(deviceId);
  
  if (!device) {
    return res.status(404).json({ error: 'Gerät nicht gefunden' });
  }
  
  device.pinned = !device.pinned;
  if (device.roomId) {
    broadcastDeviceList(device.roomId);
  }
  saveDevices();
  
  res.json({
    success: true,
    pinned: device.pinned,
    message: `Gerät ${device.pinned ? 'angepinnt' : 'abgepinnt'}`
  });
});

// Hauptroute
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Dateigröße formatieren
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Server starten
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 ETKn Share Server läuft auf Port ${PORT}`);
  console.log(`🌐 Besuchen Sie: http://localhost:${PORT}`);
  console.log(`🏠 Raum-basierte Geräteerkennung aktiviert`);
});

// Regelmäßige Bereinigung
setInterval(() => {
  const now = new Date();
  const deviceTimeout = 30 * 60 * 1000; // 30 Minuten für nicht angepinnte Geräte
  const pinnedDeviceTimeout = 24 * 60 * 60 * 1000; // 24 Stunden für angepinnte Geräte
  const transferTimeout = 60 * 60 * 1000;
  
  let cleanedCount = 0;
  
  devices.forEach((device, deviceId) => {
    const timeSinceLastSeen = now - device.lastSeen;
    const isExpired = device.pinned ? 
      timeSinceLastSeen > pinnedDeviceTimeout : 
      timeSinceLastSeen > deviceTimeout;
    
    if (isExpired && !device.online) {
      console.log(`🧹 Entferne veraltetes Gerät: ${device.name}`);
      
      // Verlasse Raum falls nötig
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
      cleanedCount++;
    }
  });
  
  if (cleanedCount > 0) {
    console.log(`🧹 ${cleanedCount} veraltete Geräte bereinigt`);
    saveDevices();
  }
  
  fileTransfers.forEach((transfer, transferId) => {
    if (now - transfer.timestamp > transferTimeout) {
      fileTransfers.delete(transferId);
    }
  });
}, 60000); // Jede Minute prüfen