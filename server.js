const { WebcastPushConnection } = require('tiktok-live-connector');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

// ─── Logger ───────────────────────────────────────────────────────────────────
const log = {
    info:  (msg, ...args) => console.log(`[${new Date().toISOString()}] [INFO]  ${msg}`, ...args),
    warn:  (msg, ...args) => console.warn(`[${new Date().toISOString()}] [WARN]  ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[${new Date().toISOString()}] [ERROR] ${msg}`, ...args),
    ok:    (msg, ...args) => console.log(`[${new Date().toISOString()}] [OK]    ${msg}`, ...args),
};

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

// ─── Apodos ───────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path_apodos = path.join(__dirname, 'apodos.json');

function loadApodos() {
    try {
        if (fs.existsSync(path_apodos)) {
            const raw = fs.readFileSync(path_apodos, 'utf8');
            return JSON.parse(raw);
        }
    } catch (e) {
        log.error("Error al cargar apodos.json:", e.message);
    }
    return {};
}

function saveApodos(data) {
    try {
        fs.writeFileSync(path_apodos, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (e) {
        log.error("Error al guardar apodos.json:", e.message);
        return false;
    }
}

// ─── Configuración Global en Memoria ──────────────────────────────────────────
let globalConfig = {
    requireGift: false,
    keywords: [
        { key: "hola", reply: "¡Hola {usuario}! Bienvenido al directo." },
        { key: "yt",   reply: "Suscríbete a mi canal de Youtube." }
    ],
    vipList: ["admin_test"],
    anuncios: {
        activo: false,
        intervalo: 5,
        orden: "secuencial",
        frases: [
            "No olvides darle doble toque a la pantalla para apoyar el directo.",
            "¡Comparte el directo con tus amigos!"
        ]
    }
};

// ─── Servidor Express & Socket.io ─────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Estructura para manejar múltiples salas activas por usuario de TikTok
const rooms = new Map();

function getOrCreateRoom(username) {
    if (!rooms.has(username)) {
        rooms.set(username, {
            username,
            connection: null,
            sockets: new Set(),
            queue: [],
            isProcessingQueue: false,
            giftStreaks: new Map(),
            lastInteractions: new Map(),
            anuncioIndex: 0,
            anuncioTimer: null,
            reconnectTimer: null
        });
    }
    return rooms.get(username);
}

// ─── Lógica de Conexión a TikTok Live ─────────────────────────────────────────
function connectTikTok(username, adminSocket) {
    const room = getOrCreateRoom(username);

    if (room.connection) {
        adminSocket.emit('toast', { type: 'info', message: `Ya hay una conexión en curso para @${username}` });
        return;
    }

    log.info(`Intentando conectar a TikTok Live: @${username}`);
    adminSocket.emit('toast', { type: 'info', message: `Conectando a @${username}...` });

    // Opciones de conexión incluyendo la cookie de sesión para evitar bloqueos de IP
    const connectionOptions = {
        enableExtendedGiftInfo: true,
        requestOptions: {
            timeout: 10000
        }
    };

    if (process.env.TIKTOK_SESSION_ID) {
        connectionOptions.sessionId = process.env.TIKTOK_SESSION_ID;
        log.info("Usando TIKTOK_SESSION_ID provisto por el entorno.");
    }

    try {
        room.connection = new WebcastPushConnection(username, connectionOptions);
    } catch (err) {
        log.error(`Error al instanciar WebcastPushConnection:`, err.message);
        adminSocket.emit('status', { connected: false, error: err.message });
        return;
    }

    room.connection.connect()
        .then(state => {
            log.ok(`¡Conectado exitosamente al Live de @${username}! (RoomID: ${state.roomId})`);
            room.giftStreaks.clear();
            room.lastInteractions.clear();
            
            io.to(username).emit('status', { connected: true, username, roomId: state.roomId });
            startAnuncios(room);
        })
        .catch(err => {
            log.error(`Error al conectar con @${username}:`, err.message);
            io.to(username).emit('status', { connected: false, error: err.message });
            room.connection = null;
        });

    // ─── Manejo de Eventos del Live ───────────────────────────────────────────
    room.connection.on('chat', data => {
        const apodos = loadApodos();
        const displayName = apodos[data.uniqueId] || data.nickname || data.uniqueId;
        const isVIP = globalConfig.vipList.includes(data.uniqueId.toLowerCase());
        
        let sinTTS = false;
        if (globalConfig.requireGift && !isVIP) {
            sinTTS = true; 
        }

        const payload = {
            id: data.msgId,
            type: 'chat',
            username: data.uniqueId,
            nickname: displayName,
            message: data.comment,
            profileUrl: data.profilePictureUrl,
            sinTTS: sinTTS,
            timestamp: Date.now()
        };

        io.to(username).emit('evt-chat', payload);

        // Procesar palabras clave configuradas
        if (globalConfig.keywords && globalConfig.keywords.length > 0) {
            const cleanComment = data.comment.toLowerCase().trim();
            for (const kw of globalConfig.keywords) {
                if (cleanComment === kw.key.toLowerCase().trim()) {
                    let replyText = kw.reply.replace(/{usuario}/g, displayName);
                    setTimeout(() => {
                        io.to(username).emit('evt-chat', {
                            id: `kw-${Date.now()}`,
                            type: 'keyword',
                            username: 'bot_system',
                            nickname: '🤖 ASISTENTE',
                            message: replyText,
                            profileUrl: '',
                            sinTTS: false,
                            timestamp: Date.now()
                        });
                    }, 800);
                    break;
                }
            }
        }
    });

    room.connection.on('gift', data => {
        if (data.giftType === 1 && !data.repeatEnd) {
            room.giftStreaks.set(data.userId, data);
            return;
        }

        room.giftStreaks.delete(data.userId);
        const count = data.repeatCount || 1;
        const apodos = loadApodos();
        const displayName = apodos[data.uniqueId] || data.nickname || data.uniqueId;

        const payload = {
            id: `${data.msgId}-${count}`,
            type: 'gift',
            username: data.uniqueId,
            nickname: displayName,
            giftId: data.giftId,
            giftName: data.giftName,
            giftIcon: data.giftIconUrl,
            diamondCount: data.diamondCount,
            repeatCount: count,
            profileUrl: data.profilePictureUrl,
            timestamp: Date.now()
        };

        io.to(username).emit('evt-gift', payload);
    });

    room.connection.on('follow', data => {
        const apodos = loadApodos();
        const displayName = apodos[data.uniqueId] || data.nickname || data.uniqueId;

        io.to(username).emit('evt-social', {
            id: `follow-${data.userId}-${Date.now()}`,
            type: 'follow',
            username: data.uniqueId,
            nickname: displayName,
            profileUrl: data.profilePictureUrl,
            message: 'se ha suscrito/seguido',
            timestamp: Date.now()
        });
    });

    room.connection.on('like', data => {
        const now = Date.now();
        const last = room.lastInteractions.get(`${data.uniqueId}-like`) || 0;
        if (now - last < 30000) return; // Filtro de spam cada 30s
        room.lastInteractions.set(`${data.uniqueId}-like`, now);

        const apodos = loadApodos();
        const displayName = apodos[data.uniqueId] || data.nickname || data.uniqueId;

        io.to(username).emit('evt-social', {
            id: `like-${data.userId}-${now}`,
            type: 'like',
            username: data.uniqueId,
            nickname: displayName,
            profileUrl: data.profilePictureUrl,
            message: 'le dio me gusta al directo',
            timestamp: now
        });
    });

    room.connection.on('share', data => {
        const now = Date.now();
        const last = room.lastInteractions.get(`${data.uniqueId}-share`) || 0;
        if (now - last < 30000) return;
        room.lastInteractions.set(`${data.uniqueId}-share`, now);

        const apodos = loadApodos();
        const displayName = apodos[data.uniqueId] || data.nickname || data.uniqueId;

        io.to(username).emit('evt-social', {
            id: `share-${data.userId}-${now}`,
            type: 'share',
            username: data.uniqueId,
            nickname: displayName,
            profileUrl: data.profilePictureUrl,
            message: 'compartió el directo',
            timestamp: now
        });
    });

    room.connection.on('disconnected', () => {
        log.warn(`TikTok Connection cerrada para @${username}`);
        io.to(username).emit('status', { connected: false });
        stopAnuncios(room);
        room.connection = null;
    });

    room.connection.on('streamEnd', () => {
        log.warn(`El directo de @${username} ha finalizado.`);
        io.to(username).emit('status', { connected: false, error: 'El directo terminó' });
        stopAnuncios(room);
        room.connection = null;
    });
}

function disconnectTikTok(username) {
    const room = rooms.get(username);
    if (room && room.connection) {
        try {
            room.connection.disconnect();
        } catch (e) {
            log.error(`Error al desconectar manualmente:`, e.message);
        }
        stopAnuncios(room);
        room.connection = null;
        io.to(username).emit('status', { connected: false });
        log.info(`Conexión abortada manualmente para @${username}`);
    }
}

// ─── Sistema de Anuncios Periódicos ───────────────────────────────────────────
function startAnuncios(room) {
    stopAnuncios(room);
    if (!globalConfig.anuncios || !globalConfig.anuncios.activo) return;
    if (!globalConfig.anuncios.frases || globalConfig.anuncios.frases.length === 0) return;

    const intervalMs = (globalConfig.anuncios.intervalo || 5) * 60 * 1000;
    
    room.anuncioTimer = setInterval(() => {
        const frases = globalConfig.anuncios.frases;
        let frase = "";

        if (globalConfig.anuncios.orden === 'aleatorio') {
            const idx = Math.floor(Math.random() * frases.length);
            frase = frases[idx];
        } else {
            if (room.anuncioIndex >= frases.length) room.anuncioIndex = 0;
            frase = frases[room.anuncioIndex];
            room.anuncioIndex++;
        }

        io.to(room.username).emit('evt-chat', {
            id: `anuncio-${Date.now()}`,
            type: 'anuncio',
            username: 'bot_anuncio',
            nickname: '📢 AVISO',
            message: frase,
            profileUrl: '',
            sinTTS: false,
            timestamp: Date.now()
        });
    }, intervalMs);
}

function stopAnuncios(room) {
    if (room && room.anuncioTimer) {
        clearInterval(room.anuncioTimer);
        room.anuncioTimer = null;
    }
}

// ─── Control de Websockets (Clientes y Admin) ─────────────────────────────────
io.on('connection', (socket) => {
    let currentRoomUsername = null;
    let isAdmin = false;

    socket.on('auth-admin', (pass) => {
        if (pass === ADMIN_PASSWORD) {
            isAdmin = true;
            socket.join('admins');
            socket.emit('auth-result', { success: true, config: globalConfig, apodos: loadApodos() });
            log.info(`Socket ${socket.id} autenticado como ADMINISTRADOR.`);
        } else {
            socket.emit('auth-result', { success: false, error: 'Contraseña incorrecta' });
        }
    });

    socket.on('join-room', (username) => {
        if (!username) return;
        const userClean = username.toLowerCase().trim();
        currentRoomUsername = userClean;
        socket.join(userClean);

        const room = getOrCreateRoom(userClean);
        room.sockets.add(socket.id);

        socket.emit('status', {
            connected: !!room.connection,
            username: userClean,
            roomId: room.connection?.roomId || null
        });
    });

    // Acciones exclusivas del administrador
    socket.on('admin-connect', (targetUser) => {
        if (!isAdmin) return;
        if (!targetUser) return;
        connectTikTok(targetUser.toLowerCase().trim(), socket);
    });

    socket.on('admin-disconnect', (targetUser) => {
        if (!isAdmin) return;
        if (!targetUser) return;
        disconnectTikTok(targetUser.toLowerCase().trim());
    });

    socket.on('admin-update-config', (newCfg) => {
        if (!isAdmin) return;
        globalConfig = { ...globalConfig, ...newCfg };
        io.to('admins').emit('config-updated', globalConfig);
        
        for (const [_, room] of rooms) {
            if (room.connection) {
                startAnuncios(room);
            }
        }
    });

    socket.on('admin-add-apodo', (data) => {
        if (!isAdmin) return;
        const { username, apodo } = data;
        if (!username || !apodo) return;
        const current = loadApodos();
        current[username] = apodo;
        if (saveApodos(current)) {
            io.to('admins').emit('apodos-updated', current);
        }
    });

    socket.on('admin-delete-apodo', (username) => {
        if (!isAdmin) return;
        const current = loadApodos();
        if (current[username]) {
            delete current[username];
            if (saveApodos(current)) {
                io.to('admins').emit('apodos-updated', current);
            }
        }
    });

    socket.on('admin-play-sound', (data) => {
        if (!isAdmin) return;
        if (currentRoomUsername) {
            io.to(currentRoomUsername).emit('cmd-play-sound', data);
        } else {
            io.emit('cmd-play-sound', data);
        }
    });

    socket.on('admin-music-control', (data) => {
        if (!isAdmin) return;
        if (currentRoomUsername) {
            io.to(currentRoomUsername).emit('cmd-music', data);
        } else {
            io.emit('cmd-music', data);
        }
    });

    socket.on('disconnect', () => {
        if (currentRoomUsername) {
            handleSocketLeaveRoom(currentRoomUsername, socket);
        }
    });
});

function handleSocketLeaveRoom(username, socket) {
    const room = rooms.get(username);
    if (!room) return;
    room.sockets.delete(socket.id);
    if (room.sockets.size === 0) {
        if (room.reconnectTimer) clearTimeout(room.reconnectTimer);
        if (room.connection) try { room.connection.disconnect(); } catch (_) {}
        rooms.delete(username);
        log.info(`Room eliminado: ${username}`);
    }
}

app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        config: globalConfig,
        rooms: [...rooms.keys()].map(u => ({
            username: u,
            sockets: rooms.get(u).sockets.size,
            queueLength: rooms.get(u).queue.length,
        })),
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    log.ok(`Servidor en puerto ${PORT}`);
    log.info(`Admin panel -> http://localhost:${PORT}/admin.html`);
    log.warn(`Contrasena admin: ${ADMIN_PASSWORD}`);
});

// ─── Auto-ping (evita que Render Free pause el servicio) ──────────────────────
if (process.env.RENDER_EXTERNAL_URL) {
    const https = require('https');
    const PING_INTERVAL_MS = 10 * 60 * 1000;

    setInterval(() => {
        const url = `${process.env.RENDER_EXTERNAL_URL}/health`;
        https.get(url, (res) => {
            log.info(`Auto-ping enviado a ${url} - Status: ${res.statusCode}`);
        }).on('error', (err) => {
            log.error(`Error en Auto-ping:`, err.message);
        });
    }, PING_INTERVAL_MS);
}
