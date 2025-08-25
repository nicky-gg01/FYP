const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");
const mysql = require("mysql2");
const session = require("express-session");
const http = require("http");
const socketIo = require("socket.io");
const Filter = require("bad-words");
const filter = new Filter();
const axios = require("axios");
const cors = require("cors");
const fs = require("fs/promises");
const multer = require("multer");
const app = express();
const server = http.createServer(app);
const io = new socketIo.Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
const path = require("path");
const { setServers } = require("dns");
const port = 3000;

let clients = [];


const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/jpg",
      "image/svg+xml",
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPG, PNG, JPEG, and SVG files are allowed"), false);
    }
  },
});

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));
app.use(express.static(path.join("client")));
app.use(
  "/socket.io",
  express.static(
    path.join(__dirname, "node_modules", "socket.io", "client-dist")
  )
);

app.use(express.static(path.join(__dirname, "chat")));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: "secret_key",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false },
  })
);

io.on("connection", (socket) => {
  console.log("A user connected");

  // Handle user joining the one-on-one chat
  socket.on("joinOneOnOneChat", (sessionID) => {
    socket.join(sessionID);
    socket.sessionID = sessionID;
    console.log(`User joined one-on-one chat room: ${sessionID}`);
  });

  // Handle user joining a chatroom90
  socket.on("joinChatroom", (chatroomId) => {
    socket.join(chatroomId);
    console.log(`User joined chatroom: ${chatroomId}`);
    socket.chatroomId = chatroomId;
  });

  socket.on("typing", (data) => {
    socket.broadcast
      .to(socket.chatroomId)
      .emit("typingStatus", { isTyping: data.isTyping, userID: data.userID });
  });

  socket.on("typing", (data) => {
    if (socket.sessionID) {
      socket.broadcast.to(socket.sessionID).emit("typingStatus", {
        isTyping: data.isTyping,
        userID: data.userID,
      });
    } else if (socket.chatroomId) {
      socket.broadcast.to(socket.chatroomId).emit("typingStatus", {
        isTyping: data.isTyping,
        userID: data.userID,
      });
    }
  });

  socket.on("typingStatus", (data) => {
    const typingStatus = document.getElementById("typing-status");

    if (data.isTyping) {
      typingStatus.style.display = "block";
    } else {
      typingStatus.style.display = "none";
    }
  });

  // Handle sending messages
  let userOffenses = {};
  let userMuteStatus = {};
  const chineseBadWords = [
    "傻逼",
    "死全家",
    "去你妈的",
    "操你妈",
    "婊子",
    "王八蛋",
    "死狗",
    "nmsl",
    "屌",
    "撚",
    "鳩",
    "臭西",
    "收皮",
    "仆街",
    "尻",
    "diu",
    "on9",
  ];

  // Helper function to check for Chinese offensive words
  function containsChineseProfanity(message) {
    for (let badWord of chineseBadWords) {
      if (message.includes(badWord)) {
        return true;
      }
    }
    return false;
  }

  socket.on("sendMessage", (messageData) => {
    const { chatroomId, userId, message } = messageData;

    // Check the user's mute status and offense count from the database
    db.query(
      "SELECT muteStatus, muteExpiration, userOffenses FROM users WHERE userId = ?",
      [userId],
      (err, results) => {
        if (err) {
          console.error("Error checking mute status:", err);
          return;
        }

        if (results.length > 0) {
          const user = results[0];
          const currentTime = new Date();
          const muteExpirationTime = new Date(results[0].muteExpiration);
          let remainingMuteTime = 0;

          // Check if the user is muted
          if (user.muteStatus && muteExpirationTime > currentTime) {
            const remainingMuteTime = Math.floor(
              (muteExpirationTime - currentTime) / 60000
            );
            socket.emit("userMuted", userId, remainingMuteTime);
            return;
          }

          // If the mute has expired, reset the mute status in the database
          if (user.muteStatus && muteExpirationTime <= currentTime) {
            db.query(
              "UPDATE users SET muteStatus = 0, muteExpiration = NULL WHERE userId = ?",
              [userId],
              (err, result) => {
                if (err) {
                  console.error("Error updating mute status:", err);
                } else {
                  console.log(`User ${userId} has been unmuted.`);
                }
              }
            );
          }

          // Check for offensive language
          if (filter.isProfane(message) || containsChineseProfanity(message)) {
            let offenses = user.userOffenses || 0;
            offenses++;

            let muteDuration =
              offenses === 2 ? 3 : offenses === 3 ? 5 : offenses > 3 ? 10 : 1;

            const muteExpirationTime = new Date();
            muteExpirationTime.setMinutes(
              muteExpirationTime.getMinutes() + muteDuration
            );

            db.query(
              "UPDATE users SET muteStatus = 1, muteExpiration = ?, userOffenses = ? WHERE userId = ?",
              [muteExpirationTime, offenses, userId],
              (err, result) => {
                if (err) {
                  console.error("Error updating mute status:", err);
                }
              }
            );

            socket.emit("userMuted", userId, muteDuration);
            socket.emit("receiveMessage", {
              chatroomId,
              userId: "系統",
              message: `You have been muted for ${muteDuration} minutes due to offensive language.`,
            });
            return;
          }

          // If no offensive language, insert the message into the database
          const query =
            "INSERT INTO messages (chatroomID, userID, message) VALUES (?, ?, ?)";
          db.query(query, [chatroomId, userId, message], (err, result) => {
            if (err) {
              console.error("Error saving message to database:", err);
              return;
            }

            // Broadcast the message to the chatroom (to all clients in the chatroom)
            io.to(chatroomId).emit("receiveMessage", {
              chatroomId,
              userId,
              message,
            });
          });
        }
      }
    );
  });

  let lastRespondedMessageId = null;
  let lastRespondedTime = 0;

  async function checkAndGenerateAIResponses(chatroomId) {
    try {
      const [results] = await db
        .promise()
        .query(
          "SELECT messageID, userID, message, created_at AS lastMessageTime FROM messages WHERE chatroomID = ? ORDER BY created_at DESC LIMIT 1",
          [chatroomId]
        );

      if (results.length === 0) {
        console.log("No messages found for the chatroom.");
        return;
      }

      const latestMessage = results[0];
      const { messageID: messageId, message, lastMessageTime } = latestMessage;

      const [existingResponse] = await db
        .promise()
        .query("SELECT * FROM ai_responses WHERE messageID = ?", [messageId]);

      if (existingResponse.length > 0) {
        return;
      }

      if (!messageId) {
        console.warn("Warning: messageId is undefined. Skipping update.");
        return;
      }

      // If this is the first check or if enough time has passed since the last check, process the message
      const currentTime = new Date();
      const messageTime = new Date(lastMessageTime);

      // Check if this message is the same as the last processed one or if it was processed recently
      if (messageId === lastRespondedMessageId) {
        console.log("This message has already been processed. Skipping.");
        return;
      }

      if (currentTime - lastRespondedTime < 10000) {
        console.log("Too soon to respond again. Skipping.");
        return;
      }

      if (currentTime - messageTime > 15000) {
        try {
          io.to(chatroomId).emit("typingStatus", {
            userID: "AI",
            isTyping: true,
          });

          // Generate AI responses based on the latest user message
          const aiResponses = await generateAIResponses(message);

          // Emit AI responses to the chatroom
          for (const { name, response } of aiResponses) {
            await db
              .promise()
              .query(
                "INSERT INTO ai_responses (messageID, aiResponse, chatroomID) VALUES (?, ?, ?)",
                [messageId, response, chatroomId]
              );
            io.to(chatroomId).emit("receiveMessage", {
              chatroomId,
              userId: name,
              message: response,
            });

            lastRespondedMessageId = messageId;
            lastRespondedTime = new Date();

            io.to(chatroomId).emit("typingStatus", {
              userID: "AI",
              isTyping: false,
            });

            console.log(`AI Response from ${name}: ${response}`);
          }
        } catch (err) {
          console.error("Error generating AI response:", err);
        }
      } else {
        console.log(
          "The latest message is less than 1 minute old. Skipping AI response."
        );
      }
    } catch (err) {
      console.error("Error fetching the latest message:", err);
    }
  }

  // Check for new messages every 15 seconds
  setInterval(() => {
    if (socket.chatroomId) {
      const chatroomId = socket.chatroomId;
      checkAndGenerateAIResponses(chatroomId);
    }
  }, 15000);
  async function generateAIResponses(message) {
    if (!message) {
      console.error("Message is undefined.");
      return [];
    }

    message = message.replace(/^"(.*)"$/, "$1");

    const aiPrompts = [
      {
        name: "AI",
        model: "llama3.2:latest",
        prompt: `You are a warm, caring, and supportive friend. Your friend just said: "${message}". 
        Respond in a natural, friendly, and comforting way, as if you're chatting with them online. 
        Keep it short, empathetic, and direct. Do NOT over-explain or generate long paragraphs—just be a comforting friend.`,
      },
    ];

    const responses = await Promise.all(
      aiPrompts.map(async ({ name, model, prompt }) => {
        try {
          const response = await fetch("http://localhost:11434/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: model,
              messages: [
                { role: "system", content: prompt },
                { role: "user", content: message },
              ],
              max_tokens: 150,
              temperature: 0.7,
            }),
          });

          console.log("Full API response:", response.data);

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          const textResponse = await response.text();

          let fullResponse = "";
          const parts = textResponse.split("\n");
          for (const part of parts) {
            if (part.trim()) {
              try {
                const json = JSON.parse(part);
                fullResponse += json.message.content || "";
                if (json.done) break;
              } catch (parseError) {
                console.error("Error parsing JSON part:", parseError);
              }
            }
          }

          return {
            name,
            response:
              fullResponse.trim() ||
              "I'm here for you, and I care about how you're feeling. Talk to me.",
          };
        } catch (error) {
          console.error(
            `Error from ${name}:`,
            error.response ? error.response.data : error.message
          );
          return {
            name,
            response:
              "I'm here for you, and I care about how you're feeling. Talk to me.",
          };
        }
      })
    );

    return responses;
  }

  // Handle sending messages in a one-on-one chat
  socket.on("sendMessageOneOnOne", (messageData) => {
    const { sessionID, userID, message } = messageData;

    const query =
      "INSERT INTO one_messages (chatroomID, userID, message) VALUES (?, ?, ?)";
    db.query(query, [sessionID, userID, message], (err, result) => {
      if (err) {
        console.error("Error saving message to database:", err);
        return;
      }
      console.log("Message saved to database", result);

      io.to(sessionID).emit("receiveMessage", {
        sessionID,
        userID,
        message,
      });
    });
  });

  socket.on("sendNotification", (notificationData) => {
    const { userID, message_usertostaff } = notificationData;
    console.log("Sending notification:", notificationData);

    const query =
      "INSERT INTO user_selections (userID, message_usertostaff) VALUES (?, ?)";

    db.query(query, [userID, message_usertostaff], (err, result) => {
      if (err) {
        console.error("Error saving notification to database:", err);
        socket.emit("notificationError", {
          message: "資料庫存取錯誤，請稍後再試。",
        });
        return;
      }
      console.log("Notification saved to database", result);

      // Broadcast the notification to the user
      const notificationData = {
        userID,
        message_usertostaff,
        selectionID: result.insertId,
      };

      io.to(`user_${notificationData.userID}`).emit(
        "receiveNotification",
        notificationData
      );
    });
  });

  // Client send back message
  socket.on("sendBackNotification", (notificationBackData) => {
    const { userID, contentback } = notificationBackData;

    const getStaffQuery = "SELECT staffID FROM users WHERE userID = ? LIMIT 1";
    db.query(getStaffQuery, [userID], (err, results) => {
      if (err) {
        console.error("Error fetching staffID:", err);
        return;
      }

      if (results.length > 0 && results[0].staffID) {
        const staffID = results[0].staffID;

        const updateQuery =
          "UPDATE user_selections SET contentback = ? WHERE userID = ?";
        db.query(updateQuery, [contentback, userID], (err, result) => {
          if (err) {
            console.error("Error:", err);
            return;
          }

          //WebSocket notification to staff
          io.to(`staff_${staffID}`).emit("receiveBackNotification", {
            userID,
            contentback,
          });
        });
      } else {
        console.warn(`No staff found for userID: ${userID}`);
      }
    });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

app.get("/", (req, res) => {
  if (req.session.user) {
    res.sendFile(path.join(__dirname, "client/index_Login.html"));
  } else {
    res.sendFile(path.join(__dirname, "client/index_nonLogin.html"));
  }
});

app.get("/home", (req, res) => {
  if (req.session.user) {
    res.sendFile(path.join(__dirname, "client/index_Login.html"));
  } else {
    res.redirect("client/login");
  }
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;

  const query = "SELECT * FROM users WHERE email = ? AND password = ?";
  db.query(query, [email, password], (err, results) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).json({ message: "Database error" });
    }

    if (results.length > 0) {
      const user = results[0];
      req.session.user = user;
      console.log("User logged in:", user);

      if (user.role === "psychologist") {
        res.status(200).json({
          message: "Login successful",
          redirectTo: "../chat/OneOnOneChat.html",
        });
      } else {
        res.status(200).json({
          message: "Login successful",
          redirectTo: "../client/index_Login.html",
        });
      }
    } else {
      res.status(401).json({ message: "Invalid email or password" });
    }
  });
});

