const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const bodyParser = require("body-parser");
const cors = require("cors");
const FormData = require("form-data");
const multer = require("multer");
const fs = require("fs");

const fetch = require("node-fetch");

// Initialisation du serveur Express et du serveur HTTP
const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(cors());

let users = {}; // Associe `user_id` à `socket.id`
let messages = []; // Stocke temporairement les messages (optionnel)

io.on("connection", (socket) => {
  console.log("Un utilisateur est connecté avec socket ID:", socket.id);

  // Lorsqu'un utilisateur s'enregistre
  socket.on("register_user", (user_id) => {
    if (!users[user_id]) {
      users[user_id] = []; // Initialiser un tableau pour stocker plusieurs sockets
    }

    users[user_id].push(socket.id);

    console.log(
      `Utilisateur ${user_id} enregistré avec socket ID: ${socket.id}`
    );
  });

  // Gérer l'envoi de messages
  socket.on("send_message", (data) => {
    console.log("Données reçues du client:", data);
    const { sender_id, receiver_id, message, piece_jointe } = data;

    if (typeof message !== "string") {
      console.error("Message mal formé :", message);
      return;
    }
    // Vérifier si le receiver_id est connecté
    const receiverSocketId = users[receiver_id];
    if (receiverSocketId) {
      // Envoyer le message au destinataire spécifique
      io.to(receiverSocketId).emit("receive_message", {
        sender_id: sender_id,
        receiver_id: receiver_id,
        message: message,
        piece_jointe: piece_jointe,
        timestamp: new Date().toLocaleTimeString(),
      });
      console.log(`Message de ${sender_id} à ${receiver_id}: ${message}`);
    } else {
      console.log(`Utilisateur ${receiver_id} non connecté.`);
    }
  });

  socket.on("disconnect", () => {
    for (let user_id in users) {
      users[user_id] = users[user_id].filter(
        (socketId) => socketId !== socket.id
      );

      if (users[user_id].length === 0) {
        delete users[user_id]; // Supprimer l'entrée si aucun socket connecté
      }
      console.log(`Un utilisateur s'est déconnecté : ${socket.id}`);
    }
  });
});

const getAdminIds = async () => {
  try {
    const response = await fetch("http://develop.zeta-app.fr/api/getAdmin", {
      method: "GET",
    });

    const admins = await response.json();
    return admins.map((admin) => admin.id); // Supposons que l'API retourne une liste d'admins { id: ... }
  } catch (error) {
    console.error("Erreur lors de la récupération des admins:", error);
    return [];
  }
};

// Endpoint pour envoyer un message via fetch

app.post("/send-message", upload.single("piece_jointe"), async (req, res) => {
  const { sender_id, receiver_id, message, type } = req.body;

  // Vérification du token
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Token non fourni ou invalide." });
  }
  const token = authHeader.split(" ")[1];

  try {
    const formData = new FormData();

    // Ajouter les champs de texte
    formData.append("sender_id", sender_id);
    formData.append("receiver_id", receiver_id);
    formData.append("message", message);
    // formData.append('type', type);

    // Ajouter la pièce jointe si elle existe
    if (req.file) {
      formData.append(
        "piece_jointe",
        req.file.buffer,
        req.file.originalname || "piece_jointe"
      );
    }

    // Requête fetch vers l'API externe
    const response = await fetch("http://develop.zeta-app.fr/api/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`, // Pas de Content-Type car géré par form-data
      },
      body: formData,
    });

    const rawResponse = await response.text(); // Lire le texte brut de la réponse
    console.log("Réponse brute de l'API externe:", rawResponse);

    if (!response.ok) {
      res.status(400).json({
        message: "Erreur lors de l'envoi à l'API externe !",
        details: rawResponse,
      });
    }

    let data;
    try {
      // data = await response.text(); // Parser le texte brut en JSON si possible
      console.log("Données JSON reçues:", rawResponse);
    } catch (parseError) {
      console.error("Erreur lors du parsing JSON:", parseError);
      return res.status(500).json({
        message: "Erreur de réponse JSON de l'API externe.",
        details: rawResponse,
      });
    }

    // Vérifier si le receiver est connecté via Socket.IO
    const receiverSocketId = users[receiver_id];
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("receive_message", {
        sender_id,
        receiver_id,
        message,
        type,
        piece_jointe: req.file ? req.file.originalname : null,
      });
    }

    res.status(200).json({
      data: data,
      message: "Message envoyé avec succès !",
    });
  } catch (error) {
    console.error("Erreur lors de la requête fetch:", error);
    res
      .status(500)
      .json({ message: "Erreur lors de l'envoi du message", error });
  }
});

