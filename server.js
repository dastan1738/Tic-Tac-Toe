// server.js
// npm i ws
// node server.js

const http = require("http");
const WebSocket = require("ws");

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("TicTacToe WS server is running");
});

const wss = new WebSocket.Server({ server });

/**
 * rooms: Map<roomCode, {
 *   players: [ws|null, ws|null],
 *   symbols: Map<ws, "X"|"O">,
 *   board: string[9],
 *   turn: "X"|"O",
 *   gameOver: boolean
 * }>
 */
const rooms = new Map();

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastRoom(roomCode, obj) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.players.forEach(p => safeSend(p, obj));
}

function roomState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return null;
  return {
    board: room.board,
    turn: room.turn,
    gameOver: room.gameOver,
    playersCount: room.players.filter(Boolean).length
  };
}

function cleanupWs(ws) {
  for (const [code, room] of rooms.entries()) {
    const idx = room.players.indexOf(ws);
    if (idx !== -1) {
      room.players[idx] = null;
      room.symbols.delete(ws);

      broadcastRoom(code, { type: "info", message: "Игрок отключился. Можно подключиться снова." });
      broadcastRoom(code, { type: "state", ...roomState(code) });

      // если комната пустая — удалим
      if (room.players.every(p => !p)) rooms.delete(code);
      return;
    }
  }
}

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // CREATE
    if (msg.type === "create") {
      let code = makeRoomCode();
      while (rooms.has(code)) code = makeRoomCode();

      const room = {
        players: [ws, null],
        symbols: new Map([[ws, "X"]]),
        board: Array(9).fill(""),
        turn: "X",
        gameOver: false,
      };
      rooms.set(code, room);

      safeSend(ws, { type: "joined", roomCode: code, you: "X" });
      safeSend(ws, { type: "state", ...roomState(code) });
      safeSend(ws, { type: "info", message: "Комната создана. Поделись кодом с другом." });
      return;
    }

    // JOIN
    if (msg.type === "join") {
      const code = (msg.roomCode || "").toUpperCase().trim();
      const room = rooms.get(code);

      if (!room) {
        safeSend(ws, { type: "error", message: "Комната не найдена." });
        return;
      }

      // если уже в комнате
      if (room.players.includes(ws)) {
        safeSend(ws, { type: "joined", roomCode: code, you: room.symbols.get(ws) });
        safeSend(ws, { type: "state", ...roomState(code) });
        return;
      }

      // найти место
      const freeIndex = room.players.findIndex(p => !p);
      if (freeIndex === -1) {
        safeSend(ws, { type: "error", message: "Комната уже заполнена (2 игрока)." });
        return;
      }

      // дать символ
      const symbol = freeIndex === 0 ? "X" : "O";
      room.players[freeIndex] = ws;
      room.symbols.set(ws, symbol);

      safeSend(ws, { type: "joined", roomCode: code, you: symbol });
      safeSend(ws, { type: "state", ...roomState(code) });

      broadcastRoom(code, { type: "info", message: "Второй игрок подключился. Можно играть!" });
      broadcastRoom(code, { type: "state", ...roomState(code) });
      return;
    }

    // MOVE
    if (msg.type === "move") {
      const code = (msg.roomCode || "").toUpperCase().trim();
      const i = msg.index;

      const room = rooms.get(code);
      if (!room) return;

      const you = room.symbols.get(ws);
      if (!you) {
        safeSend(ws, { type: "error", message: "Ты не в комнате." });
        return;
      }
      if (room.gameOver) return;
      if (typeof i !== "number" || i < 0 || i > 8) return;

      // ждать второго игрока
      if (room.players.filter(Boolean).length < 2) {
        safeSend(ws, { type: "error", message: "Ждём второго игрока..." });
        return;
      }

      // проверка очереди
      if (room.turn !== you) {
        safeSend(ws, { type: "error", message: "Сейчас не твой ход." });
        return;
      }

      // проверка клетки
      if (room.board[i] !== "") return;

      room.board[i] = you;

      // победа/ничья
      const WINS = [
        [0,1,2],[3,4,5],[6,7,8],
        [0,3,6],[1,4,7],[2,5,8],
        [0,4,8],[2,4,6]
      ];
      let winner = null;
      for (const [a,b,c] of WINS) {
        if (room.board[a] && room.board[a] === room.board[b] && room.board[a] === room.board[c]) {
          winner = room.board[a];
          break;
        }
      }
      const draw = !winner && room.board.every(v => v !== "");

      if (winner || draw) {
        room.gameOver = true;
        broadcastRoom(code, {
          type: "gameover",
          winner: winner || "D"
        });
      } else {
        room.turn = (room.turn === "X") ? "O" : "X";
      }

      broadcastRoom(code, { type: "state", ...roomState(code) });
      return;
    }

    // RESTART (сбрасывает поле, очередь X)
    if (msg.type === "restart") {
      const code = (msg.roomCode || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return;

      if (!room.symbols.get(ws)) return;

      room.board = Array(9).fill("");
      room.turn = "X";
      room.gameOver = false;

      broadcastRoom(code, { type: "info", message: "Игра перезапущена." });
      broadcastRoom(code, { type: "state", ...roomState(code) });
      return;
    }
  });

  ws.on("close", () => cleanupWs(ws));
  ws.on("error", () => cleanupWs(ws));

  safeSend(ws, { type: "hello", message: "Подключено. Создай или войди в комнату." });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
  console.log("WS server running on port", PORT);
});