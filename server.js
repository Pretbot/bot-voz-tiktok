const { WebcastPushConnection } = require('tiktok-live-connector');
const tiktokTTS = require('tiktok-tts');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

io.on('connection', (socket) => {
    let tiktokConnection;

    socket.on('join-live', (username) => {
        console.log(`Intentando conectar a: ${username}`);
        tiktokConnection = new WebcastPushConnection(username);

        tiktokConnection.connect().then(state => {
            socket.emit('status', `Conectado al Live de ${username}`);
        }).catch(err => {
            socket.emit('status', `Error: ${err.message}`);
        });

        // Evento cuando llega un comentario
        tiktokConnection.on('chat', async (data) => {
            try {
                // Generamos el audio con la voz de TikTok (es_mx_002 es voz femenina)
                const audioBase64 = await tiktokTTS.getAudioBase64(data.comment, 'es_mx_002');
                
                io.emit('nuevo-comentario-voz', {
                    usuario: data.nickname,
                    mensaje: data.comment,
                    audio: audioBase64
                });
            } catch (err) {
                console.error("Error en TTS:", err);
            }
        });
    });

    socket.on('disconnect', () => {
        if (tiktokConnection) tiktokConnection.disconnect();
    });
});

// Render usa la variable de entorno PORT
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});