app.post("/api/check-userEmail", (req, res) => {
  const { email } = req.body;
  const trimmedEmail = email.trim();

  console.log("Received request body:", req.body);

  const query = "SELECT * FROM users WHERE TRIM(email) = ?";
  db.query(query, [trimmedEmail], (err, results) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).json({ message: "database error" });
    }
    console.log("Result:", results);
    if (results.length > 0) {
      return res.json({ message: "Email is exists" });
    } else {
      return res.json({ message: "Have Not this email" });
    }
  });
});

app.post("/api/reset-userPassword", (req, res) => {
  const { email, password } = req.body;

  const query = "UPDATE users SET password = ? WHERE email = ?";
  db.query(query, [password, email], (err, results) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).json({ message: "database error" });
    }
    if (results.affectedRows === 0) {
      return res.status(404).json({ message: "Email not exist" });
    }
    if (results.affectedRows > 0) {
      return res.json({ message: "Reset Password Success" });
    } else {
      return res.json({ message: "Have Not this email" });
    }
  });
});

app.post("/api/stafflogin", (req, res) => {
  const { email, password } = req.body;

  const query = "SELECT * FROM staff WHERE email = ? AND password = ?";
  db.query(query, [email, password], (err, results) => {
    if (err) {
      return res.status(500).json({ message: "database error" });
    }

    if (results.length > 0) {
      req.session.user = { staffID: results[0].staffID };
      res.status(200).json({
        message: "Login successful",
        redirectTo: "StaffDashboard.html",
      });
    } else {
      res.status(401).json({ message: "login email or password incorrect" });
    }
  });
});

