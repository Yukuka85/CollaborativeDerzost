const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// In-memory room storage
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      axes: {
        left: 'Дерзкая',
        right: 'Милая',
        top: 'Открытая',
        bottom: 'Закрытая'
      },
      people: []
    });
  }
  return rooms.get(roomId);
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

// Serialize room state for clients
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

  socket.on('join-room', (roomId) => {
    currentRoom = roomId;
    socket.join(roomId);
    const room = getOrCreateRoom(roomId);
    socket.emit('sync-state', serializeRoom(room));
  });

  socket.on('add-person', (person) => {
    if (!currentRoom) return;
    const room = getOrCreateRoom(currentRoom);
    person.id = crypto.randomUUID();
    person.votes = {};
    person.voteCount = 0;
    room.people.push(person);
    io.to(currentRoom).emit('person-added', person);
  });

  socket.on('vote-person', ({ personId, voterId, x, y }) => {
    if (!currentRoom) return;
    const room = getOrCreateRoom(currentRoom);
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
  });

  socket.on('remove-person', (id) => {
    if (!currentRoom) return;
    const room = getOrCreateRoom(currentRoom);
    room.people = room.people.filter(p => p.id !== id);
    io.to(currentRoom).emit('person-removed', id);
  });

  socket.on('update-axes', (axes) => {
    if (!currentRoom) return;
    const room = getOrCreateRoom(currentRoom);
    room.axes = axes;
    socket.to(currentRoom).emit('axes-updated', axes);
  });
});

// Create new room endpoint
app.get('/new', (req, res) => {
  const roomId = crypto.randomBytes(4).toString('hex');
  res.redirect(`/?room=${roomId}`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
