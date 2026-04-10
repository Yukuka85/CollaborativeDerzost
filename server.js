const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// --- Upstash Redis REST API ---
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  if (!REDIS_URL) return null;
  try {
    const res = await fetch(`${REDIS_URL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', key])
    });
    const data = await res.json();
    if (data.error) { console.error('Redis GET error:', data.error); return null; }
    return data.result ? JSON.parse(data.result) : null;
  } catch (e) {
    console.error('Redis GET failed:', e.message);
    return null;
  }
}

async function redisSet(key, value) {
  if (!REDIS_URL) return;
  try {
    const res = await fetch(`${REDIS_URL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', key, JSON.stringify(value)])
    });
    const data = await res.json();
    if (data.error) console.error('Redis SET error:', data.error);
    else console.log('Redis saved:', key, '(' + value.people.length + ' people)');
  } catch (e) {
    console.error('Redis SET failed:', e.message);
  }
}

// --- Room storage (in-memory cache + Redis persistence) ---
const rooms = new Map();

async function getOrCreateRoom(roomId) {
  if (rooms.has(roomId)) return rooms.get(roomId);

  // Try loading from Redis
  const saved = await redisGet(`room:${roomId}`);
  if (saved) {
    console.log('Redis loaded room:', roomId, '(' + saved.people.length + ' people)');
    rooms.set(roomId, saved);
    return saved;
  }
  console.log('Creating new room:', roomId);

  const isDemo = (roomId === 'demo');
  const room = {
    axes: {
      left: isDemo ? 'Не в зуб ногой' : 'Дерзкая',
      right: isDemo ? 'Разбираюсь в AI' : 'Милая',
      top: isDemo ? 'Альфа' : 'Открытая',
      bottom: isDemo ? 'Бумер' : 'Закрытая'
    },
    people: []
  };
  rooms.set(roomId, room);
  await redisSet(`room:${roomId}`, room);
  return room;
}

// Debounced save per room
const saveTimers = new Map();
function scheduleSave(roomId) {
  if (saveTimers.has(roomId)) return;
  saveTimers.set(roomId, setTimeout(async () => {
    saveTimers.delete(roomId);
    const room = rooms.get(roomId);
    if (room) await redisSet(`room:${roomId}`, room);
  }, 1000));
}

function computeAverage(person) {
  const voters = Object.keys(person.votes);
  if (voters.length === 0) return;
  const sum = voters.reduce((acc, v) => {
    acc.x += person.votes[v].x;
    acc.y += person.votes[v].y;
    return acc;
  }, { x: 0, y: 0 });
  person.x = sum.x / voters.length;
  person.y = sum.y / voters.length;
  person.voteCount = voters.length;
}

function serializeRoom(room) {
  return {
    axes: room.axes,
    people: room.people.map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x,
      y: p.y,
      votes: p.votes,
      voteCount: p.voteCount || 0
    }))
  };
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', async (roomId) => {
    currentRoom = roomId;
    socket.join(roomId);
    const room = await getOrCreateRoom(roomId);
    socket.emit('sync-state', serializeRoom(room));
  });

  socket.on('add-person', async (person) => {
    if (!currentRoom) return;
    const room = await getOrCreateRoom(currentRoom);
    person.id = crypto.randomUUID();
    person.votes = {};
    person.voteCount = 0;
    room.people.push(person);
    io.to(currentRoom).emit('person-added', person);
    scheduleSave(currentRoom);
  });

  socket.on('vote-person', async ({ personId, voterId, x, y }) => {
    if (!currentRoom) return;
    const room = await getOrCreateRoom(currentRoom);
    const person = room.people.find(p => p.id === personId);
    if (!person) return;
    person.votes[voterId] = { x, y };
    computeAverage(person);
    io.to(currentRoom).emit('person-voted', {
      personId,
      voterId,
      voteX: x,
      voteY: y,
      avgX: person.x,
      avgY: person.y,
      voteCount: person.voteCount,
      votes: person.votes
    });
    scheduleSave(currentRoom);
  });

  socket.on('remove-person', async (id) => {
    if (!currentRoom) return;
    const room = await getOrCreateRoom(currentRoom);
    room.people = room.people.filter(p => p.id !== id);
    io.to(currentRoom).emit('person-removed', id);
    scheduleSave(currentRoom);
  });

  socket.on('update-axes', async (axes) => {
    if (!currentRoom) return;
    const room = await getOrCreateRoom(currentRoom);
    room.axes = axes;
    socket.to(currentRoom).emit('axes-updated', axes);
    scheduleSave(currentRoom);
  });
});

app.get('/new', (req, res) => {
  const roomId = crypto.randomBytes(4).toString('hex');
  res.redirect(`/?room=${roomId}`);
});

app.get('/demo', (req, res) => {
  res.redirect('/?room=demo');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Redis: ${REDIS_URL ? 'connected' : 'not configured (in-memory only)'}`);
});
