// Fist Duel — online presence counter server
//
// Every browser tab that has the game open connects here over WebSocket.
// The server just counts how many sockets are currently open and
// broadcasts that number to everyone whenever it changes.
//
// Run locally:   npm install && npm start
// Deploy:        see README.md in this folder

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Fist Duel online-counter server is running.\n');
});

const wss = new WebSocket.Server({ server });
const clients = new Set();

function broadcastCount() {
  const payload = JSON.stringify({ type: 'count', count: clients.size });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  broadcastCount();

  // Keep the connection alive through proxies/load balancers that
  // close idle sockets after ~60s of silence.
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25000);

  ws.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(ws);
    broadcastCount();
  });

  ws.on('error', () => {
    clearInterval(heartbeat);
    clients.delete(ws);
    broadcastCount();
  });
});

server.listen(PORT, () => {
  console.log(`Online-counter server listening on port ${PORT}`);
});
