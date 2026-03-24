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

// ─── Configuracion global ─────────────────────────────────────────────────────
let globalConfig = {
    maxQueue:  50,
    maxWords:  0,
    maxChars:  0,
    ttsRate:   1.1,
    ttsPitch:  1.0,
};

// ─── App Setup ────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
});

// ─── Rooms ────────────────────────────────────────────────────────────────────
const rooms = new Map();
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECTS     = 5;

// ─── Enqueue comentario ───────────────────────────────────────────────────────
function enqueue(username, usuario, mensaje) {
    const room = rooms.get(username);
    if (!room) return;
    if (room.queue.length >= globalConfig.maxQueue) {
        log.warn(`[${username}] Cola llena (${globalConfig.maxQueue}), descartando: ${usuario}`);
        return;
    }
    room.queue.push({ usuario, mensaje });
    io.to(username).emit('nuevo-comentario', { usuario, mensaje });
    log.ok(`[${username}] ${usuario}: ${mensaje.slice(0, 50)}`);
}

// ─── Enqueue regalo ───────────────────────────────────────────────────────────
function enqueueGift(username, usuario) {
    const room = rooms.get(username);
    if (!room) return;
    if (room.queue.length >= globalConfig.maxQueue) return;
    // Emite evento especial de regalo al frontend
    io.to(username).emit('nuevo-regalo', { usuario });
    log.ok(`[${username}] REGALO de ${usuario}`);
}

// ─── Enqueue seguidor ─────────────────────────────────────────────────────────
function enqueueFollow(username, usuario) {
    const room = rooms.get(username);
    if (!room) return;
    io.to(username).emit('nuevo-follow', { usuario });
    log.ok(`[${username}] FOLLOW de ${usuario}`);
}

// ─── Conexion TikTok Live ─────────────────────────────────────────────────────
function connectToLive(username, reconnectCount = 0) {
    const room = rooms.get(username);
    if (!room) return;
    const conn = new WebcastPushConnection(username);
    room.connection = conn;

    conn.connect()
        .then(state => {
            log.ok(`Conectado a @${username} (roomId: ${state.roomId})`);
            io.to(username).emit('status', { type: 'connected', message: `Conectado al Live de @${username}` });
        })
        .catch(err => {
            log.error(`No se pudo conectar a @${username}: ${err.message}`);
            io.to(username).emit('status', { type: 'error', message: `Error al conectar: ${err.message}` });
            scheduleReconnect(username, reconnectCount);
        });

    // Comentarios de chat
    conn.on('chat', (data) => enqueue(username, data.nickname, data.comment));

    // Regalos — solo se procesa cuando el regalo está "completado" (streakFinished)
    // para no repetir el agradecimiento en cada tick del streak
    conn.on('gift', (data) => {
        const nombre = data.nickname || data.uniqueId || 'alguien';
        // giftType 1 = regalo de streak (se repite), esperamos a que termine
        if (data.giftType === 1 && !data.repeatEnd) return;
        enqueueGift(username, nombre);
    });

    // Nuevos seguidores
    conn.on('social', (data) => {
        if (data.displayType === 'pm_mt_msg_viewer_follow') {
            const nombre = data.nickname || data.uniqueId || 'alguien';
            enqueueFollow(username, nombre);
        }
    });

    conn.on('disconnected', () => {
        log.warn(`[${username}] Desconectado`);
        io.to(username).emit('status', { type: 'reconnecting', message: `Reconectando a @${username}...` });
        scheduleReconnect(username, reconnectCount);
    });

    conn.on('error', (err) => log.error(`[${username}]: ${err.message}`));
}

function scheduleReconnect(username, previousCount) {
    const room = rooms.get(username);
    if (!room || room.sockets.size === 0) return;
    if (previousCount >= MAX_RECONNECTS) {
        io.to(username).emit('status', { type: 'failed', message: `Sin reconexion tras ${MAX_RECONNECTS} intentos` });
        return;
    }
    const delay = RECONNECT_DELAY_MS * (previousCount + 1);
    room.reconnectTimer = setTimeout(() => {
        if (rooms.has(username) && rooms.get(username).sockets.size > 0)
            connectToLive(username, previousCount + 1);
    }, delay);
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    log.info(`Socket conectado: ${socket.id}`);
    let currentRoom = null;
    let isAdmin = false;

    socket.emit('config-update', globalConfig);

    socket.on('join-live', (username) => {
        if (!username || typeof username !== 'string') {
            socket.emit('status', { type: 'error', message: 'Username invalido' });
            return;
        }
        username = username.trim().replace(/^@/, '').toLowerCase();
        if (currentRoom) leaveRoom(socket, currentRoom);
        currentRoom = username;
        socket.join(username);

        if (!rooms.has(username)) {
            rooms.set(username, { connection: null, sockets: new Set([socket.id]), queue: [], reconnectTimer: null, reconnectCount: 0 });
            connectToLive(username);
        } else {
            rooms.get(username).sockets.add(socket.id);
            socket.emit('status', { type: 'connected', message: `Unido al Live de @${username}` });
        }
    });

    socket.on('leave-live', () => {
        if (currentRoom) { leaveRoom(socket, currentRoom); currentRoom = null; }
    });

    socket.on('admin-login', (password) => {
        if (password === ADMIN_PASSWORD) {
            isAdmin = true;
            socket.join('admins');
            socket.emit('admin-auth', { ok: true, config: globalConfig });
            log.ok(`Admin autenticado: ${socket.id}`);
        } else {
            socket.emit('admin-auth', { ok: false });
            log.warn(`Contrasena incorrecta desde ${socket.id}`);
        }
    });

    socket.on('admin-set-config', (newConfig) => {
        if (!isAdmin) { socket.emit('status', { type: 'error', message: 'No autorizado' }); return; }
        const rules = {
            maxQueue: [1,   500],
            maxWords: [0,   100],
            maxChars: [0,   500],
            ttsRate:  [0.5, 3.0],
            ttsPitch: [0.0, 2.0],
        };
        for (const [key, [min, max]] of Object.entries(rules)) {
            if (newConfig[key] !== undefined) {
                const val = parseFloat(newConfig[key]);
                if (!isNaN(val) && val >= min && val <= max) globalConfig[key] = val;
            }
        }
        log.ok('Config actualizada:', JSON.stringify(globalConfig));
        io.emit('config-update', globalConfig);
        socket.emit('admin-config-saved', globalConfig);
    });

    socket.on('disconnect', () => {
        if (currentRoom) leaveRoom(socket, currentRoom);
    });
});

function leaveRoom(socket, username) {
    socket.leave(username);
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