app.post(
  "/send_message_to_admins",
  upload.single("piece_jointe"),
  async (req, res) => {
    const { user_id, message } = req.body;

    // Vérification du token
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Token non fourni ou invalide." });
    }
    const token = authHeader.split(" ")[1];

    try {
      const adminIds = await getAdminIds();

      console.log(adminIds);

      const formData = new FormData();

      formData.append("user_id", req.body.user_id ?? "");
      // formData.append('receiver_id', adminId);
      formData.append("message", message);

      // Ajouter la pièce jointe si elle existe
      if (req.file) {
        formData.append(
          "piece_jointe",
          req.file.buffer,
          req.file.originalname || "piece_jointe"
        );
      }

      // Envoi du message à chaque admin
      const response = await fetch(
        "http://develop.zeta-app.fr/api/send_messages_to_support",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: formData,
        }
      );

      const rawResponse = await response.text();

      if (!response.ok) {
        console.error(`Erreur lors de l'envoi à l'admin`, rawResponse);
      } else {
        console.log(`Message envoyé avec succès à l'admin`);
      }

      adminIds.forEach((adminId) => {
        if (users[adminId]) {
          // Vérifier si l'admin est connecté
          users[adminId].forEach((socketId) => {
            io.to(socketId).emit("receive_message", {
              sender_id: user_id,
              receiver_id: adminId,
              message: message,
              piece_jointe: req.file ? req.file.originalname : null,
            });
          });
        }
      });

      res
        .status(200)
        .json({ message: "Messages envoyés aux administrateurs avec succès." });
    } catch (error) {
      console.error("Erreur lors de la requête fetch:", error);
      res
        .status(500)
        .json({ message: "Erreur lors de l'envoi des messages", error });
    }
  }
);

