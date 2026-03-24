const { WebcastPushConnection } = require('tiktok-live-connector');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

// ─── Logger ──────────────────────────────────────────────────────────────────
const log = {
    info:  (msg, ...args) => console.log(`[${new Date().toISOString()}] ℹ️  ${msg}`, ...args),
    warn:  (msg, ...args) => console.warn(`[${new Date().toISOString()}] ⚠️  ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[${new Date().toISOString()}] ❌ ${msg}`, ...args),
    ok:    (msg, ...args) => console.log(`[${new Date().toISOString()}] ✅ ${msg}`, ...args),
};

// ─── App Setup ────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
});

// ─── Room / Session Registry ──────────────────────────────────────────────────
// rooms = { username: { connection, sockets: Set, queue, processing, reconnectTimer } }
const rooms = new Map();

const MAX_QUEUE          = 50;
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECTS     = 5;

// ─── Emit comentario directo (TTS lo hace el navegador) ───────────────────────
function enqueue(username, usuario, mensaje) {
    const room = rooms.get(username);
    if (!room) return;
    if (room.queue.length >= MAX_QUEUE) {
        log.warn(`[${username}] Cola llena, descartando comentario de ${usuario}`);
        return;
    }
    room.queue.push({ usuario, mensaje });
    // Emitir directo — el frontend habla con Web Speech API
    io.to(username).emit('nuevo-comentario', { usuario, mensaje });
    log.ok(`[${username}] ${usuario}: ${mensaje.slice(0, 50)}`);
}

// ─── Conexión a TikTok Live ───────────────────────────────────────────────────
function connectToLive(username, reconnectCount = 0) {
    const room = rooms.get(username);
    if (!room) return;

    const tiktokConnection = new WebcastPushConnection(username);
    room.connection = tiktokConnection;

    tiktokConnection.connect()
        .then(state => {
            log.ok(`Conectado al live de @${username} (roomId: ${state.roomId})`);
            room.reconnectCount = 0;
            io.to(username).emit('status', {
                type: 'connected',
                message: `✅ Conectado al Live de @${username}`,
            });
        })
        .catch(err => {
            log.error(`No se pudo conectar a @${username}:`, err.message);
            io.to(username).emit('status', {
                type: 'error',
                message: `❌ Error al conectar: ${err.message}`,
            });
            scheduleReconnect(username, reconnectCount);
        });

    // Comentarios de chat
    tiktokConnection.on('chat', (data) => {
        enqueue(username, data.nickname, data.comment);
    });

    // Desconexión inesperada
    tiktokConnection.on('disconnected', () => {
        log.warn(`[${username}] Desconectado inesperadamente`);
        io.to(username).emit('status', {
            type: 'reconnecting',
            message: `🔄 Reconectando a @${username}...`,
        });
        scheduleReconnect(username, reconnectCount);
    });

    // Errores de stream
    tiktokConnection.on('error', (err) => {
        log.error(`[${username}] Error de conexión:`, err.message);
    });
}

function scheduleReconnect(username, previousCount) {
    const room = rooms.get(username);
    if (!room || room.sockets.size === 0) return; // sin clientes, no reconectar

    if (previousCount >= MAX_RECONNECTS) {
        log.error(`[${username}] Máximo de reconexiones alcanzado`);
        io.to(username).emit('status', {
            type: 'failed',
            message: `❌ No se pudo reconectar a @${username} tras ${MAX_RECONNECTS} intentos`,
        });
        return;
    }

    const delay = RECONNECT_DELAY_MS * (previousCount + 1);
    log.info(`[${username}] Reintentando en ${delay / 1000}s (intento ${previousCount + 1}/${MAX_RECONNECTS})`);

    room.reconnectTimer = setTimeout(() => {
        if (rooms.has(username) && rooms.get(username).sockets.size > 0) {
            connectToLive(username, previousCount + 1);
        }
    }, delay);
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    log.info(`Socket conectado: ${socket.id}`);
    let currentRoom = null;

    socket.on('join-live', (username) => {
        if (!username || typeof username !== 'string') {
            socket.emit('status', { type: 'error', message: '❌ Username inválido' });
            return;
        }

        username = username.trim().replace(/^@/, '').toLowerCase();

        // Salir de room anterior si existe
        if (currentRoom) {
            leaveRoom(socket, currentRoom);
        }

        currentRoom = username;
        socket.join(username);

        if (!rooms.has(username)) {
            // Primera conexión a este room
            rooms.set(username, {
                connection: null,
                sockets: new Set([socket.id]),
                queue: [],
                processing: false,
                reconnectTimer: null,
                reconnectCount: 0,
            });
            log.info(`Room creado: ${username}`);
            connectToLive(username);
        } else {
            // Room ya existe, unirse sin reconectar
            rooms.get(username).sockets.add(socket.id);
            log.info(`Socket ${socket.id} unido al room existente: ${username}`);
            socket.emit('status', {
                type: 'connected',
                message: `✅ Unido al Live de @${username}`,
            });
        }
    });

    socket.on('leave-live', () => {
        if (currentRoom) {
            leaveRoom(socket, currentRoom);
            currentRoom = null;
        }
    });

    socket.on('disconnect', () => {
        log.info(`Socket desconectado: ${socket.id}`);
        if (currentRoom) leaveRoom(socket, currentRoom);
    });
});

function leaveRoom(socket, username) {
    socket.leave(username);
    const room = rooms.get(username);
    if (!room) return;

    room.sockets.delete(socket.id);
    log.info(`Socket ${socket.id} salió del room: ${username} (quedan ${room.sockets.size})`);

    if (room.sockets.size === 0) {
        // Último cliente: limpiar todo
        if (room.reconnectTimer) clearTimeout(room.reconnectTimer);
        if (room.connection) {
            try { room.connection.disconnect(); } catch (_) {}
        }
        rooms.delete(username);
        log.info(`Room eliminado: ${username}`);
    }
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    const activeRooms = [...rooms.keys()].map(u => ({
        username: u,
        sockets: rooms.get(u).sockets.size,
        queueLength: rooms.get(u).queue.length,
    }));
    res.json({ status: 'ok', activeRooms });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    log.ok(`Servidor escuchando en el puerto ${PORT}`);
});
