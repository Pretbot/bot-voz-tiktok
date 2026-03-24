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
        tiktokConnection = new WebcastPushConnection(username);

        tiktokConnection.connect().then(state => {
            socket.emit('status', `Conectado al Live de ${username}`);
        }).catch(err => {
            socket.emit('status', `Error: ${err.message}`);
        });

        tiktokConnection.on('chat', async (data) => {
            try {
                // Generamos el audio (Voz femenina de TikTok)
                const audioBase64 = await tiktokTTS.getAudioBase64(data.comment, { voice: 'es_mx_002' });
                
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor en puerto ${PORT}`);
});
