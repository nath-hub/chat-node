const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const bodyParser = require("body-parser");
const cors = require("cors");
const FormData = require("form-data");
const multer = require("multer");
const fs = require("fs");

const fetch = require("node-fetch");
const { send } = require("process");

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

const rateLimiter = new Map();

// Fonction pour nettoyer les rate limits expirés
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimiter.entries()) {
    if (now > data.resetTime) {
      rateLimiter.delete(key);
    }
  }
}, 60000);

// Fonction de validation et sanitisation
function validateAndSanitizeMessage(data) {
  if (!data || typeof data !== "object") {
    throw new Error("Données invalides");
  }

  const { sender_id, receiver_id, message, piece_jointe } = data;

  // Validation des champs requis
  if (!sender_id || !receiver_id || !message) {
    throw new Error("Données manquantes (sender_id, receiver_id, message)");
  }

  if (typeof message !== "string") {
    throw new Error("Le message doit être une chaîne de caractères");
  }

  // Validation de la longueur
  if (message.trim().length === 0) {
    throw new Error("Le message ne peut pas être vide");
  }

  // Sanitisation
  const sanitizedMessage = message.trim().substring(0, 1000);

  // Validation des caractères spéciaux malveillants
  const dangerousPatterns = /<script|javascript:|on\w+=/i;
  if (dangerousPatterns.test(sanitizedMessage)) {
    throw new Error("Message contient du contenu potentiellement dangereux");
  }

  return {
    sender_id: sender_id,
    receiver_id: receiver_id,
    message: sanitizedMessage,
    piece_jointe: piece_jointe,
  };
}

// Fonction de rate limiting
function checkRateLimit(userId) {
  const now = Date.now();
  const userLimit = rateLimiter.get(userId) || {
    count: 0,
    resetTime: now + 60000, // 1 minute
  };

  if (now > userLimit.resetTime) {
    userLimit.count = 0;
    userLimit.resetTime = now + 60000;
  }

  if (userLimit.count >= 30) {
    // Max 30 messages par minute
    throw new Error("Trop de messages envoyés, veuillez patienter");
  }

  userLimit.count++;
  rateLimiter.set(userId, userLimit);
}