app.post("/api/check-staffEmail", (req, res) => {
  const { email } = req.body;
  const trimmedEmail = email.trim();

  const query = "SELECT * FROM staff WHERE email = ?";
  db.query(query, [email], (err, results) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).json({ message: "database error" });
    }
    console.log("Result:", results);
    if (results.length > 0) {
      return res.json({ message: "Email is exists" });
    } else {
      return res.json({ message: "Have Not this email" });
    }
  });
});

app.post("/api/reset-staffPassword", (req, res) => {
  const { email, password } = req.body;

  const query = "UPDATE staff SET password = ? WHERE email = ?";
  db.query(query, [password, email], (err, results) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).json({ message: "database error" });
    }
    if (results.affectedRows === 0) {
      return res.status(404).json({ message: "Email not exist" });
    }
    if (results.affectedRows > 0) {
      return res.json({ message: "Reset Password Success" });
    } else {
      return res.json({ message: "Have Not this email" });
    }
  });
});

app.get("/proxy", async (req, res) => {
  try {
    const response = await fetch("https://www.jamwellness.io/心理資訊/");
    const html = await response.text();
    res.send(html);
  } catch (error) {
    res.status(500).send("Failed fetch data");
  }
});

app.get("/api/avatar/:id", (req, res) => {
  const userID = req.params.id;
  const query = "SELECT avatar FROM users WHERE userID = ?";

  db.query(query, [userID], (err, results) => {
    if (err || results.length === 0 || !results[0].avatar) {
      return res.status(404).sendFile(__dirname + "/img/default-avatar.png");
    }

    res.setHeader("Content-Type", "image/jpeg");
    res.send(results[0].avatar);
  });
});

app.get("/api/staffavatar/:id", (req, res) => {
  const staffID = req.params.id;
  const query = "SELECT avatar FROM staff WHERE staffID = ?";

  db.query(query, [staffID], (err, results) => {
    if (err || results.length === 0 || !results[0].avatar) {
      return res.status(404).sendFile(__dirname + "/img/default-avatar.png");
    }

    res.setHeader("Content-Type", "image/jpeg");
    res.send(results[0].avatar);
  });
});

app.post("/api/updateAvatar", upload.single("avatar"), (req, res) => {
  const userID = req.body.userID;
  const avatar = req.file ? req.file.buffer : null;

  if (!userID || !avatar) {
    return res.status(400).json({ message: "Missing userID or image" });
  }

  const query = "UPDATE users SET avatar = ? WHERE userID = ?";
  db.query(query, [avatar, userID], (err, result) => {
    if (err) {
      console.error("Error:", err);
      return res.status(500).json({ message: "Failed updated avatar" });
    }

    res.status(200).json({ message: "Avatar updated successful" });
  });
});

app.post("/api/book", (req, res) => {
  const { userID, date, startTime } = req.body;

  if (!startTime || !date) {
    return res
      .status(400)
      .json({ success: false, message: "Start time or date is missing." });
  }

  const startDateTime = `${date} ${startTime}:00`;
  const startDateTimeObj = new Date(`${date}T${startTime}:00`);

  if (isNaN(startDateTimeObj.getTime())) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid start time format." });
  }

  // Set Time period
  startDateTimeObj.setHours(startDateTimeObj.getHours() + 3);

  const endDateTime =
    startDateTimeObj.getFullYear() +
    "-" +
    String(startDateTimeObj.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(startDateTimeObj.getDate()).padStart(2, "0") +
    " " +
    String(startDateTimeObj.getHours()).padStart(2, "0") +
    ":" +
    String(startDateTimeObj.getMinutes()).padStart(2, "0") +
    ":00";

  console.log(`Start DateTime: ${startDateTime}`);
  console.log(`End DateTime: ${endDateTime}`);

  const query = `
    SELECT * FROM booking
    WHERE date = ? AND isBooked = 1
    AND (
        (? BETWEEN startTime AND endTime) OR
        (? BETWEEN startTime AND endTime) OR
        (startTime BETWEEN ? AND ?) OR
        (endTime BETWEEN ? AND ?)
    )
  `;

  db.query(
    query,
    [
      date,
      startDateTime,
      endDateTime,
      startDateTime,
      endDateTime,
      startDateTime,
      endDateTime,
    ],
    (err, results) => {
      if (err) {
        console.error("Error checking for conflicts:", err);
        return res.status(500).json({
          success: false,
          message: "An error occurred while checking for conflicts.",
        });
      }

      // Check any existing bookings
      if (results.length > 0) {
        return res.json({
          success: false,
          message: "This timeslot is already booked.",
        });
      }

      // No found, proceed with creating the new booking
      const insertQuery =
        "INSERT INTO booking (userID, startTime, endTime, date, isBooked) VALUES (?, ?, ?, ?, 1)";
      db.query(
        insertQuery,
        [userID, startDateTime, endDateTime, date],
        (err, result) => {
          if (err) {
            console.error("Error inserting booking:", err);
            return res.status(500).json({
              success: false,
              message: "Booking failed. Please try again.",
            });
          }

          // Successful booking
          res
            .status(200)
            .json({ success: true, message: "Booking successful" });
        }
      );
    }
  );
});

// Get booking status
app.get("/api/bookingStatus", (req, res) => {
  const userID = req.query.userID;

  if (!userID) {
    return res
      .status(400)
      .json({ success: false, message: "User ID is required" });
  }

  const sql = `
    SELECT * 
    FROM booking 
    WHERE userID = ? 
    AND startTime <= NOW() 
    AND endTime >= NOW()
  `;

  db.execute(sql, [userID], (err, results) => {
    if (err) {
      console.error("Error checking booking status:", err);
      return res
        .status(500)
        .json({ success: false, message: "Database error" });
    }

    // If a valid booking exists, return isBooked: true
    if (results.length > 0) {
      return res.json({ isBooked: true });
    }

    // Otherwise, return isBooked: false
    return res.json({ isBooked: false });
  });
});

app.get("/api/getBookingEndTime", (req, res) => {
  const userID = req.query.userID;

  if (!userID) {
    return res
      .status(400)
      .json({ success: false, message: "User ID is required" });
  }

  const checkRoleQuery = `SELECT role FROM users WHERE userID = ?`;
  db.execute(checkRoleQuery, [userID], (err, roleResults) => {
    if (err) {
      console.error("Error checking user role:", err);
      return res
        .status(500)
        .json({ success: false, message: "Database error checking role" });
    }

    const userRole = roleResults.length > 0 ? roleResults[0].role : null;

    if (userRole === "psychologist") {
      const queryOtherUsersBookings = `
        SELECT b.userID, b.endTime
        FROM booking b
        JOIN users u ON b.userID = u.userID
        WHERE b.isBooked = 1 AND u.role = 'user' AND b.startTime <= NOW() AND b.endTime >= NOW()
      `;

      db.execute(queryOtherUsersBookings, [], (err, otherUserBookings) => {
        if (err) {
          console.error("Error fetching other users' bookings:", err);
          return res
            .status(500)
            .json({
              success: false,
              message: "Error fetching other users' bookings",
            });
        }

        console.log("Fetched other bookings:", otherUserBookings);

        if (Array.isArray(otherUserBookings) && otherUserBookings.length > 0) {
          return res.json({
            hasBooking: false,
            otherBookings: otherUserBookings,
          });
        } else {
          console.error("No bookings found for other users.");
          return res.json({ hasBooking: false, otherBookings: [] });
        }
      });
    } else {
      const sql = `
        SELECT endTime
        FROM booking
        WHERE userID = ?
        AND startTime <= NOW()
        AND endTime >= NOW()
      `;

      db.execute(sql, [userID], (err, results) => {
        if (err) {
          console.error("Error getting endTime:", err);
          return res
            .status(500)
            .json({ success: false, message: "Database error" });
        }

        if (results.length > 0) {
          return res.json({ hasBooking: true, endTime: results[0].endTime });
        }

        return res.json({ hasBooking: false });
      });
    }
  });
});

