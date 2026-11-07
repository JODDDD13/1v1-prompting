require('dotenv').config({ path: './game.env' }); 

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allows connections from anywhere
    methods: ["GET", "POST"]
  }
});

// Serve static assets
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'game.html'));
});

// ==========================================
// ☁️ CLOUDFLARE AI CONFIGURATION
// ==========================================
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

async function generateImage(prompt) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: prompt,
        steps: 4
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AI ERROR]', response.status, errorText);
      return null;
    }

    // ✅ Key fix: Parse JSON, not text
    const data = await response.json();
    
    if (data.success && data.result && data.result.image) {
      // flux-1-schnell returns Base64, we need to add a data URI prefix to make it a valid image
      // According to Cloudflare documentation, the format is usually JPEG
      return `data:image/jpeg;base64,${data.result.image}`;
    } else {
      console.error('[AI ERROR] Unexpected response format:', data);
      return null;
    }

  } catch (error) {
    console.error('[AI NETWORK ERROR]', error);
    return null;
  }
}
// ==========================================

const rooms = {};

io.on('connection', (socket) => {
  console.log(`[NET] Client connected: ${socket.id}`);

  socket.on('host_room', ({ username }) => {
    const roomCode = 'PK-' + Math.floor(1000 + Math.random() * 9000);
    rooms[roomCode] = {
      code: roomCode,
      players: [{ id: socket.id, username, role: 'host', ready: true, topic: null, prompt: '', locked: false }]
    };
    socket.join(roomCode);
    socket.emit('room_created', { roomCode, player: rooms[roomCode].players[0] });
    console.log(`[ROOM] Created ${roomCode} by ${username}`);
  });

  socket.on('join_room', ({ username, roomCode }) => {
    const code = roomCode ? roomCode.toUpperCase() : '';
    const room = rooms[code];

    if (!room) {
      socket.emit('error_msg', 'Room code not found.');
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('error_msg', 'Room is currently full.');
      return;
    }

    const opponent = { id: socket.id, username, role: 'opponent', ready: true, topic: null, prompt: '', locked: false };
    room.players.push(opponent);
    socket.join(code);

    io.to(code).emit('match_ready', {
      roomCode: code,
      players: room.players
    });
    console.log(`[ROOM] ${username} joined ${code}`);
  });

  socket.on('select_topic', ({ roomCode, topic }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    
    // Only allow the host (player[0]) to update the topic
    if (player && player.role === 'host') {
      player.topic = topic;
      
      // Tell everyone in the room what the host chose
      io.to(roomCode).emit('topic_updated', { topic: topic });
    }
  });

  socket.on('start_battle', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    // Only host can trigger the start
    if (player && player.role === 'host' && player.topic) {
      io.to(roomCode).emit('start_arena', { chosenTopic: player.topic });
    }
  });
  
  socket.on('update_prompt', ({ roomCode, promptText }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.prompt = promptText;
      const wordCount = promptText.trim().split(/\s+/).filter(w => w.length > 0).length;
      socket.to(roomCode).emit('opponent_typing', { wordCount });
    }
  });

  socket.on('lock_prompt', async ({ roomCode, promptText }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.prompt = promptText;
      player.locked = true;
    }

    socket.to(roomCode).emit('opponent_locked');

    const bothLocked = room.players.length === 2 && room.players.every(p => p.locked);
    if (bothLocked) {
      io.to(roomCode).emit('match_complete', { status: 'generating' });

      console.log(`[AI] Generating images for room ${roomCode}...`);
      
      const [image1, image2] = await Promise.all([
        generateImage(room.players[0].prompt),
        generateImage(room.players[1].prompt)
      ]);

      if (image1 && image2) {
        io.to(roomCode).emit('match_results', {
          players: room.players,
          images: [image1, image2]
        });
      } else {
        io.to(roomCode).emit('error_msg', 'AI Generation failed. Check server console.');
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`[NET] Client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[PAINT OFF] Server running on http://localhost:${PORT}`);
});