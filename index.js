const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');
const cors = require('cors');
const FormData = require('form-data');
const multer = require('multer');

const fetch = require('node-fetch');

// Initialisation du serveur Express et du serveur HTTP
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(bodyParser.json());

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(cors());

let users = {}; // Associe `user_id` à `socket.id`
let messages = []; // Stocke temporairement les messages (optionnel)

io.on('connection', (socket) => {
    console.log('Un utilisateur est connecté avec socket ID:', socket.id);

    // Lorsqu'un utilisateur s'enregistre
    socket.on('register_user', (user_id) => {
        users[user_id] = socket.id; // Associe le user_id au socket.id
        console.log(`Utilisateur ${user_id} enregistré avec socket ID: ${socket.id}`);
    });

    // Gérer l'envoi de messages
    socket.on('send_message', (data) => {
        const { sender_id, receiver_id, message, piece_jointe } = data;

        // Vérifier si le receiver_id est connecté
        const receiverSocketId = users[receiver_id];
        if (receiverSocketId) {
            // Envoyer le message au destinataire spécifique
            io.to(receiverSocketId).emit('receive_message', {
                sender_id: sender_id,
                receiver_id: receiver_id,
                message: message,
                piece_jointe: piece_jointe,
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

app.post('/send-message', upload.single('piece_jointe'), async (req, res) => {
    const { sender_id, receiver_id, message } = req.body;

    // Vérification du token
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Token non fourni ou invalide.' });
    }
    const token = authHeader.split(' ')[1];

    try {
        const formData = new FormData();

        // Ajouter les champs de texte
        formData.append('sender_id', sender_id);
        formData.append('receiver_id', receiver_id);
        formData.append('message', message);

        // Ajouter la pièce jointe si elle existe
        if (req.file) {
            formData.append('piece_jointe', req.file.buffer, req.file.originalname || 'piece_jointe');
        }

        // Requête fetch vers l'API externe
        const response = await fetch("https://damam.zeta-messenger.com/api/messages", {
            method: "POST",
            headers: {
                'Authorization': `Bearer ${token}`, // Pas de Content-Type car géré par form-data
            },
            body: formData,
        });

        const rawResponse = await response.text(); // Lire le texte brut de la réponse
        console.log("Réponse bruteeeeeeeeeeeeeeeeeeeeeeeeeee:");

        if (!response.ok) {
            console.error("Erreur HTTP:", response.status, response.statusText);
            const errorText = await response.text();
            console.error("Détails de l'erreur:", errorText);

            res.status(400).json({
                message: 'Erreur lors de l\'envoi à l\'API externe !',
                details: rawResponse,
            });
            // throw new Error('Erreur lors de l\'envoi à l\'API externe');
        }
 
        let data;
        try {
            console.log("ca arrive iciiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii:");

            data = await response.text(); // Parser le texte brut en JSON si possible
            console.log("Données JSON reçues:", data);
        } catch (parseError) {
            console.error("Erreur lors du parsing JSON:", parseError);
            return res.status(500).json({
                message: 'Erreur de réponse JSON de l\'API externe.',
                details: rawResponse,
            });
        }

        // Vérifier si le receiver est connecté via Socket.IO
        const receiverSocketId = users[receiver_id];
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('receive_message', {
                sender_id,
                receiver_id,
                message,
                piece_jointe: req.file ? req.file.originalname : null,
            });
        }

        console.log("Statut de la réponse:", response.status);
        console.log("Réponse brute:", await response.text());

        res.status(200).json({
            "data": data,
            message: 'Message envoyé avec succès !',
        });

    } catch (error) {
        console.error("Erreur lors de la requête fetch:", error);
        res.status(500).json({ message: 'Erreur lors de l\'envoi du message', error });
    }
});



// Démarrer le serveur
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur en écoute sur le port ${PORT}`);
});