app.get("/api/getTodaysBookings", (req, res) => {
  console.log("API request received");
  const sql = `
    SELECT userID, startTime, endTime
    FROM booking
    WHERE DATE(startTime) = CURDATE()
    AND isBooked = 1
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error("Error fetching bookings:", err);
      return res
        .status(500)
        .json({ success: false, message: "Database error" });
    }

    console.log("Bookings data fetched:", results);
    res.json({ success: true, bookings: results });
  });
});

// Check if user is a psychologist
app.get("/api/checkRole", (req, res) => {
  const userID = req.query.userID;
  const user = getUserData(userID);

  if (user && user.role === "Psychologist") {
    res.json({ isPsychologist: true });
  } else {
    res.json({ isPsychologist: false });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ message: "Logout failed" });
    }
    res.status(200).json({ message: "Logout successful" });
  });
});

// Get Logged-In User Data
app.get("/api/userData", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ message: "User not logged in" });
  }

  // Access the userID from the session
  const userID = req.session.user.userID;
  console.log("Logged-in userID:", userID);

  const query = "SELECT * FROM users WHERE userID = ?";
  db.query(query, [userID], (err, results) => {
    if (err) {
      return res
        .status(500)
        .json({ message: "Error fetching user data", error: err });
    }
    if (results.length > 0) {
      res.status(200).json(results[0]);
    } else {
      res.status(404).json({ message: "User not found" });
    }
  });
});

// Set up MySQL connection
const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "", // Your MySQL password
  database: "fyp",
});

// Connect to MySQL
db.connect((err) => {
  if (err) {
    console.error("Error connecting to MySQL:", err);
    return;
  }
  console.log("Connected to MySQL");
});

app.use(express.json());

// Middleware to parse JSON
app.use(bodyParser.json());
//const upload = multer({ storage: multer.memoryStorage() });

// Route to update the user's address
app.post("/api/updateAddress", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ message: "User not logged in" });
  }

  const userID = req.session.user.userID;
  const { room, floor, estate, street } = req.body;

  if (!room || !floor || !estate || !street) {
    return res.status(400).json({ message: "All address fields are required" });
  }

  const query = `
    UPDATE users
    SET room = ?, floor = ?, estate = ?, street = ?
    WHERE userID = ?
  `;

  db.query(query, [room, floor, estate, street, userID], (err, result) => {
    if (err) {
      console.error("Error updating address:", err);
      return res
        .status(500)
        .json({ message: "Error updating address", error: err });
    }

    if (result.affectedRows > 0) {
      res.status(200).json({ message: "Address updated successfully" });
    } else {
      res.status(404).json({ message: "User not found" });
    }
  });
});

// Route to update the user's password
app.post("/api/updatePassword", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ message: "User not logged in" });
  }

  const userID = req.session.user.userID;
  const { currentPassword, newPassword, reenterPassword } = req.body;

  if (!currentPassword || !newPassword || !reenterPassword) {
    return res.status(400).json({ message: "All fields are required" });
  }

  if (newPassword !== reenterPassword) {
    return res.status(400).json({ message: "Passwords do not match" });
  }

  const query = "SELECT password FROM users WHERE userID = ?";

  db.query(query, [userID], (err, results) => {
    if (err) {
      console.error("Error fetching current password:", err);
      return res
        .status(500)
        .json({ message: "Error fetching current password", error: err });
    }

    if (results.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const storedPassword = results[0].password;

    if (storedPassword !== currentPassword) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    const passwordStrengthRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

    if (!passwordStrengthRegex.test(newPassword)) {
      return res.status(400).json({
        message:
          "Password must be at least 8 characters, including 1 uppercase letter, 1 lowercase letter, and 1 number.",
      });
    }

    const updatePasswordQuery =
      "UPDATE users SET password = ? WHERE userID = ?";
    db.query(updatePasswordQuery, [newPassword, userID], (err, result) => {
      if (err) {
        console.error("Error updating password:", err);
        return res
          .status(500)
          .json({ message: "Error updating password", error: err });
      }

      if (result.affectedRows > 0) {
        res.status(200).json({ message: "Password updated successfully" });
      } else {
        res.status(404).json({ message: "User not found" });
      }
    });
  });
});

// Route to handle registration
app.post("/api/register", upload.single("avatar"), (req, res) => {
  const { email, username, phoneNumber, password } = req.body;
  const avatar = req.file ? req.file.buffer : null;

  if (!email || !username || !phoneNumber || !password) {
    return res.status(400).json({ message: "All fields are required" });
  }

  const checkEmailQuery = "SELECT * FROM users WHERE email = ?";
  db.query(checkEmailQuery, [email], (err, results) => {
    if (err) {
      return res.status(500).json({ message: "Database error", error: err });
    }

    if (results.length > 0) {
      return res.status(400).json({ message: "Email is already registered" });
    }

    const insertQuery = `
    INSERT INTO users (email, username, password, phone, avatar)
    VALUES (?, ?, ?, ?, ?)
  `;
    db.query(
      insertQuery,
      [email, username, password, phoneNumber, avatar],
      (err, result) => {
        if (err) {
          return res
            .status(500)
            .json({ message: "Error registering user", error: err });
        }
        res.status(201).json({ message: "User registered successfully" });
      }
    );
  });
});

app.get("/api/getAssessments", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ message: "User not logged in" });
  }

  const userID = req.session.user.userID;

  const query = "SELECT * FROM assessments WHERE userID = ?";
  db.query(query, [userID], (err, results) => {
    if (err) {
      res
        .status(500)
        .json({ message: "Error retrieving assessments", error: err });
    } else {
      res.status(200).json(results);
    }
  });
});

app.post("/api/saveAssessment", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ message: "User not logged in" });
  }

  const userID = req.session.user.userID;
  console.log("Logged-in userID:", userID);

  const { quizResults, recommendations } = req.body;

  if (!quizResults || !recommendations) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  const query = `
    INSERT INTO assessments (userID, quizResults, recommendations)
    VALUES (?, ?, ?)
  `;
  db.query(
    query,
    [userID, JSON.stringify(quizResults), JSON.stringify(recommendations)],
    (err, result) => {
      if (err) {
        console.error("Error saving assessment:", err);
        return res
          .status(500)
          .json({ message: "Error saving assessment", error: err });
      }
      res
        .status(201)
        .json({ message: "Assessment saved successfully", result });
    }
  );
});
app.post("/create-chatroom", (req, res) => {
  const { name, category } = req.body;

  if (!name || !category) {
    return res
      .status(400)
      .json({ message: "Both chatroom name and category are required" });
  }

  const query = "INSERT INTO chatrooms (chatroomName, category) VALUES (?, ?)";
  db.query(query, [name, category], (err, results) => {
    if (err) {
      console.error("Error inserting chatroom:", err);
      return res.status(500).json({ message: "Error creating chatroom" });
    }

    res.status(201).json({
      message: `Chatroom '${name}' created successfully in '${category}' category!`,
    });
  });
});
// Route to fetch chatrooms based on category
app.get("/get-chatrooms", (req, res) => {
  const category = req.query.category || "all"; // Default to 'all' category

  let query = "SELECT * FROM chatrooms";

  if (category !== "all") {
    query += ` WHERE category = ?`;
  }

  db.query(query, [category], (err, results) => {
    if (err) {
      console.error("Error fetching chatrooms:", err);
      return res.status(500).json({ message: "Error fetching chatrooms" });
    }

    res.json({ chatrooms: results });
  });
});

app.get("/get-chatroom-data/:chatroomID", (req, res) => {
  const chatroomId = req.params.chatroomID;

  // Check the chatroom name
  const chatroomQuery =
    "SELECT chatroomName FROM chatrooms WHERE chatroomID = ?";
  db.query(chatroomQuery, [chatroomId], (err, chatroomResult) => {
    if (err) {
      console.error("Error fetching chatroom data:", err);
      return res
        .status(500)
        .json({ message: "Error fetching chatroom data", error: err });
    }

    if (chatroomResult.length === 0) {
      return res.status(404).json({ message: "Chatroom not found" });
    }

    const chatroomName = chatroomResult[0]?.chatroomName;

    // Check with message table
    const messagesQuery =
      "SELECT userID, message, messageID FROM messages WHERE chatroomID = ? ORDER BY created_at ASC";
    db.query(messagesQuery, [chatroomId], (err, messagesResult) => {
      if (err) {
        return res.status(500).send("Error fetching messages");
      }

      // Get AI response
      const aiResponsesQuery =
        "SELECT aiResponse, messageID FROM ai_responses WHERE chatroomID = ? ORDER BY created_at ASC";
      db.query(aiResponsesQuery, [chatroomId], (err, aiResponsesResult) => {
        if (err) {
          return res.status(500).send("Error fetching AI responses");
        }

        // Combine data with messages table and ai_responses table
        const allMessages = [];
        messagesResult.forEach((msg) => {
          allMessages.push({
            userID: msg.userID,
            message: msg.message,
            source: "User",
            messageID: msg.messageID,
          });

          const aiResponse = aiResponsesResult.find(
            (ai) => ai.messageID === msg.messageID
          );
          if (aiResponse) {
            allMessages.push({
              userID: "AI",
              message: aiResponse.aiResponse,
              source: "AI",
              messageID: aiResponse.messageID,
            });
          }
        });

        console.log("All messages with AI responses:", allMessages);

        res.json({
          chatroomName: chatroomName,
          messages: allMessages,
        });
      });
    });
  });
});

app.get("/get-one-chatroom-data/:chatroomID", (req, res) => {
  const chatroomId = req.params.chatroomID;

  if (chatroomId !== "1") {
    return res.status(404).json({ message: "Chatroom not found" });
  }

  // Query for messages, conditionally based on whether the user is logged in as userID 10
  const messagesQuery = `
  SELECT m.userID, m.message, m.image_url, m.created_at
  FROM one_messages m
  LEFT JOIN booking b
    ON (
      (m.userID = b.userID AND m.userID != 10 AND m.created_at BETWEEN b.startTime AND b.endTime)
      OR
      (m.userID = 10 AND b.userID != 10 AND m.created_at BETWEEN b.startTime AND b.endTime)
    )
  WHERE m.chatroomID = ? 
    AND b.isBooked = 1
    AND b.date = CURDATE()
    AND CURRENT_TIMESTAMP BETWEEN b.startTime AND b.endTime
  ORDER BY m.created_at ASC;
`;

  db.query(messagesQuery, [chatroomId], (err, messagesResult) => {
    if (err) {
      console.error("Error fetching messages:", err);
      return res.status(500).send("Error fetching messages");
    }

    console.log("Messages from DB:", messagesResult);
    res.json({
      messages: messagesResult.map((msg) => ({
        userID: msg.userID,
        message: msg.message,
        image_url: msg.image_url,
        created_at: msg.created_at,
      })),
    });
  });
});

// Upload image
app.post("/upload-image", upload.single("image"), (req, res) => {
  const { chatroomId, userId } = req.body;
  const imagePath = req.file.path;

  const query =
    "INSERT INTO images (chatroomID, userId, image_url) VALUES (?, ?, ?)";
  db.query(query, [chatroomId, userId, imagePath], (err, result) => {
    if (err) throw err;
    res.json({ message: "Image uploaded successfully", imagePath: imagePath });
  });
});

// Get Logged-In Staff Data
app.get("/api/staffData", (req, res) => {
  if (!req.session.user || !req.session.user.staffID) {
    return res.status(401).json({ message: "Staff not logged in" });
  }

  const staffID = req.session.user.staffID;
  console.log("Logged-in staffID:", staffID);

  const query = "SELECT * FROM staff WHERE staffID = ?";
  db.query(query, [staffID], (err, results) => {
    if (err) {
      return res
        .status(500)
        .json({ message: "Error fetching staff data", error: err });
    }
    if (results.length > 0) {
      res.status(200).json(results[0]);
    } else {
      res.status(404).json({ message: "Staff not found" });
    }
  });
});

// Update address
app.post("/api/StaffupdateAddress", (req, res) => {
  if (!req.session.user || !req.session.user.staffID) {
    return res.status(401).json({ message: "Please login." });
  }
  const { room, floor, estate, street } = req.body;

  if (!room || !floor || !estate || !street) {
    return res.status(400).json({ message: "All field are required." });
  }

  const query = `
    UPDATE staff
    SET room = ?, floor = ?, estate = ?, street = ?
    WHERE staffID = ?
  `;

  db.query(
    query,
    [room, floor, estate, street, req.session.user.staffID],
    (err, result) => {
      if (err) {
        return res.status(500).json({ message: "Failed update address." });
      }

      res.status(200).json({ message: "Update address successful." });
    }
  );
});

// Update password
app.post("/api/StaffupdatePassword", (req, res) => {
  if (!req.session.user || !req.session.user.staffID) {
    return res.status(401).json({ message: "Please login." });
  }

  const { currentPassword, newPassword, reenterPassword } = req.body;

  if (newPassword !== reenterPassword) {
    return res
      .status(400)
      .json({ message: "Password inputs are inconsistent." });
  }

  const query = "SELECT password FROM staff WHERE staffID = ?";
  db.query(query, [req.session.user.staffID], (err, results) => {
    if (
      err ||
      results.length === 0 ||
      results[0].password !== currentPassword
    ) {
      return res.status(400).json({ message: "Incorrect password." });
    }

    const updatePasswordQuery =
      "UPDATE staff SET password = ? WHERE staffID = ?";
    db.query(
      updatePasswordQuery,
      [newPassword, req.session.user.staffID],
      (err) => {
        if (err) {
          return res.status(500).json({ message: "更新密碼時出錯" });
        }
        res.status(200).json({ message: "密碼更新成功" });
      }
    );
  });
});

//Registration
app.post("/api/staffregister", upload.single("avatar"), (req, res) => {
  const { email, username, phoneNumber, password } = req.body;
  const avatar = req.file ? req.file.buffer : null;

  if (!email || !username || !phoneNumber || !password) {
    return res.status(400).json({ message: "All field are required" });
  }

  const checkEmailQuery = "SELECT * FROM staff WHERE email = ?";
  db.query(checkEmailQuery, [email], (err, results) => {
    if (results.length > 0) {
      return res
        .status(400)
        .json({ message: "Email is already registered. Please login." });
    }

    const insertQuery = `
      INSERT INTO staff (email, username, password, phone, avatar)
      VALUES (?, ?, ?, ?, ?)
    `;
    db.query(
      insertQuery,
      [email, username, password, phoneNumber, avatar],
      (err) => {
        if (err) {
          return res.status(500).json({ message: "Registration failed." });
        }
        res.status(201).json({ message: "Registration successful." });
      }
    );
  });
});

// Check the user's information
app.get("/api/users", (req, res) => {
  const query = "SELECT * FROM users";
  db.query(query, (err, results) => {
    if (err) {
      console.error("Error fetching users:", err);
      return res
        .status(500)
        .json({ message: "Error fetching users", error: err });
    }
    res.status(200).json(results);
  });
});

// Check the staff's information
app.get("/api/staff", (req, res) => {
  const query = "SELECT * FROM staff";
  db.query(query, (err, results) => {
    if (err) {
      console.error("Error fetching staff:", err);
      return res
        .status(500)
        .json({ message: "Error fetching staff", error: err });
    }
    res.status(200).json(results);
  });
});

// Route to delete user
app.delete("/api/userdelete/:userID", (req, res) => {
  if (!req.session.user || !req.session.user.staffID) {
    return res.status(401).json({ message: "Staff not logged in" });
  }
  const userID = req.params.userID;
  console.log(userID);
  const query = "DELETE FROM users WHERE userID = ?";

  db.query(query, [userID], (error, results) => {
    if (error) {
      console.error("Error deleting user:", error);
      return res.status(500).json({ message: "Error deleting user", error });
    }
    res.status(200).json({ message: "User deleted successfully" });
  });
});

// Route to delete staff
app.delete("/api/staffdelete/:staffID", (req, res) => {

  const staffID = req.params.staffID;
  console.log(staffID);
  const query = "DELETE FROM staff WHERE staffID = ?";

  db.query(query, [staffID], (error, results) => {
    if (error) {
      console.error("Error deleting staff:", error);
      return res.status(500).json({ message: "Error deleting staff", error });
    }
    res.status(200).json({ message: "Staff deleted successfully" });
  });
});

// Route to update user password
app.post("/api/userpassword/:userID", async (req, res) => {
  if (!req.session.user || !req.session.user.staffID) {
    return res.status(401).json({ message: "Please login." });
  }

  const { userID } = req.params;
  const { newPassword, reenterPassword } = req.body;

  if (!newPassword || !reenterPassword) {
    return res.status(400).json({ message: "Password are required." });
  }

  if (newPassword !== reenterPassword) {
    return res
      .status(400)
      .json({ message: "Password inputs are inconsistent." });
  }

  try {
    const updatePasswordQuery =
      "UPDATE users SET password = ? WHERE userID = ?";

    db.query(updatePasswordQuery, [newPassword, userID], (err) => {
      if (err) {
        console.error("Error updating user password:", err);
        return res
          .status(500)
          .json({ message: "Failed update password:", error: err });
      }
      res.status(200).json({ message: "Update password successfully." });
    });
  } catch (error) {
    console.error("Error updating password:", error);
    res.status(500).json({ message: "Please try again" });
  }
});

// Route to update user password
app.post("/api/staffpassword/:staffID", async (req, res) => {

  const { staffID } = req.params;
  const { newPassword, reenterPassword } = req.body;

  if (!newPassword || !reenterPassword) {
    return res.status(400).json({ message: "Password are required." });
  }

  if (newPassword !== reenterPassword) {
    return res.status(400).json({ message: "Password inputs are inconsistent." });
  }

  try {
    const updatePasswordQuery =
      "UPDATE staff SET password = ? WHERE staffID = ?";

    db.query(updatePasswordQuery, [newPassword, staffID], (err) => {
      if (err) {
        console.error("Error updating staff password:", err);
        return res
          .status(500)
          .json({ message: "Failed update password:", error: err });
      }
      res.status(200).json({ message: "Update password successfully." });
    });
  } catch (error) {
    console.error("Error updating password:", error);
    res.status(500).json({ message: "Please try again" });
  }
});

// Check the user's test information, return the results of all assessments
app.get("/api/userResult", (req, res) => {
  const query = "SELECT * FROM assessments";

  db.query(query, (error, results) => {
    if (error) {
      console.error("Error fetching assessments:", error);
      return res
        .status(500)
        .json({ message: "Error fetching assessments", error: error.message });
    }
    setServers;
    res.status(200).json(results);
  });
});
function safeParseJSON(value) {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn("Invalid JSON string, returning original value:", value);
    return value;
  }
}

//send message
app.post("/api/sendMessage/:userID/", (req, res) => {
  const { userID } = req.params;
  const { message, message_type } = req.body;

  if (!userID || !message || !message_type) {
    console.error("Error:", { userID, message, message_type });
    return res.status(400).json({ message: "All field are required" });
  }
  const vaildMessageTypes = ["chatroom", "test_results"];
  if (!vaildMessageTypes.includes(message_type)) {
    console.error("invail message type", message_type);
    return res.status(400).json({ message: "invaild message type" });
  }
  const query = `
      INSERT INTO user_selections ( userID, message_usertostaff, message_type)
      VALUES (?, ?, ?)
  `;

  db.query(query, [userID, message, message_type], (err, result) => {
    if (err) {
      console.error("Error inserting message:", err);
      return res
        .status(500)
        .json({ message: "插入消息時發生錯誤", error: err });
    }

    console.log("Message inserted successfully:", {
      userID,
      message,
      message_type,
    });
    res.status(201).json({ message: "Message sent." });
  });
});

app.get("/api/user-selections", (req, res) => {
  let { userID, message_usertostaff } = req.query;

  userID = userID || "";
  message_usertostaff = message_usertostaff || "";

  if (!userID) {
    console.error("Error: userID");
    return res.status(400).json({ error: "Can not fetch userID" });
  }

  let query = `SELECT * FROM user_selections WHERE userID = ?`;
  let queryParams = [userID];

  if (message_usertostaff) {
    query += ` AND message_usertostaff = ?`;
    queryParams.push(message_usertostaff);
  }

  db.query(query, queryParams, (err, result) => {
    if (err) {
      return res.status(500).json({ error: "database error" });
    }

    if (result.length === 0) {
      return res.status(404).json({ error: "Can not found user selected" });
    }

    res.json({ messages: result });
  });
});

// Handled user selected option
app.post("/api/updatemessages", (req, res) => {
  let { userID, contentback } = req.body;

  if (!userID || !contentback) {
    return res.status(400).json({ error: "Please try again" });
  }

  userID = parseInt(userID, 10);

  const query = `
      UPDATE user_selections
      SET contentback = ?
      WHERE userID = ?
  `;

  db.query(query, [contentback, userID], (err, result) => {
    if (err) {
      return res.status(500).json({ error: "Please try again" });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Can not fetch user selected" });
    }
    res.json({ message: "User selected successful" });
  });
});

app.get("/api/unreadNotifications", (req, res) => {
  const { userID } = req.query;
  if (!userID) {
    return res.status(400).json({ message: "userID required" });
  }

  const query =
    "SELECT COUNT(*) AS unreadCount FROM user_selections WHERE userID = ? AND contentback IS NULL";

  db.query(query, [userID], (err, results) => {
    if (err) {
      return res
        .status(500)
        .json({ message: "database error", error: err.message });
    }

    res.json({ unreadCount: results[0].unreadCount || 0 });
  });
});

app.get("/api/unreadBackNotifications", (req, res) => {
  const { staffID } = req.query;
  if (!staffID) return res.status(400).json({ message: "Missing staffID" });

  const query =
    "SELECT COUNT(*) AS unreadCount FROM user_selections WHERE is_read = 0 AND contentback IS NOT NULL AND staffID = ?";
  db.query(query, [staffID], (err, result) => {
    if (err) {
      console.error("error:", err);
      return res.status(500).json({ message: "Please try again" });
    }
    res.json({ unreadCount: result[0].unreadCount });
  });
});

app.post("/api/markNotificationRead/:userID", (req, res) => {
  const { userID } = req.params;
  if (!userID) return res.status(400).json({ message: "Missing userID" });

  const query =
    "UPDATE user_selections SET contentback = '' WHERE userID = ? AND contentback IS NULL";

  db.query(query, [userID], (err, results) => {
    if (err) {
      return res.status(500).json({ message: "Please try again" });
    }

    res.json({ message: "Notification read", updated: results.affectedRows });
  });
});

app.post("/api/markBackNotificationRead/:staffID", (req, res) => {
  const { staffID } = req.params;
  if (!staffID) return res.status(400).json({ message: "Missing staffID" });

  const query =
    "UPDATE user_selections SET is_read = 1 WHERE staffID = ? AND contentback IS NOT NULL";
  db.query(query, [staffID], (err, results) => {
    if (err) {
      return res.status(500).json({ message: "please try again" });
    }
    res.json({ message: "Notification read", updated: results.affectedRows });
  });
});

// Get notifications
app.get("/api/notifications", (req, res) => {
  const { userID } = req.query;

  if (!userID) {
    return res.status(400).json({ message: "Missing userID" });
  }

  const query = `
    SELECT selectionID, userID, message_usertostaff, contentback, updatedAt
    FROM user_selections
    WHERE userID = ?
    ORDER BY updatedAt DESC, selectionID DESC
  `;

  db.query(query, [userID], (err, results) => {
    if (err) {
      console.error("Error fetching notifications:", err);
      return res.status(500).json({ message: "Please try again" });
    }

    res.json({
      success: true,
      notifications: results.map((n) => ({
        ...n,
        message_usertostaff: n.message_usertostaff || "No message",
      })),
    });
  });
});

app.get("/api/Back-notifications", (req, res) => {
  const query = `
    SELECT selectionID, userID, contentback
    FROM user_selections
    WHERE contentback IS NOT NULL
    ORDER BY selectionID DESC
  `;

  db.query(query, (err, results) => {
    if (err) {
      console.error("error", err);
      return res.status(500).json({ message: "Please try again" });
    }
    res.json({ success: true, notifications: results });
  });
});

app.get("/api/user-selections", (req, res) => {
  let { userID, message_usertostaff } = req.query;

  userID = userID || "";
  message_usertostaff = message_usertostaff || "";

  if (!userID) {
    console.error("Missing userID");
    return res.status(400).json({ error: "Missing userID" });
  }

  let query = `SELECT * FROM user_selections WHERE userID = ?`;
  let queryParams = [userID];

  if (message_usertostaff) {
    query += ` AND message_usertostaff = ?`;
    queryParams.push(message_usertostaff);
  }

  db.query(query, queryParams, (err, result) => {
    if (err) {
      console.error("database error:", err);
      return res.status(500).json({ error: "Please try again." });
    }

    if (result.length === 0) {
      return res.status(404).json({ error: "Can not fetch user information" });
    }

    res.json({ messages: result });
  });
});

app.post("/api/updateNotification", (req, res) => {
  const { userID, contentback } = req.body;

  if (!userID || !contentback) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  const query = "UPDATE user_selections SET contentback = ? WHERE userID = ?";

  db.query(query, [contentback, userID], (err, result) => {
    if (err) {
      console.error("Database update error:", err);
      return res.status(500).json({ message: "Database error" });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "No matching record found" });
    }

    res.json({ message: "Update successful" });
  });
});

app.get("/api/userMessages", (req, res) => {
  const query = `
 SELECT 
  m.messageID, 
  m.userID, 
  m.message, 
  m.created_at, 
  u.username 
FROM messages m 
INNER JOIN users u ON m.userID = u.userID
ORDER BY m.created_at DESC;

  `;

  db.query(query, (error, results) => {
    if (error) {
      console.error("Error fetching user messages:", error);
      return res.status(500).json({
        message: "Error fetching user messages",
        error: error.message,
      });
    }
    res.status(200).json(results);
  });
});
app.get("/api/userAll/message/:messageID", (req, res) => {
  const messageID = req.params.messageID;

  const query = `
     SELECT 
      m.messageID, 
      m.userID, 
      m.message, 
      m.created_at AS dateTaken,
      u.room, u.floor, u.estate, u.street, u.phone, u.email,
      latest.contentback
    FROM messages m
    INNER JOIN users u ON m.userID = u.userID
    LEFT JOIN (
      SELECT userID, contentback
      FROM user_selections
      WHERE message_type = 'chatroom'
    ) latest ON latest.userID = u.userID
    WHERE m.messageID = ? 
    ORDER BY m.created_at DESC;
  `;

  db.query(query, [messageID], (error, results) => {
    if (error) {
      console.error("Error fetching message data:", error);
      return res.status(500).json({
        message: "Error fetching message data",
        error: error.message,
      });
    }

    if (results.length === 0) {
      return res.status(404).json({ message: "Message not found" });
    }

    res.status(200).json(results);
  });
});

app.get("/api/userAll/:id", (req, res) => {
  const assessmentId = req.params.id;

  const query = `
    SELECT 
      a.assessmentID, 
      a.userID, 
      a.quizResults, 
      a.recommendations, 
      a.dateTaken,
      u.room, u.floor, u.estate, u.street, u.phone, u.email,
      m.message AS latestMessage,
      us.contentback
    FROM assessments a
    INNER JOIN users u ON a.userID = u.userID
    LEFT JOIN (
      SELECT userID, message
      FROM messages
      WHERE messageID = (
        SELECT MAX(messageID) FROM messages AS sub WHERE sub.userID = messages.userID
      )
    ) m ON m.userID = u.userID
    LEFT JOIN user_selections us ON us.userID = u.userID AND us.message_type = 'test_results'
    WHERE a.assessmentID = ?
  `;

  db.query(query, [assessmentId], (error, results) => {
    if (error) {
      console.error("Database query error:", error);
      return res.status(500).json({ message: "Database query error", error });
    }

    if (results.length === 0) {
      return res
        .status(404)
        .json({ message: "No data found for the given assessment ID" });
    }

    try {
      results.forEach((result) => {
        result.quizResults = safeParseJSON(result.quizResults);
        result.recommendations = safeParseJSON(result.recommendations);
      });

      res.status(200).json(results);
    } catch (parseError) {
      console.error("Error parsing JSON fields:", parseError);
      return res
        .status(500)
        .json({ message: "Error parsing JSON fields", parseError });
    }
  });
});

app.post("/submitScore", (req, res) => {
  const { userID, score } = req.body;

  if (!userID || score === undefined) {
    return res.status(400).json({ error: "UserID or score not vaild." });
  }

  const query = `
    INSERT INTO scores (userID, score) 
    VALUES (?, ?) 
    ON DUPLICATE KEY UPDATE score = GREATEST(score, VALUES(score))
  `;

  db.query(query, [userID, score], async (err) => {
    if (err) {
      return res.status(500).json({ error: "Save score failed." });
    }
    const leaderboard = await getLeaderboard();

    io.emit("updateLeaderboard", leaderboard);

    res.json(leaderboard);
  });
});

app.get("/getLeaderboard", (req, res) => {
  const query = `
    SELECT users.username, scores.score 
    FROM scores 
    JOIN users ON scores.userID = users.userID 
    ORDER BY scores.score DESC 
    LIMIT 10
  `;

  db.query(query, (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Get leader board failed." });
    }

    res.json(results);
  });
});

async function getLeaderboard() {
  try {
    const [results] = await db.promise().query(`
      SELECT users.username, scores.score 
      FROM scores 
      JOIN users ON scores.userID = users.userID 
      ORDER BY scores.score DESC 
      LIMIT 10
    `);
    return results;
  } catch (err) {
    console.error("Error: ", err);
    return [];
  }
}
// Dashboard API Endpoint
app.get("/api/dashboard", async (req, res) => {
  try {
    // Get current date and calculate date ranges
    const now = new Date();
    const lastMonth = new Date(now);
    lastMonth.setMonth(lastMonth.getMonth() - 1);

    const lastWeek = new Date(now);
    lastWeek.setDate(lastWeek.getDate() - 7);

    // Execute all queries in parallel for better performance
    const [
      totalUsersResult,
      lastMonthUsersResult,
      sensitiveMessagesResult,
      lastWeekMessagesResult,
      totalTestsResult,
      thisMonthTestsResult,
      highRiskCasesResult,
      lastMonthHighRiskResult,
      messagesTrendResult,
      resultsDistributionResult,
      recentActivityResult
    ] = await Promise.all([
      // Total Users
      db.promise().query("SELECT COUNT(*) AS count FROM users"),

      // Users since last month
      db.promise().query(
        "SELECT COUNT(*) AS count FROM users WHERE createdAt >= ?",
        [lastMonth]
      ),

      // Sensitive Messages
      db.promise().query(
        `SELECT COUNT(*) AS count FROM messages 
         WHERE message LIKE '%kill%' OR message LIKE '%suicide%' OR message LIKE '%take my life%' 
         OR message LIKE '%die%' OR message LIKE '%homoside%' OR message LIKE '%murdrer%'`
      ),

      // Messages this week
      db.promise().query(
        "SELECT COUNT(*) AS count FROM messages WHERE created_at >= ?",
        [lastWeek]
      ),

      // Total Tests
      db.promise().query("SELECT COUNT(*) AS count FROM assessments"),

      // Tests this month
      db.promise().query(
        "SELECT COUNT(*) AS count FROM assessments WHERE dateTaken >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)"
      ),

      // High Risk Cases - Current
      db.promise().query(
        `SELECT COUNT(DISTINCT userID) AS count 
         FROM assessments
         WHERE JSON_EXTRACT(quizResults, '$.score') > 20`
      ),

      // High Risk Cases - Last Month
      db.promise().query(
        `SELECT COUNT(DISTINCT userID) AS count 
         FROM assessments
         WHERE JSON_EXTRACT(quizResults, '$.score') > 20
         AND dateTaken >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)`
      ),

      // Messages Trend (last 30 days)
      db.promise().query(
        `SELECT 
           DATE(created_at) AS date, 
           COUNT(*) AS count
         FROM messages
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
         GROUP BY DATE(created_at)
         ORDER BY date`
      ),

      // Test Results Distribution
      db.promise().query(
        `SELECT 
           JSON_UNQUOTE(JSON_EXTRACT(quizResults, '$.type')) AS result_type,
           COUNT(*) AS count
         FROM assessments
         GROUP BY result_type`
      ),

      // Recent Activity
      db.promise().query(
        `(SELECT 
           'user' AS type,
           userID,
           username,
           avatar AS avatar,
           createdAt AS timestamp,
           'New user registered' AS description
         FROM users
         ORDER BY createdAt DESC
         LIMIT 3)
         
         UNION ALL
         
         (SELECT 
           'test' AS type,
           a.userID,
           u.username,
           u.avatar AS avatar,
           a.dateTaken AS timestamp,
           CONCAT('Completed test: ', JSON_UNQUOTE(JSON_EXTRACT(a.quizResults, '$.category'))) AS description
         FROM assessments a
         JOIN users u ON a.userID = u.userID
         ORDER BY a.dateTaken DESC
         LIMIT 3)
         
         UNION ALL
         
         (SELECT 
           'message' AS type,
           m.userID,
           u.username,
           u.avatar AS avatar,
           m.created_at AS timestamp,
           'Sent sensitive message' AS description
         FROM messages m
         JOIN users u ON m.userID = u.userID
         WHERE m.message LIKE '%kill%' OR m.message LIKE '%homocide%' OR m.message LIKE '%murder%' 
           OR m.message LIKE '%die%' OR m.message LIKE '%suicide%' OR m.message LIKE '%take my life%'
         ORDER BY m.created_at DESC
         LIMIT 3)
         
         UNION ALL
         
         (SELECT 
           'alert' AS type,
           a.userID,
           u.username,           
           u.avatar AS avatar,
           a.dateTaken AS timestamp,
           CONCAT('High risk result: ', JSON_UNQUOTE(JSON_EXTRACT(a.quizResults, '$.type'))) AS description
         FROM assessments a
         JOIN users u ON a.userID = u.userID
         WHERE JSON_EXTRACT(a.quizResults, '$.score') > 50
         ORDER BY a.dateTaken DESC
         LIMIT 1)
         
         ORDER BY timestamp DESC
         LIMIT 10`
      )
    ]);

    // Calculate percentage changes
    const totalUsers = totalUsersResult[0][0].count;
    const lastMonthUsers = lastMonthUsersResult[0][0].count;
    const userChange = lastMonthUsers > 0
      ? Math.round(((totalUsers - lastMonthUsers) / lastMonthUsers) * 100)
      : 0;

    const sensitiveMessages = sensitiveMessagesResult[0][0].count;
    const lastWeekMessages = lastWeekMessagesResult[0][0].count;
    const messageChange = lastWeekMessages > 0
      ? Math.round(((sensitiveMessages - lastWeekMessages) / lastWeekMessages) * 100)
      : 0;

    const totalTests = totalTestsResult[0][0].count;
    const thisMonthTests = thisMonthTestsResult[0][0].count;
    const testChange = thisMonthTests > 0
      ? Math.round(((totalTests - thisMonthTests) / thisMonthTests) * 100)
      : 0;

    const highRiskCases = highRiskCasesResult[0][0].count;
    const lastMonthHighRisk = lastMonthHighRiskResult[0][0].count;
    const highRiskChange = lastMonthHighRisk > 0
      ? Math.round(((highRiskCases - lastMonthHighRisk) / lastMonthHighRisk) * 100)
      : 0;

    // Format messages trend data for Chart.js
    const messagesTrend = {
      labels: [],
      values: []
    };

    messagesTrendResult[0].forEach(row => {
      messagesTrend.labels.push(new Date(row.date).toLocaleDateString());
      messagesTrend.values.push(row.count);
    });

    // Format results distribution data for Chart.js
    const resultsDistribution = {
      labels: [],
      values: []
    };

    resultsDistributionResult[0].forEach(row => {
      // Extract just the level (e.g., "Severe" from "Level of Depression: Severe")
      const level = row.result_type.replace(/^.*:\s*/, '');
      resultsDistribution.labels.push(level);
      resultsDistribution.values.push(row.count);
    });

    // Format recent activity data
    const recentActivity = recentActivityResult[0].map(row => ({
      avatar: row.avatar,
      type: row.type,
      title: row.username,
      description: row.description,
      timestamp: row.timestamp
    }));

    // Prepare the response
    const dashboardData = {
      totalUsers,
      userChange,
      sensitiveMessages,
      messageChange,
      totalTests,
      testChange,
      highRiskCases,
      highRiskChange,
      messagesTrend,
      resultsDistribution,
      recentActivity
    };

    res.json(dashboardData);
  } catch (error) {
    console.error("Error fetching dashboard data:", error);
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
});

server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
