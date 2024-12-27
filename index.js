const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');

// Initialisation du serveur Express et du serveur HTTP
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const cors = require('cors');

app.use(bodyParser.json());

app.use(cors());

let users = {};
let messages = [];

io.on('connection', (socket) => {
    console.log('Un utilisateur est connecté avec socket ID:', socket.id);

    // Lorsqu'un utilisateur s'enregistre
    socket.on('register_user', (user_id) => {
        users[user_id] = socket.id; // Associe le user_id au socket.id
        console.log(`Utilisateur ${user_id} enregistré avec socket ID: ${socket.id}`);
    });

    // Gérer l'envoi de messages
    socket.on('send_message', (data) => {
        const { sender_id, receiver_id, message } = data;

        // Vérifier si le receiver_id est connecté
        const receiverSocketId = users[receiver_id];
        if (receiverSocketId) {
            // Envoyer le message au destinataire spécifique
            io.to(receiverSocketId).emit('receive_message', {
                sender_id: sender_id,
                message: message,
                timestamp: new Date().toLocaleTimeString()
            });
            console.log(`Message de ${sender_id} à ${receiver_id}: ${message}`);
        } else {
            console.log(`Utilisateur ${receiver_id} non connecté.`);
        }
    });


    socket.on('disconnect', () => {
        for (let user_id in users) {
            if (users[user_id] === socket.id) {
                console.log(`Utilisateur ${user_id} déconnecté.`);
                delete users[user_id];
                break;
            }
        }
    });
});

// Endpoint pour envoyer un message via fetch



app.post('/send-message', async (req, res) => {
    const { sender_id, receiver_id, message } = req.body;
    const token = '6|BPz0prnY0iNrnVdkVxN9QwHfjRF7EKNe91LJFbP583f71eaf';

    try {
        const response = await fetch("http://127.0.0.1:8000/api/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                sender_id: sender_id,
                receiver_id: receiver_id,
                message: message,

            }),
        });

        if (!response.ok) {
            console.log(response);
            throw new Error('Erreur lors de l\'envoi à l\'API externe');
        }

        const data = await response.json();

        // Vérifier si le receiver est connecté via Socket.IO
        io.emit('send_message', { sender_id, receiver_id, message });

        console.log('Message envoyé via Socket.IO');

        res.status(200).json({
            data: data,
            message: 'Message envoyé via fetch avec succès !',
        })

    } catch (error) {
        console.error("Erreur lors de la requête fetch:", error);
        res.status(500).json({ message: 'Erreur lors de l\'envoi du message' });
    }
 
});




// Démarrer le serveur
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur en écoute sur le port ${PORT}`);
});
