const { WebcastPushConnection } = require('tiktok-live-connector');
const tiktokTTS = require('tiktok-tts'); 
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

// Configuración de Socket.io
const io = new Server(server, {
    cors: { origin: "*" }
});

io.on('connection', (socket) => {
    let tiktokConnection;

    socket.on('join-live', (username) => {
        // 1. Limpiamos el nombre (le quitamos el @ si lo trae)
        const cleanUsername = username.replace('@', '').trim();
        
        tiktokConnection = new WebcastPushConnection(cleanUsername);

        // 2. Intentamos conectar al Live
        tiktokConnection.connect().then(state => {
            console.log(`Conectado al Live de: ${cleanUsername}`);
            socket.emit('status', `Conectado al Live de ${cleanUsername}`);
        }).catch(err => {
            console.error("Error al conectar:", err);
            socket.emit('status', `Error: ${err.message}`);
        });

        // 3. Escuchamos los comentarios del chat
        tiktokConnection.on('chat', async (data) => {
            console.log(`Nuevo comentario: ${data.uniqueId}: ${data.comment}`);
            
            try {
                // Generamos el audio base64 con la voz de TikTok (es_mx_002)
                const audioBase64 = await tiktokTTS.getAudioBase64(data.comment, { voice: 'es_mx_002' });
                
                // Enviamos todo a tu página de InfinityFree
                io.emit('nuevo-comentario-voz', {
                    usuario: data.uniqueId,
                    mensaje: data.comment,
                    audio: audioBase64
                });
            } catch (err) {
                console.error("Error generando voz:", err);
                // Si la voz falla, enviamos el texto solo para que no se pierda
                io.emit('nuevo-comentario-voz', {
                    usuario: data.uniqueId,
                    mensaje: data.comment,
                    audio: null
                });
            }
        });
    });

    // Desconectar cuando se cierra la página
    socket.on('disconnect', () => {
        if (tiktokConnection) {
            tiktokConnection.disconnect();
            console.log("Desconectado de TikTok Live");
        }
    });
});

// Usamos el puerto que nos da Render o el 3000 por defecto
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});
server.listen(PORT, () => {
    console.log(`Servidor en puerto ${PORT}`);
});