io.on("connection", (socket) => {
  console.log("Un utilisateur est connecté avec socket ID:", socket.id);

  // Timeout pour les connexions inactives
  let activityTimeout = setTimeout(() => {
    console.log(`Déconnexion pour inactivité: ${socket.id}`);
    socket.disconnect();
  }, 30 * 60 * 1000); // 30 minutes

  // Réinitialiser le timeout à chaque activité
  function resetActivityTimeout() {
    clearTimeout(activityTimeout);
    activityTimeout = setTimeout(() => {
      console.log(`Déconnexion pour inactivité: ${socket.id}`);
      socket.disconnect();
    }, 30 * 60 * 1000);
  }

  // Lorsqu'un utilisateur s'enregistre
  socket.on("register_user", (userId) => {
    resetActivityTimeout();

    console.log(`Enregistrement de l'utilisateur: ${userId}`);
    try {
      // let userId;
      console.log(userId);

      // Validation de la longueur de l'user_id après nettoyage
      if (userId.length === 0 || userId.length > 50) {
        throw new Error(
          "L'ID utilisateur doit faire entre 1 et 50 caractères."
        );
      }

      // Vérifier si l'utilisateur est déjà enregistré avec ce socket
      if (socket.user_id === userId) {
        console.log(`Utilisateur "${userId}" déjà enregistré avec ce socket.`);
        return;
      }

      // Si le socket avait un autre user_id, le nettoyer
      if (socket.user_id && users[socket.user_id]) {
        users[socket.user_id] = users[socket.user_id].filter(
          (socketId) => socketId !== socket.id
        );
        if (users[socket.user_id].length === 0) {
          delete users[socket.user_id];
        }
        console.log(`Ancien enregistrement pour "${socket.user_id}" nettoyé.`);
      }

      // Enregistrer le nouvel utilisateur
      if (!users[userId]) {
        users[userId] = [];
      }
      users[userId].push(socket.id);
      socket.user_id = userId; // Assigner l'ID à l'objet socket pour un suivi ultérieur

      console.log(
        `Utilisateur "${userId}" enregistré avec socket ID: ${socket.id}.`
      );

      // Confirmer l'enregistrement
      socket.emit("registration_success", {
        console: "Utilisateur enregistré avec succès",
        user_id: userId,
        socket_id: socket.id,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Erreur lors de l'enregistrement:", error.message);
      socket.emit("registration_error", { message: error.message });
    }
  });

  // Gérer l'envoi de messages
  // Gérer l'envoi de messages
  socket.on("send_message", (data) => {
    resetActivityTimeout();

    try {
      console.log("Données reçues du client:", data);

      // Validation et sanitisation
      const validatedData = validateAndSanitizeMessage(data);
      const { sender_id, receiver_id, message, piece_jointe } = validatedData;

      // Vérifier que l'expéditeur correspond au socket enregistré
      if (socket.user_id !== sender_id) {
        console.log(sender_id, socket.user_id, socket.id);
        throw new Error(
          "sender_id ne correspond pas à l'utilisateur enregistré"
        );
      }

      // Rate limiting
      checkRateLimit(sender_id);

      // Éviter l'auto-envoi
      if (sender_id === receiver_id) {
        throw new Error("Impossible d'envoyer un message à soi-même");
      }

      // Vérifier si le receiver_id est connecté
      const receiverSocketIds = users[receiver_id];
      console.log(
        `Recherche du destinataire ${receiver_id}:`,
        receiverSocketIds
      );

      if (
        receiverSocketIds &&
        Array.isArray(receiverSocketIds) &&
        receiverSocketIds.length > 0
      ) {
        // Préparer le message avec timestamp et ID unique
        const messageData = {
          id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          sender_id: sender_id,
          receiver_id: receiver_id,
          message: message,
          piece_jointe: piece_jointe,
          timestamp: new Date().toISOString(),
        };

        // Envoyer le message à tous les sockets du destinataire
        let messagesSent = 0;
        const failedSockets = [];

        receiverSocketIds.forEach((socketId) => {
          try {
            console.log(`Envoi du message vers socket ${socketId}`);
            io.to(socketId).emit("receive_message", messageData);
            messagesSent++;
          } catch (error) {
            console.error(`Erreur envoi vers socket ${socketId}:`, error);
            failedSockets.push(socketId);
          }
        });

        // Nettoyer les sockets défaillants
        if (failedSockets.length > 0) {
          users[receiver_id] = users[receiver_id].filter(
            (socketId) => !failedSockets.includes(socketId)
          );
          if (users[receiver_id].length === 0) {
            delete users[receiver_id];
          }
        }

        // Confirmer l'envoi à l'expéditeur
        socket.emit("message_sent", {
          message_id: messageData.id,
          receiver_id: receiver_id,
          message: message,
          timestamp: messageData.timestamp,
          sockets_notified: messagesSent,
          failed_sockets: failedSockets.length,
        });

        console.log(
          `Message de ${sender_id} à ${receiver_id}: ${message} (${messagesSent} sockets notifiés, ${failedSockets.length} échecs)`
        );

        // Optionnel : stocker le message pour l'historique
        messages.push(messageData);

        // Limiter le stockage en mémoire
        if (messages.length > 1000) {
          messages = messages.slice(-500); // Garder les 500 derniers
        }
      } else {
        console.log(
          `Utilisateur ${receiver_id} non connecté. Utilisateurs disponibles:`,
          Object.keys(users)
        );
        socket.emit("user_offline", {
          receiver_id: receiver_id,
          message: "Le destinataire n'est pas connecté",
          available_users: Object.keys(users),
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error("Erreur lors de l'envoi du message:", error.message);
      socket.emit("message_error", {
        message: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Gestion de la déconnexion
  socket.on("disconnect", (reason) => {
    console.log(`Socket déconnecté : ${socket.id}, raison: ${reason}`);

    // Nettoyer le timeout
    clearTimeout(activityTimeout);

    // Nettoyer les données utilisateur
    if (socket.user_id) {
      if (users[socket.user_id]) {
        users[socket.user_id] = users[socket.user_id].filter(
          (socketId) => socketId !== socket.id
        );

        if (users[socket.user_id].length === 0) {
          delete users[socket.user_id];
        }
      }
    } else {
      // Fallback : parcourir tous les utilisateurs
      for (let user_id in users) {
        users[user_id] = users[user_id].filter(
          (socketId) => socketId !== socket.id
        );

        if (users[user_id].length === 0) {
          delete users[user_id];
        }
      }
    }

    console.log(
      "Utilisateurs connectés après déconnexion:",
      Object.keys(users)
    );
  });

  // Événement pour obtenir la liste des utilisateurs connectés
  socket.on("get_online_users", () => {
    resetActivityTimeout();

    try {
      const onlineUsers = Object.keys(users);

      console.log("=== UTILISATEURS EN LIGNE ===");

      const userEntries = Object.entries(users);

      if (userEntries.length === 0) {
        console.log("Aucun utilisateur connecté");
        return;
      }

      userEntries.forEach(([userId, socketIds]) => {
        // Vérification supplémentaire pour identifier les objets
        const userIdType = typeof userId;
        const isValidString =
          userIdType === "string" && userId !== "[object Object]";

        if (!isValidString) {
          console.log(`⚠️  PROBLÈME DÉTECTÉ - User ID invalide:`);
          console.log(`   Type: ${userIdType}`);
          console.log(`   Valeur: ${userId}`);
          console.log(`   JSON: ${JSON.stringify(userId)}`);
          console.log(`   Sockets: [${socketIds.join(", ")}]`);
        } else {
          console.log(
            `✅ ${userId}: ${socketIds.length} connexion(s) - [${socketIds.join(
              ", "
            )}]`
          );
        }
      });

      socket.emit("online_users", {
        users: onlineUsers,
        count: onlineUsers.length,
        timestamp: new Date().toISOString(),
      });
      console.log(
        `Liste des utilisateurs en ligne envoyée à ${socket.id}:`,
        onlineUsers
      );
    } catch (error) {
      console.error("Erreur get_online_users:", error.message);
      socket.emit("error", {
        message: "Erreur lors de la récupération des utilisateurs",
      });
    }
  });

  // Événement pour ping/pong (maintenir la connexion active)
  socket.on("ping", () => {
    resetActivityTimeout();
    socket.emit("pong", { timestamp: new Date().toISOString() });
  });

  // Gestion des erreurs générales
  socket.on("error", (error) => {
    console.error("Erreur socket:", error);
  });
});

const getAdminIds = async () => {
  try {
    const response = await fetch(
      "https://backend.damam-group.com/api/getAdmin",
      {
        method: "GET",
      }
    );

    const admins = await response.json();
    return admins.map((admin) => admin.id); // Supposons que l'API retourne une liste d'admins { id: ... }
  } catch (error) {
    console.error("Erreur lors de la récupération des admins:", error);
    return [];
  }
};

const getUsersInline = async (token) => {
  try {
    const response = await fetch("https://backend.damam-group.com/api/users", {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      method: "POST",
    });

    const users = await response.json();
    return users.id; // Supposons que l'API retourne une liste d'admins { id: ... }
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
    const response = await fetch(
      "https://backend.damam-group.com/api/messages",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`, // Pas de Content-Type car géré par form-data
        },
        body: formData,
      }
    );

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

    // Validation des données
    if (!user_id || !message) {
      return res.status(400).json({
        message: "user_id et message sont requis.",
      });
    }

    // Vérification du token
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Token non fourni ou invalide." });
    }
    const token = authHeader.split(" ")[1];

    try {
      const adminIds = await getAdminIds();

      if (!adminIds || adminIds.length === 0) {
        return res
          .status(404)
          .json({ message: "Aucun administrateur trouvé." });
      }

      const formData = new FormData();
      formData.append("user_id", user_id);
      formData.append("message", message);

      // Ajouter la pièce jointe si elle existe
      if (req.file) {
        formData.append(
          "piece_jointe",
          req.file.buffer,
          req.file.originalname || "piece_jointe"
        );
      }

      // Envoi du message à l'API Laravel
      const response = await fetch(
        "https://backend.damam-group.com/api/send_messages_to_support",
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
        console.error(`Erreur lors de l'envoi à l'API Laravel:`, rawResponse);
        return res.status(500).json({
          message: "Erreur lors de l'envoi à l'API Laravel",
          error: rawResponse,
        });
      }

      $userInline = await getUsersInline(token);

      const isSenderAdmin = adminIds.includes($userInline);

      console.log("user connectee:", $userInline);

      if (isSenderAdmin === true) {
        // L'admin envoie un message à l'utilisateur (receiver_id)

        if (users[user_id] && users[user_id].length > 0) {
          users[user_id].forEach((socketId) => {
            io.to(socketId).emit("receive_message", {
              sender_id: $userInline, // ID de l'admin qui envoie
              receiver_id: user_id, // ID de l'utilisateur qui reçoit
              message: message,
              is_support_message: true,
              timestamp: new Date().toISOString(),
              piece_jointe: req.file ? req.file.originalname : null,
            });
          });
        }

        messages.push({
          sender_id: $userInline, // ID de l'admin qui envoie
          receiver_id: user_id, // ID de l'utilisateur qui reçoit
          message: message,
          is_support_message: true,
          timestamp: new Date().toISOString(),
          piece_jointe: req.file ? req.file.originalname : null,
        });

        // Limiter le stockage pour éviter la surcharge mémoire
        if (messages.length > 1000) {
          messages = messages.slice(-500); // Garder les 500 derniers
        }

        console.log(
          `Message envoyé à l'utilisateur ${user_id} par l'admin ${$userInline}:`,
          message
        );
      } else {
        // L'utilisateur envoie un message à tous les admins connectés
        let adminNotified = 0;

        adminIds.forEach((adminId) => {
          if (users[adminId] && users[adminId].length > 0) {
            users[adminId].forEach((socketId) => {
              io.to(socketId).emit("receive_message", {
                sender_id: $userInline,
                receiver_id: adminId,
                message: message,
                is_support_message: true,
                timestamp: new Date().toISOString(),
                piece_jointe: req.file ? req.file.originalname : null,
              });
            });

            messages.push({
              sender_id: $userInline,
              receiver_id: adminId,
              message: message,
              is_support_message: true,
              timestamp: new Date().toISOString(),
              piece_jointe: req.file ? req.file.originalname : null,
            });

            // Limiter le stockage pour éviter la surcharge mémoire
            if (messages.length > 1000) {
              messages = messages.slice(-500); // Garder les 500 derniers
            }

            console.log(
              `Message envoyé à l'admin ${user_id} par l'utilisateur ${$userInline} :`,
              message
            );
            adminNotified++;
          }
        });
      }

      res.status(200).json({
        message: "Messages envoyés aux administrateurs avec succès.",
        // admins_notified: adminNotified,
        total_admins: adminIds.length,
      });
    } catch (error) {
      console.error("Erreur lors de la requête fetch:", error);
      res.status(500).json({
        message: "Erreur lors de l'envoi des messages",
        error: error.message,
      });
    }
  }
);

// Exemple : Vérification des nouveaux messages pour un utilisateur
app.get("/api/socket-messages/:user_id", (req, res) => {
  const { user_id } = req.params;

  try {
    if (!user_id || user_id.trim() === "") {
      return res.status(400).json({
        success: false,
        error: "user_id requis",
      });
    }

    const userId = parseInt(user_id, 10);

    const receivedMessagesForUser = messages.filter((message) => {
      return message.receiver_id === userId;
    });

    res.json({
      success: true,
      user_id: userId,
      messages: receivedMessagesForUser, 
      total: receivedMessagesForUser.length,
    });

   
  } catch (error) {
    console.error("Erreur récupération messages:", error);
    res.status(500).json({
      success: false,
      error: "Erreur serveur",
    });
  }
});

const getUser = async (token) => {
  try {
    const response = await fetch(
      "https://backend.damam-group.com/api/get_user",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`, // Pas de Content-Type car géré par form-data
        },
      }
    );

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
      "https://backend.damam-group.com/api/save_new_status",
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