const getUser = async (token) => {
  try {
    const response = await fetch("http://develop.zeta-app.fr/api/get_user", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`, // Pas de Content-Type car géré par form-data
      },
    });

    const paymentData = await response.json();

    if (!paymentData || !paymentData.payment) {
      console.error("Données de paiement manquantes ou mal formées:");
      return 0;
    }

    const string = paymentData.payment.token;
    const paymentMethod = paymentData.payment.payment_method;

    const userId = paymentData.user.id; // ou `paymentData.user_id` selon la structure réelle

    return `${string};${userId};${paymentMethod}`;
  } catch (error) {
    console.error("Erreur lors de la récupération du user:", error);
    return [];
  }
};



const saveNewStatus = async (user_id, status) => {
  try {
    const formData = new FormData();

    formData.append("user_id", user_id);
    formData.append("status", status);

    const response = await fetch(
      "http://develop.zeta-app.fr/api/save_new_status",
      {
        method: "POST",
        body: formData,
      }
    );

    const newStatus = await response.json();

    return newStatus;
  } catch (error) {
    console.error("Erreur lors de la récupération du user:", error);
    return [];
  }
};

app.post("/check_payment", async (req, res) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Token non fourni ou invalide." });
  }
  const token = authHeader.split(" ")[1];

  const userPayment = await getUser(token);

  if (!userPayment || userPayment.length === 0) {
    console.error("Aucune donnée de paiement trouvée pour l'utilisateur.");
    return res.status(200).json({
      message: "Aucune donnée de paiement trouvée pour l'utilisateur.",
      data: userPayment,
    });
  }

  const [tokens, uuid, user_id, paymentMethod] = userPayment.split(";");

  // Suivi MoMo
  if (paymentMethod === "MOMO") {
    const momoUrl = `https://proxy.momoapi.mtn.com/collection/v1_0/requesttopay/${uuid}`;

    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (attempts > 12) {
        clearInterval(interval);
        console.warn("⏹️ MoMo : Temps d'attente dépassé (1 minute).");
        return;
      }

      try {
        const momoResponse = await fetch(momoUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${tokens}`,
            "Ocp-Apim-Subscription-Key": "906338abaea74430ba31c146b14e51e5",
            "X-Target-Environment": "mtncameroon",
          },
        });

        const text = await momoResponse.text();
        if (!text || text.trim() === "") {
          console.warn("Réponse vide de MoMo");
          return;
        }

        let momoResult;
        try {
          momoResult = JSON.parse(text);
        } catch (err) {
          console.error("Erreur parsing JSON MoMo:", err.message);
          console.debug("Réponse brute :", text);
          return;
        }

        console.log("MoMo statut:", momoResult.status);

        if (momoResult.status !== "PENDING") {
          clearInterval(interval);
          console.log(user_id);

          if (users[user_id]) {
            console.log(users[user_id]);
            users[user_id].forEach((socketId) => {
              io.to(socketId).emit("payment_status", {
                status: momoResult.status,
                timestamp: new Date().toLocaleTimeString(),
              });
            });

            await saveNewStatus(user_id, momoResult.status); 
            
          } else {
            console.warn(`Utilisateur ${user_id} non connecté au socket`);
          }
        }
      } catch (error) {
        console.error("Erreur requête MoMo:", error.message);
        clearInterval(interval); // optionnel si tu veux stopper en cas d’erreur réseau
      }
    }, 5000);

    // Suivi OM
  } else if (paymentMethod === "OM") {
    const omUrl = `https://api-s1.orange.cm/omcoreapis/1.0.2/mp/paymentstatus/${tokens}`;

    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (attempts > 12) {
        clearInterval(interval);
        console.warn("⏹️ OM : Temps d'attente dépassé (1 minute).");
        return;
      }

      try {
        const omResponse = await fetch(omUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${uuid}`,
            "X-AUTH-TOKEN": "WU5PVEVIRUFEMjpAWU5vVGVIRUBEMlBST0RBUEk=",
          },
        });

        const text = await omResponse.text();
        if (!text || text.trim() === "") {
          console.warn("Réponse vide de OM");
          return;
        }

        let omResult;
        try {
          omResult = JSON.parse(text);
        } catch (err) {
          console.error("Erreur parsing JSON OM:", err.message);
          console.debug("Réponse brute OM :", text);
          return;
        }

        const status = omResult?.data?.status;
        console.log("OM statut:", status);
        console.log("avant socket", user_id);
        if (status !== "PENDING") {
          clearInterval(interval);
          console.log("apres", user_id);
          if (users[user_id]) {
            console.log(users[user_id]);
            users[user_id].forEach((socketId) => {
              io.to(socketId).emit("payment_status", {
                status: status,
                timestamp: new Date().toLocaleTimeString(),
              });
            });

            await saveNewStatus(user_id, status); 
            
          } else {
            console.warn(`Utilisateur ${user_id} non connecté au socket`);
          }
        }
      } catch (err) {
        console.error("Erreur requête OM:", err.message);
        clearInterval(interval);
      }
    }, 5000);
  } else {
    console.error("Méthode de paiement non supportée:", paymentMethod);
  }
});

// Démarrer le serveur
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur en écoute sur le port ${PORT}`);
});
