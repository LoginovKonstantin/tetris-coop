const express = require('express');
const axios = require('axios');
const http = require('http');
const socketIo = require('socket.io');
const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
    path: '/tetris/socket.io',
});

app.use('/tetris', express.static('public')); // Статика по пути /tetris

// Game constants
const GRID_WIDTH = 20;
const GRID_HEIGHT = 20;
const FALL_SPEED = 350; // ms
const MAX_PLAYERS = 10;

// Tetromino shapes
const SHAPES = [
    [[1, 1, 1, 1]], // I
    [[1, 1], [1, 1]], // O
    [[1, 1, 1], [0, 1, 0]], // T
    [[1, 1, 1], [1, 0, 0]], // L
    [[1, 1, 1], [0, 0, 1]], // J
    [[1, 1, 0], [0, 1, 1]], // S
    [[0, 1, 1], [1, 1, 0]]  // Z
];

// Game state
let gameState = {
    grid: Array(GRID_HEIGHT).fill().map(() => Array(GRID_WIDTH).fill(0)),
    players: {},
    playerCount: 0
};

// Generate new tetromino for a player
function generateTetromino() {
    const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
    const x = Math.floor((GRID_WIDTH - shape[0].length) / 2);
    return { shape, x, y: 0, id: Math.random().toString(36).substr(2, 9) };
}

// Check if position is valid, including against other players' tetrominoes
function isValidPosition(shape, x, y, grid, players, currentPlayerId) {
    for (let i = 0; i < shape.length; i++) {
        for (let j = 0; j < shape[i].length; j++) {
            if (shape[i][j]) {
                const newX = x + j;
                const newY = y + i;
                if (
                    newX < 0 || newX >= GRID_WIDTH ||
                    newY >= GRID_HEIGHT ||
                    (newY >= 0 && grid[newY][newX])
                ) {
                    return false;
                }
                // Check for overlap with other players' tetrominoes
                for (let playerId in players) {
                    if (playerId !== currentPlayerId && players[playerId].active) {
                        const other = players[playerId].tetromino;
                        for (let oi = 0; oi < other.shape.length; oi++) {
                            for (let oj = 0; oj < other.shape[oi].length; oj++) {
                                if (other.shape[oi][oj] && newY === other.y + oi && newX === other.x + oj) {
                                    return false;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    return true;
}

// Merge tetromino to grid
function mergeTetromino(shape, x, y, grid) {
    for (let i = 0; i < shape.length; i++) {
        for (let j = 0; j < shape[i].length; j++) {
            if (shape[i][j]) {
                grid[y + i][x + j] = 1;
            }
        }
    }
}

// Clear complete lines
function clearLines() {
    let linesCleared = 0;
    gameState.grid = gameState.grid.filter(row => row.some(cell => cell === 0));
    while (gameState.grid.length < GRID_HEIGHT) {
        gameState.grid.unshift(Array(GRID_WIDTH).fill(0));
        linesCleared++;
    }
    if (linesCleared > 0) {
        io.emit('linesCleared', linesCleared);
    }
}

// Reset game state
function resetGame() {
    gameState.grid = Array(GRID_HEIGHT).fill().map(() => Array(GRID_WIDTH).fill(0));
    Object.values(gameState.players).forEach(player => {
        player.tetromino = generateTetromino();
        player.active = true;
    });
}

function notify() {
    const token = process.env.A_TELEGRAM_TOKEN;
    const chatId = process.env.A_TELEGRAM_CHAT_ID;
    const url = process.env.TELEGRAM_URL;
    const serverUrl = process.env.SERVER_URL; // Адрес сервера, можно взять из переменной окружения или задать явно
    const message = `В тетрис кто-то зашёл, заходи тоже: <a href="${serverUrl}">Играть</a>`;

    // axios.get(`${url}/bot${token}/sendMessage?parse_mode=html&chat_id=${chatId}&text=${message}`)
    //     .catch(error => console.log('Ошибка отправки сообщения:', error));
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    if (gameState.playerCount >= MAX_PLAYERS) {
        socket.emit('roomFull');
        socket.disconnect();
        return;
    }

    notify();

    gameState.playerCount++;
    gameState.players[socket.id] = {
        tetromino: generateTetromino(),
        active: true
    };

    socket.emit('init', { grid: gameState.grid, tetromino: gameState.players[socket.id].tetromino, players: gameState.players });

    socket.on('move', (data) => {
        const player = gameState.players[socket.id];
        if (!player || !player.active) return;

        let newX = player.tetromino.x + (data.dx || 0);
        let newY = player.tetromino.y + (data.dy || 0);
        let newShape = data.shape || player.tetromino.shape;

        if (isValidPosition(newShape, newX, newY, gameState.grid, gameState.players, socket.id)) {
            player.tetromino.x = newX;
            player.tetromino.y = newY;
            player.tetromino.shape = newShape;
            io.emit('update', gameState.players);
        }
    });

    socket.on('fall', () => {
        const player = gameState.players[socket.id];
        if (!player || !player.active) return;

        if (isValidPosition(player.tetromino.shape, player.tetromino.x, player.tetromino.y + 1, gameState.grid, gameState.players, socket.id)) {
            player.tetromino.y++;
            io.emit('update', gameState.players);
        } else {
            mergeTetromino(player.tetromino.shape, player.tetromino.x, player.tetromino.y, gameState.grid);
            clearLines();
            if (player.tetromino.y === 0) {
                io.emit('gameOver');
                resetGame();
            } else {
                player.tetromino = generateTetromino();
                if (!isValidPosition(player.tetromino.shape, player.tetromino.x, player.tetromino.y, gameState.grid, gameState.players, socket.id)) {
                    io.emit('gameOver');
                    resetGame();
                }
            }
            io.emit('update', gameState.players);
            io.emit('gridUpdate', gameState.grid);
        }
    });

    socket.on('disconnect', () => {
        const player = gameState.players[socket.id];
        if (player) {
            player.active = false;
            while (isValidPosition(player.tetromino.shape, player.tetromino.x, player.tetromino.y + 1, gameState.grid, gameState.players, socket.id)) {
                player.tetromino.y++;
            }
            mergeTetromino(player.tetromino.shape, player.tetromino.x, player.tetromino.y, gameState.grid);
            clearLines();
            delete gameState.players[socket.id];
            gameState.playerCount--;
            io.emit('update', gameState.players);
            io.emit('gridUpdate', gameState.grid);
        }
    });
});

setInterval(() => {
    Object.values(gameState.players).forEach(player => {
        if (player.active) {
            io.to(Object.keys(gameState.players).find(id => gameState.players[id] === player)).emit('fall');
        }
    });
}, FALL_SPEED);

server.listen(3001, () => {
    console.log('Server running on port 3001');
});